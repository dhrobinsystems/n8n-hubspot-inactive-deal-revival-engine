/**
 * n8n-hubspot-inactive-deal-revival-engine :: workflow.json integrity, sandbox gating and Code-node execution
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
const { runChecks, reachableInSandbox } = require('../scripts/build-workflow');
const { ROOT, loadWorkflow, loadSample, getNode, runCodeNode } = require('./harness');

const wf = loadWorkflow();
const SANDBOX = { SANDBOX_MODE: 'true', STALLED_STAGE_BY_PIPELINE: '{"default":"stalled_stage_placeholder"}', SEQUENCE_ID: '123456' };
const LIVE = Object.assign({}, SANDBOX, { SANDBOX_MODE: 'false', FALLBACK_OWNER_ID: '999' });

test('workflow: repository checks pass (sync, credentials, secrets, sandbox gates)', () => {
  assert.deepEqual(runChecks(), []);
});

test('workflow: required node types are present and the workflow ships inactive', () => {
  assert.equal(wf.active, false);
  const types = wf.nodes.map((n) => n.type);
  assert.ok(types.includes('n8n-nodes-base.scheduleTrigger'));
  assert.ok(types.includes('n8n-nodes-base.manualTrigger'));
  for (const name of ['HubSpot: Search Inactive Deals', 'Validate Inactivity Thresholds', 'HubSpot: Move Deal to Stalled', 'HubSpot: Create Rep Task', 'HubSpot: Enroll Primary Contact']) getNode(wf, name);
  for (const cred of wf.nodes.flatMap((n) => Object.values(n.credentials || {}))) assert.equal(cred.id, 'REPLACE_WITH_YOUR_CREDENTIAL_ID');
  assert.match(getNode(wf, 'Disclaimer').parameters.content, /No Liability[\s\S]*No Warranty[\s\S]*Production Testing Required[\s\S]*Third-Party APIs/);
});

test('workflow: no CRM write is reachable in sandbox; removing the gate is detected', () => {
  const { seen } = reachableInSandbox(wf);
  for (const name of ['HubSpot: Move Deal to Stalled', 'HubSpot: Create Rep Task', 'HubSpot: Enroll Primary Contact']) assert.ok(!seen.has(name), name);
  const tampered = JSON.parse(JSON.stringify(wf));
  getNode(tampered, 'Live Mode?').notes = 'removed';
  assert.ok(runChecks(tampered).some((e) => /No \[sandbox-gate\]/.test(e)));
});

test('nodes: search builder, validator, empty-result path', async () => {
  const built = await runCodeNode(wf, 'Build Deal Search', { env: SANDBOX });
  assert.equal(built[0].json.request.body.filterGroups.length, 2);
  const validated = await runCodeNode(wf, 'Validate Inactivity Thresholds', { env: SANDBOX, input: [{ json: loadSample('hubspot-deal-search.example.json') }] });
  assert.ok(validated.every((i) => i.json.candidate && i.json.meta.scanned === 5));
  const empty = await runCodeNode(wf, 'Validate Inactivity Thresholds', { env: SANDBOX, input: [{ json: { results: [] } }] });
  assert.equal(empty[0].json.__empty, true);
  await assert.rejects(runCodeNode(wf, 'Validate Inactivity Thresholds', { env: SANDBOX, input: [{ json: { error: { message: '401 Unauthorized' } } }] }), /deal search failed/);
});

async function planned(env, ownerResponse) {
  const candidate = { deal: { id: '1001', name: 'Sample Co - Platform Expansion', stageId: 'presentationscheduled', pipelineId: 'default', ownerId: '501', amount: 25000, isClosed: false, createdAtMs: Date.UTC(2026, 5, 1), lastActivityMs: Date.UTC(2026, 8, 20) }, eligible: true, reason: 'inactive', daysInactive: 53, referenceSource: 'last_activity' };
  const loopItem = [{ json: { candidate } }];
  const lookup = await runCodeNode(wf, 'Prepare Contact & Owner Lookup', { input: [{ json: loadSample('hubspot-deal-contacts.example.json') }], nodeOutputs: { 'Loop Over Stalled Deals': loopItem } });
  assert.deepEqual(lookup[0].json.contactInputs, [{ id: '2001' }, { id: '2002' }, { id: '2003' }]);
  return runCodeNode(wf, 'Plan Revival Actions', {
    env,
    input: [{ json: ownerResponse }],
    nodeOutputs: {
      'Prepare Contact & Owner Lookup': lookup,
      'HubSpot: Get Deal Contacts': [{ json: loadSample('hubspot-deal-contacts.example.json') }],
      'HubSpot: Batch Read Contacts': [{ json: loadSample('hubspot-contacts-batch.example.json') }]
    }
  });
}

test('sandbox path: plan -> dry-run outcome -> telemetry', async () => {
  const plan = await planned(SANDBOX, loadSample('hubspot-owner.example.json'));
  assert.equal(plan[0].json.mode, 'sandbox');
  const outcome = await runCodeNode(wf, 'Record Dry-Run Outcome', { input: plan });
  assert.deepEqual([outcome[0].json.stageStatus, outcome[0].json.enrollmentStatus], ['planned', 'planned']);
  const validated = [{ json: { meta: { scanned: 5, overflow: 0 } } }];
  const telemetry = await runCodeNode(wf, 'Run Telemetry', { env: SANDBOX, input: outcome, nodeOutputs: { 'Validate Inactivity Thresholds': validated } });
  assert.deepEqual([telemetry[0].json.mode, telemetry[0].json.wouldStall, telemetry[0].json.wouldEnroll], ['DRY_RUN', 1, 1]);
  await assert.rejects(runCodeNode(wf, 'Assert Live Mode', { env: SANDBOX, input: plan }), /Safety stop/);
});

test('live path: stage -> task -> enrollment state is carried explicitly between steps', async () => {
  const plan = await planned(LIVE, loadSample('hubspot-owner.example.json'));
  const afterStage = await runCodeNode(wf, 'After Stage Update', { input: [{ json: { id: '1001' } }], nodeOutputs: { 'Plan Revival Actions': plan } });
  assert.equal(afterStage[0].json.outcome.stageStatus, 'moved');
  const afterTask = await runCodeNode(wf, 'After Task', { input: [{ json: { id: 't-1' } }], nodeOutputs: { 'After Stage Update': afterStage } });
  assert.deepEqual([afterTask[0].json.outcome.taskStatus, afterTask[0].json.outcome.enrollmentStatus], ['created', 'pending']);
  const enrolled = await runCodeNode(wf, 'After Enrollment', { input: [{ json: { id: 'enr-1', toSequenceId: '123456' } }], nodeOutputs: { 'After Task': afterTask } });
  assert.equal(enrolled[0].json.enrollmentStatus, 'enrolled');
  const failed = await runCodeNode(wf, 'After Enrollment', { input: [{ json: { error: { message: 'sender inbox not connected' } } }], nodeOutputs: { 'After Task': afterTask } });
  assert.equal(failed[0].json.enrollmentStatus, 'failed');
  assert.ok(failed[0].json.warnings.some((w) => /sender inbox/.test(w)));
});

test('live path: failed stage update stops the task and enrollment for that deal', async () => {
  const plan = await planned(LIVE, loadSample('hubspot-owner.example.json'));
  const afterStage = await runCodeNode(wf, 'After Stage Update', { input: [{ json: { status: 'error', message: 'Invalid stage' } }], nodeOutputs: { 'Plan Revival Actions': plan } });
  assert.deepEqual([afterStage[0].json.outcome.stageStatus, afterStage[0].json.outcome.taskStatus, afterStage[0].json.outcome.enrollmentSkipReason], ['failed', 'not_attempted', 'stage_not_updated']);
  const finalized = await runCodeNode(wf, 'Finalize Without Enrollment', { input: afterStage });
  assert.equal(finalized[0].json.dealId, '1001');
});

test('live path: missing owner falls back for the task and skips enrollment', async () => {
  const plan = await planned(LIVE, { error: { message: 'Owner not found' } });
  assert.equal(plan[0].json.plan.task.body.properties.hubspot_owner_id, '999');
  assert.equal(plan[0].json.plan.enrollment, null);
});

test('repository: README embeds the disclaimer; LICENSE matches the required text; env template is safe', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const disclaimer = fs.readFileSync(path.join(ROOT, 'DISCLAIMER.md'), 'utf8').split('\n## License')[0].split('\n').slice(2).join('\n').trim();
  assert.ok(readme.includes(disclaimer));
  assert.match(fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8'), /^MIT License\n\nCopyright \(c\) 2026 DH Robin \(dhrobinsystems\.com\)\n/);
  const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.match(env, /^SANDBOX_MODE=true$/m);
  assert.match(env, /^INACTIVITY_DAYS=30$/m);
});
