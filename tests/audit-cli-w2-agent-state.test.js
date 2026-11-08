'use strict';
// audit-cli wave 2 — agent / session / lore state regressions.
// Pins the wave-2 fixes e1afb3d (agent: abort recheck before send and before
// auto-allowed tools, interrupted turns record every message, silent
// completions are marked, close() flushes worklogs), 3d15259 (sessions:
// 'a.b' / 'ab' style ids no longer collide on one file) and c78bdc7 (lore:
// an edit whose window is gone must not anchor to unrelated current content,
// and a corrupt state.json is backed aside instead of silently wiping the
// forgotten keys). Style mirrors tests/agent.test.js (fake client, isolated
// home), tests/sessions-store.test.js and tests/lore.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

// Point every folder at a throwaway one BEFORE loading any src module
// (src/agent, src/sessions and src/worklog bind their data dirs at load).
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w2-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w2-home-'));

const {Agent} = require('../src/agent');
const sessions = require('../src/sessions');
const lore = require('../src/lore');
const {Worklog} = require('../src/worklog');

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w2-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
function stubClient() {
  const c = new EventEmitter();
  c.status = 'connected'; c.ws = {readyState: 1};
  c.history = async () => ({chat_events: []});
  c.request = async () => ({session: {status: 'working'}});
  c.subscribeAgent = async () => {};
  c.closeAgentSubscription = () => {};
  c.cancel = async () => {};
  c.disconnect = () => {}; // so Agent.close() (registered by makeAgent) runs to completion
  return c;
}
function makeAgent(t, agentOpts = {}) {
  const cwd = agentOpts.cwd || tmpdir(t);
  const client = stubClient();
  const a = new Agent({
    client,
    auth: {saved: {}, vm: async () => { throw new Error('no vm in tests'); }},
    cwd,
    session: {id: 'main-session', cwd, title: '', created: 0, updated: 0, turns: 0},
    ...agentOpts,
  });
  a.subscribed = true; // as bin/muser.js marks it once its startup subscribe is done
  if (t) t.after(() => { try { a.close(); } catch {} });
  return a;
}
function startTurn(a) {
  a.main.turn = {controller: new AbortController(), baseline: new Set(), messages: new Map(), sources: new Map(), started: Date.now(), toolCalls: 0};
  return a.main.turn;
}

// ---------- (1) interrupt during the baseline history fetch: never sent ----------

test('w2-1: an interrupt landing during the history fetch keeps the turn unsent', async (t) => {
  const a = makeAgent(t);
  const sentBodies = [];
  a.device = {connected: true, send: async (body) => { sentBodies.push(body); return {message_id: 'm-never'}; }};
  // The user hits Esc while runTurn is still paging the baseline history:
  // interrupt() aborts the turn controller synchronously, the fetch then
  // returns normally — the send itself must recheck and refuse.
  a.client.history = async () => { void a.interrupt(); return {chat_events: []}; };
  await assert.rejects(a.send('w2-case1-never-sent'), e => e.name === 'AbortError');
  assert.equal(sentBodies.length, 0, 'device.send was never called');
  assert.equal(a.main.turn, null, 'the turn slot is released');
  assert.ok(!sessions.transcript('main-session').some(x => x.user === 'w2-case1-never-sent'), 'an unsent turn is not recorded');
});

// ---------- (2) abort / deadline before an auto-allowed code.write ----------

test('w2-2: an auto-allowed code.write after abort (or past its deadline) does not run', async (t) => {
  const a = makeAgent(t, {mode: 'bypass'}); // bypass: code.write is allowed without asking
  const turn = startTurn(a);
  turn.controller.abort(); // Esc landed before Muse's invoke was executed
  const r = await a.execute('code.write', {path: 'nope.txt', content: 'should not land\n'}, 1000, 'inv-w2-abort');
  assert.equal(r.ok, false);
  assert.match(r.error, /stopped before the user answered/);
  assert.equal(fs.existsSync(path.join(a.cwd, 'nope.txt')), false, 'the file was not written');

  const b = makeAgent(t, {mode: 'bypass'});
  startTurn(b);
  // A negative timeout puts call.deadline in the past: Muse stopped waiting.
  const r2 = await b.execute('code.write', {path: 'late.txt', content: 'should not land\n'}, -60000, 'inv-w2-late');
  assert.equal(r2.ok, false);
  assert.match(r2.error, /stopped waiting for this call/);
  assert.equal(fs.existsSync(path.join(b.cwd, 'late.txt')), false, 'the file was not written');
});

// ---------- (3) an interrupted turn records EVERY message of the turn ----------

test('w2-3: the interrupted-turn record keeps all messages, in arrival order', async (t) => {
  const a = makeAgent(t);
  a.device = {connected: true, send: async () => ({message_id: 'm-w2-3'})};
  const sent = new Promise(r => a.once('sent', r));
  const p = a.send('w2-case3-task');
  await sent;
  assert.ok(a.main.turn, 'the turn is live');
  // Three assistant messages streamed this turn (what onChatEvent collects).
  a.main.turn.messages.set('r1', {text: 'first part', rawText: 'first part', seq: 1});
  a.main.turn.messages.set('r2', {text: 'second part', rawText: 'second part', seq: 2});
  a.main.turn.messages.set('r3', {text: 'third part', rawText: 'third part', seq: 3});
  await a.interrupt();
  await assert.rejects(p, e => e.name === 'AbortError');
  const entry = sessions.transcript('main-session').find(x => x.user === 'w2-case3-task');
  assert.ok(entry, 'the interrupted turn was recorded');
  assert.equal(entry.reply, 'first part\n\nsecond part\n\nthird part', 'all three messages, joined in order — not only the last');
  assert.equal(entry.error, '中断しました');
});

// ---------- (4) a silent completion is recorded as silent ----------

test('w2-4: a turn Muse finishes without replying is recorded with silent: true', {timeout: 120000}, async (t) => {
  const a = makeAgent(t);
  let sentFlag = false;
  const userEv = {role: 'user', message_id: 'u-w2-silent', seq: 1, display_text: 'w2-case4-task', visibility: 'public', payload: {}};
  // Baseline fetch (before the send) sees an empty chat; afterwards the chat
  // holds exactly our message, the session reads completed, and no reply
  // ever follows — waitForReply's silent finish (its grace is 30 s, hence
  // the generous test timeout).
  a.client.history = async () => ({chat_events: sentFlag ? [userEv] : []});
  a.client.request = async () => ({session: {status: 'completed'}});
  a.device = {connected: true, send: async () => { sentFlag = true; return {message_id: 'u-w2-silent'}; }};
  const reply = await a.send('w2-case4-task');
  assert.equal(reply.text, '');
  assert.equal(reply.silent, true, 'the reply itself is marked silent');
  const entry = sessions.transcript('main-session').find(x => x.user === 'w2-case4-task');
  assert.ok(entry, 'the silent turn was recorded');
  assert.equal(entry.reply, '');
  assert.equal(entry.silent, true, 'the transcript line keeps the silent marker, not a blank-looking reply');
});

// ---------- (5) close() flushes queued worklog lines ----------

test('w2-5: Agent.close() flushes the worklog queue instead of dropping its tail', (t) => {
  const a = makeAgent(t);
  const wl = a.worklogFor(a.main);
  assert.ok(wl, 'the main worker has a work log');
  wl.turn({text: 'w2-case5-close-flush-marker', agent: 'main'});
  const has = () => Worklog.read('main-session').some(e => e.text === 'w2-case5-close-flush-marker');
  // Synchronous on purpose: appends are batched on a 200 ms timer, so the
  // line is still only queued here — no timer can fire inside this block.
  assert.equal(has(), false, 'the line is still queued in the batch window');
  a.close();
  assert.equal(has(), true, 'close() wrote the queued line out at once');
});

// ---------- (6) session ids 'a.b' / 'ab' must not share a file ----------

test("w2-6: session ids 'w2a.b' and 'w2ab' keep separate transcripts and Focus files", () => {
  const idDot = 'w2a.b', idPlain = 'w2ab'; // the old stripped naming mapped both to 'w2ab'
  assert.notEqual(sessions.transcriptFile(idDot), sessions.transcriptFile(idPlain));
  sessions.appendTurn(idDot, {v: 1, at: 1, user: 'dot-user', reply: 'dot-reply', tools: [], steps: [], todos: []});
  sessions.appendTurn(idPlain, {v: 1, at: 2, user: 'plain-user', reply: 'plain-reply', tools: [], steps: [], todos: []});
  assert.deepEqual(sessions.transcript(idDot).map(x => x.user), ['dot-user'], "a.b's transcript holds only its own turn");
  assert.deepEqual(sessions.transcript(idPlain).map(x => x.user), ['plain-user'], "ab's transcript holds only its own turn");
  assert.notEqual(sessions.focusFile(idDot), sessions.focusFile(idPlain));
  sessions.saveFocus(idDot, {marker: 'dot'});
  sessions.saveFocus(idPlain, {marker: 'plain'});
  assert.equal(sessions.loadFocus(idDot).marker, 'dot');
  assert.equal(sessions.loadFocus(idPlain).marker, 'plain');
  sessions.clearFocus(idDot);
  assert.equal(sessions.loadFocus(idDot), null, 'clearing one id leaves no legacy file to resurrect it');
  // (clearFocus also removes the LEGACY name, which for this pair is the
  // plain id's own file name — the legacy ambiguity the encoding retires;
  // the plain id's transcript, the collision that mixed conversations, is
  // untouched.)
  assert.deepEqual(sessions.transcript(idPlain).map(x => x.user), ['plain-user'], "the other id's transcript is untouched");
});

// ---------- lore fixtures (tests/lore.test.js style) ----------

function loreSetup() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w2-lore-data-'));
  process.env.LOCALAPPDATA = data; // lore reads LOCALAPPDATA at call time
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w2-lore-repo-'));
  fs.mkdirSync(path.join(repo, 'src'), {recursive: true});
  return {data, repo};
}
function writeWorklog(data, events) {
  const wl = path.join(data, 'muser', 'worklog');
  fs.mkdirSync(path.join(wl, 'blobs'), {recursive: true});
  fs.writeFileSync(path.join(wl, 'convw2.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
}

// ---------- (7) lore: an edit whose window is gone does not become 'exact' ----------

test('w2-7: lore sync does not anchor a vanished edit window to unrelated current content', () => {
  const {data, repo} = loreSetup();
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'now one\nnow two\nnow three\n');
  fs.writeFileSync(path.join(repo, 'src', 'b.js'), 'alpha\nbravo\ntarget line\ndelta\n');
  const goneHash = lore.hashText('the edited line');
  const keptHash = lore.hashText('target line');
  writeWorklog(data, [
    {v: 1, event: 'turn', at: '2026-11-08T01:00:00.000Z', session: 'convw2', agent: 'main', text: 'a.js と b.js を直して'},
    // a.js: the edit's result ('the edited line' at range 2-2) is GONE from
    // the file; unrelated text sits at the recorded range now.
    {v: 1, event: 'edit', at: '2026-11-08T01:01:00.000Z', session: 'convw2', path: path.join(repo, 'src', 'a.js'), op: 'edit', ranges: [{start: 2, end: 2}], added: 1, removed: 1, beforeHash: 'bw2a', afterHash: goneHash, diff: '@@\n- old line\n+ the edited line'},
    // b.js control: the edit's result still exists, one line lower than recorded.
    {v: 1, event: 'edit', at: '2026-11-08T01:02:00.000Z', session: 'convw2', path: path.join(repo, 'src', 'b.js'), op: 'edit', ranges: [{start: 1, end: 1}], added: 1, removed: 1, beforeHash: 'bw2b', afterHash: keptHash, diff: '@@\n- old head\n+ target line'},
    {v: 1, event: 'reply', at: '2026-11-08T01:03:00.000Z', session: 'convw2', agent: 'main', text: 'a.js と b.js を直しました。'},
  ]);
  lore.syncFromWorklog(repo);
  const records = lore.readRecords(repo);
  const whyA = records.find(x => x.kind === 'why' && x.path === 'src/a.js');
  assert.ok(whyA, 'a why record was still derived for a.js');
  assert.equal(whyA.hash, goneHash, "the record keeps the edit's own afterHash");
  assert.deepEqual(whyA.text, [], 'no unrelated current text was adopted as the record');
  assert.deepEqual(whyA.before, []);
  assert.deepEqual(whyA.after, []);
  assert.equal(whyA.start, 2, 'the recorded range is kept');
  assert.equal(lore.locate(whyA, ['now one', 'now two', 'now three']).status, 'lost', "it locates as 'lost', never 'exact' against the unrelated line");
  const whyB = records.find(x => x.kind === 'why' && x.path === 'src/b.js');
  assert.ok(whyB, 'control: a why record for b.js');
  assert.equal(whyB.start, 3, 'control: the surviving window is found at its real place');
  assert.deepEqual(whyB.text, ['target line']);
  assert.equal(lore.locate(whyB, ['alpha', 'bravo', 'target line', 'delta']).status, 'exact');
});

// ---------- (8) lore: a corrupt state.json must not silently wipe the forgotten keys ----------

test('w2-8: a corrupt lore state.json is backed aside, so forgotten records are not silently wiped', () => {
  const {data, repo} = loreSetup();
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'one\ntwo\nthree\n');
  writeWorklog(data, [
    {v: 1, event: 'turn', at: '2026-11-08T02:00:00.000Z', session: 'convw2', agent: 'main', text: 'a.js を直して'},
    {v: 1, event: 'edit', at: '2026-11-08T02:01:00.000Z', session: 'convw2', path: path.join(repo, 'src', 'a.js'), op: 'edit', ranges: [{start: 2, end: 2}], added: 1, removed: 1, beforeHash: 'bw2c', afterHash: lore.hashText('two'), diff: '@@\n- 2\n+ two'},
    {v: 1, event: 'reply', at: '2026-11-08T02:02:00.000Z', session: 'convw2', agent: 'main', text: 'a.js を直しました。'},
  ]);
  lore.syncFromWorklog(repo);
  assert.equal(lore.readRecords(repo).length, 1, 'the why record was derived');
  assert.equal(lore.forget(repo, {path: 'src/a.js'}), 1);
  assert.equal(lore.readRecords(repo).length, 0);
  lore.syncFromWorklog(repo);
  assert.equal(lore.readRecords(repo).length, 0, 'with state intact, the forgotten record stays gone');
  const ctx = lore.repoContext(repo);
  const stateFile = path.join(ctx.dir, 'state.json');
  const raw = fs.readFileSync(stateFile, 'utf8');
  assert.ok(raw.includes('why|'), 'state.json holds the forgotten key: ' + raw);
  // A crash mid-write leaves a truncated state.json behind.
  const truncated = raw.slice(0, Math.ceil(raw.length / 2));
  fs.writeFileSync(stateFile, truncated);
  // The next state write (here: toggling share) reads the corrupt file
  // first. It must move those bytes aside, not overwrite them — they are
  // the only copy of what the user forgot.
  lore.setShared(repo, true);
  const backups = fs.readdirSync(ctx.dir).filter(n => n.startsWith('state.json.corrupt-'));
  assert.equal(backups.length, 1, 'the corrupt bytes were moved aside: ' + fs.readdirSync(ctx.dir).join(', '));
  assert.equal(fs.readFileSync(path.join(ctx.dir, backups[0]), 'utf8'), truncated, 'the backup holds the corrupt bytes verbatim, forgotten key included');
  assert.ok(fs.readFileSync(path.join(ctx.dir, backups[0]), 'utf8').includes('why|'));
  const rewritten = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(rewritten.shared, true, 'the new state.json is valid JSON with the write applied');
  assert.deepEqual(fs.readdirSync(ctx.dir).filter(n => n.includes('.tmp-')), [], 'the atomic write left no temp files behind');
});
