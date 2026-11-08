'use strict';
// 2026-11-09: one conversation must not be held by two muser processes on one PC (two
// devices on one chat lose each other's work). src/session-holders.js finds the holders;
// the Server refuses to open a chat a standalone window / exec holds, and says so.
const test = require('node:test');
const assert = require('node:assert');
const {EventEmitter} = require('node:events');
const holders = require('../src/session-holders');
const {SessionsHost, HostError} = require('../src/server/sessions-host');

const windows = [
  {kind: 'window', pid: 111, session: {id: 'chat-a', title: '容量がまずい'}},
  {kind: 'window', pid: 222, session: {id: 'chat-b'}},
  {kind: 'window', pid: 333, session: null},
];
const execs = [{pid: 444, session: 'chat-c'}, {pid: 555, session: null}];
const opts = {readWindows: () => windows, readExecs: () => execs};

test('localHolders finds the standalone window or exec that has a chat, never the asker itself', () => {
  assert.deepEqual(holders.localHolders('chat-a', {...opts, excludePid: 999}), [{kind: 'window', pid: 111, title: '容量がまずい'}]);
  assert.deepEqual(holders.localHolders('chat-c', {...opts, excludePid: 999}), [{kind: 'exec', pid: 444, title: null}]);
  assert.deepEqual(holders.localHolders('chat-a', {...opts, excludePid: 111}), [], 'the window asking about its own chat');
  assert.deepEqual(holders.localHolders('chat-z', opts), []);
  assert.deepEqual(holders.localHolders(null, opts), []);
  // a broken source reads as "nobody" rather than failing the open
  assert.deepEqual(holders.localHolders('chat-a', {readWindows: () => { throw new Error('x'); }, readExecs: () => { throw new Error('y'); }}), []);
});

test('allHolders adds the resident Servers that have the chat open', async () => {
  const gatherServers = async () => [{pid: 777, sessions: [{id: 'chat-b'}, {id: 'chat-d'}]}, {pid: 888, sessions: []}];
  assert.deepEqual(await holders.allHolders('chat-d', {...opts, gatherServers, excludePid: 999}), [{kind: 'server', pid: 777, title: null}]);
  const both = await holders.allHolders('chat-b', {...opts, gatherServers, excludePid: 999});
  assert.deepEqual(both.map(h => h.kind).sort(), ['server', 'window']);
  assert.deepEqual(await holders.allHolders('chat-d', {...opts, gatherServers, excludePid: 777}), [], 'a Server asking about itself');
  assert.deepEqual(await holders.allHolders('chat-d', {...opts, gatherServers: async () => { throw new Error('down'); }}), []);
});

test('holderText says where, in the user\'s words', () => {
  assert.match(holders.holderText({kind: 'window', pid: 1}), /窓（pid 1）/);
  assert.match(holders.holderText({kind: 'server', pid: 2}), /Server.*pid 2/);
  assert.match(holders.holderText({kind: 'exec', pid: 3}), /exec（pid 3）/);
});

class FakeAgent extends EventEmitter {
  constructor(session) { super(); this.cwd = 'C:\\work'; this.mode = 'default'; this.session = {...session}; this.accountId = 'default'; this.busy = false; }
  close() {}
}
class FakeController {
  constructor(agent) { this.agent = agent; this.listeners = new Set(); this.s = {entries: [], busy: false, queue: []}; }
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  get = () => this.s;
  set(patch) { this.s = {...this.s, ...patch}; }
}

test('the Server does not open a chat a standalone window holds (409 with who), unless forced', async t => {
  const stored = new Map([['chat-a', {id: 'chat-a', cwd: 'C:\\work'}], ['chat-free', {id: 'chat-free', cwd: 'C:\\work'}]]);
  let built = 0;
  const host = new SessionsHost({
    idleMs: 0,
    findSession: ref => stored.get(ref) || null,
    holders: id => holders.localHolders(id, {...opts, excludePid: 999}),
    create: async ({session}) => { built++; const agent = new FakeAgent(session); return {agent, controller: new FakeController(agent), museName: 'm'}; },
  });
  t.after(async () => { await host.closeAll(); });
  await assert.rejects(() => host.openExisting('chat-a'), e => e instanceof HostError && e.status === 409 && e.code === 'held' && e.holders[0].pid === 111);
  assert.equal(built, 0, 'nothing was built for a held chat');
  const free = await host.openExisting('chat-free');
  assert.equal(free.agent.session.id, 'chat-free');
  const forced = await host.openExisting('chat-a', {}, {force: true});
  assert.equal(forced.agent.session.id, 'chat-a', 'force opens it anyway');
});
