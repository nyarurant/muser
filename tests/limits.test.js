'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {Agent, resolveAgentLimits} = require('../src/agent');
const usage = require('../src/usage');

function tmp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-limits-')); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; }

test('agent limits: flag beats env beats ~/.muser/config.json; defaults 4 at a time, no per-task cap', t => {
  const cfg = path.join(tmp(t), 'config.json');
  assert.deepEqual(resolveAgentLimits({}, {}, cfg), {concurrent: 4, perTurn: 0});
  fs.writeFileSync(cfg, JSON.stringify({maxAgents: 2, maxAgentsTotal: 6}));
  assert.deepEqual(resolveAgentLimits({}, {}, cfg), {concurrent: 2, perTurn: 6});
  assert.deepEqual(resolveAgentLimits({}, {MUSER_MAX_AGENTS: '3', MUSER_MAX_AGENTS_TOTAL: '5'}, cfg), {concurrent: 3, perTurn: 5});
  assert.deepEqual(resolveAgentLimits({maxAgents: 1, maxAgentsTotal: 0}, {MUSER_MAX_AGENTS: '3'}, cfg), {concurrent: 1, perTurn: 0});
  assert.deepEqual(resolveAgentLimits({}, {MUSER_MAX_AGENTS: 'lots'}, cfg), {concurrent: 2, perTurn: 6}, 'invalid values are ignored');
});

function agentWith(t, limits) {
  const client = new EventEmitter(); client.status = 'connected'; client.ws = {readyState: 1};
  const cwd = tmp(t);
  const a = new Agent({client, auth: {saved: {}, vm: async () => { throw new Error('no vm'); }}, cwd,
    session: {id: 'main', cwd, title: '', created: 0, updated: 0, turns: 0}, agentLimits: limits});
  a.runTurn = async w => { if (!w.main) w.turn = {}; }; // spawned agents stay "running"; nothing goes to Muse
  return a;
}

test('spawn honours the at-a-time limit and the per-task total, which restarts with each task', async t => {
  const a = agentWith(t, {maxAgents: 2, maxAgentsTotal: 3});
  a.spawn('one'); a.spawn('two');
  assert.throws(() => a.spawn('three'), /同時に 2 つまで/);
  for (const w of a.workers.values()) if (!w.main) w.turn = null; // both finished
  a.spawn('three');
  assert.throws(() => a.spawn('four'), /この作業で起動できる並列エージェントは 3 つまで/);
  a.spawnedThisTurn = 0; // what runTurn does when the next main task starts
  for (const w of a.workers.values()) if (!w.main) w.turn = null;
  a.spawn('four');
});

test('0 means no limit', async t => {
  const a = agentWith(t, {maxAgents: 0, maxAgentsTotal: 0});
  for (let i = 0; i < 12; i++) a.spawn('task ' + i);
  assert.equal([...a.workers.values()].filter(w => !w.main).length, 12);
});

test('plan usage: the subscription line of the server action reply is read and shaped', () => {
  const reply = '0:{"a":"$@1","f":"","b":"x"}\n1:{"subscription":{"tier":{"name":"Muse Free","isPaid":false},"usage":{"state":"METERED","percentUsed":8,"resetsAt":1794044850,"quotaStatus":"SUFFICIENT"},"statusSubtitle":"Weekly limit resets on Nov 7","usageRowValueLabel":"8% used","topupRowValueLabel":"0% used (2B tokens left)","topupBalance":80000000,"topupTotal":80000000}}\n';
  const p = usage.shapePlan(usage.parseSubscription(reply));
  assert.equal(p.plan, 'Muse Free'); assert.equal(p.percentUsed, 8); assert.equal(p.resetsAt, 1794044850 * 1000);
  assert.match(usage.formatPlan(p), /Muse Free · 週の使用量 8%/);
  assert.equal(usage.parseSubscription('0:{"nothing":1}\n'), null);
});

test('plan usage: a stale cached action id is looked up again once', async t => {
  usage.resetWeb();
  const dir = tmp(t); process.env.MUSER_USAGE_FILE = path.join(dir, 'usage.json'); t.after(() => { delete process.env.MUSER_USAGE_FILE; });
  fs.writeFileSync(path.join(dir, 'subscription-action.json'), JSON.stringify({id: 'old'}));
  const good = 'a'.repeat(42), pages = {
    '/': '<script src="/_next/static/chunks/main.js"></script>',
    '/_next/static/chunks/main.js': 'x static/chunks/act.js',
    '/_next/static/chunks/act.js': '(0,r.createServerReference)("' + good + '",r.callServer,void 0,r.findSourceMapURL,"fetchSubscriptionAction")',
  };
  const calls = [];
  const web = {
    pageText: async route => { if (!(route in pages)) throw new Error('404'); return pages[route]; },
    serverAction: async id => { calls.push(id); return id === good ? {ok: true, text: '1:{"subscription":{"usage":{"percentUsed":12}}}\n'} : {ok: false, status: 404, text: ''}; },
  };
  const p = await usage.plan(web);
  assert.equal(p.percentUsed, 12);
  assert.deepEqual(calls, ['old', good]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'subscription-action.json'), 'utf8')).id, good, 'the new id is cached');
});

// A lapsed login made every read fail, and each failure crawled the site's page chunks again.
test('plan usage: a failing read crawls for the action id at most once an hour', async t => {
  usage.resetWeb();
  const dir = tmp(t); process.env.MUSER_USAGE_FILE = path.join(dir, 'usage.json'); t.after(() => { delete process.env.MUSER_USAGE_FILE; });
  fs.writeFileSync(path.join(dir, 'subscription-action.json'), JSON.stringify({id: 'cached'}));
  let crawls = 0;
  const web = {
    pageText: async route => { if (route === '/') crawls++; return route === '/' ? '<script src="/_next/static/chunks/a.js"></script>' : '(0,r.createServerReference)("' + 'b'.repeat(42) + '",r.callServer,void 0,r.findSourceMapURL,"fetchSubscriptionAction")'; },
    serverAction: async () => ({ok: false, status: 401, text: ''}), // logged out: every read fails
  };
  for (let i = 0; i < 3; i++) await assert.rejects(usage.plan(web));
  assert.equal(crawls, 1, 'crawled once, not on every read');
});

// Audit #245 (1): a temporary failure of the read must not throw away a valid cached
// id — the same id is retried once, and no crawl happens at all.
test('plan usage: a transient read failure retries the cached id instead of discarding it', async t => {
  usage.resetWeb();
  const dir = tmp(t); process.env.MUSER_USAGE_FILE = path.join(dir, 'usage.json'); t.after(() => { delete process.env.MUSER_USAGE_FILE; });
  fs.writeFileSync(path.join(dir, 'subscription-action.json'), JSON.stringify({id: 'cached'}));
  const calls = [];
  let crawls = 0;
  const web = {
    pageText: async () => { crawls++; throw new Error('must not crawl'); },
    serverAction: async id => { calls.push(id); if (calls.length === 1) throw new Error('socket reset'); return {ok: true, text: '1:{"subscription":{"usage":{"percentUsed":33}}}\n'}; },
  };
  const p = await usage.plan(web);
  assert.equal(p.percentUsed, 33);
  assert.deepEqual(calls, ['cached', 'cached'], 'the same id was retried');
  assert.equal(crawls, 0, 'no crawl was needed');
});

// Audit #245 (2): a failed action-id lookup stamps only a short retry delay, not the
// once-an-hour gate — and the hour gate never applies while a cached id exists.
test('plan usage: a failed lookup does not block a later read that has a cached id', async t => {
  usage.resetWeb();
  const dir = tmp(t); process.env.MUSER_USAGE_FILE = path.join(dir, 'usage.json'); t.after(() => { delete process.env.MUSER_USAGE_FILE; });
  const web = {
    pageText: async () => { throw new Error('site down'); },
    serverAction: async () => ({ok: true, text: '1:{"subscription":{"usage":{"percentUsed":7}}}\n'}),
  };
  await assert.rejects(usage.plan(web), /site down/, 'the lookup failure itself is reported');
  // The site recovers enough to serve the action; a cached id (written by another
  // window, say) is used at once — the failed lookup did not gate it for an hour.
  fs.writeFileSync(path.join(dir, 'subscription-action.json'), JSON.stringify({id: 'cached'}));
  const p = await usage.plan(web);
  assert.equal(p.percentUsed, 7);
});
