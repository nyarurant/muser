'use strict';
// audit-cli wave 2 (defects) regressions: the focus fixes in 679e4eb and the
// tell fixes in 6bc56f4. Style follows tests/focusfix-core.test.js (direct
// Focus drives) and tests/tell.test.js (isolated home, explicit tell base).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w2-test-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w2-test-home-'));

const {Focus} = require('../src/focus');
const tell = require('../src/tell');

const insp = [{text: 'Source satisfies the requested behavior', kind: 'inspection'}];
const read = p => ({command: 'code.read', kind: 'read', params: {path: p}, summary: p});
const run = (cmd, extra = {}) => ({command: 'system.run', kind: 'exec', params: {command: cmd, ...extra}, summary: cmd});
const exit = code => ({ok: true, payload: {exit_code: code}});
const met = (id, evidence = []) => ({id, status: 'met', evidence, reason: 'observed'});
const bgOut = (id, code) => ({command: 'shell.output', kind: 'read', params: {shell_id: id}, summary: id});
const bgResult = (id, code) => ({ok: true, payload: {id, running: false, exit_code: code, backgroundResult: {id, running: false, exit_code: code}}});

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w2-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

// ---------- focus (679e4eb) ----------

test('w2 focus D1: plan append never duplicates an existing criterion', () => {
  const A = {text: 'Alpha done', kind: 'inspection'};
  const B = {text: 'Tests pass', kind: 'command', command: 'npm test'};
  const C = {text: 'Gamma done', kind: 'inspection'};
  const f = new Focus('Task'); f.beginRound();
  f.plan([A, B]);
  // Old-style append: the caller repeats the whole recorded list. Those repeats
  // are the criteria themselves, not new ones.
  f.plan([A, B], {append: true});
  assert.deepEqual(f.criteria.map(c => c.id + ':' + c.text), ['c1:Alpha done', 'c2:Tests pass']);
  // Duplicates inside the appended tail itself (and against the recorded list)
  // are dropped too; the one genuinely new criterion lands with a contiguous ID.
  f.plan([B, C, C, A], {append: true});
  assert.deepEqual(f.criteria.map(c => c.id + ':' + c.text), ['c1:Alpha done', 'c2:Tests pass', 'c3:Gamma done']);
  // Identity is the full criterion (text, kind, command, cwd, shell): the same
  // text under another kind is a different criterion and is kept.
  f.plan([{text: 'Alpha done', kind: 'manual'}], {append: true});
  assert.deepEqual(f.criteria.map(c => c.id + ':' + c.kind), ['c1:inspection', 'c2:command', 'c3:inspection', 'c4:manual']);
  // A plain append of only-new criteria still works as before.
  const g = new Focus('Task'); g.beginRound();
  g.plan([A]);
  g.plan([C], {append: true});
  assert.deepEqual(g.criteria.map(c => c.text), ['Alpha done', 'Gamma done']);
});

test('w2 focus D2: a new_task replacement leaves no unanswered question behind', () => {
  // Criteria path: the old task stopped for the user; in the resumed leg a
  // question about the old task is still pending when the replacement lands.
  const f = new Focus('Old task'); f.beginRound();
  f.plan([{text: 'Device ok', kind: 'manual'}]);
  f.checkpoint([{id: 'c1', status: 'unknown', reason: 'please check'}]);
  assert.equal(f.endRound().status, 'needs_input');
  f.resumeLeg('A different task'); f.beginRound();
  f.askUser('Which old option?', {options: JSON.stringify([{label: 'Blue'}, {label: 'Green'}])});
  assert.ok(f.question && f.ask, 'a question is pending at replacement time');
  f.plan([{text: 'Different work', kind: 'inspection'}], {newTask: true});
  assert.equal(f.goal, 'A different task');
  assert.equal(f.question, '', 'the old question does not carry into the new task');
  assert.equal(f.ask, null, 'the old picker does not carry into the new task');
  assert.notEqual(f.endRound().status, 'needs_input', 'the new task does not stop on the old question');
  // Zero-criteria path: a task tracked only by an ask_user replaces the same way.
  const g = new Focus('Old task'); g.beginRound();
  g.askUser('Which one?');
  assert.equal(g.endRound().status, 'needs_input');
  g.resumeLeg('A different task'); g.beginRound();
  g.askUser('And the old follow-up?');
  g.plan([{text: 'Different work', kind: 'inspection'}], {newTask: true});
  assert.equal(g.goal, 'A different task');
  assert.equal(g.criteria.length, 1);
  assert.equal(g.question, '');
  assert.equal(g.ask, null);
  assert.notEqual(g.endRound().status, 'needs_input');
});

test('w2 focus D3: restore demotes evidence-free met criteria and never reissues an evidence ID', () => {
  // A hand-edited save claiming complete with mets no checkpoint could have
  // produced: no cited evidence, a citation of a missing ID, a citation of
  // unusable evidence, and a manual met with no recorded user confirmation.
  const s = new Focus('Task'); s.beginRound();
  s.plan([{text: 'Inspected', kind: 'inspection'}, {text: 'Also inspected', kind: 'inspection'},
    {text: 'Tests pass', kind: 'command', command: 'npm test'}, {text: 'Seen on device', kind: 'manual'}]);
  const data = s.serialize();
  data.status = 'complete'; data.criteriaAllMet = true;
  data.criteria[0].status = 'met'; data.criteria[0].evidence = [];
  data.criteria[1].status = 'met'; data.criteria[1].evidence = ['e404'];
  data.criteria[2].status = 'met'; data.criteria[2].evidence = ['e1'];
  data.criteria[3].status = 'met';
  data.evidence = [{id: 'e1', command: 'system.run', summary: 'npm test', ok: false, usable: false, revision: 0, round: 1}];
  const r = Focus.restore(data);
  assert.deepEqual(r.criteria.map(c => c.status), ['pending', 'pending', 'pending', 'pending'], 'every unproven met is demoted');
  assert.equal(r.criteriaAllMet, false);
  assert.notEqual(r.status, 'complete', 'an evidence-free save cannot restore into complete');
  // Proven mets survive: a real inspection met on cited usable evidence, and a
  // manual met the user confirmed in a resumed leg.
  const p = new Focus('Proven'); p.beginRound(); p.plan(insp);
  const proof = p.observe(read('probe.txt'), {ok: true});
  p.checkpoint([met('c1', [proof])]);
  const pd = p.serialize(); pd.status = 'complete';
  const pr = Focus.restore(pd);
  assert.equal(pr.criteria[0].status, 'met', 'a met on restored usable evidence stands');
  assert.equal(pr.status, 'complete');
  const m = new Focus('Manual'); m.beginRound();
  m.plan([{text: 'Visible in the headset', kind: 'manual'}]);
  m.checkpoint([{id: 'c1', status: 'unknown', reason: 'please check'}]); m.endRound();
  m.resumeLeg('seen it'); m.beginRound();
  m.checkpoint([met('c1')]);
  const mr = Focus.restore(m.serialize());
  assert.equal(mr.criteria[0].status, 'met', 'a manual met with a recorded confirmation stands');
  // Evidence IDs stay unique going forward even when the saved counter is stale.
  const ids = new Focus('Ids'); ids.beginRound(); ids.plan(insp);
  const first = ids.observe(read('a.txt'), {ok: true});
  const stale = ids.serialize(); stale.nextEvidence = 1;
  const restored = Focus.restore(stale);
  const second = restored.observe(read('b.txt'), {ok: true});
  assert.equal(first, 'e1');
  assert.equal(second, 'e2', 'the next ID moves past the largest restored ID');
  assert.equal(new Set(restored.evidence.map(e => e.id)).size, restored.evidence.length, 'no ID is issued twice');
});

test('w2 focus D4: the oldest of 51 uncollected background runs still yields usable evidence', () => {
  const f = new Focus('Bg task'); f.beginRound();
  f.plan([{text: 'Oldest job passes', kind: 'command', command: 'job-oldest'}]);
  f.observe(run('job-oldest'), {ok: true, payload: {shell_id: 'w2bg0'}});
  for (let i = 1; i <= 50; i++) f.observe(run('job-' + i), {ok: true, payload: {shell_id: 'w2bg' + i}});
  assert.equal(f.background.size, 51, 'uncollected runs are held even beyond the old cap of 50');
  assert.ok(f.background.has('w2bg0'), 'the oldest uncollected run is not evicted');
  const done = f.observe(bgOut('w2bg0'), bgResult('w2bg0', 0));
  const entry = f.evidence.find(e => e.id === done);
  assert.equal(entry.verificationCommand, 'job-oldest');
  assert.equal(f.evidenceCurrent(entry), true, 'its completion evidence is usable');
  f.checkpoint([met('c1', [done])]);
  assert.equal(f.endRound().status, 'complete');
  // Only collected entries leave first: one more start evicts the collected
  // oldest run, never a still-uncollected one.
  f.observe(run('job-extra'), {ok: true, payload: {shell_id: 'w2bgX'}});
  assert.equal(f.background.has('w2bg0'), false, 'a collected entry is the eviction victim');
  assert.ok(f.background.has('w2bg1'), 'an uncollected entry is still kept');
});

// ---------- tell (6bc56f4) ----------

test('w2 tell C3: a long send reports truncation and the original length; delivery is still cut', (t) => {
  const base = tmpdir(t); const dir = tmpdir(t);
  const h = new tell.PeerHandle({sessionId: 'sess-w2-long', cwd: dir, base, pid: process.pid}).start();
  t.after(() => h.stop());
  const from = {pid: 4242, sessionId: 'sess-w2-sender', name: 's', cwd: dir};
  const long = tell.send({from, target: 'sess-w2-long', text: 'a'.repeat(tell.MAX_TEXT + 1), base});
  assert.equal(long.ok, true);
  assert.equal(long.truncated, true, 'a body over MAX_TEXT says so');
  assert.equal(long.originalLength, tell.MAX_TEXT + 1, 'the pre-cut code-point length rides along');
  const got = tell.readInbox('sess-w2-long', {base});
  assert.equal(got.length, 1);
  assert.equal([...got[0].text].length, tell.MAX_TEXT, 'the delivery itself is still cut at MAX_TEXT');
  const short = tell.send({from, target: 'sess-w2-long', text: 'short', base});
  assert.equal(short.ok, true);
  assert.equal(short.truncated, false, 'a short body is not flagged');
  assert.equal(short.originalLength, 5);
});

test('w2 tell C4: drain/requeue round trips never grow the receive count', (t) => {
  const base = tmpdir(t); const dir = tmpdir(t);
  const h = new tell.PeerHandle({sessionId: 'sess-w2-cap', cwd: dir, base, pid: process.pid}).start();
  t.after(() => h.stop());
  const from = {pid: 4242, sessionId: 'sess-w2-s2', name: 's', cwd: dir};
  assert.equal(tell.send({from, target: 'sess-w2-cap', text: 'one', base}).ok, true);
  assert.equal(tell.send({from, target: 'sess-w2-cap', text: 'two', base}).ok, true);
  // The same two messages ride the drain -> requeue loop three times (a
  // conversation switch or a close between drain and delivery does this).
  for (let round = 0; round < 3; round++) {
    const drained = tell.drainInbox('sess-w2-cap', {base});
    assert.deepEqual(drained.map(m => m.text), ['one', 'two'], 'nothing is lost or duplicated in the loop');
    assert.equal(tell.requeue('sess-w2-cap', drained, {base}), 2);
  }
  assert.equal(tell.readInbox('sess-w2-cap', {base}).length, 2, 'the pair is back in the inbox, counted there once');
  // Counted exactly once each, the pair leaves room for exactly three more
  // real deliveries before the per-minute cap bites — not zero room.
  for (let i = 0; i < tell.RECEIVE_PER_MIN - 2; i++)
    assert.equal(tell.send({from, target: 'sess-w2-cap', text: 'new' + i, base}).ok, true, 'real send ' + i + ' still fits');
  const over = tell.send({from, target: 'sess-w2-cap', text: 'one too many', base});
  assert.equal(over.ok, false);
  assert.equal(over.error, 'rate-limited', 'the cap itself is unchanged');
});

test('w2 tell C5: old inbox files are pruned on the peer-housekeeping path; recent ones stay', (t) => {
  const base = tmpdir(t);
  const inbox = tell.inboxDir({base});
  fs.mkdirSync(inbox, {recursive: true});
  const old = new Date(Date.now() - 31 * 24 * 3600 * 1000);
  const recent = new Date(Date.now() - 29 * 24 * 3600 * 1000);
  const put = (name, when) => { const f = path.join(inbox, name); fs.writeFileSync(f, 'x\n'); fs.utimesSync(f, when, when); return f; };
  const dead = [put('sess-dead.jsonl', old), put('sess-dead.jsonl.rate', old), put('sess-dead.jsonl.drain-123-1', old)];
  const alive = [put('sess-live.jsonl', new Date()), put('sess-recent.jsonl', recent), put('notes.txt', old)];
  tell.listPeers({base}); // the existing housekeeping route (prunePeers)
  for (const f of dead) assert.equal(fs.existsSync(f), false, path.basename(f) + ' (31 days old) is pruned');
  for (const f of alive) assert.equal(fs.existsSync(f), true, path.basename(f) + ' stays');
});
