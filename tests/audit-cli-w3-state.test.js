'use strict';
// audit-cli wave 3 (abnormal cases) regressions, state-file shapes: parity
// snapshots, Focus restore, and the accounts identity store. The fixes pinned
// here all share one shape — a hand-edited or half-written state file whose
// ELEMENTS are the wrong type used to slip past a top-level check and then
// crash (or silently wedge) the next real use. Style follows
// tests/audit-cli-w2-focus-tell.test.js (isolated home set before any require)
// and tests/parity.test.js (snapshots as plain data, files in a temp dir).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w3-test-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w3-test-home-'));

const parity = require('../src/parity');
const {Focus} = require('../src/focus');
const accounts = require('../src/accounts');
const store = require('../src/secure-store');

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w3-state-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
const read = p => ({command: 'code.read', kind: 'read', params: {path: p}, summary: p});

// ---------- parity: readSnapshotFile refuses bad shapes in words ----------

// A snapshot good enough for isSnapshot, as plain data (no probing needed).
function validSnap(overrides = {}) {
  return {
    kind: 'muser-parity',
    version: 1,
    createdAt: '2026-11-08T00:00:00.000Z',
    project: 'w3-probe',
    os: {platform: 'win32', version: 'Windows 11', release: '10.0.1', build: '1', arch: 'x64'},
    locale: {language: 'ja-JP', codePage: 932},
    settings: {executionPolicy: 'RemoteSigned', longPaths: true},
    tools: {node: '22.1.0', npm: null},
    path: ['C:\\Tools', '%USERPROFILE%\\bin'],
    env: {names: ['NODE_ENV', 'PATH'], values: {NODE_ENV: 'test'}},
    locks: [{file: 'package-lock.json', sha256: 'a'.repeat(64), bytes: 42}],
    ...overrides,
  };
}
function writeSnap(t, snap) {
  const file = path.join(tmpdir(t), 'snap.json');
  fs.writeFileSync(file, typeof snap === 'string' ? snap : JSON.stringify(snap));
  return file;
}
// The refusal must be the snapshot wording, never a bare TypeError leaking
// out of the diff (locks.find / names.every on a wrong-typed element).
function assertRefusedInWords(file) {
  let err = null;
  try { parity.readSnapshotFile(file); } catch (e) { err = e; }
  assert.ok(err, 'readSnapshotFile refuses ' + path.basename(file));
  assert.ok(!(err instanceof TypeError), 'the refusal is in words, not a TypeError: ' + err.message);
  assert.match(err.message, /スナップショットではありません/);
}

test('w3 parity S1: a snapshot from another version is refused in words, not diffed', t => {
  // Control: the untouched shape reads back as itself.
  const good = writeSnap(t, validSnap());
  assert.equal(parity.readSnapshotFile(good).version, 1);
  assert.equal(parity.isSnapshot(validSnap()), true);
  // A newer (or older, or mistyped) format version is a different file kind
  // in practice: silently diffing it would report 'no differences' for data
  // this build does not understand.
  for (const version of [2, 0, '1', null]) {
    const snap = validSnap({version});
    assert.equal(parity.isSnapshot(snap), false, 'version ' + JSON.stringify(version) + ' is not a v1 snapshot');
    assertRefusedInWords(writeSnap(t, snap));
  }
  const missing = validSnap();
  delete missing.version;
  assert.equal(parity.isSnapshot(missing), false);
  assertRefusedInWords(writeSnap(t, missing));
});

test('w3 parity S2: a null (or otherwise malformed) lock element is refused in words', t => {
  const goodLock = {file: 'package-lock.json', sha256: 'a'.repeat(64), bytes: 42};
  assert.equal(parity.readSnapshotFile(writeSnap(t, validSnap({locks: [goodLock]}))).locks.length, 1, 'control: a well-formed lock reads');
  assert.equal(parity.readSnapshotFile(writeSnap(t, validSnap({locks: []}))).locks.length, 0, 'control: no locks is fine');
  // [null] used to pass the Array.isArray check and then crash diffSnapshots
  // reading .file of null; the string / partial forms crash or lie the same way.
  for (const locks of [[null], [undefined], ['package-lock.json'], [42], [{file: 'package-lock.json', sha256: 'a'.repeat(64), bytes: '42'}], [{file: 'package-lock.json', sha256: 'a'.repeat(64)}], [{sha256: 'a'.repeat(64), bytes: 42}], [goodLock, null]]) {
    assert.equal(parity.isSnapshot(validSnap({locks})), false, 'locks ' + JSON.stringify(locks) + ' is not a snapshot');
    assertRefusedInWords(writeSnap(t, validSnap({locks})));
  }
});

test('w3 parity S3: env.names as a string (or with non-string elements) is refused in words', t => {
  // Control: a real name list reads, and a snapshot with no env section at
  // all stays readable (env is optional in the shape).
  assert.deepEqual(parity.readSnapshotFile(writeSnap(t, validSnap())).env.names, ['NODE_ENV', 'PATH']);
  const noEnv = validSnap();
  delete noEnv.env;
  assert.equal(parity.readSnapshotFile(writeSnap(t, noEnv)).kind, 'muser-parity', 'a missing env section is tolerated');
  // 'PATH' as a bare string is iterable character by character: accepted, it
  // would diff into one-letter environment variables instead of refusing.
  for (const env of [{names: 'PATH', values: {}}, {names: ['PATH', 42], values: {}}, {names: [null], values: {}}, {names: [{}], values: {}}, 'names-only', null]) {
    assert.equal(parity.isSnapshot(validSnap({env})), false, 'env ' + JSON.stringify(env) + ' is not a snapshot');
    assertRefusedInWords(writeSnap(t, validSnap({env})));
  }
  // Same element rule on PATH itself: a null entry must refuse, not crash.
  assert.equal(parity.isSnapshot(validSnap({path: ['C:\\Tools', null]})), false);
  assertRefusedInWords(writeSnap(t, validSnap({path: ['C:\\Tools', null]})));
});

// ---------- focus: restore drops bad elements, the task still runs ----------

test('w3 focus S4: restore drops null / string elements of criteria and evidence; beginRound and modelState still work', () => {
  const base = new Focus('State task');
  base.beginRound();
  base.plan([{text: 'Seed criterion', kind: 'inspection'}]);
  const data = base.serialize();
  // A hand-edited save: junk interleaved with two usable criteria and one
  // usable evidence entry. The junk used to restore 'successfully' and then
  // crash every leg (resumeNote / beginRound / modelState reading fields of
  // null, or a string's missing .id).
  data.criteria = [
    null,
    'a string is not a criterion',
    42,
    {text: 'no id, cannot be checked'},
    {id: 'cX'},
    {id: 'c1', text: 'Check A', kind: 'inspection', status: 'pending', evidence: [null, 42, 'e1']},
    {id: 'c2', text: 'Run it', kind: 'bogus-kind', status: 'pending', evidence: 'e1'},
  ];
  data.evidence = [
    null,
    'a string is not evidence',
    7,
    {summary: 'no id, cannot be cited'},
    {id: 'e1', command: 'code.read', summary: 'probe.txt', ok: true, usable: true, revision: 0, round: 1},
  ];
  data.changes = [null, 'junk', {revision: 1}];
  const r = Focus.restore(data);
  assert.deepEqual(r.criteria.map(c => c.id), ['c1', 'c2'], 'only criteria with a usable id and text survive');
  assert.ok(r.criteria.every(c => c && typeof c === 'object' && typeof c.text === 'string'));
  assert.deepEqual(r.criteria[0].evidence, ['e1'], 'a criterion keeps only its string evidence ids');
  assert.deepEqual(r.criteria[1].evidence, [], 'a non-array evidence field falls back to none');
  assert.equal(r.criteria[1].kind, 'inspection', 'an unknown kind falls back to inspection');
  assert.deepEqual(r.evidence.map(e => e.id), ['e1'], 'only evidence with a string id survives');
  assert.deepEqual(r.changes, [{revision: 1}], 'changes keep only their object entries');
  // The restored task is alive, not just parseable: the next leg runs.
  const roundBefore = r.round;
  assert.doesNotThrow(() => r.beginRound());
  assert.equal(r.round, roundBefore + 1, 'beginRound advances the restored task');
  let state = null;
  assert.doesNotThrow(() => { state = r.modelState(); });
  assert.deepEqual(state.criteria.map(c => c.id), ['c1', 'c2'], 'modelState hands back the surviving criteria');
  assert.ok(state.evidence.every(e => e && typeof e === 'object' && typeof e.id === 'string'));
  assert.doesNotThrow(() => r.resumeNote());
  assert.match(r.resumeNote(), /Check A/, 'the resume note names the surviving criterion');
  const fresh = r.observe(read('after-restore.txt'), {ok: true});
  assert.equal(typeof fresh, 'string', 'the restored task records new evidence');
  assert.ok(r.evidence.some(e => e.id === fresh), 'the new evidence lands on the restored task');
});

test('w3 focus S5: restore with only junk elements restores empty; a bad top level still throws loudly', () => {
  const base = new Focus('Junk task');
  base.beginRound();
  base.plan([{text: 'Seed', kind: 'inspection'}]);
  const data = base.serialize();
  data.criteria = [null, 'x', 0, false];
  data.evidence = [null, 'x'];
  data.changes = [null];
  const r = Focus.restore(data);
  assert.deepEqual(r.criteria, [], 'no usable criterion survives');
  assert.deepEqual(r.evidence, [], 'no usable evidence survives');
  assert.deepEqual(r.changes, []);
  assert.doesNotThrow(() => r.beginRound());
  assert.doesNotThrow(() => r.modelState());
  assert.deepEqual(r.modelState().criteria, []);
  // Element junk is dropped, but a file that is not a Focus state at all is
  // still refused loudly — the caller reads that as 'no saved task'.
  for (const bad of [null, 'state', {...data, goal: 42}, {...data, criteria: 'c1'}, {...data, evidence: {}}, {...data, changes: null}])
    assert.throws(() => Focus.restore(bad), /Invalid Focus state/, 'top-level garbage still throws: ' + JSON.stringify(bad)?.slice(0, 60));
  // Wave 18 contract: a later version is no longer top-level garbage — it
  // restores (fields this build does not know are simply never read), and
  // the junk elements above are dropped exactly as in the v1 case.
  const fromV2 = Focus.restore({...data, v: 2});
  assert.equal(fromV2.goal, data.goal);
  assert.deepEqual(fromV2.criteria, []);
  assert.deepEqual(fromV2.evidence, []);
  assert.deepEqual(fromV2.changes, []);
});

// ---------- accounts: identity.json heals instead of wedging ----------

const identityFile = () => store.file('identity.json');
function resetIdentity(t) {
  const f = identityFile();
  const clean = () => {
    try { fs.unlinkSync(f); } catch {}
    try {
      for (const n of fs.readdirSync(path.dirname(f)))
        if (n.startsWith('identity.json.corrupt-')) fs.unlinkSync(path.join(path.dirname(f), n));
    } catch {}
  };
  clean();
  t.after(clean);
  return f;
}

test('w3 accounts S6: a corrupt identity.json is backed aside (.corrupt-*) and remembering works again', t => {
  const f = resetIdentity(t);
  fs.mkdirSync(path.dirname(f), {recursive: true});
  fs.writeFileSync(f, 'not-json{{{');
  assert.equal(accounts.museName('default'), 'Muse', 'a plain read of a corrupt file still falls back, without healing it');
  assert.equal(fs.readFileSync(f, 'utf8'), 'not-json{{{', 'the read alone leaves the corrupt bytes in place');
  // The old behaviour left the file in place on writes too, so every
  // remember* was a silent permanent no-op. Now the bytes are kept aside
  // and the store heals.
  accounts.rememberMuseName('default', 'Kaguya W3');
  const backups = fs.readdirSync(path.dirname(f)).filter(n => n.startsWith('identity.json.corrupt-'));
  assert.equal(backups.length, 1, 'exactly one .corrupt-* backup is left');
  assert.equal(fs.readFileSync(path.join(path.dirname(f), backups[0]), 'utf8'), 'not-json{{{', 'the backup holds the corrupt bytes verbatim, not a rewrite');
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(saved.byAccount.default, 'Kaguya W3', 'the new name is saved in a fresh, parseable file');
  assert.equal(saved.name, 'Kaguya W3', 'the default account also keeps the historic flat name');
  assert.equal(accounts.museName('default'), 'Kaguya W3');
  // And the healed store keeps working for the next account, undisturbed.
  accounts.rememberMuseName('second', 'Muse Two');
  assert.equal(accounts.museName('second'), 'Muse Two');
  assert.equal(accounts.museName('default'), 'Kaguya W3', 'healing did not cost the first name');
});

test('w3 accounts S7: a string byAccount is normalised, never spread into character keys', t => {
  const f = resetIdentity(t);
  fs.mkdirSync(path.dirname(f), {recursive: true});
  // Hand-edited wrong types: spreading a string byAccount used to write
  // {"0":"n","1":"o",...} into the file, and every name lookup then missed.
  fs.writeFileSync(f, JSON.stringify({byAccount: 'nope', usageCmd: 'also-a-string'}));
  accounts.rememberMuseName('default', 'Fresh Name');
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(saved.byAccount && typeof saved.byAccount === 'object' && !Array.isArray(saved.byAccount), 'byAccount is a plain object again');
  assert.deepEqual(saved.byAccount, {default: 'Fresh Name'}, 'the name lands under its account key alone');
  assert.ok(!('0' in saved.byAccount) && !('1' in saved.byAccount), 'no character-index keys from spreading the string');
  assert.ok(saved.usageCmd && typeof saved.usageCmd === 'object' && !Array.isArray(saved.usageCmd), 'a string usageCmd is normalised the same way');
  assert.deepEqual(saved.usageCmd, {});
  assert.equal(accounts.museName('default'), 'Fresh Name');
  accounts.rememberMuseName('acct-two', 'Second Name');
  const again = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(Object.keys(again.byAccount).sort(), ['acct-two', 'default'], 'later names join by account key, still no character keys');
  assert.equal(accounts.museName('acct-two'), 'Second Name');
});
