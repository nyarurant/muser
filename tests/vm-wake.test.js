'use strict';
// A Muse VM that muse.ai suspended after idling makes the chat gateway answer 502 on every
// connect; restarting muser did not help (a user's report, reproduced on our account 3:
// /api/session vm_state SUSPENDED, wss .../v1/noise 502). muse.ai's page wakes it with
// POST /api/hatch/vm/wake; muser now does the same once and connects again.
const test = require('node:test');
const assert = require('node:assert');
const {wakeVm} = require('../src/session.js');
const {MuseClient} = require('../src/core/muse-client.js');

function fakeWeb(states, {wakeFails = false} = {}) {
  const calls = [];
  let i = 0;
  return {
    calls,
    fetchJson: async route => { calls.push('GET ' + route); const st = states[Math.min(i++, states.length - 1)]; return {vm_id: 'vm-1', vm_state: st}; },
    postJson: async (route, body) => { calls.push('POST ' + route + ' ' + JSON.stringify(body)); if (wakeFails) throw Object.assign(new Error('x'), {status: 400}); return {status: 'wake_requested'}; },
  };
}
const fast = {waitMs: 30, pollMs: 10, sleep: async () => {}};

test('a suspended VM is woken with its id and waited for until RUNNING', async () => {
  const web = fakeWeb(['SUSPENDED', 'SUSPENDED', 'RUNNING']);
  assert.equal(await wakeVm(web, fast), true);
  assert.ok(web.calls.includes('POST /api/hatch/vm/wake {"vm_id":"vm-1","retry_count":0}'), web.calls.join('\n'));
});

test('a running VM needs no wake', async () => {
  const web = fakeWeb(['RUNNING']);
  assert.equal(await wakeVm(web, fast), true);
  assert.ok(!web.calls.some(c => c.startsWith('POST')));
});

test('an updating VM is waited out without a wake request', async () => {
  const web = fakeWeb(['UPDATING', 'UPDATING', 'RUNNING']);
  assert.equal(await wakeVm(web, fast), true);
  assert.ok(!web.calls.some(c => c.startsWith('POST')));
});

test('a refused wake, a VM that never comes up, or another state gives false', async () => {
  assert.equal(await wakeVm(fakeWeb(['SUSPENDED'], {wakeFails: true}), fast), false);
  assert.equal(await wakeVm(fakeWeb(['SUSPENDED']), fast), false);
  assert.equal(await wakeVm(fakeWeb(['STOPPED']), fast), false);
});

test('the client wakes the VM once on a gateway 502 and connects again', async () => {
  let opens = 0, wakes = 0;
  const c = new MuseClient({credentials: {}, fetchJson: async () => ({}), wakeVm: async () => { wakes++; return true; }});
  c.open = async () => { opens++; if (opens === 1) throw Object.assign(new Error('HTTP 502'), {status: 502}); return 'ok'; };
  assert.equal(await c.connect(), 'ok');
  assert.equal(opens, 2); assert.equal(wakes, 1);
});

test('no wake for an auth failure or a failed wake; the original error stays', async () => {
  for (const [status, woke] of [[401, true], [502, false]]) {
    let wakes = 0;
    const c = new MuseClient({credentials: {}, fetchJson: async () => ({}), wakeVm: async () => { wakes++; return woke; }});
    c.open = async () => { throw Object.assign(new Error('E' + status), {status}); };
    await assert.rejects(c.connect(), new RegExp('E' + status));
    assert.equal(wakes, status === 401 ? 0 : 1);
  }
});

test('postJson sends the wake body as one JSON object, not a JSON string (real 400 on 2026-11-09)', async () => {
  const {createWeb} = require('../src/web.js');
  const realFetch = global.fetch;
  let seen = null;
  global.fetch = async (url, opts) => { seen = {url: String(url), opts}; return new Response('{"status":"wake_requested"}', {status: 200, headers: {'content-type': 'application/json'}}); };
  try {
    const web = createWeb([], {file: require('node:path').join(require('node:os').tmpdir(), 'muser-vmwake-jar-' + process.pid + '.enc')});
    const r = await web.postJson('/api/hatch/vm/wake', {vm_id: 'vm-1', retry_count: 0});
    assert.deepEqual(r, {status: 'wake_requested'});
    assert.equal(seen.url, 'https://muse.ai/api/hatch/vm/wake');
    assert.equal(seen.opts.method, 'POST');
    assert.deepEqual(JSON.parse(seen.opts.body), {vm_id: 'vm-1', retry_count: 0}, 'the body parses to the object itself');
    assert.equal(seen.opts.headers['Content-Type'], 'application/json');
  } finally { global.fetch = realFetch; }
});
