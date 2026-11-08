'use strict';
// app-ux: GET /api/ui-config — the GUI theme the server hands to paired
// clients — plus its place on the channel relay allowlist. No real Muse,
// no real server: a GuiServer over stub controller/agent, like
// gui-server.test.js, and the pure builder by itself.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {GuiServer} = require('../src/gui-server');
const {buildUiConfig} = require('../src/ui-config');
const {isAllowedChannelRequest} = require('../src/link/channel-server');

test('buildUiConfig: schema 1 with the GUI theme tokens', () => {
  const cfg = buildUiConfig();
  assert.equal(cfg.schema, 1);
  // The tokens the Android RemoteUiConfig accepts (COLOR_KEYS / FONT_KEYS).
  for (const key of ['background', 'sidebar', 'panel', 'surface', 'chip', 'hover', 'selected', 'userBubble', 'text', 'muted', 'progress', 'faint', 'accent', 'pink', 'code', 'codeBackground', 'ok', 'error', 'warn', 'danger', 'diffAddBackground', 'diffAdd', 'diffRemoveBackground', 'diffRemove', 'line', 'lineSoft', 'composerActive']) {
    assert.match(cfg.colors[key] || '', /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/, key);
  }
  assert.equal(cfg.colors.accent, '#B4A0FF');
  assert.deepEqual(cfg.fontSizes, {caption: 12, small: 13, body: 15, heading: 18, lineHeightBody: 24});
});

test('GET /api/ui-config answers the theme; a missing token is refused', async (t) => {
  const agent = new EventEmitter();
  agent.cwd = 'C:\\work'; agent.session = {id: 's1'};
  const controller = {version: '9.9.9', subscribe: () => () => {}, get: () => ({entries: []})};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-uicfg-'));
  const server = new GuiServer({controller, agent, token: 'test-token', port: 0, discoveryFile: path.join(dir, 'gui.json')});
  t.after(async () => { await server.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  await server.start();
  const ok = await fetch('http://127.0.0.1:' + server.port + '/api/ui-config', {headers: {authorization: 'Bearer test-token'}});
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.schema, 1);
  assert.equal(body.colors.background, '#0E0E11');
  assert.equal(body.fontSizes.body, 15);
  const denied = await fetch('http://127.0.0.1:' + server.port + '/api/ui-config');
  assert.equal(denied.status, 401);
});

test('the channel relay allows reading the theme and nothing more', () => {
  assert.equal(isAllowedChannelRequest('GET', '/api/ui-config'), true);
  assert.equal(isAllowedChannelRequest('POST', '/api/ui-config'), false);
  assert.equal(isAllowedChannelRequest('GET', '/api/ui-config/extra'), false);
});
