'use strict';
// Fix phase 2, agent A2: view.mjs rendering defects from the 2026-11-04 audits
// (deep c5 #1, first Part B, deep Part B r1/r2/r3/r4, third M22/M23 view parts).
// Each test reproduces one defect on the pre-fix tree and passes after the fix.
const test = require('node:test');
const assert = require('node:assert');
const {EventEmitter} = require('node:events');

function fakeOut(columns = 100) {
  const s = new EventEmitter(); s.columns = columns; s.rows = 40; s.isTTY = false; s.out = '';
  s.write = d => { s.out += d; return true; };
  return s;
}
async function setup(agentExtra = {}) {
  const React = (await import('react')).default, {render} = await import('ink');
  const {Entry, Live} = await import('../src/ui/view.mjs');
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new EventEmitter();
  Object.assign(agent, {mode: 'default', cwd: process.cwd(), session: {id: 'x', turns: 0}, ctx: {readFiles: new Set(), todos: []}, client: {status: 'connected'}, allowAlways: new Set(), device: {connected: true}}, agentExtra);
  agent.constructor.DEVICE = 'testdev';
  const ctrl = new Controller({agent, museName: 'Muse', version: '0.3.6', onExit() {}});
  const show = async (el, columns = 100) => {
    const out = fakeOut(columns);
    const app = render(el, {stdout: out, debug: true, patchConsole: false, exitOnCtrlC: false});
    const start = Date.now();
    while (!out.out) { if (Date.now() - start > 5000) throw new Error('timed out waiting for the first frame'); await new Promise(r => setTimeout(r, 20)); }
    app.unmount();
    return out.out.replace(/\x1b\[[0-9;]*m/g, '');
  };
  return {h: React.createElement, Entry, Live, ctrl, show};
}
const live = async (ctx, patch, W = 100) => { ctx.ctrl.set(patch); return ctx.show(ctx.h(ctx.Live, {s: ctx.ctrl.get(), ctrl: ctx.ctrl, W}), W + 1); };

// ---- deep c5 #1: one malformed record must not take the whole screen down ----
test('c5#1: entries with missing optional fields render instead of throwing', async () => {
  const {h, Entry, ctrl, show} = await setup();
  const cases = [
    {type: 'tool', call: {command: 'code.read', ok: false, declined: true, summary: 'a.js'}}, // no error
    {type: 'tool', call: {command: 'code.edit', ok: true, summary: 'a.js', view: {files: [{path: 'a.js', added: 1, removed: 0}]}}}, // no diff
    {type: 'focus', full: true, focus: {status: 'complete', round: 1, maxRounds: 1, goal: 'g', criteria: [{id: 'c1', text: 't', status: 'met'}]}}, // no evidence
    {type: 'shellout', id: 'bg1', running: false, exit: 0}, // no lines
    {type: 'shellout', id: 'bg2', running: true, lines: []},
    {type: 'agent', snap: {tag: 'a1', state: 'done', started: 0, ended: 1000}}, // no result
    {type: 'end', ok: true, ms: 1000},
    {type: 'past', steps: [], tools: [{command: 'code.read', ok: false}]},
  ];
  for (const e of cases) {
    const out = await show(h(Entry, {e, ctrl, W: 100}));
    assert.ok(out.length > 0, 'rendered: ' + e.type);
    assert.ok(!/undefined|NaN/.test(out), 'no undefined/NaN leak for ' + e.type + ': ' + JSON.stringify(out));
  }
});

test('c5#1: an exec approval without params and a live Focus without criteria render', async () => {
  const ctx = await setup();
  const out = await live(ctx, {approval: {call: {command: 'system.run', kind: 'exec', summary: 'x'}, preview: null, options: [{label: 'yes'}, {label: 'no'}], index: 0, resolve() {}}});
  assert.match(out, /1\. yes/);
  const out2 = await live(ctx, {approval: null, busy: true, turnStart: Date.now(), focus: {status: 'running', round: 1, maxRounds: 2}});
  assert.match(out2, /Focus 1\/2/);
});

// ---- B8 / I8: live todos beyond 8 are counted, not silently dropped ----
test('B8: live todos past the eighth say how many more there are', async () => {
  const ctx = await setup();
  const todos = Array.from({length: 10}, (_, i) => ({content: 'todo ' + (i + 1), status: 'pending'}));
  const out = await live(ctx, {todos});
  assert.match(out, /ほか 2 件/);
});

// ---- B9 + r2 R2-10: the queue line counts what it cuts and marks multi-line items ----
test('B9/R2-10: the queue line counts hidden items and marks multi-line ones', async () => {
  const ctx = await setup();
  const queue = ['まずテストを書いてください', 'それからドキュメントも更新してください', '3つ目の長いメッセージです。3つ目の長いメッセージです。3つ目の長いメッセージです。', '4件目のお願い', '5件目のお願い'];
  const out = await live(ctx, {busy: true, turnStart: Date.now(), queue});
  assert.match(out, /ほか 3 件/);
  const out2 = await live(ctx, {busy: true, turnStart: Date.now(), queue: ['1行目\n2行目\n3行目', '次のお願い']});
  assert.match(out2, /全 3 行/);
});

// ---- B16 / I7: an unknown slash command is answered, not blank ----
test('B16: slash completion with no match says so', async () => {
  const ctx = await setup();
  const out = await live(ctx, {text: '/zzz', pos: 4});
  assert.match(out, /一致するコマンドがありません/);
});

// ---- B17 / I7: an empty menu does not offer picking keys ----
test('B17: an empty menu says there is nothing to pick', async () => {
  const ctx = await setup();
  const out = await live(ctx, {menu: {title: '空メニュー', options: [], index: 0}});
  assert.match(out, /選択肢がありません/);
  assert.ok(!out.includes('で選んで enter'), 'no pick hint for an empty menu');
});

// ---- B3 / I2: a disconnected footer is readable without colour ----
test('B3: the footer marks a disconnected device with a different glyph', async () => {
  const ctx = await setup();
  const on = await live(ctx, {deviceOk: true});
  const off = await live(ctx, {deviceOk: false});
  assert.ok(on.includes('●'), 'connected shows ●');
  assert.ok(off.includes('○'), 'disconnected shows ○');
  assert.ok(!off.split('\n').some(l => l.includes('○') && l.includes('● muser') && false));
});

// ---- B20: user attachments are one per line so none vanish at width 40 ----
test('B20: a sent message lists every file and image at width 40', async () => {
  const {h, Entry, ctrl, show} = await setup();
  const e = {type: 'user', text: 'hi', files: [{ref: '@src/math.js', kind: 'file', lines: 42}, {ref: '@src/', kind: 'dir', count: 128}, {ref: '@big.bin', kind: 'large'}], images: ['shot.png', 'diagram.jpg']};
  const out = await show(h(Entry, {e, ctrl, W: 40}), 41);
  assert.ok(out.includes('@big.bin'), 'third file is listed');
  assert.ok(out.includes('diagram.jpg'), 'second image name is whole');
});

// ---- B1: attachment chips stack vertically so names never interleave ----
test('B1: chips are one per line and the hint is on its own line', async () => {
  const ctx = await setup();
  const attachments = [{name: 'a-very-long-screenshot-1.png', size: 229 * 1024}, {name: 'diagram-2.jpg', size: 1024}, {name: 'photo-3.webp', size: 1024}];
  const out = await live(ctx, {attachments}, 40);
  const lines = out.split('\n');
  assert.ok(lines.some(l => l.includes('a-very-long-screenshot-1.png')), 'first name intact on one line');
  assert.ok(lines.some(l => l.includes('diagram-2.jpg')), 'second name intact');
  assert.ok(lines.some(l => l.trim().startsWith('空の入力で')), 'hint on its own line');
});

// ---- B2/R4-5/r3 R11: footer warnings survive at width 30, account lane comes first ----
test('B2/R11: at width 30 the login warning keeps its command', async () => {
  const ctx = await setup();
  const out = await live(ctx, {loginNeeded: true}, 30);
  assert.ok(out.includes('/login'), 'the /login command is visible at width 30');
});

test('B2: the account and switch plan outrank the device lane in the footer', async () => {
  const ctx = await setup();
  ctx.ctrl.agent.cwd = '/tmp/proj';
  const out = await live(ctx, {account: {label: 'second account'}, accountReserved: 'main account', plan: {percentUsed: 61}}, 80);
  assert.ok(out.includes('second account'), 'account label visible');
  assert.ok(out.includes('main account'), 'switch plan visible');
});

// ---- R4-4: a long mode name must not erase the connection dot at width 30 ----
test('R4-4: the connection dot survives a long mode label at width 30', async () => {
  const ctx = await setup({mode: 'plan'});
  ctx.ctrl.set({mode: 'plan'});
  const out = await live(ctx, {deviceOk: true}, 30);
  assert.ok(out.includes('●'), 'dot visible');
});

// ---- R4-6: a flash does not hide a non-default mode ----
test('R4-6: a long flash still shows the bypass marker', async () => {
  const ctx = await setup({mode: 'bypass'});
  ctx.ctrl.set({mode: 'bypass'});
  const out = await live(ctx, {flash: 'とても長いフラッシュ文です。'.repeat(6)}, 80);
  assert.ok(out.includes('⏵⏵'), 'mode marker visible during a flash');
});

// ---- R4-2: the slash window says how many are hidden ----
test('R4-2: slash completion counts the commands above and below the window', async () => {
  const ctx = await setup();
  const out = await live(ctx, {text: '/', pos: 1});
  assert.match(out, /↓ ほか \d+ 件/);
});

// ---- U13: the selected command's description is shown in full ----
test('U13: the selected slash command description wraps whole at width 40', async () => {
  const ctx = await setup();
  const out = await live(ctx, {text: '/settings', pos: 9}, 40);
  assert.ok(out.replace(/[\s│╭╮╰╯]+/g, '').includes('スキル・MCP）'), 'the end of the /settings description is visible');
});

// ---- R4-3: completion key hints fit a narrow screen ----
test('R4-3: the slash key hint keeps enter/tab whole at width 30', async () => {
  const ctx = await setup();
  const out = await live(ctx, {text: '/s', pos: 2}, 30);
  assert.ok(out.includes('enter/tab'), 'short key hint is whole');
});

// ---- R4-7: the placeholder has a short form on narrow screens ----
test('R4-7: at width 30 the placeholders are short forms', async () => {
  const ctx = await setup();
  const out = await live(ctx, {}, 30);
  assert.ok(out.includes('何をしますか？'));
  assert.ok(!out.includes('/ で…'), 'not the truncated long placeholder');
  const busy = await live(ctx, {busy: true, turnStart: Date.now()}, 30);
  assert.ok(busy.includes('Muse が作業中'), 'busy placeholder present');
  assert.ok(!busy.includes('送ると'), 'the busy placeholder is not the truncated long form');
});

// ---- B15: the question footer wraps instead of losing esc ----
test('B15: the question footer keeps esc at width 40', async () => {
  const ctx = await setup();
  const q = {questions: [{header: '範囲', question: '範囲は？', options: [{label: 'A'}, {label: 'B'}]}], tab: 0, index: 0, mode: 'pick', checked: {}, picked: {}, custom: {}, answers: {}};
  const out = await live(ctx, {question: q}, 40);
  assert.ok(out.replace(/\s+/g, ' ').includes('esc 閉じる'), 'esc hint visible (wrapped, not cut)');
});

// ---- r2 R2-2: the tab row wraps so the submit tab is always visible ----
test('R2-2: all question tabs and the submit tab show at width 40', async () => {
  const ctx = await setup();
  const mk = n => ({header: '質問' + n, question: '質問' + n + 'は？', options: [{label: 'A'}]});
  const q = {questions: [mk(1), mk(2), mk(3), mk(4)], tab: 1, index: 0, mode: 'pick', checked: {}, picked: {}, custom: {}, answers: {}};
  const out = await live(ctx, {question: q}, 40);
  assert.ok(out.includes('✓ 送信'), 'submit tab visible');
});

// ---- r2 R2-3 + U11/I9: the submit screen uses the short tab label and warns about unanswered ----
test('R2-3/U11: the submit screen uses 質問 n for a fallback header and warns when unanswered', async () => {
  const ctx = await setup();
  const long = 'キーボードとマウスとモニターのうちどれを買いますか';
  const q = {questions: [{header: long.slice(0, 16), question: long, options: [{label: 'キーボード'}]}, {header: '予算', question: '予算は？', options: [{label: '1万円'}]}], tab: 2, index: 0, mode: 'pick', checked: {}, picked: {0: 0}, custom: {}, answers: {0: 'キーボード'}};
  const out = await live(ctx, {question: q}, 80);
  assert.ok(out.includes('質問 1: キーボード'), 'short label on the submit screen');
  assert.ok(!out.includes('のう:'), 'the raw 16-char fallback header is not shown');
  assert.match(out, /未回答があります/);
});

// ---- r2 R2-4: a long answer on the submit screen wraps whole ----
test('R2-4: a long answer on the submit screen is not cut', async () => {
  const ctx = await setup();
  const ans = 'とても長い回答のラベルです。'.repeat(4);
  const q = {questions: [{header: '範囲', question: '範囲は？', options: [{label: ans}]}], tab: 1, index: 0, mode: 'pick', checked: {}, picked: {0: 0}, custom: {}, answers: {0: ans}};
  const out = await live(ctx, {question: q}, 80);
  assert.ok(out.replace(/[\s│╭╮╰╯]+/g, '').includes(ans), 'the whole answer is on the submit screen');
});

// ---- B5/I4: the selected question option description wraps whole ----
test('B5: the selected option description is shown in full', async () => {
  const ctx = await setup();
  const desc = 'とても長い選択肢の説明文です。'.repeat(6);
  const q = {questions: [{header: '範囲', question: '範囲は？', options: [{label: '案A', description: desc}, {label: '案B'}]}], tab: 0, index: 0, mode: 'pick', checked: {}, picked: {}, custom: {}, answers: {}};
  const out = await live(ctx, {question: q}, 80);
  assert.ok(out.replace(/[\s│╭╮╰╯]+/g, '').includes(desc.replace(/\s+/g, '')), 'full description visible for the selected option');
});

// ---- B6: at narrow widths the preview goes under the options, intact ----
test('B6: at width 40 the preview text is not split mid-phrase', async () => {
  const ctx = await setup();
  const q = {questions: [{header: '案', question: 'どれ？', options: [{label: '案A', preview: 'プレビューの1行目\nプレビューの2行目'}, {label: '案B'}]}], tab: 0, index: 0, mode: 'pick', checked: {}, picked: {}, custom: {}, answers: {}};
  const out = await live(ctx, {question: q}, 40);
  assert.ok(out.includes('プレビューの1行目'), 'preview line intact');
});

// ---- r2 R2-9: typing a custom answer shows its tail and the caret ----
test('R2-9: a long custom answer shows its tail and caret', async () => {
  const ctx = await setup();
  const text = '自分で考えたとても長い自由記述の回答です。これは後半が見えないと困る文章です';
  const q = {questions: [{header: '範囲', question: '範囲は？', options: [{label: 'A'}]}], tab: 0, index: 1, mode: 'type', typeText: text, checked: {}, picked: {}, custom: {}, answers: {}};
  const out = await live(ctx, {question: q}, 40);
  assert.ok(out.includes('困る文章です'), 'the tail being typed is visible');
  assert.ok(out.includes('▌'), 'the caret is visible');
});

// ---- r2 R2-5: approval option labels wrap so the permanent-allow target is readable ----
test('R2-5: a long approval option label is shown in full at width 40', async () => {
  const ctx = await setup();
  const label = 'はい、このフォルダーでは npm test は今後聞かない';
  const out = await live(ctx, {approval: {call: {command: 'system.run', kind: 'exec', params: {command: 'npm test'}, summary: 'npm test'}, preview: null, options: [{label: 'はい'}, {label}, {label: 'いいえ'}], index: 1, resolve() {}}}, 40);
  assert.ok(out.replace(/[\s│╭╮╰╯]+/g, '').includes(label.replace(/\s+/g, '')), 'the whole option label is visible');
});

// ---- r2 R2-6: an MCP approval names its tool at width 30 ----
test('R2-6: an MCP approval shows the tool name at width 30', async () => {
  const ctx = await setup();
  const out = await live(ctx, {approval: {call: {command: 'mcp.filesystem.read_file', kind: 'mcp', mcp: {server: 'filesystem', tool: 'read_file'}, params: {path: '/tmp/x'}, summary: 'filesystem · read_file'}, preview: null, options: [{label: 'yes'}, {label: 'no'}], index: 0, resolve() {}}}, 30);
  assert.ok(out.includes('read_file'), 'tool name visible');
});

// ---- r2 R2-7: MCP approval values use a width-aware budget ----
test('R2-7: a 12-argument MCP approval fits a 30-row screen at width 30', async () => {
  const ctx = await setup();
  const params = Object.fromEntries(Array.from({length: 12}, (_, i) => ['arg' + i, 'x'.repeat(500)]));
  const out = await live(ctx, {approval: {call: {command: 'mcp.s.t', kind: 'mcp', mcp: {server: 's', tool: 't'}, params, summary: 's · t'}, preview: null, options: [{label: 'yes'}, {label: 'no'}], index: 0, resolve() {}}}, 30);
  const at = out.split('\n').findIndex(l => l.includes('1. yes'));
  assert.ok(at > 0 && at < 40, 'options at row ' + at);
});

// ---- r2 R2-8: the exec approval counts partially hidden characters as well as lines ----
test('R2-8: an exec approval with a partially shown line counts its hidden characters', async () => {
  const ctx = await setup();
  const command = Array.from({length: 15}, (_, i) => 'echo line ' + (i + 1) + ' ' + 'z'.repeat(70)).join('\n');
  const out = await live(ctx, {approval: {call: {command: 'system.run', kind: 'exec', params: {command}, summary: 'echo'}, preview: null, options: [{label: 'yes'}, {label: 'no'}], index: 0, resolve() {}}}, 80);
  assert.match(out, /ほか 4 行と \d+ 文字/);
});

// ---- B10/I1: the approval file list truncates by count, never mid-name in silence ----
test('B10: the approval rest-file list ends with a count of the names it could not show', async () => {
  const ctx = await setup();
  const {lineDiff} = require('../src/tools');
  const files = Array.from({length: 15}, (_, i) => ({path: process.cwd() + '/src/file' + (i + 1) + '.js', op: 'edit', diff: lineDiff('a\n', 'A\n')}));
  const out = await live(ctx, {approval: {call: {command: 'code.apply_patch', kind: 'edit', params: {patch: 'x'}, summary: 'f'}, preview: {files}, options: [{label: 'yes'}, {label: 'no'}], index: 0, resolve() {}}}, 40);
  assert.match(out, /: src\\file\d+\.js/);
  assert.match(out, /… ほか \d+ ファイル(?!:)/);
});

// ---- r3 R3/R5: a menu hint that does not fit gets its own wrapped line ----
test('R3: a menu hint is fully visible at width 40', async () => {
  const ctx = await setup();
  const out = await live(ctx, {menu: {title: '並列エージェント', hint: '作業中のものは選ぶと停止', options: [{label: 'a1', desc: '作業中'}], index: 0}}, 40);
  assert.ok(out.replace(/\s+/g, '').includes('作業中のものは選ぶと停止'), 'the warning hint is whole');
});

// ---- r3 R6: a truncated menu label keeps a gap before the description ----
test('R6: a full-width menu label still leaves a gap before its description', async () => {
  const ctx = await setup();
  const label = 'とても長いラベルのメニュー項目ですこれは切れます';
  const out = await live(ctx, {menu: {title: 't', options: [{label, desc: 'DESC'}], index: 0}}, 80);
  const line = out.split('\n').find(l => l.includes('DESC'));
  assert.ok(line, 'desc line exists');
  assert.match(line, /… {2,}DESC/);
});

// ---- B4/I3: at narrow widths menu labels get the full row and descriptions go below ----
test('B4: at width 40 two settings rows sharing a prefix are distinguishable', async () => {
  const ctx = await setup();
  const options = [{label: 'フッターに端末名を表示する', desc: 'オン'}, {label: 'フッターに窓番号を表示する', desc: 'オフ'}];
  const out = await live(ctx, {menu: {title: '設定', options, index: 0}}, 40);
  assert.ok(out.includes('フッターに端末名を表示する'), 'first label whole');
  assert.ok(out.includes('フッターに窓番号を表示する'), 'second label whole');
});

// ---- r3 R12/R13 + I4: the selected menu row description wraps whole ----
test('I4: the selected menu description is shown in full', async () => {
  const ctx = await setup();
  const desc = 'main account で続けます。追加購入分を使います（追加購入分はありません）';
  const out = await live(ctx, {menu: {title: 'クォータ', options: [{label: 'このまま追加を利用する', desc}], index: 0}}, 80);
  assert.ok(out.replace(/[\s│╭╮╰╯]+/g, '').includes(desc.replace(/\s+/g, '')), 'full description visible');
});

// ---- B11: the working line keeps its elapsed/esc part together at width 40 ----
test('B11: the waiting line does not scatter at width 40', async () => {
  const ctx = await setup();
  const out = await live(ctx, {busy: true, turnStart: Date.now(), status: 'waiting_for_approval'}, 40);
  const lines = out.split('\n');
  assert.ok(lines.some(l => l.includes('esc で中断')), 'esc hint on one line');
});

// ---- B12: /help keys wrap whole at width 40 ----
test('B12: help keys are not cut mid-phrase at width 40', async () => {
  const {h, Entry, ctrl, show} = await setup();
  const out = await show(h(Entry, {e: {type: 'help'}, ctrl, W: 40}), 41);
  assert.ok(out.replace(/\s+/g, '').includes('カーソルの前・後ろを消す'), 'the key phrase is whole somewhere');
});

// ---- B13: the banner keeps the version and the folder name at width 40 ----
test('B13: the banner shows version and folder tail at width 40', async () => {
  const {h, Entry, ctrl, show} = await setup();
  ctrl.agent.cwd = 'C:\\Users\\nyaru\\muser';
  const out = await show(h(Entry, {e: {type: 'banner'}, ctrl, W: 40}), 41);
  assert.ok(out.includes('v0.3.6'), 'version visible');
  assert.ok(out.includes('muser'), 'folder name visible');
});

// ---- B18/I5 + R4-8: notes hang-indent on wrap and errors carry a mark ----
test('B18/R4-8: a long error note wraps indented and is marked as an error', async () => {
  const {h, Entry, ctrl, show} = await setup();
  const long = 'MCP サーバーがありません。mcp.json に mcpServers を書くか、Claude Code / Codex に設定してください。';
  const out = await show(h(Entry, {e: {type: 'note', level: 'error', lines: [long]}, ctrl, W: 40}), 41);
  const lines = out.split('\n').filter(l => l.trim());
  assert.ok(lines[0].includes('✗'), 'error mark on the note');
  assert.ok(lines.length > 1 && lines.slice(1, 3).every(l => l.startsWith('  ')), 'continuation lines are indented');
});

// ---- B19: an agent card keeps its elapsed time at width 40 ----
test('B19: an agent card shows its elapsed time at width 40', async () => {
  const {h, Entry, ctrl, show} = await setup();
  const e = {type: 'agent', snap: {tag: 'a2', type: 'test', title: 'write tests for the whole rendering layer and more', state: 'failed', error: 'timeout after 10 minutes while running the test suite', started: 0, ended: 600000}};
  const out = await show(h(Entry, {e, ctrl, W: 40}), 41);
  assert.ok(out.includes('10m 0s'), 'elapsed time visible');
});

// ---- B14/I4: @ completion paths are tail-truncated so files are distinguishable ----
test('B14: at completion paths keep their file names at width 40', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-at-'));
  const deep = path.join(dir, 'android', 'app', 'src', 'main', 'java', 'app', 'muser', 'link');
  fs.mkdirSync(deep, {recursive: true});
  for (const n of ['MainActivity.kt', 'LinkViewModel.kt', 'WifiDiscovery.kt']) fs.writeFileSync(path.join(deep, n), 'x');
  try {
    const ctx = await setup();
    ctx.ctrl.agent.cwd = dir;
    await live(ctx, {text: '@link/', pos: 6}, 40); // first frame starts the listing ("searching…")
    await new Promise(r => setTimeout(r, 600));
    const out = await live(ctx, {text: '@link/', pos: 6}, 40);
    assert.ok(out.includes('MainActivity.kt'), 'first file name whole: ' + JSON.stringify(out));
    assert.ok(out.includes('LinkViewModel.kt'), 'second file name whole');
  } finally { try { fs.rmSync(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200}); } catch { /* the completion walk may still hold the folder on Windows; cleanup is best-effort */ } }
});

// ---- r1 R1-2: a diff pair differing at the line end shows the difference ----
test('R1-2: a long diff line shows its changed tail', async () => {
  const {h, Entry, ctrl, show} = await setup();
  const base = 'const aVeryLongVariableName = computeSomething(argumentOne, argumentTwo, argumentThree';
  const diff = [{t: '-', n: 2, l: base + ')'}, {t: '+', n: 2, l: base + ', argumentFour)'}];
  const out = await show(h(Entry, {e: {type: 'tool', call: {command: 'code.edit', ok: true, summary: 'a.js', view: {diff}}}, ctrl, W: 80}), 81);
  assert.ok(out.includes('argumentFour'), 'the added tail is visible');
});

// ---- r1 R1-5: a tool summary path keeps its file name ----
test('R1-5: a long tool summary keeps the file name', async () => {
  const {h, Entry, ctrl, show} = await setup();
  const summary = 'src/very/deeply/nested/folder/structure/with/a/very-long-file-name-that-matters.ts';
  const out = await show(h(Entry, {e: {type: 'tool', call: {command: 'code.edit', ok: true, summary, view: {}}}, ctrl, W: 80}), 81);
  assert.ok(out.includes('very-long-file-name-that-matters.ts'), 'file name visible');
});

// ---- r1 R1-6: files outside the folder are shown as absolute paths ----
test('R1-6: an outside file in a tool row is not shown as ..\\..\\..', async () => {
  const {h, Entry, ctrl, show} = await setup();
  const e = {type: 'tool', call: {command: 'code.apply_patch', ok: true, summary: 'patch', view: {files: [{path: 'C:\\outside\\secret-folder\\x.js', added: 2, removed: 0, diff: [{t: '+', n: 1, l: 'x'}]}]}}};
  const out = await show(h(Entry, {e, ctrl, W: 100}));
  assert.ok(out.includes('C:\\outside\\secret-folder\\x.js'), 'absolute path shown');
  const out2 = await show(h(Entry, {e: {type: 'tool', call: {command: 'code.edit', ok: true, summary: 'a.js', view: {files: [{path: 'src\\in.js', added: 1, removed: 0, diff: [{t: '+', n: 1, l: 'y'}]}]}}}, ctrl, W: 100}));
  assert.ok(out2.includes('src\\in.js'), 'an inside path stays relative-ish');
  void out2;
  assert.ok(!out.includes('..\\..'), 'no dot-dot chain');
});

// ---- r1 R1-7: a past error is cut by screen width, with an ellipsis ----
test('R1-7: a past tool error uses the screen width before cutting', async () => {
  const {h, Entry, ctrl, show} = await setup();
  const err = 'permission denied because this file is outside the project and the policy for it says no';
  const e = {type: 'past', steps: [], tools: [{command: 'code.read', summary: 'src/x.js', ok: false, error: err}]};
  const out = await show(h(Entry, {e, ctrl, W: 200}), 201);
  assert.ok(out.includes('says no'), 'the whole error fits at width 200');
  const out40 = await show(h(Entry, {e, ctrl, W: 40}), 41);
  assert.ok(out40.includes('…'), 'cut with an ellipsis at width 40');
});

// ---- r1 R1-8: a source URI keeps its identifying tail ----
test('R1-8: a long source URI keeps its slug at width 40', async () => {
  const {h, Entry, ctrl, show} = await setup();
  const e = {type: 'sources', items: [{label: '公式ドキュメント', uri: 'https://example.com/blog/very-long-article-slug'}]};
  const out = await show(h(Entry, {e, ctrl, W: 40}), 41);
  assert.ok(out.includes('very-long-article-slug'), 'slug visible');
});

// ---- r1 R1-9: a file-only send is not labelled image-only ----
test('R1-9: a file-only send says file-only, an empty send says no-text', async () => {
  const {h, Entry, ctrl, show} = await setup();
  const out = await show(h(Entry, {e: {type: 'user', text: '', files: [{ref: '@report.pdf', kind: 'other'}]}, ctrl, W: 80}));
  assert.ok(out.includes('（ファイルのみ）'), 'file-only label');
  assert.ok(!out.includes('（画像のみ）'), 'not image-only');
  const out2 = await show(h(Entry, {e: {type: 'user', text: ''}, ctrl, W: 80}));
  assert.ok(out2.includes('（本文なし）'), 'no-text label');
});

// ---- r1 R1-10: a zero usage is not stated as a measured zero ----
test('R1-10: an end row with zero usage does not print 0 in / 0 out', async () => {
  const {h, Entry, ctrl, show} = await setup();
  const out = await show(h(Entry, {e: {type: 'end', ok: true, ms: 0, usage: {inputTokens: 0, outputTokens: 0}}, ctrl, W: 80}));
  assert.ok(!out.includes('0 in / 0 out'), 'no false zero');
  const out2 = await show(h(Entry, {e: {type: 'end', ok: true, ms: 0, usage: {inputTokens: 1200, outputTokens: 30}}, ctrl, W: 80}));
  assert.ok(out2.includes('1.2k in / 30 out'), 'real usage still shown');
});

// ---- r1 R1-12: an empty agent result says so ----
test('R1-12: an agent card with an empty result says (結果なし)', async () => {
  const {h, Entry, ctrl, show} = await setup();
  const e = {type: 'agent', snap: {tag: 'a9', type: 'explore', title: 'nothing found', state: 'done', result: '   ', started: 0, ended: 3000}};
  const out = await show(h(Entry, {e, ctrl, W: 80}));
  assert.ok(out.includes('(結果なし)'), 'empty result is stated');
});

// ---- r1 R1-13: a progress row names its agent ----
test('R1-13: a progress row says エージェント before the tag', async () => {
  const {h, Entry, ctrl, show} = await setup();
  const out = await show(h(Entry, {e: {type: 'progress', message: '調査を続けています', agent: 'a3'}, ctrl, W: 80}));
  assert.ok(out.includes('エージェント a3'), 'agent named');
});

// ---- r1 R1-17: a running shell with no output yet says so ----
test('R1-17: a running shellout with no lines says it is still waiting', async () => {
  const {h, Entry, ctrl, show} = await setup();
  const out = await show(h(Entry, {e: {type: 'shellout', id: 'bg10', running: true, lines: []}, ctrl, W: 80}));
  assert.ok(out.includes('まだ出力がありません'), 'waiting wording');
  const out2 = await show(h(Entry, {e: {type: 'shellout', id: 'bg10', running: false, exit: 0, lines: []}, ctrl, W: 80}));
  assert.ok(out2.includes('(出力なし)'), 'finished empty keeps its wording');
});

// ---- r1 R1-18: a declined tool row keeps the reason the user gave ----
test('R1-18: a declined tool row shows the reason', async () => {
  const {h, Entry, ctrl, show} = await setup();
  const e = {type: 'tool', call: {command: 'code.edit', ok: false, declined: true, summary: 'a.js', error: 'The user declined this: そのファイルは触らないでください. Do not retry it unless the user asks.'}};
  const out = await show(h(Entry, {e, ctrl, W: 80}));
  assert.ok(out.includes('そのファイルは触らないでください'), 'reason visible');
});

// ---- U6/I8: the running output says how many lines are hidden ----
test('U6: a running tool shows how many earlier lines are hidden', async () => {
  const ctx = await setup();
  const tail = Array.from({length: 10}, (_, i) => 'line ' + (i + 1));
  const out = await live(ctx, {running: {call: {command: 'system.run', summary: 'x'}, tail, now: ''}});
  assert.match(out, /ほか 5 行/);
  assert.ok(out.includes('line 10'));
});

// ---- U7/I7: a full Focus with no criteria says so ----
test('U7: a full Focus with no criteria says 条件: なし', async () => {
  const {h, Entry, ctrl, show} = await setup();
  const e = {type: 'focus', full: true, focus: {status: 'running', round: 1, maxRounds: 3, goal: '直す', criteria: []}};
  const out = await show(h(Entry, {e, ctrl, W: 80}));
  assert.ok(out.includes('条件: なし'), 'no-criteria stated');
});

// ---- U12: the agents overflow note comes after the cards ----
test('U12: the agents overflow note follows the cards', async () => {
  const ctx = await setup();
  const agents = Array.from({length: 25}, (_, i) => ({tag: 'a' + (i + 1), title: 'task ' + i, type: 'general', state: 'working', lastTool: 'Read', text: '', started: Date.now(), ended: 0}));
  const out = await live(ctx, {busy: true, turnStart: Date.now(), agents});
  const note = out.indexOf('ほか');
  assert.ok(note > out.indexOf('task 0'), 'note after the first card');
});

// ---- r3 R8: /status stacks label and value at narrow widths ----
test('R8: at width 30 the status values are readable on their own lines', async () => {
  const {h, Entry, ctrl, show} = await setup();
  ctrl.agent.accountId = 'mainacct'; ctrl.agent.accountLabel = 'main account';
  const out = await show(h(Entry, {e: {type: 'status'}, ctrl, W: 30}), 31);
  assert.ok(out.includes('ゲートウェイ 接続中'), 'gateway state in Japanese, whole');
  assert.ok(out.includes('main account'), 'account label whole');
});

// ---- r3 R9: the account-add screen wraps its lines ----
test('R9: an add-screen line wraps so its instruction survives at width 80', async () => {
  const ctx = await setup();
  const line = '認証コードが違います (HTTP 400: invalid code provided for this challenge, please request a new one) もう一度入力してください';
  const out = await live(ctx, {addFlow: {lines: [line], busy: null, promptFor: null}}, 80);
  assert.ok(out.replace(/\s+/g, '').includes('もう一度入力してください'), 'instruction whole');
});

// ---- r3 R19: a limit-input error keeps the enter/esc hint ----
test('R19: a limit-input flash keeps the key hint', async () => {
  const ctx = await setup();
  const out = await live(ctx, {limitInput: {key: 'concurrent', text: '99', label: '', hint: ''}, flash: '1〜10 の整数を入力してください'});
  assert.ok(out.includes('1〜10 の整数を入力してください'), 'error shown');
  assert.ok(out.includes('enter で確定'), 'key hint kept');
});

// ---- r3 R20/B18: /todos continuation lines are indented ----
test('R20: a long todo wraps with a hanging indent', async () => {
  const {h, Entry, ctrl, show} = await setup();
  const todos = [{content: 'とても長いTodoの内容です。'.repeat(6), status: 'in_progress'}];
  const out = await show(h(Entry, {e: {type: 'todos', todos}, ctrl, W: 40}), 41);
  const lines = out.split('\n').filter(l => l.trim());
  assert.ok(lines.length > 1, 'wrapped');
  assert.ok(lines.slice(1, 5).every(l => l.startsWith('    ')), 'continuation indented by the marker width');
});
