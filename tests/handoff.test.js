'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {buildHandoff} = require('../src/handoff');

// Turns in the real shape sessions.transcript(id) returns (src/sessions.js / agent.record()).
const turn = (user, reply, extra = {}) => ({v: 1, at: 1730000000000, user, reply, tools: [], steps: [], sources: [], todos: [], ...extra});

const FULL = {
  fromLabel: '前の名前', toLabel: '新しい名前', cwd: 'C:\\work\\proj', sessionTitle: 'バグを直す',
  focus: {goal: 'ログインの不具合を直す', criteria: [{text: '再現する', status: 'met'}, {text: 'テストが通る', status: 'unmet'}]},
  todos: [{content: '終わったこと', status: 'completed'}, {content: '今やっていること', status: 'in_progress'}, {content: 'これからのこと', status: 'pending'}],
  gitLines: [' M src/a.js', '?? src/b.js'],
  recordPath: 'C:\\Users\\me\\.muser\\transcripts\\sess1.jsonl',
  turns: [turn('直して', '直します'), turn('テストは？', '通しました')],
};

test('full input produces all sections in order, headed by the handoff line', () => {
  const note = buildHandoff(FULL);
  const first = note.split('\n')[0];
  assert.ok(first.includes('前のアカウント（前の名前）'), first);
  assert.ok(first.includes('新しいアカウント（新しい名前）'), first);
  assert.ok(first.includes('続けてください'), first);
  const heads = ['■ 作業フォルダー', '■ セッション', '■ 進行中の作業', '■ Todo', '■ 変更中のファイル', '■ 前のセッションの記録', '■ 直近のやり取り'];
  let at = -1;
  for (const h of heads) { const i = note.indexOf(h); assert.ok(i > at, h + ' present and in order'); at = i; }
  assert.ok(note.includes('C:\\Users\\me\\.muser\\transcripts\\sess1.jsonl'));
  assert.ok(note.includes('全部を読み込まないこと'), 'the pointer says read only what you need');
  assert.ok(note.includes('C:\\work\\proj'));
  assert.ok(note.includes('バグを直す'));
  assert.ok(note.includes('目標: ログインの不具合を直す'));
  assert.ok(note.includes('- [met] 再現する'));
  assert.ok(note.includes('- [unmet] テストが通る'));
  assert.ok(note.includes(' M src/a.js') && note.includes('?? src/b.js'));
  assert.ok(note.includes('ユーザー: 直して'));
  assert.ok(note.includes('Muse: 通しました'));
});

test('todos: unfinished first with marks, completed last', () => {
  const note = buildHandoff(FULL);
  const doing = note.indexOf('- ◼ 今やっていること'), todo = note.indexOf('- ☐ これからのこと'), done = note.indexOf('- ☑ 終わったこと');
  assert.ok(doing >= 0 && todo > doing && done > todo, note);
});

test('empty and absent inputs omit every section; only the handoff line remains', () => {
  for (const input of [{}, {fromLabel: 'a'}, {fromLabel: 'a', toLabel: 'b', cwd: '', sessionTitle: ' ', turns: [], todos: [], focus: null, gitLines: null},
                       {turns: 'nope', todos: 42, focus: {}, gitLines: ' M x'}]) {
    const note = buildHandoff(input);
    assert.ok(!note.includes('■'), JSON.stringify(input) + ' -> ' + note);
    assert.ok(note.includes('前のアカウント'), note);
    assert.ok(note.length <= 4000);
  }
  assert.doesNotThrow(() => buildHandoff());
  assert.doesNotThrow(() => buildHandoff(null));
});

test('turns with no text are skipped, and only the last 6 text turns are kept', () => {
  const turns = [turn('', ''), turn(' ', '  ', {tools: [{command: 'code.read'}]}),
    ...Array.from({length: 8}, (_, i) => turn('質問' + (i + 1), '回答' + (i + 1)))];
  const note = buildHandoff({fromLabel: 'a', turns});
  assert.ok(!note.includes('質問1') && !note.includes('質問2'), note);
  for (let i = 3; i <= 8; i++) assert.ok(note.includes('ユーザー: 質問' + i) && note.includes('Muse: 回答' + i), 'turn ' + i);
  // A turn carrying only an error still counts as text.
  const err = buildHandoff({fromLabel: 'a', turns: [turn('やって', '', {error: '落ちた'})]});
  assert.ok(err.includes('エラー: 落ちた'), err);
  // No text anywhere: the whole transcript section is omitted.
  assert.ok(!buildHandoff({fromLabel: 'a', turns: [turn('', '')]}).includes('直近のやり取り'));
});

test('each speaker text is truncated to about 300 characters', () => {
  const note = buildHandoff({fromLabel: 'a', turns: [turn('あ'.repeat(1000), 'い'.repeat(1000))]});
  assert.ok(note.includes('あ'.repeat(300) + '…'), 'user text clipped at 300 with an ellipsis');
  assert.ok(!note.includes('あ'.repeat(301)));
  assert.ok(note.includes('い'.repeat(300) + '…'));
  assert.ok(!note.includes('い'.repeat(301)));
  // Short text is passed through untouched, with no ellipsis added.
  const short = buildHandoff({fromLabel: 'a', turns: [turn('短い', '返事')]});
  assert.ok(short.includes('ユーザー: 短い\nMuse: 返事'), 'joined lines present: ' + JSON.stringify(short));
  assert.ok(!short.includes('…'), 'no ellipsis in a short note');
  assert.deepEqual(short.split('\n').slice(-2), ['ユーザー: 短い', 'Muse: 返事']);
});

test('total cap holds: the transcript section is cut first, newest turns survive', () => {
  const turns = Array.from({length: 6}, (_, i) => turn('T' + (i + 1) + ' ' + 'x'.repeat(2000), 'R' + (i + 1) + ' ' + 'y'.repeat(2000)));
  // The clipped transcript alone is ~3.7k chars; the long todo list pushes the note over
  // the cap, so transcript turns have to be dropped for it to fit.
  const todos = Array.from({length: 20}, (_, i) => 'todo ' + i + ' ' + 'z'.repeat(90));
  const note = buildHandoff({fromLabel: 'a', cwd: 'C:\\w', turns, todos});
  assert.ok(note.length <= 4000, 'length ' + note.length);
  assert.ok(note.includes('T6'), 'the newest turn is kept');
  assert.ok(!note.includes('T1'), 'the oldest turn is dropped first');
  assert.ok(note.includes('■ 作業フォルダー'), 'other sections survive the transcript cut');
  // Even with nothing transcript-shaped left to cut, the cap still holds.
  const fat = buildHandoff({fromLabel: 'a', todos: Array.from({length: 200}, (_, i) => 'todo ' + i + ' ' + 'z'.repeat(100))});
  assert.ok(fat.length <= 4000, 'length ' + fat.length);
});

test('record pointer: omitted without a path, and it survives the cap trimming', () => {
  assert.ok(!buildHandoff({fromLabel: 'a', turns: [turn('x', 'y')]}).includes('前のセッションの記録'));
  assert.ok(!buildHandoff({fromLabel: 'a', recordPath: '  '}).includes('前のセッションの記録'));
  // Over the cap the transcript turns are dropped first; the pointer must still be there.
  const turns = Array.from({length: 6}, (_, i) => turn('T' + (i + 1) + ' ' + 'x'.repeat(2000), 'R' + (i + 1)));
  const note = buildHandoff({fromLabel: 'a', turns, recordPath: 'C:\\t\\s.jsonl'});
  assert.ok(note.length <= 4000, 'length ' + note.length);
  assert.ok(note.includes('C:\\t\\s.jsonl'), 'the pointer survives: ' + note.slice(-300));
});

test('todos tolerate plain strings', () => {
  const note = buildHandoff({fromLabel: 'a', todos: ['買い物に行く', {content: '掃除', status: 'completed'}, '  ', 42, null]});
  assert.ok(note.includes('- ☐ 買い物に行く'), note);
  assert.ok(note.indexOf('買い物に行く') < note.indexOf('掃除'), 'the string todo (pending) sorts before the completed one');
  assert.ok(!note.includes('42'), note);
});

test('git lines are capped at 30 with a remainder note', () => {
  const gitLines = Array.from({length: 35}, (_, i) => ' M f' + (i + 1) + '.txt');
  const note = buildHandoff({fromLabel: 'a', gitLines});
  assert.ok(note.includes(' M f30.txt'));
  assert.ok(!note.includes('f31.txt'), note);
  assert.ok(note.includes('ほか 5 件'), note);
  // Exactly at the cap there is no remainder note, and blank lines never reach the note.
  const exact = buildHandoff({fromLabel: 'a', gitLines: [...gitLines.slice(0, 30), '', '  ']});
  assert.ok(!exact.includes('ほか'), exact);
});

test('focus without a goal still lists criteria; a goal without criteria still shows', () => {
  assert.ok(buildHandoff({fromLabel: 'a', focus: {criteria: [{text: '基準だけ', status: 'blocked'}]}}).includes('- [blocked] 基準だけ'));
  const goalOnly = buildHandoff({fromLabel: 'a', focus: {goal: '目標だけ', criteria: []}});
  assert.ok(goalOnly.includes('■ 進行中の作業') && goalOnly.includes('目標: 目標だけ'), goalOnly);
});

test('pure and deterministic: same input, same note, input untouched', () => {
  const input = JSON.parse(JSON.stringify(FULL));
  const before = JSON.stringify(input);
  assert.equal(buildHandoff(input), buildHandoff(input));
  assert.equal(JSON.stringify(input), before);
});
