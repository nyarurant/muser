'use strict';
// release-039: an updated muser attaches to a resident Server started from the
// previous install (same protocol 6), so the conversation keeps running the old
// code until that Server restarts. olderServer() decides when to say so.
const test = require('node:test');
const assert = require('node:assert/strict');
const {olderServer} = require('../src/server/ensure-server');

test('an older server build is detected; same, newer or unknown is not', () => {
  assert.equal(olderServer('0.3.8', '0.3.9'), true);
  assert.equal(olderServer('0.2.12', '0.3.0'), true);
  assert.equal(olderServer('0.3.9', '0.3.10'), true, 'numeric, not string, comparison');
  assert.equal(olderServer('0.3.9', '0.3.9'), false);
  assert.equal(olderServer('0.4.0', '0.3.9'), false);
  assert.equal(olderServer(undefined, '0.3.9'), false);
  assert.equal(olderServer('dev', '0.3.9'), false);
});

test('a pinned window note survives the snapshot and entries-reset that replace the list', async () => {
  const {RemoteController} = await import('../src/ui/remote-controller.mjs');
  const ctrl = new RemoteController({client: {request: async () => ({status: 200, json: {}})}, sessionId: 's', version: 't', onExit() {}, onReload() {}});
  ctrl.pinNote(['old server']);
  ctrl.applySnapshot({entries: [{id: 'a', type: 'user', text: 'hi'}]}, true);
  assert.deepEqual(ctrl.s.entries.map(e => e.id === 'a' ? 'a' : e.lines?.[0]), ['a', 'old server']);
  ctrl.handleEvent({kind: 'entries-reset', entries: [{id: 'b', type: 'user', text: 'x'}]});
  assert.deepEqual(ctrl.s.entries.map(e => e.id === 'b' ? 'b' : e.lines?.[0]), ['b', 'old server']);
});

test('an idle older server is stopped so the current build can start; a busy one is kept', async () => {
  const {stopOlderServer} = require('../src/server/ensure-server');
  const make = ({live, stopStatus = 200, dieAfter = 1}) => {
    let probes = 0; const calls = [];
    return {calls, args: {info: {port: 1}, live, ownVersion: '0.3.9', sleep: async () => {}, pollMs: 1, timeoutMs: 5,
      request: async (info, verb, route) => { calls.push(verb + ' ' + route); return {status: stopStatus}; },
      probe: async () => (++probes > dieAfter ? null : {pid: 1})}};
  };
  let m = make({live: {version: '0.3.8', sessions: [{busy: false}]}});
  assert.deepEqual(await stopOlderServer(m.args), {restarted: true});
  assert.deepEqual(m.calls, ['POST /api/server/stop']);
  m = make({live: {version: '0.3.8', sessions: [{busy: true}]}});
  assert.equal((await stopOlderServer(m.args)).reason, 'busy'); assert.equal(m.calls.length, 0);
  m = make({live: {version: '0.3.8', sessions: [{approval: true}]}});
  assert.equal((await stopOlderServer(m.args)).reason, 'busy');
  for (const version of ['0.3.9', '0.4.0', undefined]) { m = make({live: {version, sessions: []}}); assert.equal((await stopOlderServer(m.args)).reason, 'not-older'); assert.equal(m.calls.length, 0); }
  m = make({live: {version: '0.3.8', sessions: []}, stopStatus: 500});
  assert.equal((await stopOlderServer(m.args)).reason, 'stop-failed');
  m = make({live: {version: '0.3.8', sessions: []}, dieAfter: 1e9});
  assert.equal((await stopOlderServer(m.args)).reason, 'still-running');
});
