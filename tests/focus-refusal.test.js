'use strict';
// Focus weakness 5 (2026-11-06): after repeated tool-less replies, stop and
// say this conversation's Muse cannot continue — with the /focus carry way
// out — instead of spinning more rounds in silence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-focus-refusal-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-focus-refusal-home-'));

const {Agent} = require('../src/agent');
const {Focus} = require('../src/focus');
const sessions = require('../src/sessions');

function tmpdir(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-focus-refusal-')); if (t) t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir; }
function stubClient() {
  const c = new EventEmitter();
  c.status = 'connected'; c.ws = {readyState: 1};
  c.history = async () => ({chat_events: []});
  c.subscribe = async () => {}; c.subscribeAgent = async () => {};
  c.closeAgentSubscription = () => {}; c.cancel = async () => {}; c.disconnect = () => {};
  return c;
}
function makeAgent(t, id = 's1') {
  const cwd = tmpdir(t);
  const a = new Agent({client: stubClient(), auth: {saved: {}, vm: async () => ({})}, cwd, session: {id, cwd, title: '', created: 0, updated: 0, turns: 0}});
  a.subscribed = true;
  if (t) t.after(() => { try { a.close(); } catch {} });
  return a;
}

test('weakness 5: two tool-less rounds in a row stop the task as blocked with the carry guidance', async (t) => {
  const a = makeAgent(t, 's-refuse');
  let round = 0;
  a.runTurn = async (w, input, opts) => {
    round++;
    if (round === 1) {
      opts.focus.plan([{text: 'Do the thing', kind: 'inspection'}]);
      opts.focus.checkpoint([{id: 'c1', status: 'unmet', reason: 'not done yet'}]);
    }
    return {text: 'I cannot do that.', sources: [], usage: null, focusDecision: opts.focus.endRound(), toolCalls: 0};
  };
  const reply = await a.sendFocused('Do the thing', {maxRounds: 10, turnEnd: false});
  assert.equal(round, 2, 'the second tool-less reply ends the leg');
  assert.equal(reply.focus.status, 'blocked', 'the refusal overrides the stalled stop');
  assert.match(reply.focus.reason, /ツールを使わずに返事だけ/);
  assert.match(reply.text, /\/focus carry s-refuse/, 'the reply tells the user how to carry the task over');
  assert.match(reply.text, /\[muser: /);
  const saved = sessions.loadFocus('s-refuse');
  assert.ok(saved, 'the blocked task is saved for the carry');
  assert.equal(saved.status, 'blocked');
  assert.equal(saved.criteria[0].status, 'unmet');
  assert.equal(a.resumeFocus, null, 'the refused task is not stashed for the next message here');
});

test('weakness 5: a round with tool calls resets the refusal count', async (t) => {
  const a = makeAgent(t, 's-reset');
  // toolCalls per round: 2, 0, 2, 0, 0 — the refusal fires on the second
  // consecutive zero, in round 5. Each round edits a file so the signature
  // changes and the rounds do not go stalled first.
  const calls = [2, 0, 2, 0, 0];
  let round = 0;
  a.runTurn = async (w, input, opts) => {
    round++;
    if (round === 1) {
      opts.focus.plan([{text: 'Do the thing', kind: 'inspection'}]);
      opts.focus.checkpoint([{id: 'c1', status: 'unmet', reason: 'not done yet'}]);
    }
    opts.focus.observe({command: 'code.edit', kind: 'edit', params: {path: 'f' + round + '.txt'}, summary: 'edit'}, {ok: true, payload: {}});
    return {text: 'ok', sources: [], usage: null, focusDecision: opts.focus.endRound(), toolCalls: calls[round - 1]};
  };
  const reply = await a.sendFocused('Do the thing', {maxRounds: 10, turnEnd: false});
  assert.equal(round, 5);
  assert.equal(reply.focus.status, 'blocked');
});

test('weakness 5: adoptFocus carries a saved task into a new session, and refuses the rest', async (t) => {
  // An old conversation whose task stopped for the user (saved under its id).
  const oldCwd = tmpdir(t);
  const old = sessions.create(oldCwd); sessions.touch(old, 'old task');
  const a = makeAgent(t, old.id);
  a.runTurn = async (w, input, opts) => {
    opts.focus.plan([{text: 'Do the thing', kind: 'manual'}]);
    opts.focus.checkpoint([{id: 'c1', status: 'unknown', reason: 'need the user to confirm'}]);
    return {text: 'ok', sources: [], usage: null, focusDecision: opts.focus.endRound(), toolCalls: 2};
  };
  const first = await a.sendFocused('Do the thing', {turnEnd: false});
  assert.equal(first.focus.status, 'needs_input');
  const prefix = old.id.slice(0, 8);
  // A new conversation adopts it by prefix.
  const b = makeAgent(t, sessions.create(tmpdir(t)).id);
  const r = b.adoptFocus(prefix);
  assert.equal(r.ok, true);
  assert.equal(b.resumeFocus.focus.id, first.focus.id);
  assert.equal(b.resumeFocus.focus.criteria[0].status, 'unknown');
  // The next message in the new conversation resumes and completes it.
  b.runTurn = async (w, input, opts) => {
    opts.focus.checkpoint([{id: 'c1', status: 'met', reason: 'the user confirmed it'}]);
    return {text: 'ok', sources: [], usage: null, focusDecision: opts.focus.endRound(), toolCalls: 1};
  };
  const second = await b.sendFocused('Yes, it is done', {turnEnd: false});
  assert.equal(second.focus.status, 'complete');
  assert.equal(sessions.loadFocus(b.session.id), null, 'the completed carry leaves no file in the new session');
  assert.ok(sessions.loadFocus(old.id), 'the old session keeps its own copy');
  // Error cases.
  const c = makeAgent(t, sessions.create(tmpdir(t)).id);
  assert.deepEqual(c.adoptFocus('no-such-session'), {ok: false, error: 'not-found'});
  const noFocus = sessions.create(tmpdir(t)); sessions.touch(noFocus, 'plain chat');
  assert.deepEqual(c.adoptFocus(noFocus.id), {ok: false, error: 'no-focus'});
  const amb1 = sessions.create(tmpdir(t)); amb1.id = 'amb-11111111-1111-1111-1111-111111111111'; sessions.touch(amb1, 'one');
  const amb2 = sessions.create(tmpdir(t)); amb2.id = 'amb-22222222-2222-2222-2222-222222222222'; sessions.touch(amb2, 'two');
  assert.deepEqual(c.adoptFocus('amb-'), {ok: false, error: 'ambiguous'});
});
