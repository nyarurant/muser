'use strict';
// A window on the shared node id (every slot of its account held, src/node-slots.js) registers
// it again before its turn (src/agent.js runTurn): Muse treated the id as offline once the window
// that had registered it last went away, while this window's socket stayed open (2026-11-03).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-rereg-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-rereg-home-'));

const {Agent} = require('../src/agent');
const sessions = require('../src/sessions');

function harness(t, slot) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-rereg-test-'));
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
  const client = new EventEmitter(), events = [];
  Object.assign(client, {status: 'connected', ws: {readyState: 1}, taskStatus: 'running', disconnect() {}, closeAgentSubscription() {}, async subscribeAgent() {}, async cancel() {}, async history() { return {chat_events: events}; }, async request() { return {session: {status: this.taskStatus}}; }});
  const agent = new Agent({client, auth: {}, cwd, session: sessions.create(cwd)}); agent.subscribed = true;
  agent.focusEnabled = false;
  t.after(() => agent.close());
  const log = [];
  const device = {connected: true, disconnect() {}, async send(body, sessionId) {
    log.push('send'); const id = 'user-' + log.length;
    setImmediate(() => { const done = {event: 'delta.message_done', seq: 2, payload: {session_id: sessionId, message_id: 'reply-1', role: 'assistant', text: 'ok', status: 'completed'}}; events.push(done); client.taskStatus = 'completed'; client.emit('event', done); });
    return {message_id: id};
  }};
  agent.device = device;
  agent.nodeSlot = {slot, nodeId: 'n', base: 'n', release() {}};
  agent.connectDevice = async function () { log.push('register'); this.nodeSlot = {slot: 2, nodeId: 'n-2', base: 'n', release() {}}; this.device = device; };
  return {agent, log};
}

test('on the shared node id the window registers again before its turn (and takes a freed slot)', async t => {
  const {agent, log} = harness(t, 0);
  await agent.send('hello');
  assert.deepEqual(log, ['register', 'send']);
  assert.equal(agent.nodeSlot.slot, 2);
});

test('a window with a slot of its own does not re-register', async t => {
  const {agent, log} = harness(t, 3);
  await agent.send('hello');
  assert.deepEqual(log, ['send']);
});
