'use strict';
// audit-cli wave 15, W14-20: pruneInbox must not delete unread mail.
// The user's decision: an inbox with unread messages is not deleted.
// prunePeers (exported) calls pruneInbox; files older than 30 days are
// pruned UNLESS a .jsonl inbox file or a .jsonl.drain-* aside still holds
// a parseable undelivered message (parseInbox's own rules). Empty
// inboxes, inboxes whose lines are all unparseable, and .rate logs
// (timestamps only, no messages) still prune at 30 days.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated homes under %TEMP%, set before src/tell (via secure-store)
// reads LOCALAPPDATA. Head guard: abort unless every home is under the
// temp root, so the real HOME / resident Server state is never touched.
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w15-tell-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w15-tell-home-'));
{
  const root = path.resolve(os.tmpdir()).toLowerCase();
  for (const [k, v] of [['LOCALAPPDATA', process.env.LOCALAPPDATA], ['USERPROFILE', process.env.USERPROFILE], ['HOME', process.env.HOME]]) {
    const full = path.resolve(v).toLowerCase();
    if (!(full === root || full.startsWith(root + path.sep))) throw new Error(`head guard: ${k} is not under %TEMP%: ${v}`);
  }
}

const tell = require('../src/tell');

const DAY_MS = 24 * 3600 * 1000;
const NOW = Date.now();
const OLD_MS = NOW - 31 * DAY_MS; // older than the 30-day prune age
const YOUNG_MS = NOW - 10 * DAY_MS; // younger than the 30-day prune age

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w15-tell-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
// A line parseInbox accepts: non-empty text + a named sender session.
const validLine = text => JSON.stringify({id: 'w15-1', at: new Date(NOW - DAY_MS).toISOString(), from: {sessionId: 'w15-sender', name: 's'}, text}) + '\n';
function writeAged(file, content, mtimeMs) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, content);
  const when = new Date(mtimeMs);
  fs.utimesSync(file, when, when);
  return file;
}
function inbox(base, sessionId, content, mtimeMs) {
  return writeAged(tell.inboxFile(sessionId, {base}), content, mtimeMs);
}
// No peer files exist in these bases, so no live-peer exemption applies;
// isAlive:false is passed explicitly to keep that deterministic anyway.
function prune(base) {
  tell.prunePeers({base, now: NOW, isAlive: () => false});
}

test('w15 tell W14-20 (1): an inbox older than 30 days with a valid message survives prune', (t) => {
  const base = tmpdir(t);
  const file = inbox(base, 'w15-old-unread', validLine('still unread'), OLD_MS);
  prune(base);
  assert.equal(fs.existsSync(file), true, 'an old inbox holding an undelivered message is not deleted');
  assert.deepEqual(tell.readInbox('w15-old-unread', {base}).map(m => m.text), ['still unread'], 'the surviving message is still readable');
});

test('w15 tell W14-20 (2): an empty inbox older than 30 days is removed', (t) => {
  const base = tmpdir(t);
  const file = inbox(base, 'w15-old-empty', '', OLD_MS);
  prune(base);
  assert.equal(fs.existsSync(file), false, 'an empty old inbox prunes as before');
});

test('w15 tell W14-20 (3): an inbox older than 30 days whose lines are all unparseable is removed', (t) => {
  const base = tmpdir(t);
  const garbage = 'not json at all\n' + JSON.stringify({text: ''}) + '\n' + JSON.stringify({text: 'no sender'}) + '\n' + JSON.stringify({from: {name: 'x'}}) + '\n';
  const file = inbox(base, 'w15-old-garbage', garbage, OLD_MS);
  prune(base);
  assert.equal(fs.existsSync(file), false, 'lines parseInbox drops do not count as unread');
});

test('w15 tell W14-20 (4): an old drain aside with a valid message survives; an old .rate file is removed even while its inbox survives', (t) => {
  const base = tmpdir(t);
  const file = inbox(base, 'w15-old-aside', validLine('in the inbox'), OLD_MS);
  const aside = writeAged(file + '.drain-999-1', validLine('stranded in the aside'), OLD_MS);
  const rate = writeAged(file + '.rate', new Date(OLD_MS).toISOString() + '\n', OLD_MS);
  prune(base);
  assert.equal(fs.existsSync(file), true, 'the inbox survives (it holds a message)');
  assert.equal(fs.existsSync(aside), true, 'a drain aside holding an undelivered message is not deleted');
  assert.equal(fs.existsSync(rate), false, 'the .rate log carries no messages and prunes on age alone');
});

test('w15 tell W14-20 (5): an inbox younger than 30 days is untouched either way (control)', (t) => {
  const base = tmpdir(t);
  const valid = inbox(base, 'w15-young-unread', validLine('fresh unread'), YOUNG_MS);
  const empty = inbox(base, 'w15-young-empty', '', YOUNG_MS);
  const garbage = inbox(base, 'w15-young-garbage', 'not json at all\n', YOUNG_MS);
  prune(base);
  assert.equal(fs.existsSync(valid), true, 'a young inbox with a message is untouched');
  assert.equal(fs.existsSync(empty), true, 'a young empty inbox is untouched');
  assert.equal(fs.existsSync(garbage), true, 'a young unparseable inbox is untouched');
});
