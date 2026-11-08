'use strict';
// audit-cli wave 14, tell + account-switch rollback:
//  (1) a switch rollback returns messages collected for the discarded fresh
//      session to FRESH's inbox, never into the old conversation's turn;
//  (2) a long target reference (a full id's length) matches exactly or not
//      at all — prefix matching is for short references only;
//  (3) the delivery label carries the send time, and a sender that is
//      already gone is not labelled as working;
//  (4) the receive cap counts deliveries by delivery time, so an old
//      backlog is metered out instead of bursting through at once;
//  (5) an inbox holds at most MAX_INBOX undelivered messages; past that the
//      sender gets an inbox-full error and nothing is appended or dropped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w14-tell-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w14-tell-home-'));

const tell = require('../src/tell');
const accounts = require('../src/accounts');

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w14-tell-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
function seedInbox(base, sessionId, messages) {
  const file = tell.inboxFile(sessionId, {base});
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, messages.map(m => JSON.stringify(m)).join('\n') + '\n');
  return file;
}
const peerMsg = (text, at) => ({text, at: new Date(at).toISOString(), from: {sessionId: 'w14-sender', pid: 4242}});

// ---------- (2) findPeer: long references are exact-only ----------

test('w14 tell (2): a short reference may match by prefix; a full-id-length one may not', () => {
  const longId = '12345678-1234-1234-1234-1234567890ab-extended';
  const peers = [
    {sessionId: longId, pid: 111, name: 'long-peer'},
    {sessionId: 'shortpeer-session', pid: 222, name: 'shorty'},
  ];
  assert.equal(tell.findPeer(peers, '12345678')?.sessionId, longId, 'an 8-char id prefix still resolves');
  assert.equal(tell.findPeer(peers, 'shor')?.sessionId, 'shortpeer-session', 'a short name prefix still resolves');
  assert.equal(tell.findPeer(peers, longId)?.sessionId, longId, 'the whole id resolves exactly');
  assert.equal(tell.findPeer(peers, 'SHORTPEER-SESSION')?.sessionId, 'shortpeer-session', 'an exact id in another case still resolves');
  // 36 chars: a whole UUID's worth of reference, but only a PREFIX of the
  // peer's longer id — it must not deliver there.
  const almost = '12345678-1234-1234-1234-1234567890ab';
  assert.equal(almost.length, 36);
  assert.equal(tell.findPeer(peers, almost), null, 'a full-id-length prefix is not a match');
  assert.equal(tell.findPeer(peers, '12345678-1234-1234-1234-1234567890ac'), null, 'a mistyped full-length id is not a match either');
});

// ---------- (3) formatMessage / peerBlock: send time + gone sender ----------

test('w14 tell (3): the label shows the send time; a gone sender is not shown as working', (t) => {
  const base = tmpdir(t);
  const at = '2026-01-02T03:04:05.000Z';
  const gone = tell.peerBlock([{from: {sessionId: 'w14-gone', name: 'leaver', activity: 'working'}, at, text: 'old news'}], {base});
  assert.ok(gone.includes(at), 'the send time is on the label: ' + gone);
  assert.ok(!gone.includes('作業中'), 'a sender with no live peer record is not labelled working: ' + gone);
  // A sender that is still there keeps the working tag (and the time).
  const dir = tmpdir(t);
  const h = new tell.PeerHandle({sessionId: 'w14-alive', cwd: dir, base, pid: process.pid}).start();
  t.after(() => h.stop());
  const live = tell.peerBlock([{from: {sessionId: 'w14-alive', name: 'stayer', activity: 'working'}, at, text: 'fresh'}], {base});
  assert.ok(live.includes('作業中'), 'a live sender keeps the working tag: ' + live);
  assert.ok(live.includes(at), 'the send time is on the live label too: ' + live);
  // No send time recorded: no time bit is invented.
  const timeless = tell.formatMessage({from: {name: 'plain'}, text: 'hi'}, {base});
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(timeless), 'no timestamp is fabricated: ' + timeless);
});

// ---------- (4) the cap counts delivery time, not send time ----------

test('w14 tell (4): an old backlog is metered by delivery time, not send time', (t) => {
  const base = tmpdir(t);
  const dir = tmpdir(t);
  const now = Date.now();
  const old = now - 10 * 60 * 1000; // every message was SENT ten minutes ago
  const msgs = [];
  for (let i = 0; i < 7; i++) msgs.push(peerMsg('backlog-' + i, old));
  seedInbox(base, 'w14-backlog', msgs);
  const first = tell.drainInbox('w14-backlog', {base, now});
  assert.equal(first.length, tell.RECEIVE_PER_MIN, 'the first drain delivers one minute\'s allowance');
  assert.ok(first.every(m => m.deliveredAt === new Date(now).toISOString()), 'delivered copies are stamped with the delivery time');
  const second = tell.drainInbox('w14-backlog', {base, now});
  assert.equal(second.length, 0, 'a second drain in the same minute delivers nothing more — the deliveries count at delivery time');
  assert.equal(tell.readInbox('w14-backlog', {base}).length, 2, 'the rest wait in the inbox');
  // The .rate log itself holds delivery times, not the old send times.
  const rateLines = fs.readFileSync(tell.inboxFile('w14-backlog', {base}) + '.rate', 'utf8').split('\n').filter(Boolean);
  assert.equal(rateLines.length, tell.RECEIVE_PER_MIN);
  for (const l of rateLines) assert.ok(Math.abs(Date.parse(l) - now) < 5000, 'rate entry is a delivery time: ' + l);
  // And the send side agrees: a new send right after the burst is capped.
  const h = new tell.PeerHandle({sessionId: 'w14-backlog', cwd: dir, base, pid: process.pid}).start();
  t.after(() => h.stop());
  const over = tell.send({from: {pid: 4242, sessionId: 'w14-other', name: 's', cwd: dir}, target: 'w14-backlog', text: 'one more', base, now});
  assert.equal(over.ok, false);
  assert.equal(over.error, 'rate-limited');
});

// ---------- (5) the inbox total cap ----------

test('w14 tell (5): a full inbox answers inbox-full and keeps what it holds', (t) => {
  const base = tmpdir(t);
  const dir = tmpdir(t);
  const old = Date.now() - 10 * 60 * 1000; // old send times: the per-minute cap is not what stops these sends
  const from = {pid: 4242, sessionId: 'w14-sender-x', name: 's', cwd: dir};
  const h1 = new tell.PeerHandle({sessionId: 'w14-full', cwd: dir, base, pid: process.pid}).start();
  t.after(() => h1.stop());
  seedInbox(base, 'w14-full', Array.from({length: tell.MAX_INBOX}, (_, i) => peerMsg('held-' + i, old)));
  const full = tell.send({from, target: 'w14-full', text: 'does not fit', base});
  assert.equal(full.ok, false);
  assert.equal(full.error, 'inbox-full', 'the sender is told the inbox is full');
  assert.equal(tell.readInbox('w14-full', {base}).length, tell.MAX_INBOX, 'nothing was appended and nothing was dropped');
  // One below the cap still fits; the send after that is the full one.
  const h2 = new tell.PeerHandle({sessionId: 'w14-almost', cwd: dir, base, pid: process.pid}).start();
  t.after(() => h2.stop());
  seedInbox(base, 'w14-almost', Array.from({length: tell.MAX_INBOX - 1}, (_, i) => peerMsg('held-' + i, old)));
  assert.equal(tell.send({from, target: 'w14-almost', text: 'fits', base}).ok, true);
  assert.equal(tell.readInbox('w14-almost', {base}).length, tell.MAX_INBOX);
  const over = tell.send({from, target: 'w14-almost', text: 'now it is full', base});
  assert.equal(over.ok, false);
  assert.equal(over.error, 'inbox-full');
});

// ---------- (1) switch rollback: fresh's messages go back to fresh ----------

function stubClient() {
  const c = new EventEmitter();
  c.status = 'connected'; c.ws = {readyState: 1};
  c.subscribe = async () => {};
  c.disconnect = () => { c.status = 'disconnected'; c.disconnected = true; };
  c.request = async () => ({});
  return c;
}
function bundleFor(id, label) {
  return {account: {id, label}, files: accounts.filesFor(id), web: {jar: []},
    auth: {saved: {nodeId: 'node-' + id}, vm: async () => ({vm_id: 'vm-' + id})}, client: stubClient()};
}

test('w14 agent (1): a rolled-back switch returns fresh-addressed messages to the fresh inbox', async (t) => {
  const {Agent} = require('../src/agent');
  const a = new Agent({client: stubClient(), auth: bundleFor('default', 'default').auth, cwd: process.cwd(), web: {jar: []},
    session: {id: 'w14-old-session', cwd: process.cwd(), title: '', created: 0, updated: 0, turns: 2},
    accountId: 'default', accountLabel: 'default', accountFiles: accounts.filesFor('default')});
  t.after(() => { try { a.close(); } catch {} });
  let freshId = null;
  // While connectCurrent runs, the current session is the fresh one and
  // collectTell drains ITS inbox into the queues — stand in for exactly
  // that, then fail the way a refused device link fails the switch.
  a.connectCurrent = async () => {
    freshId = a.session.id;
    a.pendingTell.push({at: new Date().toISOString(), deliveredAt: new Date().toISOString(), from: {sessionId: 'w14-sender', name: 's'}, text: 'for fresh only'});
    throw new Error('device link refused');
  };
  await assert.rejects(() => a.switchAccount(bundleFor('second-account', 'Second')), /device link refused/);
  assert.ok(freshId && freshId !== 'w14-old-session', 'the switch really created a fresh session');
  assert.equal(a.session.id, 'w14-old-session', 'the window is back on the old session');
  assert.equal(a.pendingTell.length, 0, 'the old conversation holds nothing addressed to fresh');
  assert.equal(a.peerQueue.length, 0);
  const back = tell.readInbox(freshId);
  assert.equal(back.length, 1, 'the message is back in the inbox it was addressed to');
  assert.equal(back[0].text, 'for fresh only');
  assert.equal(back[0].deliveredAt, undefined, 'the requeued line carries no stale delivery stamp');
  assert.equal(tell.readInbox('w14-old-session').length, 0, 'nothing leaked into the old inbox either');
});
