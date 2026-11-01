'use strict';
// config.json / mcp.json saved with a BOM (Windows PowerShell's Set-Content -Encoding utf8) were
// ignored whole, and the next write moved config.json aside as corrupt.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/config');
const {resolveAgentLimits} = require('../src/agent');
const update = require('../src/update');

const BOM = String.fromCharCode(0xfeff);

test('a config.json with a BOM is read, not ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-bom-'));
  const f = path.join(dir, 'config.json');
  fs.writeFileSync(f, BOM + JSON.stringify({maxAgents: 7, maxAgentsTotal: 9, updateCheck: false}));
  assert.deepStrictEqual(config.readJson(f), {maxAgents: 7, maxAgentsTotal: 9, updateCheck: false});
  const limits = resolveAgentLimits({}, {}, f);
  assert.strictEqual(limits.concurrent, 7);
  assert.strictEqual(update.enabled({env: {}, configFile: f, root: dir}), false);
  assert.deepStrictEqual(config.parseJson(BOM + '{"a":1}'), {a: 1});
});
