/**
 * n8n-hubspot-inactive-deal-revival-engine :: Unit tests: thresholds, owner fallbacks, contact selection, multi-object payloads
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

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const engine = require('../src/inactiveDealEngine');
const { loadConfig, snapshotEnv } = require('../src/config');

const DAY = engine.DAY_MS;
const NOW = Date.UTC(2026, 10, 13); // 2026-11-13T00:00:00Z, matches samples/
const sample = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', name), 'utf8'));
const LIVE = {
  SANDBOX_MODE: 'false',
  PIPELINE_IDS: 'default',
  STALLED_STAGE_BY_PIPELINE: '{"default":"stalled_stage_placeholder"}',
  SEQUENCE_ID: '123456',
  FALLBACK_OWNER_ID: '999'
};
const cfg = (extra) => loadConfig(Object.assign({}, LIVE, extra || {})).config;
const deal = (extra) => Object.assign({ id: '1', name: 'Deal', stageId: 'qualifiedtobuy', pipelineId: 'default', ownerId: '501', amount: 1000, isClosed: false, createdAtMs: NOW - 120 * DAY, lastActivityMs: NOW - 45 * DAY }, extra || {});

/* ---------------------------------------------------------------- config */

test('config: sandbox is the default and garbage values keep it on', () => {
  assert.equal(loadConfig({}).config.sandboxMode, true);
  const bad = loadConfig({ SANDBOX_MODE: 'nope' });
  assert.equal(bad.config.sandboxMode, true);
  assert.equal(bad.ok, false);
});

test('config: live mode requires a Stalled stage per pipeline and a sequence ID', () => {
  const errors = loadConfig({ SANDBOX_MODE: 'false', PIPELINE_IDS: 'default,enterprise_pipeline', STALLED_STAGE_BY_PIPELINE: '{"default":"s1"}' }).errors.join('\n');
  assert.match(errors, /missing: enterprise_pipeline/);
  assert.match(errors, /SEQUENCE_ID is required/);
  assert.deepEqual(loadConfig(LIVE).errors, []);
  assert.deepEqual(loadConfig(Object.assign({}, LIVE, { SEQUENCE_ID: '', ENROLL_IN_SEQUENCE: 'false' })).errors, []);
});

test('config: malformed JSON map, IDs, priority and property names are rejected', () => {
  assert.ok(loadConfig({ STALLED_STAGE_BY_PIPELINE: '[1,2]' }).errors.some((e) => /JSON object/.test(e)));
  assert.ok(loadConfig({ FALLBACK_OWNER_ID: 'rep@example.com' }).errors.some((e) => /FALLBACK_OWNER_ID/.test(e)));
  assert.ok(loadConfig({ TASK_PRIORITY: 'URGENT' }).errors.some((e) => /TASK_PRIORITY/.test(e)));
  assert.ok(loadConfig({ PREVIOUS_STAGE_PROPERTY: 'Bad Name' }).errors.some((e) => /PREVIOUS_STAGE_PROPERTY/.test(e)));
  assert.ok(loadConfig({ INACTIVITY_DAYS: '0' }).errors.some((e) => /INACTIVITY_DAYS/.test(e)));
});

test('config: blocked $env access falls back to sandbox defaults', () => {
  const snap = snapshotEnv(new Proxy({}, { get() { throw new Error('denied'); } }));
  assert.equal(snap.blocked, true);
  assert.equal(loadConfig(snap.env).config.sandboxMode, true);
});

/* ------------------------------------------------------------ thresholds */

test('threshold: exactly 30 days is still active; 30 days + 1 ms is inactive', () => {
  const c = cfg();
  assert.equal(engine.evaluateInactivity(deal({ lastActivityMs: NOW - 30 * DAY }), c, NOW).reason, 'recent_activity');
  const v = engine.evaluateInactivity(deal({ lastActivityMs: NOW - 30 * DAY - 1 }), c, NOW);
  assert.equal(v.eligible, true);
  assert.equal(v.daysInactive, 30);
});

test('threshold: custom INACTIVITY_DAYS is honoured', () => {
  const c = cfg({ INACTIVITY_DAYS: '14' });
  assert.equal(engine.evaluateInactivity(deal({ lastActivityMs: NOW - 15 * DAY }), c, NOW).eligible, true);
  assert.equal(engine.evaluateInactivity(deal({ lastActivityMs: NOW - 10 * DAY }), c, NOW).eligible, false);
});

test('threshold: never-contacted deals use createdate as the reference', () => {
  const v = engine.evaluateInactivity(deal({ lastActivityMs: null, createdAtMs: NOW - 40 * DAY }), cfg(), NOW);
  assert.deepEqual([v.eligible, v.referenceSource, v.daysInactive], [true, 'created_never_contacted', 40]);
  assert.equal(engine.evaluateInactivity(deal({ lastActivityMs: null, createdAtMs: NOW - 10 * DAY }), cfg(), NOW).reason, 'recent_activity');
});

test('threshold: closed, stalled, excluded, out-of-scope and invalid deals are skipped', () => {
  const c = cfg({ EXCLUDED_STAGE_IDS: 'contractsent' });
  assert.equal(engine.evaluateInactivity(deal({ isClosed: true }), c, NOW).reason, 'deal_closed');
  assert.equal(engine.evaluateInactivity(deal({ stageId: 'stalled_stage_placeholder' }), c, NOW).reason, 'already_in_stalled_stage');
  assert.equal(engine.evaluateInactivity(deal({ stageId: 'contractsent' }), c, NOW).reason, 'excluded_stage');
  assert.equal(engine.evaluateInactivity(deal({ pipelineId: 'other' }), c, NOW).reason, 'pipeline_out_of_scope');
  assert.equal(engine.evaluateInactivity(deal({ lastActivityMs: null, createdAtMs: null }), c, NOW).reason, 'invalid_activity_and_create_dates');
  assert.equal(engine.evaluateInactivity(deal({ lastActivityMs: NOW + 10 * DAY }), c, NOW).reason, 'invalid_activity_and_create_dates');
  assert.equal(engine.evaluateInactivity(deal({ id: '' }), c, NOW).reason, 'missing_deal_id');
});

test('threshold: minimum deal age and minimum amount guards', () => {
  assert.equal(engine.evaluateInactivity(deal({ createdAtMs: NOW - 20 * DAY, lastActivityMs: NOW - 45 * DAY }), cfg({ MIN_DEAL_AGE_DAYS: '30' }), NOW).reason, 'deal_too_new');
  assert.equal(engine.evaluateInactivity(deal({ amount: 500 }), cfg({ MIN_DEAL_AMOUNT: '1000' }), NOW).reason, 'below_min_amount');
  assert.equal(engine.evaluateInactivity(deal({ amount: null }), cfg({ MIN_DEAL_AMOUNT: '1000' }), NOW).reason, 'below_min_amount');
});

test('dates: ISO strings, epoch-millisecond strings and garbage', () => {
  assert.equal(engine.parseHubSpotTimestamp('2026-11-13T00:00:00.000Z'), NOW);
  assert.equal(engine.parseHubSpotTimestamp(String(NOW)), NOW);
  assert.equal(engine.parseHubSpotTimestamp('not-a-date'), null);
  assert.equal(engine.parseHubSpotTimestamp(''), null);
  assert.equal(engine.daysBetween(NOW - 29.9 * DAY, NOW), 29);
});

/* ------------------------------------------------------- search & payloads */

test('search request: open deals, scoped pipelines, Stalled/excluded stages removed, two filter groups', () => {
  const req = engine.buildDealSearchRequest(cfg({ EXCLUDED_STAGE_IDS: 'contractsent', MAX_DEALS_PER_RUN: '200' }), NOW);
  assert.equal(req.url, 'https://api.hubapi.com/crm/v3/objects/deals/search');
  const [contacted, never] = req.body.filterGroups;
  assert.deepEqual(contacted.filters[0], { propertyName: 'pipeline', operator: 'IN', values: ['default'] });
  assert.deepEqual(contacted.filters[1], { propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' });
  assert.deepEqual(contacted.filters[2].values, ['stalled_stage_placeholder', 'contractsent']);
  assert.deepEqual(contacted.filters[3], { propertyName: 'notes_last_contacted', operator: 'LT', value: String(NOW - 30 * DAY) });
  assert.deepEqual(never.filters.slice(-2), [{ propertyName: 'notes_last_contacted', operator: 'NOT_HAS_PROPERTY' }, { propertyName: 'createdate', operator: 'LT', value: String(NOW - 30 * DAY) }]);
  assert.equal(req.body.limit, 200, 'HubSpot search pages are capped at 200');
  assert.ok(loadConfig({ MAX_DEALS_PER_RUN: '500' }).errors.some((e) => /MAX_DEALS_PER_RUN/.test(e)), 'values above the API page limit are rejected');
  assert.ok(req.body.filterGroups.every((g) => g.filters.length <= 6), 'within HubSpot per-group filter limit');
});

test('multi-object payload: search response is normalised, de-duplicated and re-validated', () => {
  const { candidates, skipped, totalAvailable } = engine.selectInactiveDeals(sample('hubspot-deal-search.example.json'), cfg(), NOW);
  assert.deepEqual(candidates.map((c) => [c.deal.id, c.daysInactive, c.referenceSource]), [['1002', 103, 'created_never_contacted'], ['1001', 53, 'last_activity']]);
  assert.deepEqual(skipped.map((s) => [s.dealId, s.reason]), [['1003', 'recent_activity'], ['1004', 'deal_closed']]);
  assert.equal(totalAvailable, 5);
  assert.equal(candidates[0].deal.ownerId, '', 'blank owner normalised to empty');
});

test('multi-object payload: batch cap and overflow reporting', () => {
  const results = Array.from({ length: 7 }, (_, i) => ({ id: String(100 + i), properties: { dealname: 'D' + i, dealstage: 's', pipeline: 'default', hs_is_closed: 'false', createdate: new Date(NOW - 400 * DAY).toISOString(), notes_last_contacted: new Date(NOW - (40 + i) * DAY).toISOString() } }));
  const out = engine.selectInactiveDeals({ results }, cfg({ MAX_DEALS_PER_RUN: '3' }), NOW);
  assert.deepEqual(out.candidates.map((c) => c.deal.id), ['106', '105', '104']);
  assert.equal(out.overflow, 4);
  assert.deepEqual(engine.selectInactiveDeals(null, cfg(), NOW).candidates, []);
});

test('normalizeDeal: strips control characters and handles flat objects', () => {
  const d = engine.normalizeDeal({ id: '5', properties: { dealname: 'Bad\u0000Name\n', hubspot_owner_id: 'abc', amount: '1,500' } });
  assert.equal(d.name, 'Bad Name');
  assert.equal(d.ownerId, '');
  assert.equal(d.amount, 1500);
  assert.equal(engine.normalizeDeal({ id: '6', dealname: 'Flat' }).name, 'Flat');
});

/* --------------------------------------------------- contacts & owners */

test('contacts: association labels pick the primary contact; opted-out contacts are never chosen', () => {
  const assoc = engine.parseContactAssociations(sample('hubspot-deal-contacts.example.json'));
  assert.deepEqual(assoc.map((a) => a.id), ['2001', '2002', '2003']);
  const picked = engine.pickPrimaryContact(assoc, sample('hubspot-contacts-batch.example.json'), ['primary', 'decision maker']);
  assert.deepEqual([picked.contact.id, picked.reason], ['2002', 'label_match']);
  const onlyOptedOut = engine.pickPrimaryContact([{ id: '2003', labels: [] }], sample('hubspot-contacts-batch.example.json'), []);
  assert.equal(onlyOptedOut.contact, null);
  assert.match(onlyOptedOut.reason, /email_opted_out/);
});

test('contacts: falls back to the first eligible contact; skips missing emails and active enrollments', () => {
  const contacts = { results: [
    { id: '1', properties: { email: '', hs_email_optout: 'false' } },
    { id: '2', properties: { email: 'busy@example.com', hs_sequences_is_enrolled: 'true' } },
    { id: '3', properties: { email: 'ok@example.org' } }
  ] };
  const picked = engine.pickPrimaryContact([{ id: '1', labels: [] }, { id: '2', labels: [] }, { id: '3', labels: [] }], contacts, ['primary']);
  assert.deepEqual([picked.contact.id, picked.reason], ['3', 'first_associated']);
  assert.equal(engine.pickPrimaryContact([], contacts, []).reason, 'no_associated_contacts');
  assert.match(engine.pickPrimaryContact([{ id: '9', labels: [] }], contacts, []).reason, /contact_not_found/);
});

test('owners: active deal owner, fallback owner, and fully unassigned', () => {
  const owner = sample('hubspot-owner.example.json');
  assert.deepEqual(engine.resolveOwner(deal(), owner, '999'), { ownerId: '501', source: 'deal_owner', userId: '9001', senderEmail: 'rep.one@example.com' });
  assert.equal(engine.resolveOwner(deal({ ownerId: '' }), { error: { message: '404' } }, '999').source, 'fallback_owner');
  assert.equal(engine.resolveOwner(deal(), Object.assign({}, owner, { archived: true }), '999').source, 'fallback_owner');
  assert.deepEqual(engine.resolveOwner(deal({ ownerId: '' }), null, ''), { ownerId: '', source: 'unassigned', userId: '', senderEmail: '' });
});

/* ------------------------------------------------------------- planning */

function planFor(dealOverrides, configOverrides, ownerResponse) {
  const c = cfg(configOverrides);
  const candidate = Object.assign({ deal: deal(dealOverrides) }, engine.evaluateInactivity(deal(dealOverrides), c, NOW));
  return engine.planRevival({
    config: c,
    candidate,
    associationsResponse: sample('hubspot-deal-contacts.example.json'),
    contactsResponse: sample('hubspot-contacts-batch.example.json'),
    ownerResponse: ownerResponse === undefined ? sample('hubspot-owner.example.json') : ownerResponse,
    nowMs: NOW
  });
}

test('plan: stage update, owner task and sequence enrollment for a healthy case', () => {
  const plan = planFor({}, { PREVIOUS_STAGE_PROPERTY: 'revival_previous_stage', STALLED_AT_PROPERTY: 'revival_stalled_at' });
  assert.deepEqual(plan.stageUpdate.body.properties, { dealstage: 'stalled_stage_placeholder', revival_previous_stage: 'qualifiedtobuy', revival_stalled_at: '2026-11-13T00:00:00.000Z' });
  const t = plan.task.body;
  assert.equal(t.properties.hubspot_owner_id, '501');
  assert.equal(t.properties.hs_timestamp, '2026-11-15T00:00:00.000Z');
  assert.equal(t.properties.hs_task_subject, 'Revive stalled deal: Deal (45 days inactive)');
  assert.deepEqual(t.associations.map((a) => a.types[0].associationTypeId), [216, 204]);
  assert.equal(plan.enrollment.url, 'https://api.hubapi.com/automation/v4/sequences/enrollments?userId=9001');
  assert.deepEqual(plan.enrollment.body, { sequenceId: '123456', contactId: '2002', senderEmail: 'rep.one@example.com' });
  assert.equal(plan.contact.email, 'j***@example.org', 'telemetry only carries masked emails');
});

test('plan: missing owner -> task goes to FALLBACK_OWNER_ID, enrollment skipped (no sender)', () => {
  const plan = planFor({ ownerId: '' }, {}, { error: { message: 'Not found' } });
  assert.equal(plan.task.body.properties.hubspot_owner_id, '999');
  assert.equal(plan.enrollment, null);
  assert.equal(plan.enrollmentSkipReason, 'no_active_deal_owner_to_send_from');
  assert.ok(plan.warnings.some((w) => /FALLBACK_OWNER_ID/.test(w)));
});

test('plan: no owner and no fallback -> unassigned task with a warning', () => {
  const plan = planFor({ ownerId: '' }, { FALLBACK_OWNER_ID: '' }, null);
  assert.equal(plan.task.body.properties.hubspot_owner_id, undefined);
  assert.ok(plan.warnings.some((w) => /unassigned/.test(w)));
});

test('plan: unmapped pipeline blocks the stage move; enrollment toggles are respected', () => {
  const c = loadConfig({ SANDBOX_MODE: 'true', PIPELINE_IDS: 'default', SEQUENCE_ID: '1' }).config;
  const candidate = Object.assign({ deal: deal() }, engine.evaluateInactivity(deal(), c, NOW));
  const plan = engine.planRevival({ config: c, candidate, nowMs: NOW });
  assert.equal(plan.stageUpdate, null);
  assert.ok(plan.warnings.some((w) => /No Stalled stage/.test(w)));
  assert.equal(engine.dryRunOutcome(plan).stageStatus, 'blocked_unmapped_stage');
  assert.equal(planFor({}, { ENROLL_IN_SEQUENCE: 'false' }).enrollmentSkipReason, 'enrollment_disabled');
  assert.throws(() => engine.planRevival({}), /requires config and candidate/);
});

test('plan: owner without userId/email cannot send a sequence', () => {
  const plan = planFor({}, {}, { id: '501', archived: false, email: '' });
  assert.equal(plan.enrollmentSkipReason, 'owner_missing_user_id_or_email');
});

/* ---------------------------------------------------- success & telemetry */

test('isHubSpotSuccess: n8n error objects and HubSpot error bodies are failures', () => {
  assert.equal(engine.isHubSpotSuccess({ id: '1' }), true);
  assert.equal(engine.isHubSpotSuccess({}), true);
  assert.equal(engine.isHubSpotSuccess({ error: { message: '400' } }), false);
  assert.equal(engine.isHubSpotSuccess({ status: 'error', message: 'Property values were not valid' }), false);
});

test('telemetry: dry-run counts, live counts, masked contacts and skip reasons', () => {
  const plan = planFor({});
  const dry = engine.buildTelemetry({ outcomes: [engine.dryRunOutcome(plan)], sandboxMode: true, inactivityDays: 30, scanned: 5, overflow: 0, nowMs: NOW });
  assert.deepEqual([dry.mode, dry.wouldStall, dry.wouldEnroll, dry.stalled], ['DRY_RUN', 1, 1, 0]);
  const live = engine.buildTelemetry({
    outcomes: [
      { dealId: '1', stageStatus: 'moved', taskStatus: 'created', enrollmentStatus: 'enrolled', ownerSource: 'deal_owner', contactEmail: 'j***@example.com' },
      { dealId: '2', stageStatus: 'moved', taskStatus: 'failed', enrollmentStatus: 'skipped', enrollmentSkipReason: 'email_opted_out', ownerSource: 'fallback_owner' },
      { dealId: '3', stageStatus: 'failed', taskStatus: 'not_attempted', enrollmentStatus: 'skipped', enrollmentSkipReason: 'stage_not_updated', ownerSource: 'deal_owner' }
    ],
    sandboxMode: false,
    inactivityDays: 30,
    nowMs: NOW
  });
  assert.deepEqual([live.mode, live.stalled, live.stageFailures, live.tasksCreated, live.taskFailures, live.enrolled], ['LIVE', 2, 1, 1, 1, 1]);
  assert.deepEqual(live.enrollmentSkips, { email_opted_out: 1, stage_not_updated: 1 });
  assert.ok(!JSON.stringify(live).includes('jane'), 'no raw emails or names in telemetry');
});

test('helpers: email masking and template rendering', () => {
  assert.equal(engine.maskEmail('jane.doe@example.com'), 'j***@example.com');
  assert.equal(engine.maskEmail(''), '');
  assert.equal(engine.renderTemplate('{{dealName}} - {{ daysInactive }}d {{missing}}', { dealName: 'X', daysInactive: 31 }), 'X - 31d ');
});
