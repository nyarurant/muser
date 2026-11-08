'use strict';
// Parity tests for the fullscreen redraw (stage 2, worker B5): the live parts
// approval / menu / question / chips / add-screen / limit-input.
// The React side is view.mjs Live (or the exported Question): for approval,
// menu, question and limit-input a state carrying only that part renders the
// part alone; for chips and add-screen the part heads the Live output, so the
// React lines are sliced to the drawn part's line count (content compared in
// full, cell by cell, by the harness).
//
// Env comes FIRST: both sides must colourise the same way (see
// tests/fs-parity.test.js).
process.env.MUSER_LANG = 'ja';
process.env.MUSER_SGR = '1';
process.env.COLORTERM = 'truecolor';
process.env.FORCE_COLOR = '3';
delete process.env.NO_COLOR;

const {test, before} = require('node:test');
const assert = require('node:assert');
const React = require('react');
const h = React.createElement;

let parity, Live, Question, drawApproval, drawMenu, drawQuestion, drawChips, drawAddScreen, drawLimitInput;
before(async () => {
  parity = await import('./helpers/parity.mjs');
  ({Live, Question} = await import('../src/ui/view.mjs'));
  ({drawApproval} = await import('../src/ui/fs/draw/live/approval.mjs'));
  ({drawMenu} = await import('../src/ui/fs/draw/live/menu.mjs'));
  ({drawQuestion} = await import('../src/ui/fs/draw/live/question.mjs'));
  ({drawChips} = await import('../src/ui/fs/draw/live/chips.mjs'));
  ({drawAddScreen} = await import('../src/ui/fs/draw/live/add-screen.mjs'));
  ({drawLimitInput} = await import('../src/ui/fs/draw/live/limit-input.mjs'));
});

const CWD = 'C:\\Users\\nyaru\\muser-b5';
const ctrlFor = () => ({
  previewRow: () => null,
  museName: 'kaguya',
  version: '0.3.8',
  agent: {cwd: CWD, constructor: {DEVICE: 'mizuki'}, session: {id: 'abcdef0123456789', title: '', turns: 0}, client: {status: 'demo'}, nodeSlot: null, device: {connected: true}},
  slashIndex: () => 0,
  atIndex: () => 0,
});
const liveReact = s => W => parity.reactLines(h(Live, {s, ctrl: ctrlFor(), W}), W);
const check = (name, s, drawFn, exceptions = []) => {
  const used = parity.checkParity({name, react: liveReact(s), draw: W => drawFn(s, parity.baseCtx(W, {ctrl: ctrlFor()})), exceptions});
  assert.equal(used.length, exceptions.length);
};

// --- chips -------------------------------------------------------------------
const chipCases = [
  {name: 'chips: one image', s: {attachments: [{name: 'photo.png', size: 2048}]}},
  {name: 'chips: several, KB and MB', s: {attachments: [{name: 'a.jpg', size: 500}, {name: 'big-video-frame.png', size: 3 * 1024 * 1024 + 512 * 1024}]}},
  {name: 'chips: long name drops the size', s: {attachments: [{name: 'とても長いファイル名のスクリーンショット_2026-11-06_最終版-コピー-2.png', size: 123456}]}},
  {name: 'chips: no name', s: {attachments: [{size: 0}]}},
];
for (const c of chipCases) {
  test(c.name, () => {
    const s = {text: '', pos: 0, mode: 'default', agents: [], todos: [], focus: {}, ...c.s};
    const used = parity.checkParity({
      name: c.name,
      react: W => liveReact(s)(W).slice(0, drawChips(s, parity.baseCtx(W)).length),
      draw: W => drawChips(s, parity.baseCtx(W)),
    });
    assert.equal(used.length, 0);
  });
}
test('chips: empty list draws nothing', () => {
  assert.deepEqual(drawChips({attachments: []}, parity.baseCtx(80)), []);
  assert.deepEqual(drawChips({}, parity.baseCtx(80)), []);
});

// --- add-screen --------------------------------------------------------------
const addCases = [
  {name: 'add-screen: a few lines', s: {addFlow: {lines: ['名前を入力してください', 'ブラウザが開きます'], busy: ''}}},
  {name: 'add-screen: busy', s: {addFlow: {lines: ['ログインを待っています'], busy: '認証中'}}},
  {name: 'add-screen: long wrapping line', s: {addFlow: {lines: ['これは長い行です。https://example.com/very/long/url/that/keeps/going/and/going 幅が狭いと折り返されます。'], busy: ''}}},
  {name: 'add-screen: no lines', s: {addFlow: {lines: [], busy: ''}}},
];
for (const c of addCases) {
  test(c.name, () => {
    const s = {text: '', pos: 0, mode: 'default', agents: [], todos: [], focus: {}, promptFor: true, ...c.s};
    const used = parity.checkParity({
      name: c.name,
      react: W => liveReact(s)(W).slice(0, drawAddScreen(s, parity.baseCtx(W)).length),
      draw: W => drawAddScreen(s, parity.baseCtx(W)),
    });
    assert.equal(used.length, 0);
  });
}

// --- limit-input -------------------------------------------------------------
const limitCases = [
  {name: 'limit: concurrent, empty text', s: {limitInput: {key: 'concurrent', text: ''}}},
  {name: 'limit: total, a number typed', s: {limitInput: {key: 'total', text: '12'}}},
  {name: 'limit: custom label and hint', s: {limitInput: {key: 'x', label: '上限を入力', hint: '1 以上', text: '3'}}},
  {name: 'limit: flash rides with the keys', s: {limitInput: {key: 'concurrent', text: 'abc'}, flash: '数字を入力してください'}},
  {name: 'limit: long text wraps, caret at the end', s: {limitInput: {key: 'total', text: '1234567890'.repeat(12)}}},
];
for (const c of limitCases) {
  test(c.name, () => {
    const s = {text: '', pos: 0, mode: 'default', agents: [], todos: [], focus: {}, ...c.s};
    check(c.name, s, (st, ctx) => drawLimitInput(st, ctx).lines);
    // The caret sits on the last text row of the prompt box, after the typed text.
    for (const W of [40, 80, 120]) {
      const {lines, caret} = drawLimitInput(s, parity.baseCtx(W));
      assert.ok(caret && caret.row < lines.length, 'caret row inside the block');
      assert.equal(parity.reactLines(h(Live, {s, ctrl: ctrlFor(), W}), W).length, lines.length);
    }
  });
}

// --- approval ----------------------------------------------------------------
const approvalCases = [
  {name: 'approval: exec short command', s: {approval: {call: {kind: 'exec', command: 'system.run', params: {command: 'echo hello', shell: 'powershell'}}, options: [{label: 'はい'}, {label: 'いいえ'}], index: 0}}},
  {name: 'approval: exec agent and outside', s: {approval: {call: {command: 'code.edit', summary: 'src/ui/view.mjs', agent: 'b1'}, outside: true, options: [{label: 'はい'}, {label: 'いいえ'}, {label: '常に許可'}], index: 2}}},
  {name: 'approval: exec hidden lines', s: {approval: {call: {kind: 'exec', command: 'system.run', params: {command: Array.from({length: 15}, (_, i) => 'echo line' + i).join('\n'), shell: 'powershell'}}, options: [{label: 'はい'}], index: 0}}},
  {name: 'approval: exec long line cut', s: {approval: {call: {kind: 'exec', command: 'system.run', params: {command: 'x'.repeat(500), shell: 'cmd', cwd: CWD}}, options: [{label: 'はい'}, {label: 'いいえ'}], index: 1}}},
  {name: 'approval: mcp params', s: {approval: {call: {kind: 'mcp', mcp: {server: 'my-server', tool: 'read_file'}, params: {path: '/very/long/path/that/keeps/going/on/and/on/file.txt', content: 'x'.repeat(500), n: 42}, summary: 'read a file'}, options: [{label: 'はい'}, {label: 'いいえ'}, {label: 'やめる'}], index: 1}}},
  {name: 'approval: mcp many params', s: {approval: {call: {kind: 'mcp', mcp: {server: 's', tool: 't'}, params: Object.fromEntries(Array.from({length: 13}, (_, i) => ['p' + i, 'v' + i]))}, options: [{label: 'はい'}], index: 0}}},
  {name: 'approval: preview error', s: {approval: {call: {command: 'code.edit', summary: 'x'}, preview: {error: 'binary file'}, options: [{label: 'はい'}, {label: 'いいえ'}], index: 0}}},
  {name: 'approval: no options', s: {approval: {call: {command: 'code.write', summary: 'new.txt', view: {created: true}}, options: [], index: 0}}},
];
for (const c of approvalCases) {
  test(c.name, () => {
    const s = {text: '', pos: 0, mode: 'default', agents: [], todos: [], focus: {}, ...c.s};
    check(c.name, s, drawApproval);
  });
}
test('approval: a diff draws (drawDiff landed with B3, connected in stage C)', () => {
  const withDiff = {text: '', pos: 0, mode: 'default', agents: [], todos: [], focus: {}, approval: {call: {command: 'code.edit', summary: 'a'}, preview: {diff: [{t: '+', n: 1, l: 'new'}]}, options: [], index: 0}};
  check('approval: a diff draws', withDiff, drawApproval);
  const withFiles = {text: '', pos: 0, mode: 'default', agents: [], todos: [], focus: {}, approval: {call: {command: 'code.edit', summary: 'a'}, preview: {files: [{path: CWD + '\\src\\ui\\view.mjs', op: 'edit', diff: [{t: ' ', n: 1, l: 'x'}]}]}, options: [], index: 0}};
  check('approval: files draw', withFiles, drawApproval);
});

// --- menu --------------------------------------------------------------------
const menuCases = [
  {name: 'menu: basic with hint, danger and current', s: {menu: {title: 'コマンドを選択', hint: '60 秒で自動決定', options: [{label: 'はい', desc: 'このまま進めます'}, {label: 'いいえ', desc: 'やめます', danger: true}, {label: 'あとで', value: 'later'}], current: 'later', index: 0}}},
  {name: 'menu: long hint takes its own line', s: {menu: {title: '設定', hint: 'このヒントはとても長くてタイトルの横には収まりません', options: [{label: 'オン'}], index: 0}}},
  {name: 'menu: no options', s: {menu: {title: '空', options: [], index: 0}}},
  {name: 'menu: long list scrolled down', s: {menu: {title: '一覧', options: Array.from({length: 15}, (_, i) => ({label: '項目' + (i + 1), desc: '説明' + (i + 1), group: i < 5 ? '基本' : i < 10 ? '詳細' : undefined})), index: 10}}},
  {name: 'menu: long list scrolled up', s: {menu: {title: '一覧', options: Array.from({length: 15}, (_, i) => ({label: '項目' + (i + 1), desc: '説明' + (i + 1)})), index: 0}}},
  {name: 'menu: selected long description wraps', s: {menu: {title: '選んでください', options: [{label: '短い', desc: '短い説明'}, {label: '長い説明の選択肢', desc: 'これはとても長い説明文です。幅が狭いと折り返されますし、幅が広くても折り返されるくらい長くしておきます。'}], index: 1}}},
];
for (const c of menuCases) {
  test(c.name, () => {
    const s = {text: '', pos: 0, mode: 'default', agents: [], todos: [], focus: {}, ...c.s};
    check(c.name, s, drawMenu);
  });
}

// --- question ----------------------------------------------------------------
const questionCases = [
  {name: 'question: single-select with descriptions', s: {question: {tab: 0, index: 1, notes: '確認済み', questions: [{question: 'どれにしますか？', options: [{label: 'A', description: 'A の説明です。'}, {label: 'B', description: 'B の説明は長めにしておきます。幅が狭いと折り返されるはずです。'}, {label: 'C'}]}]}}},
  {name: 'question: multi-select with checked and custom', s: {question: {tab: 0, index: 3, questions: [{question: 'あてはまるものを選んでください', multi: true, options: [{label: 'X'}, {label: 'Y'}, {label: 'Z'}]}], checked: {0: [0, 2]}, custom: {0: '手入力'}}}},
  {name: 'question: several questions, second tab', s: {question: {tab: 1, index: 0, questions: [{question: '最初の質問です', header: '概要', options: [{label: 'はい'}, {label: 'いいえ'}]}, {question: '2番目の質問はどれがいいですか？', options: [{label: '赤'}, {label: '青'}]}, {question: '最後の質問です', options: [{label: 'OK'}]}], answers: {0: 'はい'}, picked: {1: 0}}}} ,
  {name: 'question: submit tab with an unanswered question', s: {question: {tab: 3, index: 0, questions: [{question: '最初の質問です', header: '概要', options: [{label: 'はい'}]}, {question: '2番目の質問です', options: [{label: '赤'}]}, {question: '最後の質問です', options: [{label: 'OK'}]}], answers: {0: 'はい', 2: 'OK'}}}} ,
  {name: 'question: submit tab, not selected', s: {question: {tab: 3, index: 1, questions: [{question: '最初の質問です', options: [{label: 'はい'}]}, {question: '2番目の質問です', options: [{label: '赤'}]}, {question: '最後の質問です', options: [{label: 'OK'}]}], answers: {0: 'はい', 1: '赤', 2: 'OK'}}}} ,
  {name: 'question: type mode shows the tail', s: {question: {mode: 'type', tab: 0, index: 3, typeText: 'こんにちは世界', questions: [{question: '何か書いてください', options: [{label: 'A'}, {label: 'B'}, {label: 'C'}]}]}}},
  {name: 'question: notes mode', s: {question: {mode: 'notes', tab: 0, index: 0, typeText: 'あとで直す', questions: [{question: 'どれ？', options: [{label: 'A'}]}]}}},
  {name: 'question: preview beside and below', s: {question: {tab: 0, index: 0, questions: [{question: 'どれ？', options: [{label: 'A', preview: 'line1\nline2 is longer than the pane and keeps going\n\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11'}, {label: 'B'}]}]}}},
  {name: 'question: header falls back to a numbered label', s: {question: {tab: 0, index: 0, questions: [{question: 'これは16文字を超える長い質問文です', header: 'これは16文字を超える長い質問文です'.slice(0, 16), options: [{label: 'A'}]}, {question: '二つ目', options: [{label: 'B'}]}]}}},
  {name: 'question: no options', s: {question: {tab: 0, index: 0, questions: [{question: '何かある？', options: []}]}}},
];
for (const c of questionCases) {
  test(c.name, () => {
    const s = {text: '', pos: 0, mode: 'default', agents: [], todos: [], focus: {}, ...c.s};
    check(c.name, s, drawQuestion);
  });
}

// --- extra branch coverage ---------------------------------------------------
const extraApproval = [
  {name: 'approval: edit without preview, outside warning (no rows)', s: {approval: {call: {command: 'code.write', summary: 'outside.txt'}, outside: true, options: [{label: 'はい'}], index: 0}}},
  {name: 'approval: exec hidden lines and a cut tail together', s: {approval: {call: {kind: 'exec', command: 'system.run', params: {command: 'y'.repeat(3000) + '\n' + Array.from({length: 15}, (_, i) => 'echo ' + i).join('\n')}}, options: [{label: 'はい'}], index: 0}}},
  {name: 'approval: cmd shell title', s: {approval: {call: {kind: 'exec', command: 'system.run', params: {command: 'dir', shell: 'cmd'}}, options: [{label: 'はい'}, {label: 'いいえ'}], index: 0}}},
];
for (const c of extraApproval) {
  test(c.name, () => {
    const s = {text: '', pos: 0, mode: 'default', agents: [], todos: [], focus: {}, ...c.s};
    check(c.name, s, drawApproval);
  });
}
const extraMenu = [
  {name: 'menu: groups change mid-list', s: {menu: {title: '設定', options: [{label: 'a1', group: '表示'}, {label: 'a2', group: '表示'}, {label: 'b1', group: '動作', desc: 'グループが変わる行'}, {label: 'b2', group: '動作'}], index: 2}}},
  {name: 'menu: long list, cursor at the end', s: {menu: {title: '一覧', options: Array.from({length: 20}, (_, i) => ({label: '項目' + (i + 1)})), index: 19}}},
  {name: 'menu: custom mark on an option', s: {menu: {title: '印', options: [{label: '印つき', mark: ' ●'}, {label: '通常'}], index: 1}}},
];
for (const c of extraMenu) {
  test(c.name, () => {
    const s = {text: '', pos: 0, mode: 'default', agents: [], todos: [], focus: {}, ...c.s};
    check(c.name, s, drawMenu);
  });
}
const extraQuestion = [
  {name: 'question: chat row selected', s: {question: {tab: 0, index: 3, questions: [{question: '話す行', options: [{label: 'x'}, {label: 'y'}]}]}}},
  {name: 'question: long question text wraps', s: {question: {tab: 0, index: 0, questions: [{question: 'これはとても長い質問文です。幅が狭い画面では何行にも折り返されますが、広い画面でも読み切れるようにしておきます。', options: [{label: 'はい'}]}]}}},
  {name: 'question: multi single with a note', s: {question: {tab: 0, index: 0, notes: 'メモあり', questions: [{question: '複数選んで', multi: true, options: [{label: 'a'}, {label: 'b'}]}], checked: {0: [1]}}}},
];
for (const c of extraQuestion) {
  test(c.name, () => {
    const s = {text: '', pos: 0, mode: 'default', agents: [], todos: [], focus: {}, ...c.s};
    check(c.name, s, drawQuestion);
  });
}
