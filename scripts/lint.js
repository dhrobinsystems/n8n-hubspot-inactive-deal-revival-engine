#!/usr/bin/env node
/**
 * n8n-hubspot-inactive-deal-revival-engine :: Zero-dependency lint: syntax check + repository hygiene rules
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
 * Usage: npm run lint
 * - Syntax-checks every .js file (node --check).
 * - src/ must use strict mode, must not log (console.*), must not require() npm packages.
 * - No TODO/FIXME placeholder comments in any .js file.
 * - JSON files must parse.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const problems = [];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out); else out.push(full);
  }
  return out;
}

for (const file of walk(ROOT, [])) {
  const rel = path.relative(ROOT, file);
  if (file.endsWith('.js')) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (error) {
      problems.push(rel + ': syntax error\n' + String(error.stderr || error.message));
    }
    const text = fs.readFileSync(file, 'utf8');
    // Only placeholders in comments count (HubSpot's task type value 'TODO' is legitimate data).
    if (/(\/\/|\/\*|^\s*\*)\s*(TODO|FIXME)\b/m.test(text) && !rel.endsWith('lint.js')) problems.push(rel + ': contains a TODO/FIXME comment.');
    if (rel.startsWith('src' + path.sep)) {
      if (!/['"]use strict['"]/.test(text)) problems.push(rel + ': missing "use strict".');
      if (/\bconsole\.(log|info|debug)\(/.test(text)) problems.push(rel + ': console logging is not allowed in src/.');
      if (/\brequire\s*\(\s*['"](?!\.)/.test(text)) problems.push(rel + ': src/ must not require npm/builtin modules.');
    }
  }
  if (file.endsWith('.json')) {
    try {
      JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      problems.push(rel + ': invalid JSON (' + error.message + ').');
    }
  }
}

if (problems.length) {
  console.error('\u2716 Lint failed:\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log('\u2714 Lint passed.');
