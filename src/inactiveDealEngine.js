/**
 * n8n-hubspot-inactive-deal-revival-engine :: Inactivity detection, deal normalisation, revival planning & dry-run telemetry
 *
 * ⚠️ Disclaimer & Liability Limitation
 * Use at your own risk. The code, workflows, and scripts provided in this repository
 * (n8n-hubspot-inactive-deal-revival-engine) are for educational and architectural
 * demonstration purposes.
 *
 * - No Liability: The author and dhRobin Systems assume no responsibility or liability for
 *   any direct, indirect, incidental, or consequential damages resulting from the use,
 *   misuse, or deployment of these scripts.
 * - No Warranty: All software, n8n JSON blueprints, and JavaScript modules are provided "AS
 *   IS" without warranty of any kind, express or implied, including but not limited to
 *   merchantability, fitness for a particular purpose, or non-infringement.
 * - Production Testing Required: Always test thoroughly in an isolated staging environment
 *   (for example a HubSpot developer test account or sandbox) with SANDBOX_MODE=true
 *   enabled before connecting live HubSpot credentials.
 * - Third-Party APIs & Compliance: Users are solely responsible for complying with the
 *   terms of service, rate limits, data privacy regulations (GDPR/CCPA), anti-spam laws
 *   (e.g. CAN-SPAM, CASL, PECR), and security policies of HubSpot and any connected
 *   services, including honouring every unsubscribe request and reviewing every automated
 *   deal-stage change and sequence enrollment.
 *
 * Full text: DISCLAIMER.md | License: MIT (see LICENSE)
 * Copyright (c) 2026 DH Robin (dhRobin Systems) - https://dhrobinsystems.com
 */
'use strict';

/**
 * Core logic for the inactive-deal revival engine. Pure and dependency-free:
 * it runs unchanged in Node.js tests and inside n8n Code nodes (compiled in
 * by `npm run build`). It never performs network I/O; it builds the exact
 * HubSpot requests the workflow sends.
 *
 * Definition of "inactive":
 *   reference = the deal's activity property (default notes_last_contacted =
 *               last logged call, sales email or meeting), or, if the deal was
 *               never contacted, its createdate.
 *   inactive  = (now - reference) > INACTIVITY_DAYS  (strictly greater)
 *   and the deal is open, in a monitored pipeline, not already Stalled, not in
 *   an excluded stage, older than MIN_DEAL_AGE_DAYS and >= MIN_DEAL_AMOUNT.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HUBSPOT_API = 'https://api.hubapi.com';
const TASK_TO_DEAL_ASSOCIATION = 216; // HUBSPOT_DEFINED task -> deal
const TASK_TO_CONTACT_ASSOCIATION = 204; // HUBSPOT_DEFINED task -> contact

const SKIP_REASON = Object.freeze({
  CLOSED: 'deal_closed',
  ALREADY_STALLED: 'already_in_stalled_stage',
  EXCLUDED_STAGE: 'excluded_stage',
  PIPELINE_OUT_OF_SCOPE: 'pipeline_out_of_scope',
  RECENT_ACTIVITY: 'recent_activity',
  TOO_NEW: 'deal_too_new',
  BELOW_MIN_AMOUNT: 'below_min_amount',
  INVALID_DATES: 'invalid_activity_and_create_dates',
  MISSING_ID: 'missing_deal_id'
});

/* ------------------------------------------------------------------------ */
/* Parsing helpers                                                          */
/* ------------------------------------------------------------------------ */

/** HubSpot dates arrive as ISO strings or epoch-millisecond strings. */
function parseHubSpotTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim();
  const ms = /^\d{10,14}$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function parseAmount(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function cleanText(value, max) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 200);
}

/** Whole days elapsed, floored (29.9 days -> 29). */
function daysBetween(fromMs, toMs) {
  return Math.floor((toMs - fromMs) / DAY_MS);
}

function maskEmail(email) {
  const value = String(email || '');
  const at = value.indexOf('@');
  return at > 0 ? value[0] + '***' + value.slice(at) : '';
}

/* ------------------------------------------------------------------------ */
/* Search request                                                           */
/* ------------------------------------------------------------------------ */

const DEAL_SEARCH_PROPERTIES = Object.freeze([
  'dealname', 'dealstage', 'pipeline', 'hubspot_owner_id', 'amount', 'closedate', 'createdate',
  'hs_is_closed', 'notes_last_contacted', 'notes_last_updated'
]);

/**
 * CRM Search body: open deals in scope whose activity property is older than
 * the cutoff, OR that were never contacted and were created before the cutoff.
 * Sorted oldest-activity first; capped at MAX_DEALS_PER_RUN. Deals moved to
 * Stalled drop out of the next search, so runs naturally page through backlog.
 */
function buildDealSearchRequest(config, nowMs) {
  const cutoff = String(nowMs - config.inactivityDays * DAY_MS);
  const stalledStages = Object.values(config.stalledStageByPipeline || {}).map(String);
  const notInStages = Array.from(new Set(stalledStages.concat(config.excludedStageIds || [])));
  const base = [
    { propertyName: 'pipeline', operator: 'IN', values: config.pipelineIds.slice() },
    { propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' }
  ];
  if (notInStages.length) base.push({ propertyName: 'dealstage', operator: 'NOT_IN', values: notInStages });
  const properties = Array.from(new Set(DEAL_SEARCH_PROPERTIES.concat([config.activityProperty])));
  return {
    method: 'POST',
    url: HUBSPOT_API + '/crm/v3/objects/deals/search',
    body: {
      filterGroups: [
        { filters: base.concat([{ propertyName: config.activityProperty, operator: 'LT', value: cutoff }]) },
        { filters: base.concat([{ propertyName: config.activityProperty, operator: 'NOT_HAS_PROPERTY' }, { propertyName: 'createdate', operator: 'LT', value: cutoff }]) }
      ],
      properties,
      sorts: [{ propertyName: config.activityProperty, direction: 'ASCENDING' }],
      limit: Math.min(200, config.maxDealsPerRun)
    }
  };
}

/* ------------------------------------------------------------------------ */
/* Normalisation & inactivity validation                                    */
/* ------------------------------------------------------------------------ */

/**
 * Normalise a HubSpot deal record ({ id, properties }) or a flat object.
 * @returns {object} canonical deal
 */
function normalizeDeal(raw, activityProperty) {
  const r = raw || {};
  const p = r.properties || r;
  return {
    id: cleanText(r.id || p.hs_object_id, 32),
    name: cleanText(p.dealname, 150) || 'Untitled deal',
    stageId: cleanText(p.dealstage, 64),
    pipelineId: cleanText(p.pipeline, 64),
    ownerId: /^\d{1,20}$/.test(cleanText(p.hubspot_owner_id, 20)) ? cleanText(p.hubspot_owner_id, 20) : '',
    amount: parseAmount(p.amount),
    isClosed: String(p.hs_is_closed).toLowerCase() === 'true',
    createdAtMs: parseHubSpotTimestamp(p.createdate || r.createdAt),
    lastActivityMs: parseHubSpotTimestamp(p[activityProperty || 'notes_last_contacted'])
  };
}

/**
 * Re-validate inactivity in code (defence in depth on top of the search filter:
 * protects against stale indexes, clock/timezone mistakes and config drift).
 * @returns {{eligible:boolean, reason:string, daysInactive:number|null, referenceSource:string}}
 */
function evaluateInactivity(deal, config, nowMs) {
  const result = (eligible, reason, extra) => Object.assign({ eligible, reason, daysInactive: null, referenceSource: '' }, extra || {});
  if (!deal.id) return result(false, SKIP_REASON.MISSING_ID);
  if (deal.isClosed) return result(false, SKIP_REASON.CLOSED);
  if (!config.pipelineIds.includes(deal.pipelineId)) return result(false, SKIP_REASON.PIPELINE_OUT_OF_SCOPE);
  const stalledStage = config.stalledStageByPipeline[deal.pipelineId];
  if (stalledStage && deal.stageId === String(stalledStage)) return result(false, SKIP_REASON.ALREADY_STALLED);
  if (config.excludedStageIds.includes(deal.stageId)) return result(false, SKIP_REASON.EXCLUDED_STAGE);

  const referenceMs = deal.lastActivityMs !== null ? deal.lastActivityMs : deal.createdAtMs;
  const referenceSource = deal.lastActivityMs !== null ? 'last_activity' : 'created_never_contacted';
  if (referenceMs === null || referenceMs > nowMs + DAY_MS) return result(false, SKIP_REASON.INVALID_DATES);

  const daysInactive = daysBetween(referenceMs, nowMs);
  if (nowMs - referenceMs <= config.inactivityDays * DAY_MS) {
    return result(false, SKIP_REASON.RECENT_ACTIVITY, { daysInactive, referenceSource });
  }
  if (deal.createdAtMs !== null && daysBetween(deal.createdAtMs, nowMs) < config.minDealAgeDays) {
    return result(false, SKIP_REASON.TOO_NEW, { daysInactive, referenceSource });
  }
  if (config.minDealAmount > 0 && (deal.amount === null || deal.amount < config.minDealAmount)) {
    return result(false, SKIP_REASON.BELOW_MIN_AMOUNT, { daysInactive, referenceSource });
  }
  return result(true, 'inactive', { daysInactive, referenceSource });
}

/**
 * Normalise a search response and split it into candidates and skips.
 * Candidates are de-duplicated, ordered by inactivity and capped.
 */
function selectInactiveDeals(searchResponse, config, nowMs) {
  const rows = searchResponse && Array.isArray(searchResponse.results) ? searchResponse.results : [];
  const seen = new Set();
  const candidates = [];
  const skipped = [];
  for (const row of rows) {
    const deal = normalizeDeal(row, config.activityProperty);
    if (deal.id && seen.has(deal.id)) continue;
    seen.add(deal.id);
    const verdict = evaluateInactivity(deal, config, nowMs);
    if (verdict.eligible) candidates.push(Object.assign({ deal }, verdict));
    else skipped.push({ dealId: deal.id, reason: verdict.reason });
  }
  candidates.sort((a, b) => b.daysInactive - a.daysInactive);
  return {
    candidates: candidates.slice(0, config.maxDealsPerRun),
    skipped,
    overflow: Math.max(0, candidates.length - config.maxDealsPerRun),
    totalAvailable: searchResponse && Number.isFinite(searchResponse.total) ? searchResponse.total : rows.length
  };
}

/* ------------------------------------------------------------------------ */
/* Contacts & owners                                                        */
/* ------------------------------------------------------------------------ */

/** Unique contact IDs + association labels from a v4 associations response. */
function parseContactAssociations(response) {
  const rows = response && Array.isArray(response.results) ? response.results : [];
  const byId = new Map();
  for (const row of rows) {
    const id = String(row.toObjectId || row.id || '');
    if (!/^\d{1,20}$/.test(id)) continue;
    const labels = (row.associationTypes || []).map((t) => String(t.label || '').toLowerCase()).filter(Boolean);
    const existing = byId.get(id) || [];
    byId.set(id, existing.concat(labels));
  }
  return Array.from(byId.entries()).map(([id, labels]) => ({ id, labels }));
}

/**
 * Choose the primary contact for re-engagement.
 * Priority: configured association label (e.g. "Primary") > first associated.
 * Contacts are ineligible when they have no valid email, opted out of email,
 * or are already enrolled in a sequence.
 * @returns {{contact:object|null, reason:string, considered:number}}
 */
function pickPrimaryContact(associations, contactsResponse, labelPriority) {
  const records = contactsResponse && Array.isArray(contactsResponse.results) ? contactsResponse.results : [];
  const byId = new Map(records.map((c) => [String(c.id), c.properties || {}]));
  const priorities = labelPriority || [];
  const ranked = (associations || [])
    .map((a, index) => {
      const labelRank = priorities.findIndex((label) => a.labels.includes(label));
      return { id: a.id, labels: a.labels, rank: labelRank === -1 ? priorities.length : labelRank, index };
    })
    .sort((x, y) => x.rank - y.rank || x.index - y.index);

  if (ranked.length === 0) return { contact: null, reason: 'no_associated_contacts', considered: 0 };
  const reasons = [];
  for (const candidate of ranked) {
    const p = byId.get(candidate.id);
    if (!p) { reasons.push('contact_not_found'); continue; }
    const email = String(p.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) { reasons.push('missing_email'); continue; }
    if (String(p.hs_email_optout).toLowerCase() === 'true') { reasons.push('email_opted_out'); continue; }
    if (String(p.hs_sequences_is_enrolled).toLowerCase() === 'true') { reasons.push('already_in_sequence'); continue; }
    return {
      contact: { id: candidate.id, email, firstName: cleanText(p.firstname, 80), labels: candidate.labels },
      reason: candidate.rank < priorities.length ? 'label_match' : 'first_associated',
      considered: ranked.length
    };
  }
  return { contact: null, reason: 'no_eligible_contact:' + Array.from(new Set(reasons)).join('+'), considered: ranked.length };
}

/**
 * Resolve the task assignee and the sequence sender.
 * The Sequences API needs the owner's HubSpot userId and a connected sender
 * email; both come from GET /crm/v3/owners/{ownerId}.
 */
function resolveOwner(deal, ownerResponse, fallbackOwnerId) {
  const o = ownerResponse && !ownerResponse.error ? ownerResponse : null;
  const ownerLookupOk = Boolean(o && o.id && !o.archived);
  const ownerId = deal.ownerId && ownerLookupOk ? String(o.id) : (fallbackOwnerId || '');
  const source = deal.ownerId && ownerLookupOk ? 'deal_owner' : fallbackOwnerId ? 'fallback_owner' : 'unassigned';
  const userId = ownerLookupOk && o.userId !== undefined && o.userId !== null ? String(o.userId) : '';
  const senderEmail = ownerLookupOk && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(String(o.email || '')) ? String(o.email).toLowerCase() : '';
  return { ownerId, source, userId, senderEmail };
}

/* ------------------------------------------------------------------------ */
/* Revival plan                                                             */
/* ------------------------------------------------------------------------ */

function renderTemplate(template, values) {
  return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (values[key] === undefined ? '' : String(values[key])));
}

function addDaysIso(nowMs, days) {
  return new Date(nowMs + days * DAY_MS).toISOString();
}

/**
 * Build every HubSpot request for one stalled deal.
 * @returns {{dealId, stageUpdate, task, enrollment, enrollmentSkipReason, owner, contact, warnings}}
 */
function planRevival(params) {
  const p = params || {};
  const { config, candidate } = p;
  const nowMs = Number.isFinite(p.nowMs) ? p.nowMs : Date.now();
  if (!config || !candidate || !candidate.deal) throw new Error('planRevival requires config and candidate.');
  const deal = candidate.deal;
  const warnings = [];

  const stalledStageId = config.stalledStageByPipeline[deal.pipelineId] ? String(config.stalledStageByPipeline[deal.pipelineId]) : '';
  if (!stalledStageId) warnings.push('No Stalled stage mapped for pipeline ' + deal.pipelineId + '.');

  const stageProperties = { dealstage: stalledStageId };
  if (config.properties.previousStage) stageProperties[config.properties.previousStage] = deal.stageId;
  if (config.properties.stalledAt) stageProperties[config.properties.stalledAt] = new Date(nowMs).toISOString();

  const owner = resolveOwner(deal, p.ownerResponse, config.fallbackOwnerId);
  if (owner.source === 'fallback_owner') warnings.push('Deal has no active owner; task assigned to FALLBACK_OWNER_ID.');
  if (owner.source === 'unassigned') warnings.push('Deal has no active owner and no FALLBACK_OWNER_ID; task is unassigned.');

  const primary = pickPrimaryContact(parseContactAssociations(p.associationsResponse), p.contactsResponse, config.enrollment.primaryContactLabels);
  const contact = primary.contact;

  const subject = renderTemplate(config.task.subjectTemplate, { dealName: deal.name, daysInactive: candidate.daysInactive }).slice(0, 200);
  const body = [
    'This deal had no logged calls, sales emails or meetings for ' + candidate.daysInactive + ' days and was moved to the Stalled stage automatically.',
    'Previous stage ID: ' + (deal.stageId || 'unknown') + '.',
    contact ? 'Primary contact was enrolled in the low-touch re-engagement sequence (if enrollment succeeded). Personal follow-up is still recommended.' : 'No eligible primary contact for the re-engagement sequence (' + primary.reason + '). Reach out personally.',
    'Move the deal back to an active stage once re-engaged, or close it out.'
  ].join('\n');

  const taskProperties = {
    hs_timestamp: addDaysIso(nowMs, config.task.dueInDays),
    hs_task_subject: subject,
    hs_task_body: body,
    hs_task_status: 'NOT_STARTED',
    hs_task_priority: config.task.priority,
    hs_task_type: 'TODO'
  };
  if (owner.ownerId) taskProperties.hubspot_owner_id = owner.ownerId;
  const taskAssociations = [{ to: { id: deal.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: TASK_TO_DEAL_ASSOCIATION }] }];
  if (contact) taskAssociations.push({ to: { id: contact.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: TASK_TO_CONTACT_ASSOCIATION }] });

  let enrollment = null;
  let enrollmentSkipReason = '';
  if (!config.enrollment.enabled) enrollmentSkipReason = 'enrollment_disabled';
  else if (!config.enrollment.sequenceId) enrollmentSkipReason = 'sequence_id_not_configured';
  else if (!contact) enrollmentSkipReason = primary.reason;
  else if (owner.source !== 'deal_owner') enrollmentSkipReason = 'no_active_deal_owner_to_send_from';
  else if (!owner.userId || !owner.senderEmail) enrollmentSkipReason = 'owner_missing_user_id_or_email';
  else {
    enrollment = {
      method: 'POST',
      url: HUBSPOT_API + '/automation/v4/sequences/enrollments?userId=' + encodeURIComponent(owner.userId),
      body: { sequenceId: config.enrollment.sequenceId, contactId: contact.id, senderEmail: owner.senderEmail }
    };
  }

  return {
    dealId: deal.id,
    dealName: deal.name,
    pipelineId: deal.pipelineId,
    previousStageId: deal.stageId,
    daysInactive: candidate.daysInactive,
    referenceSource: candidate.referenceSource,
    stageUpdate: stalledStageId ? { method: 'PATCH', url: HUBSPOT_API + '/crm/v3/objects/deals/' + encodeURIComponent(deal.id), body: { properties: stageProperties } } : null,
    task: { method: 'POST', url: HUBSPOT_API + '/crm/v3/objects/tasks', body: { properties: taskProperties, associations: taskAssociations } },
    enrollment,
    enrollmentSkipReason,
    owner: { id: owner.ownerId, source: owner.source },
    contact: contact ? { id: contact.id, email: maskEmail(contact.email), selection: primary.reason } : null,
    warnings
  };
}

/** Did a HubSpot write succeed? Errors arrive as { error } (HTTP node continues on error). */
function isHubSpotSuccess(response) {
  const r = response || {};
  if (r.error) return false;
  if (r.status === 'error') return false;
  return Boolean(r.id) || r.status === 'COMPLETE' || Object.keys(r).length === 0 || Boolean(r.enrolledAt || r.toSequenceId);
}

/* ------------------------------------------------------------------------ */
/* Telemetry                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Final per-run report (shown in the n8n execution log). Contains IDs, counts
 * and masked emails only; never deal amounts or contact names.
 */
function buildTelemetry(params) {
  const p = params || {};
  const outcomes = p.outcomes || [];
  const count = (pred) => outcomes.filter(pred).length;
  const enrollmentSkips = {};
  for (const o of outcomes) {
    if (o.enrollmentStatus === 'skipped') enrollmentSkips[o.enrollmentSkipReason] = (enrollmentSkips[o.enrollmentSkipReason] || 0) + 1;
  }
  return {
    mode: p.sandboxMode ? 'DRY_RUN' : 'LIVE',
    generatedAt: new Date(Number.isFinite(p.nowMs) ? p.nowMs : Date.now()).toISOString(),
    thresholdDays: p.inactivityDays,
    scanned: p.scanned || 0,
    candidates: outcomes.length,
    overflowNextRun: p.overflow || 0,
    stalled: count((o) => o.stageStatus === 'moved'),
    stageFailures: count((o) => o.stageStatus === 'failed'),
    tasksCreated: count((o) => o.taskStatus === 'created'),
    taskFailures: count((o) => o.taskStatus === 'failed'),
    enrolled: count((o) => o.enrollmentStatus === 'enrolled'),
    enrollmentFailures: count((o) => o.enrollmentStatus === 'failed'),
    enrollmentSkips,
    wouldStall: count((o) => o.stageStatus === 'planned'),
    wouldEnroll: count((o) => o.enrollmentStatus === 'planned'),
    deals: outcomes.map((o) => ({
      dealId: o.dealId,
      daysInactive: o.daysInactive,
      stage: o.stageStatus,
      task: o.taskStatus,
      enrollment: o.enrollmentStatus + (o.enrollmentSkipReason ? ' (' + o.enrollmentSkipReason + ')' : ''),
      owner: o.ownerSource,
      contact: o.contactEmail || null,
      warnings: o.warnings || []
    }))
  };
}

/** Outcome record for a dry run (nothing executed). */
function dryRunOutcome(plan) {
  return {
    dealId: plan.dealId,
    daysInactive: plan.daysInactive,
    stageStatus: plan.stageUpdate ? 'planned' : 'blocked_unmapped_stage',
    taskStatus: plan.stageUpdate ? 'planned' : 'not_attempted',
    enrollmentStatus: plan.stageUpdate && plan.enrollment ? 'planned' : 'skipped',
    enrollmentSkipReason: plan.stageUpdate ? plan.enrollmentSkipReason : 'stage_not_updated',
    ownerSource: plan.owner.source,
    contactEmail: plan.contact ? plan.contact.email : '',
    warnings: plan.warnings
  };
}

module.exports = {
  DAY_MS,
  SKIP_REASON,
  DEAL_SEARCH_PROPERTIES,
  parseHubSpotTimestamp,
  daysBetween,
  maskEmail,
  buildDealSearchRequest,
  normalizeDeal,
  evaluateInactivity,
  selectInactiveDeals,
  parseContactAssociations,
  pickPrimaryContact,
  resolveOwner,
  renderTemplate,
  planRevival,
  isHubSpotSuccess,
  buildTelemetry,
  dryRunOutcome
};
