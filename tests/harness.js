/**
 * n8n-hubspot-inactive-deal-revival-engine :: Runs workflow.json Code nodes in a vm sandbox that emulates n8n globals
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

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function loadWorkflow() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8'));
}

function loadSample(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', name), 'utf8'));
}

function getNode(workflow, name) {
  const node = workflow.nodes.find((n) => n.name === name);
  if (!node) throw new Error('Node not found: ' + name);
  return node;
}

const accessor = (items) => ({ first: () => items[0], last: () => items[items.length - 1], all: () => items, item: items[0] });

/** Execute one Code node exactly as stored in workflow.json; output is JSON round-tripped. */
async function runCodeNode(workflow, nodeName, options) {
  const o = options || {};
  const outputs = o.nodeOutputs || {};
  const context = vm.createContext({
    $: (name) => {
      if (!outputs[name]) throw new Error('Harness: no output registered for "' + name + '"');
      return accessor(outputs[name]);
    },
    $input: accessor(o.input || [{ json: {} }]),
    $env: o.envBlocked ? new Proxy({}, { get() { throw new Error('access to env vars denied'); } }) : (o.env || {}),
    $getWorkflowStaticData: () => o.staticData || {},
    require: (m) => { throw new Error('Module not allowed: ' + m); },
    console
  });
  const fn = new vm.Script('(async function () {\n' + getNode(workflow, nodeName).parameters.jsCode + '\n})').runInContext(context);
  return JSON.parse(JSON.stringify(await fn.call({ helpers: {} })));
}

module.exports = { ROOT, loadWorkflow, loadSample, getNode, runCodeNode };
