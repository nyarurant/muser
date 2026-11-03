'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {EventEmitter} = require('node:events');

class FakeAgent extends EventEmitter {
  constructor(cwd) {
    super();
    this.mode = 'default'; this.cwd = cwd; this.session = {id: 'x', turns: 0}; this.ctx = {readFiles: new Set()};
    this.client = {status: 'connected'}; this.allowAlways = new Set(); this.device = {connected: true};
  }
}
FakeAgent.DEVICE = 'test';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'muser-1101f-'));

test('mentions: balanced ) in filenames (image (1).png) survives fragment and expand', async () => {
  const m = require('../src/mentions');
  assert.deepEqual(m.mentions('@image(1).png'), ['image(1).png']);
  assert.deepEqual(m.mentions('look @image (1).png please'), ['image (1).png']);
  assert.deepEqual(m.mentions('@"image (1).png"'), ['image (1).png']);
  assert.deepEqual(m.mentions('(see @a.txt)'), ['a.txt'], 'an unmatched ) is still sentence punctuation');
  assert.deepEqual(m.fragmentAt('@image(1).pn', 12), {start: 1, fragment: 'image(1).pn'});
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'image(1).png'), 'x');
  const ex = m.expand('@image(1).png', dir, new Set());
  assert.deepEqual(ex.missing, []);
  assert.equal(ex.files[0].ref, 'image(1).png');
});

test('mentions: one completion limit, and invalidate() refreshes the cached list', async () => {
  const m = require('../src/mentions');
  const dir = tmp();
  for (let i = 0; i < 9; i++) fs.writeFileSync(path.join(dir, 'f' + i + '.txt'), '');
  await m.ready(dir);
  assert.equal(m.complete('f', dir).length, m.COMPLETE_LIMIT);
  assert.equal(m.COMPLETE_LIMIT, 6);
  fs.writeFileSync(path.join(dir, 'newfile.txt'), '');
  m.invalidate(dir);
  await m.ready(dir);
  assert.deepEqual(m.complete('newfile', dir), ['newfile.txt']);
});

test('term width: grapheme clusters (ZWJ / modifiers / combining) count once', () => {
  const {width} = require('../src/tui/term');
  assert.equal(width('abc'), 3);
  assert.equal(width('あ'), 2);
  assert.equal(width('👨‍👩‍👧'), 2, 'a ZWJ family is one glyph, two cells');
  assert.equal(width('👍🏽'), 2, 'a skin-tone modifier adds no width');
  assert.equal(width('é'), 1, 'a combining mark adds no width');
  assert.equal(width('1️⃣'), 2);
});

test('recovery: a flag (regional-indicator pair) measures two cells', () => {
  const {width} = require('../src/tui/term');
  assert.equal(width('🇯🇵'), 2, 'a flag used to measure 1 and shifted the layout');
});

test('recovery: rgb/bg quantize on non-truecolor terminals (child with a fake TTY)', () => {
  // term/logo read isTTY and COLORTERM at module load and disable colour
  // entirely without a TTY, so this needs a child process to observe.
  const {execFileSync} = require('node:child_process');
  const script = "process.stdout.isTTY = true; const t = require('./src/tui/term');" +
    "console.log(t.truecolor ? 'TC' : 'C256');" +
    "console.log(JSON.stringify(t.rgb(255, 0, 0)('x')));" +
    "console.log(JSON.stringify(t.c.addBg('x')));";
  const env = {...process.env}; delete env.COLORTERM;
  const out = execFileSync(process.execPath, ['-e', script], {cwd: require('node:path').join(__dirname, '..'), env, encoding: 'utf8', timeout: 60000});
  const [mode, fg, bgLine] = out.trim().split('\n');
  if (mode === 'TC') { assert.match(fg, /38;2;255;0;0/); assert.match(bgLine, /48;2;/); }
  else { assert.match(fg, /38;5;/, 'fg quantizes'); assert.match(bgLine, /48;5;/, 'bg quantizes like fg (it used to bypass)'); }
});

test('clipboard: success and failure are distinct ({files, error})', async () => {
  const clip = require('../src/clipboard');
  const r = await clip.clipboardImages();
  assert.ok(Array.isArray(r.files), 'files is an array');
  assert.ok(r.error === null || typeof r.error === 'string', 'error is null on success, a message on failure');
});

test('menus: two-digit numbers pick options 10+ (buffered first digit)', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  let picked = null;
  ctrl.openMenu({title: 'x', options: Array.from({length: 15}, (_, i) => ({value: i, label: 'o' + i})), pick: v => { picked = v; }});
  ctrl.key('1', {});
  assert.equal(picked, null, 'a lone 1 waits: it could become 10-15');
  ctrl.key('2', {});
  assert.equal(picked, 11, '1 then 2 picks the 12th option');
  // A digit that cannot grow picks at once.
  let picked2 = null;
  ctrl.openMenu({title: 'x', options: Array.from({length: 5}, (_, i) => ({value: i, label: 'o' + i})), pick: v => { picked2 = v; }});
  ctrl.key('3', {});
  assert.equal(picked2, 2);
});

test('slash: Enter on a strict prefix completes the highlighted candidate; unknown command suggests a near one', async () => {
  const {Controller, nearSlashCommand} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  ctrl.setText('/hel', 4);
  ctrl.key('', {return: true});
  assert.equal(ctrl.get().text, '/help', 'enter completed instead of submitting the unknown /hel');
  assert.equal(nearSlashCommand('/resum'), '/resume');
  assert.equal(nearSlashCommand('/zzzzz'), null);
  ctrl.slash('/hep');
  const note = ctrl.get().entries.filter(e => e.type === 'note').pop();
  assert.match(note.lines.join(''), /\/help/);
  assert.equal(note.level, 'error', 'error notes carry the error level (rendered red)');
});

test('queue: messages sent while busy land in state for the live queue line', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  ctrl.set({busy: true});
  await ctrl.submit('first queued');
  await ctrl.submit('second queued');
  assert.deepEqual(ctrl.get().queue, ['first queued', 'second queued']);
});

test('/output entries: edit diffs and long agent results are kept in full', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new FakeAgent(process.cwd());
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  agent.emit('tool-end', {id: 'e1', command: 'code.edit', summary: 'x.js', ok: true, output: '', view: {diff: [{t: '+', n: 1, l: 'added line'}, {t: '-', n: 2, l: 'gone line'}]}});
  assert.match(ctrl.outputs.at(-1).text, /\+ added line/);
  assert.match(ctrl.outputs.at(-1).text, /- gone line/);
  const long = Array.from({length: 250}, (_, i) => 'result line ' + i).join('\n');
  agent.emit('agent-done', {tag: 'a1', type: 'general', title: 'big', state: 'done', result: long, started: Date.now(), ended: Date.now()});
  assert.equal(ctrl.outputs.at(-1).text.split('\n').length, 250, 'the whole agent result is reachable via /output');
});

test('/bg view: the cut is marked and the full output is kept for /output', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new FakeAgent(process.cwd());
  const full = Array.from({length: 50}, (_, i) => 'bg line ' + i).join('\n');
  agent.shells = {all: () => [{id: 'bg1', command: 'npm run dev', running: false, exit: 0, tail: []}], output: async () => ({running: false, exit_code: 0, output: full, truncated: false}), kill() {}};
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  ctrl.slash('/bg');
  ctrl.key('1', {});
  await new Promise(r => setTimeout(r, 20));
  const entry = ctrl.get().entries.filter(e => e.type === 'shellout').pop();
  assert.equal(entry.cut, true);
  assert.equal(entry.lines.length, 30);
  assert.equal(ctrl.outputs.at(-1).text.split('\n').length, 50);
});

test('bin: --help lists -h/-V/logout/stdin; doctor and exec keep their remedies and sources', () => {
  const bin = fs.readFileSync(path.join(__dirname, '..', 'bin', 'muser.js'), 'utf8');
  for (const s of ['muser -h, --help', 'muser -V, --version', 'muser logout', '標準入力から読む', 'resume [ID] [指示]', 'Node.js 22 以上が必要です', '直し方', '出典:']) assert.ok(bin.includes(s), 'bin/muser.js contains: ' + s);
});

test('bin: help output and an unknown demo word with a suggestion', async () => {
  const run = args => new Promise(res => execFile(process.execPath, [path.join(__dirname, '..', 'bin', 'muser.js'), ...args], {env: {...process.env, MUSER_LANG: 'ja'}}, (e, out, err) => res({code: e?.code ?? 0, out, err})));
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /-V, --version/);
  assert.match(help.out, /logout\s+muse\.ai からログアウト/);
  const demo = await run(['demo', 'logn']);
  assert.equal(demo.code, 1);
  assert.match(demo.err, /もしかして: muser demo login/);
});

test('bin: --help hides pc-login, keeps login, and lists the env vars in one place', async () => {
  const run = args => new Promise(res => execFile(process.execPath, [path.join(__dirname, '..', 'bin', 'muser.js'), ...args], {env: {...process.env, MUSER_LANG: 'ja'}}, (e, out, err) => res({code: e?.code ?? 0, out, err})));
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.ok(!help.out.includes('pc-login'), 'pc-login still runs but is not listed in --help');
  assert.match(help.out, /muser login\s+muse\.ai にログインし直す/);
  assert.match(help.out, /環境変数:/);
  assert.match(help.out, /MUSER_NO_BELL/);
  assert.match(help.out, /MUSER_MAX_AGENTS/);
  const bin = fs.readFileSync(path.join(__dirname, '..', 'bin', 'muser.js'), 'utf8');
  assert.ok(bin.includes("cmd === 'pc-login'"), 'the hidden alias still dispatches');
});

test('READMEs: background is a trailing &, and the slash list matches COMMANDS', async () => {
  const en = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const ja = fs.readFileSync(path.join(__dirname, '..', 'README.ja.md'), 'utf8');
  assert.match(en, /append ` &` at the end/);
  assert.match(ja, /末尾に ` &`/);
  const {COMMANDS} = await import('../src/ui/controller.mjs');
  for (const [name] of COMMANDS) { assert.ok(en.includes('`' + name + '`'), 'README.md lists ' + name); assert.ok(ja.includes('`' + name + '`'), 'README.ja.md lists ' + name); }
});
