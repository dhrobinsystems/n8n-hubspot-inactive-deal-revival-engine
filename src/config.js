/**
 * n8n-hubspot-inactive-deal-revival-engine :: Environment parsing & validation (SANDBOX_MODE on by default)
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
 * Pure configuration module. Callers pass a plain env object, so the same
 * code runs in n8n Code nodes ($env) and in Node.js tests (process.env).
 */

const CONFIG_ENV_KEYS = Object.freeze([
  'SANDBOX_MODE', 'INACTIVITY_DAYS', 'ACTIVITY_PROPERTY', 'PIPELINE_IDS', 'STALLED_STAGE_BY_PIPELINE',
  'EXCLUDED_STAGE_IDS', 'MIN_DEAL_AGE_DAYS', 'MAX_DEALS_PER_RUN', 'MIN_DEAL_AMOUNT',
  'FALLBACK_OWNER_ID', 'TASK_DUE_IN_DAYS', 'TASK_PRIORITY', 'TASK_SUBJECT_TEMPLATE',
  'ENROLL_IN_SEQUENCE', 'SEQUENCE_ID', 'PRIMARY_CONTACT_LABELS',
  'PREVIOUS_STAGE_PROPERTY', 'STALLED_AT_PROPERTY'
]);

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PROPERTY_RE = /^[a-z][a-z0-9_]{0,99}$/;

function parseFlag(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return null;
}

function parseNumber(raw, fallback, min, max, name, errors) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    errors.push(name + ' must be a number between ' + min + ' and ' + max + '.');
    return fallback;
  }
  return n;
}

function parseList(raw) {
  return Array.from(new Set(String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)));
}

/** Copy known keys from an env-like source; tolerates n8n's blocked $env proxy. */
function snapshotEnv(source) {
  const env = {};
  let blocked = false;
  if (!source) return { env, blocked };
  for (const key of CONFIG_ENV_KEYS) {
    try {
      const value = source[key];
      if (value !== undefined && value !== null) env[key] = String(value);
    } catch (error) {
      blocked = true;
    }
  }
  return { env, blocked };
}

/**
 * Parse and validate configuration.
 * @returns {{config:object, errors:string[], warnings:string[], ok:boolean}}
 */
function loadConfig(env) {
  const e = env || {};
  const read = (k) => (e[k] === undefined || e[k] === null ? '' : String(e[k]).trim());
  const errors = [];
  const warnings = [];

  let sandboxMode = parseFlag(read('SANDBOX_MODE'), true);
  if (sandboxMode === null) {
    errors.push('SANDBOX_MODE must be true or false; sandbox stays ENABLED.');
    sandboxMode = true;
  }

  const activityProperty = read('ACTIVITY_PROPERTY') || 'notes_last_contacted';
  if (!PROPERTY_RE.test(activityProperty)) errors.push('ACTIVITY_PROPERTY must be a HubSpot internal property name.');

  const pipelineIds = parseList(read('PIPELINE_IDS') || 'default');
  for (const id of pipelineIds) if (!ID_RE.test(id)) errors.push('PIPELINE_IDS contains an invalid ID: ' + id);

  let stalledStageByPipeline = {};
  const rawMap = read('STALLED_STAGE_BY_PIPELINE');
  if (rawMap) {
    try {
      const parsed = JSON.parse(rawMap);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      stalledStageByPipeline = parsed;
    } catch (error) {
      errors.push('STALLED_STAGE_BY_PIPELINE must be a JSON object like {"<pipelineId>":"<stalledStageId>"}.');
    }
  }
  for (const [pipeline, stage] of Object.entries(stalledStageByPipeline)) {
    if (!ID_RE.test(pipeline) || !ID_RE.test(String(stage))) errors.push('STALLED_STAGE_BY_PIPELINE has an invalid entry for "' + pipeline + '".');
  }
  const missingStalled = pipelineIds.filter((p) => !stalledStageByPipeline[p]);
  if (!sandboxMode && missingStalled.length) {
    errors.push('STALLED_STAGE_BY_PIPELINE must define a Stalled stage for every pipeline in PIPELINE_IDS (missing: ' + missingStalled.join(', ') + ').');
  } else if (missingStalled.length) {
    warnings.push('No Stalled stage mapped for pipeline(s) ' + missingStalled.join(', ') + '; dry run will report them as unmapped.');
  }

  const excludedStageIds = parseList(read('EXCLUDED_STAGE_IDS'));
  for (const id of excludedStageIds) if (!ID_RE.test(id)) errors.push('EXCLUDED_STAGE_IDS contains an invalid ID: ' + id);

  const fallbackOwnerId = read('FALLBACK_OWNER_ID');
  if (fallbackOwnerId && !/^\d{1,20}$/.test(fallbackOwnerId)) errors.push('FALLBACK_OWNER_ID must be a numeric HubSpot owner ID.');

  const enrollInSequence = parseFlag(read('ENROLL_IN_SEQUENCE'), true);
  if (enrollInSequence === null) errors.push('ENROLL_IN_SEQUENCE must be true or false.');
  const sequenceId = read('SEQUENCE_ID');
  if (sequenceId && !/^\d{1,20}$/.test(sequenceId)) errors.push('SEQUENCE_ID must be a numeric HubSpot sequence ID.');
  if (!sandboxMode && enrollInSequence !== false && !sequenceId) errors.push('SEQUENCE_ID is required when ENROLL_IN_SEQUENCE=true and SANDBOX_MODE=false.');

  const taskPriority = (read('TASK_PRIORITY') || 'HIGH').toUpperCase();
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(taskPriority)) errors.push('TASK_PRIORITY must be LOW, MEDIUM or HIGH.');

  const optionalProperty = (key) => {
    const value = read(key);
    if (value && !PROPERTY_RE.test(value)) errors.push(key + ' must be a HubSpot internal property name.');
    return value;
  };

  if (sandboxMode) warnings.push('SANDBOX_MODE is enabled: deals are read and planned only; nothing is updated, no tasks are created, no contacts are enrolled.');

  const config = {
    sandboxMode,
    inactivityDays: parseNumber(read('INACTIVITY_DAYS'), 30, 1, 365, 'INACTIVITY_DAYS', errors),
    minDealAgeDays: parseNumber(read('MIN_DEAL_AGE_DAYS'), 30, 0, 3650, 'MIN_DEAL_AGE_DAYS', errors),
    maxDealsPerRun: parseNumber(read('MAX_DEALS_PER_RUN'), 50, 1, 200, 'MAX_DEALS_PER_RUN', errors),
    minDealAmount: parseNumber(read('MIN_DEAL_AMOUNT'), 0, 0, 1e12, 'MIN_DEAL_AMOUNT', errors),
    activityProperty,
    pipelineIds,
    stalledStageByPipeline,
    excludedStageIds,
    fallbackOwnerId,
    task: {
      dueInDays: parseNumber(read('TASK_DUE_IN_DAYS'), 2, 0, 60, 'TASK_DUE_IN_DAYS', errors),
      priority: taskPriority,
      subjectTemplate: (read('TASK_SUBJECT_TEMPLATE') || 'Revive stalled deal: {{dealName}} ({{daysInactive}} days inactive)').slice(0, 200)
    },
    enrollment: {
      enabled: enrollInSequence !== false,
      sequenceId,
      primaryContactLabels: parseList(read('PRIMARY_CONTACT_LABELS') || 'Primary,Decision Maker,Champion').map((l) => l.toLowerCase())
    },
    properties: {
      previousStage: optionalProperty('PREVIOUS_STAGE_PROPERTY'),
      stalledAt: optionalProperty('STALLED_AT_PROPERTY')
    }
  };
  return { config, errors, warnings, ok: errors.length === 0 };
}

function requireValidConfig(env) {
  const result = loadConfig(env);
  if (!result.ok) throw new Error('Invalid configuration:\n - ' + result.errors.join('\n - '));
  return result;
}

module.exports = {
  CONFIG_ENV_KEYS,
  snapshotEnv,
  loadConfig,
  requireValidConfig
};
