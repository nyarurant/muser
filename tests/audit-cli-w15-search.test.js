'use strict';
// W13-14 remainder: title/body search for conversation resume.
// Transcript format finding (fixture-verified): the writer
// (sessions.appendTurn, JSON.stringify) stores Japanese as LITERAL UTF-8,
// not escaped, so the raw-line lowercase pre-filter in search() is valid;
// only pre-filtered lines are JSON.parsed, and a hit counts only when the
// parsed user/reply field itself contains the query.
// Isolation: this file pins its own data/home roots under %TEMP% BEFORE any
// src module loads (the wave-3 head guard), and the bin subprocesses get
// their own scratch dirs, also under %TEMP%.
const test = require('node:test');
const {after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {EventEmitter} = require('node:events');
const TMP = os.tmpdir();
const dataRoot = fs.mkdtempSync(path.join(TMP, 'muser-w15search-data-'));
const homeRoot = fs.mkdtempSync(path.join(TMP, 'muser-w15search-home-'));
process.env.LOCALAPPDATA = dataRoot;
process.env.USERPROFILE = homeRoot;
process.env.HOME = homeRoot;
process.env.MUSER_LANG = 'ja';
for (const v of [process.env.USERPROFILE, process.env.HOME, process.env.LOCALAPPDATA]) assert.ok(v && path.resolve(v).startsWith(path.resolve(TMP)), 'head guard: test homes under %TEMP%: ' + v);
for (const m of ['../src/secure-store', '../src/sessions']) { try { delete require.cache[require.resolve(m)]; } catch {} }
const sessions = require('../src/sessions');
assert.ok(path.resolve(sessions.FILE).startsWith(path.resolve(dataRoot)), 'head guard: scratch sessions index: ' + sessions.FILE);
after(() => { for (const d of [dataRoot, homeRoot]) fs.rmSync(d, {recursive: true, force: true}); });
const WORK = 'C:\\w15-work';
function resetStore() { fs.rmSync(sessions.FILE, {force: true}); fs.rmSync(sessions.FILE + '.lock', {force: true}); fs.rmSync(sessions.TRANSCRIPTS, {recursive: true, force: true}); }
function make(id, {cwd = WORK, title = '', turns = 1, updated = 1000} = {}) { const s = sessions.create(cwd); s.id = id; s.title = title; s.turns = turns; s.updated = updated; s.created = updated; sessions.save(s); return s; }
function turn(id, user, reply = '') { sessions.appendTurn(id, {v: 1, at: Date.now(), user, reply, tools: [], steps: [], sources: [], todos: []}); }
function rawLine(id, line) { fs.mkdirSync(sessions.TRANSCRIPTS, {recursive: true}); fs.appendFileSync(sessions.transcriptFile(id), line + '\n'); }
function addIndexEntry(entry) { const list = JSON.parse(fs.readFileSync(sessions.FILE, 'utf8')); list.push(entry); fs.writeFileSync(sessions.FILE, JSON.stringify(list)); }
test('w15 search: empty / blank query finds nothing', () => {
  resetStore(); make('s-empty-1', {title: 'something'});
  assert.deepEqual(sessions.search(''), []); assert.deepEqual(sessions.search('   '), []); assert.deepEqual(sessions.search(null), []);
});
test('w15 search: title hit (case-insensitive), and a turns=0 title is not a candidate', () => {
  resetStore();
  make('s-title-1', {title: 'Fix the NeedleTitle bug', updated: 2000});
  make('s-title-0', {title: 'NeedleTitle but no turns', turns: 0, updated: 3000});
  const hits = sessions.search('needletitle');
  assert.equal(hits.length, 1); assert.equal(hits[0].matchedIn, 'title'); assert.equal(hits[0].session.id, 's-title-1');
});
test('w15 search: title hits come before body hits even when the body session is newer', () => {
  resetStore();
  make('s-body-new', {title: 'plain', updated: 9000}); turn('s-body-new', 'the NeedleOrder word is in this body');
  make('s-title-old', {title: 'NeedleOrder in the title', updated: 1000});
  assert.deepEqual(sessions.search('needleorder').map(h => [h.session.id, h.matchedIn]), [['s-title-old', 'title'], ['s-body-new', 'body']]);
});
test('w15 search: body hit in user text, case-insensitive, with a snippet', () => {
  resetStore(); make('s-user-1', {title: 'unrelated'}); turn('s-user-1', 'please look at NeedleUserXYZ today', 'sure');
  const hits = sessions.search('needleuserxyz');
  assert.equal(hits.length, 1); assert.equal(hits[0].matchedIn, 'body'); assert.ok(hits[0].snippet.includes('NeedleUserXYZ'), hits[0].snippet);
});
test('w15 search: body hit in reply when the user text does not match', () => {
  resetStore(); make('s-reply-1', {title: 'unrelated'}); turn('s-reply-1', 'a plain question', 'the answer mentions NeedleReplyXYZ here');
  const hits = sessions.search('needlereplyxyz');
  assert.equal(hits.length, 1); assert.equal(hits[0].matchedIn, 'body'); assert.ok(hits[0].snippet.includes('NeedleReplyXYZ'));
});
test('w15 search: the user field is preferred over the reply for the snippet', () => {
  resetStore(); make('s-pref-1', {title: 'unrelated'}); turn('s-pref-1', 'USERCTX NeedlePref in the ask', 'REPLYCTX NeedlePref in the answer');
  const hits = sessions.search('needlepref');
  assert.equal(hits.length, 1); assert.ok(hits[0].snippet.includes('USERCTX'), hits[0].snippet); assert.ok(!hits[0].snippet.includes('REPLYCTX'));
});
test('w15 search: snippet is collapsed, control-free and cut to about 60 code points around the match', () => {
  resetStore(); make('s-snip-1', {title: 'unrelated'});
  turn('s-snip-1', '\u{1F98A}'.repeat(40) + '\n\n  NeedleLong   ' + 'y'.repeat(100) + '\u202e', '');
  const hits = sessions.search('needlelong');
  assert.equal(hits.length, 1); const snip = hits[0].snippet;
  assert.ok(snip.includes('NeedleLong')); assert.ok([...snip].length <= 60, 'code points: ' + [...snip].length);
  assert.ok(!/[\x00-\x1f\x7f-\x9f\u202a-\u202e]/.test(snip), 'no control/bidi in snippet'); assert.ok(!/  /.test(snip), 'whitespace collapsed');
});
test('w15 search: a truncation-marker line does NOT match, a real turn after it still does', () => {
  resetStore();
  make('s-mark-1', {title: 'unrelated'});
  rawLine('s-mark-1', JSON.stringify({truncated: true, user: 'NeedleMarkerOnly was dropped', reply: ''}));
  rawLine('s-mark-1', JSON.stringify({type: 'truncation', user: 'NeedleMarkerOnly again', reply: ''}));
  make('s-mark-2', {title: 'unrelated'});
  rawLine('s-mark-2', JSON.stringify({truncated: true, user: 'nothing', reply: ''}));
  turn('s-mark-2', 'a real NeedleMarkerOnly turn');
  assert.deepEqual(sessions.search('needlemarkeronly').map(h => h.session.id), ['s-mark-2']);
});
test('w15 search: a word only in another field (tools) is not a body hit; no-hit is empty', () => {
  resetStore(); make('s-other-1', {title: 'unrelated'});
  sessions.appendTurn('s-other-1', {v: 1, at: Date.now(), user: 'plain', reply: 'plain', tools: [{name: 'NeedleToolsOnly'}], steps: [], sources: [], todos: []});
  assert.deepEqual(sessions.search('needletoolsonly'), []); assert.deepEqual(sessions.search('absent-word-zzz'), []);
});
test('w15 search: turns=0 sessions are not body candidates; cwd narrows candidates', () => {
  resetStore();
  make('s-zero-1', {title: 'unrelated', turns: 0}); turn('s-zero-1', 'NeedleScope in a zero-turn body');
  make('s-here-1', {title: 'unrelated', cwd: 'C:\\w15-here'}); turn('s-here-1', 'NeedleScope here');
  make('s-else-1', {title: 'unrelated', cwd: 'C:\\w15-elsewhere'}); turn('s-else-1', 'NeedleScope elsewhere');
  assert.deepEqual(sessions.search('needlescope').map(h => h.session.id).sort(), ['s-else-1', 's-here-1']);
  assert.deepEqual(sessions.search('needlescope', {cwd: 'c:\\W15-HERE'}).map(h => h.session.id), ['s-here-1']);
});
test('w15 search: limit caps total hits, newest first', () => {
  resetStore();
  for (let i = 1; i <= 5; i++) make('s-lim-' + i, {title: 'NeedleLimit chat ' + i, updated: i * 1000});
  assert.deepEqual(sessions.search('needlelimit', {limit: 2}).map(h => h.session.id), ['s-lim-5', 's-lim-4']);
  assert.equal(sessions.search('needlelimit').length, 5);
});
test('w15 search: duplicate-id sessions are separate hits with their own session objects (body)', () => {
  resetStore();
  make('dup-search-1', {cwd: 'C:\\w15-dup-a', title: 'first dup', updated: 2000});
  addIndexEntry({id: 'dup-search-1', cwd: 'C:\\w15-dup-b', title: 'second dup', turns: 1, created: 3000, updated: 3000});
  turn('dup-search-1', 'the shared transcript holds NeedleDupXYZ');
  const hits = sessions.search('needledupxyz');
  assert.equal(hits.length, 2); assert.notEqual(hits[0].session, hits[1].session);
  assert.deepEqual(hits.map(h => h.session.cwd).sort(), ['C:\\w15-dup-a', 'C:\\w15-dup-b']);
  assert.ok(hits.every(h => h.session.id === 'dup-search-1' && h.matchedIn === 'body'));
});
test('w15 search: duplicate-id sessions are separate title hits too', () => {
  resetStore();
  make('dup-title-1', {cwd: 'C:\\w15-dupa', title: 'NeedleDupTitle A', updated: 2000});
  addIndexEntry({id: 'dup-title-1', cwd: 'C:\\w15-dupb', title: 'NeedleDupTitle B', turns: 1, created: 3000, updated: 3000});
  const hits = sessions.search('needleduptitle');
  assert.equal(hits.length, 2); assert.deepEqual(hits.map(h => h.session.title).sort(), ['NeedleDupTitle A', 'NeedleDupTitle B']);
});
test('w15 bin: one body hit resumes, several list candidates, none keeps the old not-found error', {timeout: 180000}, () => {
  const BIN = path.join(__dirname, '..', 'bin', 'muser.js');
  const mk = prefix => fs.mkdtempSync(path.join(TMP, prefix));
  const data = mk('muser-w15bin-data-'), home = mk('muser-w15bin-home-'), folder = mk('muser-w15bin-folder-');
  for (const d of [data, home, folder]) assert.ok(path.resolve(d).startsWith(path.resolve(TMP)), 'head guard: ' + d);
  try {
    const store = path.join(data, 'muser'), tr = path.join(store, 'transcripts'); fs.mkdirSync(tr, {recursive: true});
    const now = Date.now();
    const list = [{id: 'w15bin-sess-1', cwd: folder, title: 'first chat', created: now, updated: now, turns: 1}, {id: 'w15bin-sess-2', cwd: folder, title: 'second chat', created: now, updated: now + 1000, turns: 1}];
    fs.writeFileSync(path.join(store, 'sessions.json'), JSON.stringify(list));
    fs.writeFileSync(path.join(tr, 'w15bin-sess-1.jsonl'), JSON.stringify({v: 1, at: now, user: 'body holds UniqSingleWord and UniqMultiWord', reply: 'ok', tools: [], steps: []}) + '\n');
    fs.writeFileSync(path.join(tr, 'w15bin-sess-2.jsonl'), JSON.stringify({v: 1, at: now, user: 'body also holds UniqMultiWord', reply: 'ok', tools: [], steps: []}) + '\n');
    const runBin = ref => { const env = {...process.env, MUSER_LANG: 'ja', MUSER_CLIENT: '', MUSER_NO_UPDATE_CHECK: '1', USERPROFILE: home, HOME: home, LOCALAPPDATA: data, MUSER_SERVER_FILE: path.join(home, 'server.json')}; const r = spawnSync(process.execPath, [BIN, 'exec', '--session', ref, 'hello'], {encoding: 'utf8', timeout: 60000, env}); return {status: r.status, out: (r.stdout || '') + (r.stderr || '')}; };
    const single = runBin('UniqSingleWord');
    assert.ok(!single.out.includes('会話が見つかりません'), 'single hit is not not-found: ' + single.out);
    assert.ok(!single.out.includes('検索に当てはまる会話が複数あります'), 'single hit is not several: ' + single.out);
    assert.ok(single.out.includes('まず `muser login`'), 'run continued past resumeTarget to the login check: ' + single.out);
    const multi = runBin('UniqMultiWord');
    assert.equal(multi.status, 1, 'several hits refused: ' + multi.out);
    assert.ok(multi.out.includes('「UniqMultiWord」の検索に当てはまる会話が複数あります。ID で指定してください:'), multi.out);
    assert.ok(multi.out.includes('w15bin-sess-1') && multi.out.includes('w15bin-sess-2'), 'both ids listed');
    assert.ok(multi.out.includes('first chat') && multi.out.includes('second chat'), 'both titles listed');
    assert.ok(multi.out.includes(folder), 'folder listed');
    assert.ok(multi.out.includes(' / ') && multi.out.includes('UniqMultiWord'), 'body snippet shown after a slash');
    const none = runBin('UniqAbsentWord');
    assert.equal(none.status, 1);
    assert.ok(none.out.includes('会話が見つかりません: UniqAbsentWord'), 'old not-found unchanged: ' + none.out);
    assert.ok(!none.out.includes('検索に当てはまる'), 'no search wording on a plain miss');
  } finally { for (const d of [data, home, folder]) fs.rmSync(d, {recursive: true, force: true}); }
});
class FakeAgent extends EventEmitter {
  constructor(cwd) { super(); this.mode = 'default'; this.cwd = cwd; this.session = {id: 'x', turns: 0}; this.ctx = {readFiles: new Set(), todos: []}; this.client = {status: 'connected'}; this.allowAlways = new Set(); this.device = {connected: true}; }
}
FakeAgent.DEVICE = 'test';
const notesWith = (ctrl, re) => ctrl.get().entries.filter(e => e.type === 'note' && re.test(e.lines.join('\n')));
test('w15 TUI /resume: one search hit in the folder resumes it', async () => {
  resetStore();
  const {Controller} = await import('../src/ui/controller.mjs');
  const dir = fs.mkdtempSync(path.join(TMP, 'muser-w15tui-'));
  try {
    make('tui-decoy-1', {cwd: dir, title: 'decoy chat', updated: 5000}); turn('tui-decoy-1', 'decoy body');
    make('tui-target-1', {cwd: dir, title: 'target chat', updated: 4000}); turn('tui-target-1', 'the body holds TuiNeedleSingle');
    const agent = new FakeAgent(dir); const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
    await ctrl.slash('/resume TuiNeedleSingle');
    assert.equal(agent.session.id, 'tui-target-1'); assert.equal(notesWith(ctrl, /見つかりません/).length, 0); assert.equal(notesWith(ctrl, /再開: target chat/).length, 1);
    clearTimeout(ctrl.flashTimer);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
test('w15 TUI /resume: several hits open the search menu, picking a row resumes that row', async () => {
  resetStore();
  const {Controller} = await import('../src/ui/controller.mjs');
  const dir = fs.mkdtempSync(path.join(TMP, 'muser-w15tui-'));
  try {
    make('tui-decoy-2', {cwd: dir, title: 'decoy chat', updated: 9000}); turn('tui-decoy-2', 'decoy body');
    make('tui-multi-1', {cwd: dir, title: 'multi one', updated: 8000}); turn('tui-multi-1', 'first body holds TuiNeedleMulti');
    make('tui-multi-2', {cwd: dir, title: 'multi two', updated: 7000}); turn('tui-multi-2', 'second body holds TuiNeedleMulti');
    const agent = new FakeAgent(dir); const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
    await ctrl.slash('/resume TuiNeedleMulti');
    const menu = ctrl.get().menu;
    assert.ok(menu, 'a menu opened'); assert.equal(menu.title, '検索: TuiNeedleMulti'); assert.equal(menu.options.length, 2);
    assert.deepEqual(menu.options.map(o => o.session && o.session.id).sort(), ['tui-multi-1', 'tui-multi-2']);
    assert.ok(menu.options.every(o => o.desc.includes('TuiNeedleMulti')), JSON.stringify(menu.options.map(o => o.desc)));
    assert.equal(notesWith(ctrl, /見つかりません/).length, 0);
    const opt = menu.options.find(o => o.session.id === 'tui-multi-2'); await menu.pick(opt.value, opt);
    assert.equal(agent.session.id, 'tui-multi-2'); clearTimeout(ctrl.flashTimer);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
test('w15 TUI /resume: no hits keeps the old note; a digit arg is not searched', async () => {
  resetStore();
  const {Controller} = await import('../src/ui/controller.mjs');
  const dir = fs.mkdtempSync(path.join(TMP, 'muser-w15tui-'));
  try {
    make('tui-decoy-3', {cwd: dir, title: 'decoy 999 chat', updated: 5000}); turn('tui-decoy-3', 'body with 999 inside');
    const agent = new FakeAgent(dir); const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
    await ctrl.slash('/resume TuiAbsentWord');
    assert.equal(notesWith(ctrl, /見つかりません: TuiAbsentWord/).length, 1);
    await ctrl.slash('/resume 999');
    assert.equal(notesWith(ctrl, /見つかりません: 999/).length, 1, 'digit arg is not a search');
    assert.ok(!ctrl.get().menu, 'no search menu for a digit arg'); clearTimeout(ctrl.flashTimer);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
