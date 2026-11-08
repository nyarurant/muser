'use strict';
// Wave 14 state fix:
//  focus — Focus.restore re-validates the saved ask through
//    normalizeAsk (the same validation askUser enforces) and drops
//    an invalid one, restoring as no-pending-question: the ask, its
//    plain question text and the needs_input wait that rested on it
//    go together (status becomes running, awaitingInput false),
//    while the plan / criteria stay intact and a fresh askUser still
//    works. A valid saved ask restores untouched (wave-13 behaviour:
//    needs_input, the question text, and resumeLeg naming the
//    interrupted question in resumeNote).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Tests read the Japanese UI strings (setup.mjs pins the same).
process.env.MUSER_LANG = 'ja';
// Self-isolation, the w13-state pattern: throwaway home/data BEFORE
// any src module loads, so a bare run never touches the real ones.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w14-state-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(ROOT, 'home-'));
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(ROOT, 'data-'));
// Head guard: abort unless every one of those lives under this %TEMP%
// root. The Resident Server and the real HOME stay untouched.
for (const [name, v] of Object.entries({USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, LOCALAPPDATA: process.env.LOCALAPPDATA})) {
  if (!v || !path.resolve(v).startsWith(path.resolve(ROOT))) throw new Error('w14 isolation guard: ' + name + ' is not under the temp root: ' + v);
}
test.after(() => { try { fs.rmSync(ROOT, {recursive: true, force: true}); } catch {} });

const {Focus} = require('../src/focus');

const insp = text => ({text, kind: 'inspection'});
const opts2 = [{label: 'yes'}, {label: 'no'}];

// A saved state exactly as serialize() writes it for a task that is
// waiting on a valid structured question: plan intact, status
// needs_input, awaitingInput set. Tampering replaces data.ask (and
// the plain question text that went with it) afterwards.
function savedWaitingData() {
  const f = new Focus('Task goal'); f.beginRound();
  f.plan([insp('Done one'), insp('Done two')]);
  f.askUser('Which colour should it be?', {options: opts2});
  f.status = 'needs_input'; f.awaitingInput = true;
  const data = f.serialize();
  assert.equal(data.status, 'needs_input', 'precondition: the saved state is waiting');
  assert.equal(data.awaitingInput, true, 'precondition: the saved state is awaiting input');
  assert.ok(data.ask && Array.isArray(data.ask.questions), 'precondition: the saved ask is structured');
  return data;
}

// ---------- (4) tampered asks are dropped on restore ----------

const tamperedCases = [
  ['flat {question, options: []}', {question: 'x', options: []}, 'x'],
  ['flat {question} without options', {question: 'x'}, 'x'],
  ['structured {questions: [{question, options: []}]}', {questions: [{question: 'x', options: []}]}, 'x'],
  ['empty question text', {questions: [{question: '', options: opts2}]}, ''],
];
for (const [name, ask, question] of tamperedCases) {
  test('w14 focus (4): restore drops a tampered ask — ' + name, () => {
    const data = savedWaitingData();
    data.ask = ask;
    data.question = question;
    data.status = 'needs_input'; data.awaitingInput = true;
    const f = Focus.restore(data);
    assert.equal(f.ask, null, 'the invalid ask is dropped');
    assert.equal(f.question, '', 'the plain question text goes with it');
    assert.notEqual(f.status, 'needs_input', 'the restored task is NOT left waiting on an unanswerable question');
    assert.equal(f.status, 'running', 'it restores as a task with no pending question');
    assert.equal(f.awaitingInput, false, 'it is not awaiting input');
    assert.deepEqual(f.criteria.map(c => c.text), ['Done one', 'Done two'], 'the plan / criteria are intact');
    assert.deepEqual(f.criteria.map(c => c.id), ['c1', 'c2'], 'the criterion ids are intact');
    // A subsequent fresh askUser still works on the restored task.
    const snap = f.askUser('Fresh question?', {options: opts2});
    assert.equal(f.question, 'Fresh question?', 'the fresh question is recorded');
    assert.ok(f.ask && Array.isArray(f.ask.questions), 'the fresh ask is structured');
    assert.equal(f.ask.questions[0].question, 'Fresh question?');
    assert.ok(snap, 'askUser returns its snapshot');
  });
}

// ---------- (5) a valid saved ask restores untouched ----------

test('w14 focus (5): a valid saved ask restores untouched and resumeLeg names the interrupted question', () => {
  const data = savedWaitingData();
  const f = Focus.restore(data);
  assert.equal(f.status, 'needs_input', 'the valid wait is preserved');
  assert.equal(f.awaitingInput, true, 'the restored task is still awaiting input');
  assert.equal(f.question, 'Which colour should it be?', 'the question text is preserved');
  assert.ok(f.ask && Array.isArray(f.ask.questions), 'the structured ask is preserved');
  assert.equal(f.ask.questions[0].question, 'Which colour should it be?', 'the structured question text is preserved');
  assert.deepEqual(f.ask.questions[0].options.map(o => o.label), ['yes', 'no'], 'the options are preserved');
  assert.deepEqual(f.criteria.map(c => c.text), ['Done one', 'Done two'], 'the plan / criteria are intact');
  // Wave-13 behaviour intact: after resumeLeg, resumeNote names the
  // question that was waiting when the leg stopped.
  f.resumeLeg('the next message');
  const note = f.resumeNote();
  assert.ok(note.includes('Which colour should it be?'), 'the interrupted question is named: ' + note);
  assert.ok(note.includes('前回、次の質問への回答を待っている途中で止まりました'), 'the note says the leg stopped mid-question');
});
