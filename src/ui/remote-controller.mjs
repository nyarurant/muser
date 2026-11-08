// The Controller's remote twin (remote/DESIGN.md step 4): the same store shape
// and key surface src/ui/view.mjs drives, but the conversation itself lives in
// the resident Muser Server. Snapshots and SSE events from the server are the
// state (src/server/client.js, protocol v6); keys either edit the local
// composer (text, caret, history, completion, modal highlights) or are turned
// into the matching POST. Everything else — turns, approvals' effects, menus'
// picks, slash commands — stays server-side, exactly as with the C# GUI.
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createMd, tableRows} from './md.mjs';
import {stripControls} from './sanitize.mjs';
const require = createRequire(import.meta.url);
const clip = require('../clipboard.js');
const mention = require('../mentions.js');
const {MODES} = require('../policy.js');
const {renameRetry} = require('../config.js');
const skills = require('../skills.js');
const i18n = require('../i18n.js');
const {t} = i18n;

const MAX_HISTORY = 200;
const ATTACH_TOTAL = 11 * 1024 * 1024; // the same per-message cap as the local Controller
// The history file, read at use time (not module load) so tests and a relocated
// MUSER_HISTORY_FILE are honoured — the local Controller's helpers are not
// exported, so this is the small local copy its header comment describes.
function historyFile() { return process.env.MUSER_HISTORY_FILE || path.join(os.homedir(), '.muser', 'history.json'); }
// Move a corrupt history file aside, in the sessions.json style
// (src/sessions.js backupCorruptFile): the original bytes survive as
// history.json.corrupt-<time> and the caller starts from an empty history,
// so new entries are recorded again from that moment on. Ported from the
// local Controller (controller.mjs backupCorruptHistory) — both
// controllers treat a corrupt history file exactly the same way (wave 13).
function backupCorruptHistory(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try { fs.renameSync(file, file + '.corrupt-' + stamp); return true; } catch { return false; }
}
// The local Controller's read guard, ported (controller.mjs readHistoryDisk):
// the history on disk, or null when the file is there but could not be READ
// (a lock, a permission problem) — a read failure is not an empty history,
// and saving over it would replace everything with the newest entry alone.
// A file that reads fine but is corrupt — unparseable, or valid JSON that
// is not an array — is moved aside (backupCorruptHistory) and the read
// answers empty instead, exactly as the local Controller and sessions.json
// treat corruption, so recording resumes instead of refusing every save
// forever. (If the move itself fails, the read still answers empty: the
// save's own temp+rename then replaces the bad file instead.)
function readHistoryDisk() {
  const file = historyFile();
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return e && e.code === 'ENOENT' ? [] : null; }
  let h;
  try { h = JSON.parse(raw); } catch { backupCorruptHistory(file); return []; }
  if (Array.isArray(h)) return h.filter(x => typeof x === 'string').slice(-MAX_HISTORY);
  backupCorruptHistory(file); return [];
}
function loadHistory() { return readHistoryDisk() || []; }
// A short cross-window lock for the read-modify-write below, ported from the
// local Controller (controller.mjs acquireHistoryLock): a file created
// exclusively; a holder lives for milliseconds, so a lock older than 10 s is
// a crash leftover and is broken. When no lock can be had within a second
// the save still goes ahead unlocked rather than losing the entry outright.
function acquireHistoryLock() {
  const file = historyFile(), lock = file + '.lock';
  try { fs.mkdirSync(path.dirname(file), {recursive: true}); } catch { return null; }
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      return () => { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(lock); } catch {} };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return null;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) { fs.unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() >= deadline) return null;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } catch { return null; }
    }
  }
}
function saveHistory(history) {
  const release = acquireHistoryLock();
  let temp = null;
  try {
    const file = historyFile();
    const text = history[history.length - 1], disk = readHistoryDisk();
    if (disk === null) return; // unreadable right now: never overwrite it with just the newest entry
    if (typeof text === 'string' && disk[disk.length - 1] !== text) disk.push(text);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    temp = file + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    // renameRetry, not a plain rename: a momentarily locked history.json (another window or a
    // reader holding it open) made the rename throw EPERM and the entry was silently lost, with
    // the temp file left behind. The swallow stays — history must not crash a turn — but only
    // after the retries are exhausted, and the temp is removed when the write ultimately fails.
    fs.writeFileSync(temp, JSON.stringify(disk.slice(-MAX_HISTORY))); renameRetry(temp, file); temp = null;
  } catch { if (temp) { try { fs.unlinkSync(temp); } catch {} } }
  finally { try { release?.(); } catch {} }
}
const deviceName = () => os.hostname() + ' CLI (muser)'; // src/agent.js's DEVICE_NAME formula
// Grapheme-cluster lengths, the local Controller's helpers (controller.mjs)
// copied: caret moves and deletes must not split a ZWJ emoji, a flag, a
// skin-tone modifier or a combining kana (c8 #9). Falls back to code points
// where Intl.Segmenter is absent.
const graphemeSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, {granularity: 'grapheme'}) : null;
function lastClusterLen(s) { if (!graphemeSegmenter) return [...s].pop()?.length || 0; let n = 0; for (const g of graphemeSegmenter.segment(s)) n = g.segment.length; return n; }
function firstClusterLen(s) { if (!graphemeSegmenter) return [...s][0]?.length || 0; for (const g of graphemeSegmenter.segment(s)) return g.segment.length; return 0; }
function clusterCount(s) { if (!graphemeSegmenter) return [...s].length; let n = 0; for (const g of graphemeSegmenter.segment(s)) n++; return n; }
function offsetAtClusterCol(s, col) { if (!graphemeSegmenter) return [...s].slice(0, col).join('').length; let n = 0, off = 0; for (const g of graphemeSegmenter.segment(s)) { if (n >= col) break; n++; off += g.segment.length; } return off; }
// A menu's identity, the fingerprint applySnapshot already used for #68:
// title plus every option's label and value. The menu digit buffer's timer
// judges by this too (c8 #4), so a re-sent copy of the SAME menu still
// counts as the same menu while a different one does not.
// Side/group awareness: a snapshot menu may carry a side-paging flag and
// its options may carry group (genre) / side fields; they are part of the
// identity too, so a page or genre change is a different menu, and the
// options pass through applySnapshot untouched for the view's headers.
const menuFp = x => x ? JSON.stringify([x.title ?? null, x.side ?? null, (x.options || []).map(o => [o?.label ?? null, JSON.stringify(o?.value ?? null), o?.group ?? null, o?.side ?? null])]) : null;
// A selectable question's identity, in menuFp's spirit: the question texts,
// headers, multi flags and every option's label/description/preview. The
// picker's local edits survive a re-sent snapshot of the SAME question, and
// a question the user already answered or closed here is not reopened by the
// server's still-open copy of it (see applySnapshot / closeQuestion).
const questionFp = x => x ? JSON.stringify([x.id ?? x.questionId ?? null, (x.questions || []).map(q => [q?.question ?? null, q?.header ?? null, !!q?.multi, (q?.options || []).map(o => [typeof o === 'string' ? o : o?.label ?? null, typeof o === 'string' ? null : o?.description ?? null, typeof o === 'string' ? null : o?.preview ?? null])])]) : null;
// The identity a question answer carries, when the snapshot's question has
// one (its `id`, or `questionId` in the other spelling): sent as questionId
// with the /send answer so the server can refuse a late answer (409) once
// another front-end has answered the same question.
const questionIdOf = q => { const id = q?.id ?? q?.questionId; return id === undefined || id === null || id === '' ? null : id; };
// wave18: a body-carrying POST that hits the client-side timeout in
// discovery.request is NOT a dropped connection — the server may already
// have accepted the send, so the failure is marked unconfirmed there
// (err.unconfirmed / code 'UNCONFIRMED', or a resolved {unconfirmed: true}
// result). The wording is the one src/export.js already uses for an
// unconfirmed delivery, so its English entry already exists in
// src/i18n/en.js: it says delivery is unknown and that sending again may
// duplicate, and leaves the re-send decision to the user.
const UNCONFIRMED_SEND = '応答が読めなかったため、届いたか確認できませんでした。再送すると重複することがあります。';
const isUnconfirmed = x => !!x && (x.unconfirmed === true || x.code === 'UNCONFIRMED');
const MAX_INPUT = 1000000; // the local Controller's cap, for the picker's typed answers

export class RemoteController {
  constructor({client, sessionId, version, onExit, onReload}) {
    if (!client) throw new Error('RemoteController needs a client (src/server/client.js)');
    this.client = client; this.sessionId = sessionId; this.version = version;
    this.onExit = onExit || (() => {}); this.onReload = onReload;
    this.listeners = new Set();
    this.outputs = []; // the server owns tool outputs; ctrl+o fetches them via /outputs (showLatestOutput)
    this.museName = 'Muse'; // until the first snapshot names this conversation's Muse
    // The agent facade the view reads (Banner / Entry / Footer / status): a plain
    // mirror of the server-side agent, refreshed by every snapshot. `constructor`
    // is an own property on purpose — the view reads agent.constructor.DEVICE.
    this.agent = {
      cwd: '', mode: 'default',
      session: {id: null, turns: 0, title: ''},
      client: {status: ''},
      device: {connected: false},
      nodeSlot: null,
      accountId: null, accountLabel: null,
      constructor: {DEVICE: deviceName()},
    };
    // A mirror of the local Controller's initial state, plus linkDown (set when
    // the event stream stays down past linkDownDelayMs; the view ignores it).
    this.s = {
      entries: [],
      stream: null, running: null, bangRunning: null, busy: false, turnStart: 0, status: '', activity: '', museRunning: '',
      spinnerWord: null, agentWords: {},
      approval: null, reasonFor: null, promptFor: null, question: null, addFlow: null, menu: null, limitInput: null,
      todos: [], flash: '', deviceOk: false, loginNeeded: false,
      account: null, accountReserved: null,
      text: '', pos: 0, mode: 'default', clearCount: 0, attachments: [], agents: [], shells: [], queue: [],
      focus: null, plan: null, update: null, approvalQueue: 0, linkDown: false,
    };
    this.history = loadHistory(); this.hIndex = -1; this.draft = ''; this.exitArmed = {key: null, at: 0}; this.escArmed = 0;
    this.tabState = null; this.atPick = {key: null, idx: 0}; this.slashPick = {key: null, idx: 0};
    this.dollarPick = {key: null, idx: 0}; this.dollarDismissed = null; this._skillCache = null; // $skill completion, the local Controller's fields
    this.pasting = false; // one clipboard read at a time (the local Controller's double-paste guard)
    this.entriesHasMore = null; this._loadingOlder = false; this._entriesGen = 0; // /entries paging (loadOlderEntries); the generation guards a page fetched across a replacement (R16)
    this.md = createMd();
    this.linkDownDelayMs = 10000;
    this._closeEvents = null; this._linkTimer = null; this._stopped = false; this._started = false;
    this._allSlash = null; this._slashLoading = null; this.menuBuf = ''; this.menuTimer = null;
    this._questionClosedFp = null; // fingerprint of a picker answered/closed locally (see applySnapshot)
    this._reasonDraft = null; // the composer draft stashed while a decline reason is typed (R7)
    this._reasonForLocal = null; // the approval THIS window declined and is typing a reason for (R1)
    this._sending = false; // a submit is in flight (c8 #5)
    this._flashSource = null; // who owns s.flash right now: 'local' | 'server' | null (c8 #7)
    this._localEntrySeq = 0; // ids for locally appended entries (ctrl+o's note)
    this._pinned = []; // this window's own notes (pinNote): kept across entry replacements
  }
  // ---- store (the local Controller's shape, word for word) ----
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  get = () => this.s;
  set(patch) { this.s = {...this.s, ...patch}; this.trace(Object.keys(patch).join(',')); for (const fn of this.listeners) fn(); }
  trace(what) { (this.trail ||= []).push([Date.now(), what]); if (this.trail.length > 400) this.trail.splice(0, 100); }
  flash(msg, ms = 2500) { this._flashSource = 'local'; this.set({flash: msg}); clearTimeout(this.flashTimer); this.flashTimer = setTimeout(() => { this._flashSource = null; this.set({flash: ''}); }, ms); this.flashTimer.unref?.(); }
  setText(text, pos = text.length) { this.set({text, pos}); }
  insert(text) {
    const {text: cur, pos} = this.s;
    // serverfirst-debug R13: the composer insert honours the same
    // MAX_INPUT cap as the picker's typed answers — a paste of any size
    // used to grow the composer (and every state frame echoing it)
    // without limit.
    const next = cur.slice(0, pos) + text + cur.slice(pos);
    this.setText(next.slice(0, MAX_INPUT), Math.min(pos + text.length, MAX_INPUT));
  }

  base() { return '/api/s/' + encodeURIComponent(this.sessionId); }
  // Calls the client synchronously (a stub/recorder sees the request in the same
  // tick as the key press) and keeps a failure as a flash instead of a throw
  // escaping a key handler.
  request(method, p, body) {
    let r;
    try { r = this.client.request(method, p, body); }
    catch (e) {
      // wave18: an unconfirmed failure (see isUnconfirmed) gets its own
      // wording and a marked result, never the disconnect line.
      if (isUnconfirmed(e)) { this.flash(t(UNCONFIRMED_SEND), 8000); return Promise.resolve({status: 0, json: null, unconfirmed: true}); }
      this.flash(t('接続が切れました。再接続しています…'), 5000); return Promise.resolve(null);
    }
    return Promise.resolve(r).catch(err => {
      if (isUnconfirmed(err)) { if (!this._stopped) this.flash(t(UNCONFIRMED_SEND), 8000); return {status: 0, json: null, unconfirmed: true}; }
      if (!this._stopped) this.flash(t('接続が切れました。再接続しています…'), 5000);
      return null;
    });
  }
  post(p, body) { return this.request('POST', p, body); }
  // serverfirst-debug R6: for posts whose REFUSAL is a fact the user
  // must see (an answer the server rejects), flash the server's own
  // error text on a >= 400 response instead of letting it pass silently
  // (a transport failure already flashes through request()). Not for
  // fire-and-forget posts (interrupts) or expected refusals (menu side
  // posts against servers without paging).
  async postChecked(p, body) {
    let res = null;
    try { res = await this.post(p, body); } catch { res = null; }
    if (res && res.status >= 400 && !this._stopped) this.flash(res.json?.error || t('送信できませんでした'), 5000);
    return res;
  }

  // ---- lifecycle ----
  async start() {
    if (this._started) return this;
    this._started = true; this._stopped = false;
    // #67: the latch used to be set before the first fetch, so a failed seed
    // left a controller that looked started but had no snapshot and no event
    // subscription — and stop()/start() could never retry it. The latch now
    // only holds once seeding and subscribing have both succeeded.
    try {
      const r = await this.client.request('GET', this.base() + '/state');
      if (!r || r.status !== 200 || !r.json) throw new Error(r?.json?.error || ('server answered ' + (r?.status ?? 'nothing')));
      this.applySnapshot(r.json, true);
      this.refreshSlash(); // the slash candidate list, fetched once for Tab / Enter / ↑↓
      this._closeEvents = this.client.events(this.sessionId, {
        onEvent: ev => this.handleEvent(ev),
        onClose: () => this.handleLinkClose(),
      });
    } catch (e) { this._started = false; throw e; }
    return this;
  }
  stop() {
    this._stopped = true;
    this._started = false; // a stopped controller can be started again (#67)
    clearTimeout(this._linkTimer); this._linkTimer = null;
    clearTimeout(this.flashTimer); clearTimeout(this.menuTimer);
    if (this._closeEvents) { try { this._closeEvents(); } catch {} this._closeEvents = null; }
  }
  close() { this.stop(); }

  handleLinkClose() {
    if (this._stopped || this._linkTimer) return;
    this._linkTimer = setTimeout(() => {
      this._linkTimer = null;
      if (!this._stopped) { this._flashSource = 'local'; this.set({linkDown: true, flash: t('接続が切れました。再接続しています…')}); }
    }, this.linkDownDelayMs);
    this._linkTimer.unref?.();
  }
  handleEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    // Any event after a drop means the stream recovered.
    if (this._linkTimer) { clearTimeout(this._linkTimer); this._linkTimer = null; }
    if (this.s.linkDown) { this._flashSource = null; this.set({linkDown: false, flash: ''}); }
    if (ev.kind === 'entry' && ev.entry) return this.set({entries: [...this.s.entries, ev.entry]});
    if (ev.kind === 'entries-reset' && Array.isArray(ev.entries)) {
      this._entriesGen++; this.entriesHasMore = null; // R16/R17: a replacement retires in-flight pages and the stale hasMore
      // Always clear (deep H3): the server sends a reset for ANY non-append
      // replacement, whatever its size, and view's <Static> is keyed on
      // clearCount — clearing only on a shrink left the old conversation
      // rendered above a same-size-or-larger replacement.
      return this.set({entries: [...ev.entries, ...this._pinned], clearCount: this.s.clearCount + 1});
    }
    if (ev.kind === 'state' && ev.state) return this.applySnapshot(ev.state, Array.isArray(ev.state.entries));
    // {kind: 'server'} frames belong to serverEvents(), not a conversation stream.
  }

  // One snapshot (v6, with the v5 fields tolerated) onto the flat state the view
  // reads. Local composer state (text/pos/attachments) and the local modal
  // highlights are never in a snapshot, so they survive one arriving mid-typing;
  // a modal's highlight likewise survives the debounced state frames that keep
  // re-sending the still-open modal with its server-side index.
  applySnapshot(snap, withEntries = false) {
    if (!snap || typeof snap !== 'object') return;
    const live = snap.live || {}, patch = {};
    const pick = key => live[key] !== undefined ? live[key] : snap[key];
    if (withEntries && Array.isArray(snap.entries)) { patch.entries = [...snap.entries, ...this._pinned]; this._entriesGen++; this.entriesHasMore = null; } // R16/R17, same as entries-reset
    const stream = pick('stream');
    if (stream !== undefined) patch.stream = stream ? {id: stream.id ?? null, started: !!stream.started, partial: stream.partial || '', done: 0, emitted: '', raw: stream.partial || '', table: Array.isArray(stream.table) ? stream.table.map(String) : []} : null;
    for (const key of ['running', 'bangRunning', 'status', 'activity', 'museRunning', 'agentWords', 'turnStart']) {
      const v = pick(key); if (v !== undefined) patch[key] = v;
    }
    if (snap.busy !== undefined) patch.busy = !!snap.busy; else if (live.busy !== undefined) patch.busy = !!live.busy;
    const spinner = pick('spinnerWord'); if (spinner !== undefined) patch.spinnerWord = spinner;
    // Flash is dual-owned (c8 #7): a local notice ("Interrupting…", a
    // clipboard failure) must survive the state frames that keep arriving
    // with the server's usual flash:'' until its own timer runs out, and a
    // server flash that arrives later must not be erased early by that
    // local timer. Ownership decides whose '' may clear the line.
    const flash = live.flash;
    if (flash !== undefined) {
      if (!flash && this._flashSource === 'local') { /* keep the local notice */ }
      else { patch.flash = flash; if (flash) { clearTimeout(this.flashTimer); this._flashSource = 'server'; } else if (this._flashSource === 'server') this._flashSource = null; }
    }
    const device = snap.device || live.device;
    const deviceOk = live.deviceOk !== undefined ? live.deviceOk : device?.connected;
    if (deviceOk !== undefined) patch.deviceOk = !!deviceOk;
    const loginNeeded = pick('loginNeeded'); if (loginNeeded !== undefined) patch.loginNeeded = !!loginNeeded;
    if (snap.approval !== undefined) {
      const a = snap.approval, prev = this.s.approval;
      // #68: "both calls lack an id" used to count as the same approval, so a
      // different modal inherited the old highlight. Identity now also needs
      // the call's fingerprint (command/agent/summary + option labels) to
      // match; a differing id never matches.
      const fpA = x => x ? JSON.stringify([x.call?.command ?? null, x.call?.agent ?? null, x.call?.summary ?? null, (x.options || []).map(o => o?.label ?? null)]) : null;
      const same = !!prev && !!a && fpA(prev) === fpA(a) && (!(prev.call?.id || a.call?.id) || prev.call?.id === a.call?.id);
      patch.approval = a ? {...a, options: a.options || [], index: same ? Math.min(prev.index || 0, Math.max(0, (a.options || []).length - 1)) : (a.index ?? 0)} : null;
    }
    if (snap.reasonFor !== undefined) {
      const rf = snap.reasonFor ? (typeof snap.reasonFor === 'object' ? snap.reasonFor : true) : null;
      if (this._reasonForLocal) {
        // serverfirst-debug R1: the reason being typed here belongs to an
        // approval THIS window declined — the server enters its reason
        // wait only when the reason itself posts, so snapshots carry no
        // reasonFor for it and must not clear the local one. A snapshot
        // that DOES show a reason wait means the modal moved on: the
        // local reason is void.
        if (rf) { this._reasonForLocal = null; this._reasonDraft = null; patch.reasonFor = rf; }
      } else if (!this.s.reasonFor && rf) {
        // serverfirst-debug R7: a reason wait opened (another front-end
        // declined): the composer's current text is stashed, not eaten —
        // it comes back when the reason is answered or cancelled.
        if (this.s.text) { this._reasonDraft = {text: this.s.text, pos: this.s.pos}; patch.text = ''; patch.pos = 0; }
        patch.reasonFor = rf;
      } else if (this.s.reasonFor && !rf && this._reasonDraft) {
        // R7: the wait ended without this window answering (answered
        // elsewhere): hand the stashed draft back to the composer.
        patch.reasonFor = null;
        patch.text = this._reasonDraft.text; patch.pos = this._reasonDraft.pos;
        this._reasonDraft = null;
      } else patch.reasonFor = rf;
    }
    if (snap.menu !== undefined) {
      const m = snap.menu, prev = this.s.menu;
      // #68: title + option count took a different menu for the same one; the
      // options' labels and values are part of the identity now.
      const same = !!prev && !!m && menuFp(prev) === menuFp(m);
      patch.menu = m ? {...m, options: m.options || [], index: same ? prev.index : (m.index ?? 0)} : null;
    }
    if (snap.limitInput !== undefined) {
      const li = snap.limitInput, prev = this.s.limitInput;
      // #68: the same key alone took a NEW limit dialog (different label or
      // range) for the one being edited and kept the old local text for it.
      const same = !!prev && !!li && prev.key === li.key && prev.label === li.label && prev.min === li.min && prev.max === li.max;
      patch.limitInput = li ? {...li, ...(same ? {text: prev.text, selected: prev.selected} : {})} : null;
    }
    if (snap.question !== undefined) {
      const q = snap.question, prev = this.s.question;
      if (!q) { patch.question = null; this._questionClosedFp = null; }
      else if (questionFp(q) === this._questionClosedFp) {
        // Answered or closed in this window already: the server's copy is
        // still open (it only learns the answer from the /send it caused),
        // so a state frame re-sending it must not reopen the picker here.
        patch.question = null;
      } else {
        this._questionClosedFp = null;
        // Like the menu/approval highlights above: the interactive state
        // (tab, highlight, checks, picks, typed answers, notes, edit mode)
        // is local, and a re-sent copy of the SAME question keeps it; a
        // different question starts from the snapshot's own state, with the
        // local Controller's openQuestion defaults filling any gaps.
        const same = !!prev && questionFp(prev) === questionFp(q);
        const keep = same ? prev : q;
        patch.question = {...q, questions: q.questions || [], tab: keep.tab ?? 0, index: keep.index ?? 0, checked: keep.checked ?? {}, picked: keep.picked ?? {}, custom: keep.custom ?? {}, answers: keep.answers ?? {}, notes: keep.notes ?? '', mode: keep.mode ?? 'list', typeText: keep.typeText ?? ''};
      }
    }
    for (const key of ['queue', 'todos', 'agents', 'shells', 'focus', 'plan', 'approvalQueue']) {
      if (snap[key] !== undefined) patch[key] = snap[key];
    }
    if (snap.account !== undefined) patch.account = snap.account;
    // c8 #10: these three were constructor nulls that no snapshot ever
    // wrote, so the account-add screen, the prompt placeholder and the
    // footer's reserved-account lane could never appear in a remote
    // window. Map them whenever a snapshot carries them. (Today's
    // gui-server snapshot does not send them yet — see rows-A12.)
    if (snap.promptFor !== undefined) patch.promptFor = snap.promptFor || null;
    if (snap.addFlow !== undefined) patch.addFlow = snap.addFlow || null;
    if (snap.accountReserved !== undefined) patch.accountReserved = snap.accountReserved ?? null;
    if (snap.mode != null) { patch.mode = snap.mode; this.agent.mode = snap.mode; }
    if (snap.update !== undefined) patch.update = snap.update;
    // The agent facade and Muse's name.
    if (typeof snap.cwd === 'string' && snap.cwd) this.agent.cwd = snap.cwd;
    if (snap.session) this.agent.session = {id: snap.session.id ?? this.agent.session.id, turns: snap.session.turns ?? this.agent.session.turns, title: snap.session.title ?? this.agent.session.title ?? ''};
    const clientStatus = snap.clientStatus ?? snap.client?.status;
    if (clientStatus != null) this.agent.client = {...this.agent.client, status: clientStatus};
    if (device) {
      this.agent.device = {...this.agent.device, connected: !!device.connected};
      if (device.name) this.agent.constructor = {DEVICE: device.name};
      if (device.slot != null) this.agent.nodeSlot = {slot: device.slot};
    }
    if (patch.account) { this.agent.accountId = patch.account.id ?? null; this.agent.accountLabel = patch.account.label ?? null; }
    if (snap.accountId !== undefined) this.agent.accountId = snap.accountId;
    if (snap.accountLabel !== undefined) this.agent.accountLabel = snap.accountLabel;
    const museName = snap.muse?.name ?? snap.museName;
    if (typeof museName === 'string' && museName) this.museName = museName;
    if (Object.keys(patch).length) this.set(patch); else this.set({});
  }

  // ---- server-owned in the local Controller: harmless no-ops here ----
  showResumed() { return Promise.resolve(); } // the snapshot already carries the entries
  // A note from this window itself (not the server's conversation), e.g. "the Server
  // still runs an older build". A plain appended entry was wiped by the first
  // snapshot or entries-reset that replaced the list, so pinned notes ride along.
  pinNote(lines) {
    const entry = {id: 'local-pinned-' + (++this._localEntrySeq), type: 'note', lines: [].concat(lines)};
    this._pinned.push(entry);
    this.set({entries: [...this.s.entries, entry]});
  }
  checkUpdate() { return Promise.resolve(null); } // the snapshot's `update` field is the server's
  refreshPlan() { return Promise.resolve(this.s.plan || null); } // likewise `plan`

  // Preview of the unfinished line, the local Controller.previewRow() contract:
  // {row, first} for the view's Live area, null when nothing is streaming.
  previewRow() {
    const st = this.s.stream; if (!st?.partial && !st?.table?.length) return null;
    const room = (process.stdout.columns || 100) * Math.max(3, (process.stdout.rows || 30) - 16);
    const shown = st.partial.length > room ? '…' + st.partial.slice(-room) : st.partial;
    this.md ||= createMd();
    // The unfinished next row of a held table shows once it is whole (in the table, aligned).
    const fence = this.md.fence, row = shown && !(st.table?.length && /^\s*\|/.test(shown)) ? this.md.row(shown) : null; this.md.fence = fence;
    return {row, first: !st.started, table: st.table?.length ? tableRows(st.table) : []};
  }

  // ---- completion (slash via the server's /complete, @files local) ----
  refreshSlash() {
    if (this._allSlash) return Promise.resolve(this._allSlash);
    if (this._slashLoading) return this._slashLoading;
    let r;
    try { r = this.client.request('GET', this.base() + '/complete?kind=slash&q=' + encodeURIComponent('/')); } catch { return Promise.resolve([]); }
    this._slashLoading = Promise.resolve(r).then(res => {
      this._slashLoading = null;
      // serverfirst-debug R18: cache ONLY a real list — any resolved
      // response without items (a 404/500 body, an old server without
      // the route) used to cache [] and kill slash completion for the
      // whole session.
      if (res?.status === 200 && Array.isArray(res?.json?.items)) {
        this._allSlash = res.json.items.map(i => typeof i === 'string' ? i : i?.text).filter(x => typeof x === 'string');
        this.set({}); // a footer already showing a / prefix can draw the candidates now
        return this._allSlash;
      }
      return [];
    }).catch(() => { this._slashLoading = null; return []; });
    return this._slashLoading;
  }
  slashList(text) {
    if (!this._allSlash) { this.refreshSlash(); return []; }
    return this._allSlash.filter(n => n.startsWith(text));
  }
  slashIndex(text, n) {
    if (this.slashPick.key !== text) this.slashPick = {key: text, idx: 0};
    return n ? ((this.slashPick.idx % n) + n) % n : 0;
  }
  atIndex(fragment, n) {
    if (this.atPick.key !== fragment) this.atPick = {key: fragment, idx: 0};
    return n ? ((this.atPick.idx % n) + n) % n : 0;
  }
  // $skill completion, the local Controller's implementation: the candidates
  // come from the local filesystem (src/skills.js load, the same sources the
  // local Controller reads — skills are files on this PC, and the server-side
  // Controller.submit the /send lands in expands $name against the same
  // list), cached briefly because the footer asks on every render while a
  // $fragment is being typed and skills.load reads every SKILL.md it finds.
  skillList() {
    if (this._skillCache && Date.now() - this._skillCache.at < 3000 && this._skillCache.cwd === this.agent.cwd) return this._skillCache.list;
    let list = [];
    try { list = skills.load(this.agent.cwd); } catch { list = []; }
    this._skillCache = {at: Date.now(), cwd: this.agent.cwd, list};
    return list;
  }
  dollarContext(text, pos) {
    const frag = skills.dollarFragmentAt(text, pos);
    if (!frag) return null;
    const key = frag.start + ':' + frag.fragment;
    if (this.dollarDismissed === key) return null;
    const all = this.skillList();
    const q = frag.fragment;
    const list = all.filter(s => s.enabled && s.name.startsWith(q)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return {frag, key, list, noSkills: !all.some(s => s.enabled)};
  }
  dollarIndex(fragment, n) {
    if (this.dollarPick.key !== fragment) this.dollarPick = {key: fragment, idx: 0};
    return n ? ((this.dollarPick.idx % n) + n) % n : 0;
  }
  applyDollarPick(frag, pick) {
    const {text, pos} = this.s;
    const ins = pick.name + ' ';
    const nt = text.slice(0, frag.start) + ins + text.slice(pos);
    this.tabState = null;
    return this.setText(nt, frag.start + ins.length);
  }
  atContext(text, pos) {
    const at = mention.fragmentAt(text, pos);
    // All matches, as in the local Controller (deep Part B R4-1), not
    // mention.COMPLETE_LIMIT's first 6.
    return at ? {at, list: mention.complete(at.fragment, this.agent.cwd, 10000, () => this.set({}))} : null;
  }
  applyAtPick(at, pick) {
    const {text, pos} = this.s;
    const q = /\s/.test(pick) ? '"' + pick + '"' : pick;
    const ins = pick.endsWith('/') ? q : q + ' ';
    const nt = text.slice(0, at.start) + ins + text.slice(pos);
    this.tabState = null;
    return this.setText(nt, at.start + ins.length);
  }
  completeTab(text, pos) {
    const prev = this.tabState;
    if (prev && prev.text === text && prev.end === pos && prev.list.length > 1) {
      const idx = (prev.idx + 1) % prev.list.length, ins = prev.format(prev.list[idx]);
      const nt = text.slice(0, prev.start) + ins + text.slice(prev.end);
      this.tabState = {...prev, idx, text: nt, end: prev.start + ins.length};
      return this.setText(nt, prev.start + ins.length);
    }
    const dctx = this.dollarContext(text, pos);
    if (dctx) {
      // Tab completes the highlighted $skill to '$name ' (no list, no completion).
      if (!dctx.list.length) return;
      return this.applyDollarPick(dctx.frag, dctx.list[this.dollarIndex(dctx.frag.fragment, dctx.list.length)]);
    }
    const at = mention.fragmentAt(text, pos);
    if (at) {
      const list = mention.complete(at.fragment, this.agent.cwd, 10000, () => this.set({}));
      if (!list.length) return;
      const format = pick => { const q = /\s/.test(pick) ? '"' + pick + '"' : pick; return pick.endsWith('/') ? q : q + ' '; };
      const ins = format(list[0]), nt = text.slice(0, at.start) + ins + text.slice(pos);
      this.tabState = {kind: 'at', start: at.start, idx: 0, list, format, text: nt, end: at.start + ins.length};
      return this.setText(nt, at.start + ins.length);
    }
    if (text.startsWith('/') && !text.slice(0, pos).includes(' ')) {
      const word = text.slice(0, pos);
      const list = this.slashList(word).filter(n => n !== word);
      if (!list.length) return;
      const format = name => list.length === 1 ? name + ' ' : name;
      const ins = format(list[0]), nt = ins + text.slice(pos);
      this.tabState = {kind: 'slash', start: 0, idx: 0, list, format, text: nt, end: ins.length};
      return this.setText(nt, ins.length);
    }
  }

  // ---- sending ----
  async submit(text) {
    if (this.s.reasonFor) return this.submitReason(text);
    const trimmed = String(text ?? '').trim();
    if (!trimmed && !this.s.attachments.length) return;
    const cmd = trimmed.split(/\s+/)[0];
    // serverfirst-debug R4: while a typed prompt (or the account-add
    // flow) is open, the text IS its answer — the local Controller
    // routes it to the prompt. The /exit, /reload and /lang carve-outs
    // below must not fire: an answer of "/exit" used to close the
    // window and leave the server's prompt pending forever, and "/lang"
    // was eaten as a command instead of reaching the prompt.
    const promptOpen = !!(this.s.promptFor || this.s.addFlow);
    // Local only: forwarding /exit would close the conversation on the server
    // for every front-end, and /reload restarts this client, not the server.
    if (!promptOpen && (cmd === '/exit' || cmd === '/quit')) return this.onExit();
    if (!promptOpen && cmd === '/reload') return this.onReload ? this.onReload() : undefined;
    // /lang with a language argument: forwarding it runs setLang in the
    // SERVER process only, and this window's own language cache would keep
    // the old language until a restart — apply it in this process too (the
    // local Controller's argument mapping), then forward as usual so the
    // server switches and saves as before. A bare /lang (the menu) stays
    // server-driven, exactly as today.
    // serverfirst-debug R5: the local language is applied only once the
    // send lands (in the 2xx branch below) — it used to switch at once,
    // so a refused /lang (a closed conversation, a dropped link) left
    // this window in the new language and the server in the old one
    // until a restart.
    let langWant = null;
    if (!promptOpen && cmd === '/lang') {
      const arg = trimmed.slice(cmd.length).trim().toLowerCase();
      langWant = ({en: 'en', english: 'en', ja: 'ja', jp: 'ja', japanese: 'ja', '日本語': 'ja'})[arg] ?? null;
    }
    // c8 #5: no second send while one is in flight — the attachments stay
    // attached until a 2xx (the #63 fix), so a repeat Enter in that window
    // used to re-post the same images with the fallback text.
    if (this._sending) return;
    this._sending = true;
    if (cmd === '/clear') { this._entriesGen++; this.entriesHasMore = null; this.set({clearCount: this.s.clearCount + 1}); } // the server resets the entries too (R16/R17)
    // An image-only message still needs a text for the wire (the local
    // Controller's own fallback words for the same case).
    const body = {text: trimmed || t('（画像を見てください）')};
    if (this.s.attachments.length) body.attachments = [...this.s.attachments];
    const r = this.post(this.base() + '/send', body);
    // #63: the result used to be ignored and the attachments cleared at once,
    // so a 404 (the conversation was closed) silently ate the message and its
    // images. Only a 2xx clears them; on failure the text goes back into the
    // composer (when it is empty) and the attachments stay attached.
    let res = null;
    try { res = await r; } catch { res = null; } finally { this._sending = false; }
    if (res && res.status >= 200 && res.status < 300) {
      if (langWant) { try { i18n.setLang(langWant); } catch {} this.set({}); }
      // Remove only what this send carried (c8 #5): an attachment added
      // while the send was in flight is not this send's to clear.
      if (body.attachments?.length) {
        const left = [...this.s.attachments];
        for (const sent of body.attachments) { const i = left.indexOf(sent); if (i >= 0) left.splice(i, 1); }
        if (left.length !== this.s.attachments.length) this.set({attachments: left});
      }
    } else if (!this._stopped) {
      // wave18: an UNCONFIRMED send (the client-side timeout fired; the
      // server may already have accepted it) is neither a refusal nor a
      // dropped connection. Say delivery is unknown and leave the re-send
      // decision to the user — and do NOT put the text back into the
      // composer as if it were unsent: that restore is what turned the
      // measured abort into a duplicated turn on re-send. (The text is
      // still in the input history, so ↑ recalls it when the user decides
      // the send really did not land and chooses to send it again.)
      if (isUnconfirmed(res)) this.flash(t(UNCONFIRMED_SEND), 8000);
      else {
        // serverfirst-debug R6: a server REFUSAL (a response came back)
        // is not a dropped connection — flash the server's own reason (a
        // 409, a 400) instead of claiming the link is down. Only
        // no-response at all keeps the connection wording.
        if (res) this.flash(res.json?.error || t('送信できませんでした'), 5000);
        else this.flash(t('接続が切れました。再接続しています…'), 5000);
        if (trimmed && !this.s.text) this.setText(trimmed);
      }
    }
    return res;
  }
  submitReason(text) {
    // Clear BEFORE posting (deep H5): the modal is answered, so a repeat key
    // before the next snapshot must not be able to answer whatever modal
    // the server has since promoted. Clearing is the local Controller's
    // behaviour on answer (it consumes the state it answers).
    // serverfirst-debug R2: the answer names the approval it belongs to
    // when that is known (this window's own decline, or the snapshot's
    // reason wait), so a reason typed slowly cannot land on a DIFFERENT
    // approval the server has since promoted.
    const local = this._reasonForLocal;
    const waiting = typeof this.s.reasonFor === 'object' ? this.s.reasonFor : null;
    this._reasonForLocal = null;
    this.set({reasonFor: null});
    const body = {decision: {allow: false, reason: String(text ?? '').trim()}};
    const aid = local?.id ?? waiting?.id;
    if (aid != null) body.approvalId = aid;
    const r = this.postChecked(this.base() + '/approval', body);
    // R7: however the reason ends — submitted, or cancelled with an
    // empty one (ctrl+c / ctrl+d / esc all post '') — the half-typed
    // reason text is gone with it, and the draft stashed when the
    // reason opened returns to the composer. (The half-typed reason
    // used to stay behind in the composer as if it were a chat draft.)
    const d = this._reasonDraft; this._reasonDraft = null;
    if (d) this.setText(d.text, d.pos);
    return r;
  }
  setMode(m) {
    if (!MODES.includes(m)) return;
    this.agent.mode = m; this.set({mode: m});
    return this.postChecked(this.base() + '/mode', {mode: m});
  }
  cycleMode() { return this.setMode(MODES[(MODES.indexOf(this.s.mode) + 1) % MODES.length]); }

  // ---- attachments (the local Controller's helpers and messages) ----
  attach(file, temporary) {
    try {
      const a = clip.attachment(file, temporary);
      const total = this.s.attachments.reduce((n, x) => n + x.size, 0) + a.size;
      if (total > ATTACH_TOTAL) return this.flash(t('画像は合計 {max} MB までです（{name} を足すと {mb} MB）', {max: ATTACH_TOTAL / 1024 / 1024, name: a.name, mb: (total / 1024 / 1024).toFixed(1)}), 6000);
      this.set({attachments: [...this.s.attachments, a]}); this.flash(t('画像を添付: {name}', {name: a.name}));
    } catch (e) { this.flash(e.message); }
  }
  // Which input a paste would land in right now, the local Controller's
  // pasteTarget (deep c1 #10): a clipboard read can take a while, and the
  // paste must go to the input that was current when the user asked — or
  // nowhere — never into whatever happens to be open when the read finishes.
  pasteTarget() { const s = this.s; return s.approval ? 'approval' : s.question ? 'question:' + s.question.mode : s.limitInput ? 'limit' : s.reasonFor ? 'reason' : s.menu ? 'menu' : 'composer'; }
  async pasteImage() {
    if (this.pasting) return; // a second press while a read is in flight would attach the same image twice
    this.pasting = true;
    const target = this.pasteTarget();
    try {
      this.flash(t('クリップボードを確認しています…'), 5000);
      const {files, error} = await clip.clipboardImages();
      if (this.pasteTarget() !== target) return this.flash(t('画面が切り替わったため、貼り付けませんでした'));
      if (error) return this.flash(t('クリップボードを読めませんでした: {error}', {error}), 6000);
      if (!files.length) return this.flash(t('クリップボードに画像がありません'));
      files.forEach(f => this.attach(f.path, f.temporary));
    } finally { this.pasting = false; }
  }
  paste(text) {
    const value = String(text ?? '');
    if (this.s.limitInput) {
      const edit = this.s.limitInput, digits = value.trim();
      if (!/^\d+$/.test(digits)) return this.flash(t('0 以上の整数を入力してください（0 は無制限）'));
      return this.set({limitInput: {...edit, selected: false, text: (edit.selected ? '' : edit.text) + digits}});
    }
    // #158's remote recurrence (c8 #6): while a decline reason is being
    // typed the composer belongs to it, even if a menu opened meanwhile.
    if (this.s.approval || (this.s.menu && !this.s.reasonFor)) return;
    if (this.s.question) {
      // Into the picker's text modes (type-something / notes), as the local
      // Controller's paste does; the list itself takes no paste. Sanitised
      // and flattened to one line, as typed picker input is.
      const q = this.s.question;
      if (q.mode === 'list') return;
      return this.setQuestion({...q, typeText: (q.typeText + stripControls(value).replace(/\r\n?/g, ' ').replace(/\n/g, ' ')).slice(0, MAX_INPUT)});
    }
    const paths = clip.pastedImagePaths(value);
    if (paths) return paths.forEach(p => this.attach(p));
    // Sanitised exactly like the local Controller's paste (deep H4): pasted
    // text is untrusted, and an OSC 52 / CSI sequence in it would otherwise
    // execute in the terminal at render time. stripControls keeps \n and \t.
    this.insert(stripControls(value.replace(/\r\n?/g, '\n')));
  }
  // Paste whatever the clipboard holds (ctrl+shift+v, a right-click), the
  // local Controller's pasteFromClipboard (first #24): an image attaches,
  // text inserts at the caret through paste() (the sanitised path).
  async pasteFromClipboard() {
    if (this.pasting) return; // one read at a time, as in pasteImage above
    this.pasting = true;
    const target = this.pasteTarget();
    try {
      // Said at once: the two reads below are PowerShell runs, which take a second or
      // more on a busy PC, and a right click that showed nothing for that long read as
      // "right click does not paste". The image and the text are read in parallel.
      this.flash(t('貼り付けています…'), 15000);
      const [{files, error}, text] = await Promise.all([clip.clipboardImages(), clip.clipboardText().catch(() => '')]);
      if (this.pasteTarget() !== target) return this.flash(t('画面が切り替わったため、貼り付けませんでした'));
      if (!error && files.length) { this.flash(''); return files.forEach(f => this.attach(f.path, f.temporary)); }
      if (text) { this.flash(''); return this.paste(text); }
      if (error) return this.flash(t('クリップボードを読めませんでした: {error}', {error}), 6000);
      this.flash(t('クリップボードに貼れるものがありません'));
    } finally { this.pasting = false; }
  }
  // SGR mouse sequences, the local Controller's mouseInput: only a
  // right-button press means anything (it pastes); every sequence is
  // swallowed so clicks never land in the composer as garbage.
  mouseInput(input) {
    const re = /\x1b\[<\d+;\d+;\d+[Mm]/g;
    let right = false;
    for (const seq of input.match(re) || []) if (/\x1b\[<2;\d+;\d+M/.test(seq)) right = true;
    if (right && !this.s.approval && !this.s.menu && !this.s.limitInput && !(this.s.question && this.s.question.mode === 'list')) this.pasteFromClipboard();
  }
  // ctrl+o (first #25): the newest tool output in full. The outputs live
  // server-side, so fetch them (GET /outputs, newest first) and show the
  // newest as a local note entry, the way the local showOutput does; the
  // old code only ever read a local array nothing filled, so the key
  // always claimed there was no output.
  async showLatestOutput() {
    let res = null;
    try { res = await this.request('GET', this.base() + '/outputs'); } catch { res = null; }
    const list = res?.json?.outputs;
    if (!Array.isArray(list)) return; // request() already flashed the failure
    this.outputs = list;
    if (!list.length) return this.flash(t('まだ PC 操作の出力はありません。'));
    const o = list[0], text = String(o?.text ?? ''), lines = text.split('\n'), long = lines.length > 400;
    // The local Controller's showOutput saves the full text to a file every
    // time (os.tmpdir()/muser-output) and names it in the note; the wire
    // output carries a title (command + summary) instead of command/at.
    // serverfirst-debug R12: the file is named from the output's own id
    // when it has one — stable per output, so pressing ctrl+o again on
    // the same output overwrites the same file instead of piling up a
    // new timestamped file per press. The title part keeps Unicode
    // letters: the old [^\w.-] strip reduced every Japanese title to
    // the fallback 'output'.
    let file = '';
    try {
      const dir = path.join(os.tmpdir(), 'muser-output'); fs.mkdirSync(dir, {recursive: true});
      const namePart = String(o?.title ?? '').replace(/[^\p{L}\p{N}_.-]+/gu, '-').slice(0, 80) || 'output';
      const idPart = String(o?.id ?? '').replace(/[^\w.-]/g, '');
      file = path.join(dir, (idPart ? idPart + '-' : new Date().toISOString().replace(/[:.]/g, '-') + '-') + namePart + '.txt');
      fs.writeFileSync(file, text + '\n');
    } catch { file = ''; }
    const note = [...(o?.title ? [String(o.title)] : []), ...(long ? [t('… 先頭の {n} 行は省略', {n: lines.length - 200})] : []), ...(long ? lines.slice(-200) : lines),
      // R12: a truncated output's file holds only the capped text — the
      // note must not call it 全文.
      ...(file ? ['', o?.truncated ? t('保存先: {file}（サーバー側の上限で切り取られています）', {file}) : t('全文: {file}', {file})] : [])];
    this.set({entries: [...this.s.entries, {id: 'remote-output-' + (++this._localEntrySeq), type: 'note', lines: note}]});
  }

  // ---- older entries (GET /api/entries paging) ----
  // The snapshot carries only the newest 200 entries; this fetches one page
  // older than the oldest entry currently held and prepends it (deduplicated
  // by id, so an overlapping page never doubles a row). Returns the page
  // {entries, hasMore}, or null when the fetch failed / was refused (a 404
  // for an unknown `before` id leaves the held entries untouched). Wiring a
  // key or scroll trigger to it is the view's choice; the controller-side
  // fetch the investigation asked for lives here.
  async loadOlderEntries(limit = 200) {
    if (this._loadingOlder) return null;
    this._loadingOlder = true;
    try {
      const first = this.s.entries[0];
      const gen = this._entriesGen, firstId = first?.id;
      const n = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : 200;
      const qs = '?limit=' + n + (first?.id != null ? '&before=' + encodeURIComponent(String(first.id)) : '');
      let res = null;
      try { res = await this.request('GET', this.base() + '/entries' + qs); } catch { res = null; }
      if (!res || res.status !== 200 || !Array.isArray(res.json?.entries)) return null;
      // serverfirst-debug R16: the entries were REPLACED while the page
      // was in flight (a reset, a snapshot with entries, /clear) — the
      // fetched page belongs to the old list, and prepending it would
      // graft another conversation's history onto this one. Discard it.
      if (gen !== this._entriesGen || String(this.s.entries[0]?.id) !== String(firstId)) return null;
      const seen = new Set(this.s.entries.map(e => String(e?.id)));
      const older = res.json.entries.filter(e => !seen.has(String(e?.id)));
      this.entriesHasMore = !!res.json.hasMore;
      if (older.length) this.set({entries: [...older, ...this.s.entries]});
      return {entries: older, hasMore: this.entriesHasMore};
    } finally { this._loadingOlder = false; }
  }

  // ---- modal key modes (the local Controller's priority order) ----
  approvalKey(input, k) {
    const a = this.s.approval, n = a.options?.length || 0;
    // serverfirst-debug R9: escape / ctrl+c answer even an option-less
    // approval — they sat below the !n early return, so such an approval
    // could not be dismissed from the keyboard at all (the local
    // Controller handles them unconditionally).
    if (k.escape || (k.ctrl && input === 'c')) { this.set({approval: null}); const body = {decision: {allow: false}}; if (a.id != null) body.approvalId = a.id; return this.postChecked(this.base() + '/approval', body); }
    if (!n) return;
    if (k.upArrow) return this.set({approval: {...a, index: (a.index + n - 1) % n}});
    if (k.downArrow || k.tab) return this.set({approval: {...a, index: (a.index + 1) % n}});
    // R11: a batched digit run answers by its first digit, as the local
    // Controller's approvalKey truncates it.
    if (/^[0-9]{2,}$/.test(input)) input = input[0];
    if (/^[1-9]$/.test(input) && Number(input) <= n) return this.answerApproval(Number(input) - 1);
    // R10: a bare '\n' confirms too (terminals that report Enter as LF).
    if (k.return || input === '\n') return this.answerApproval(a.index || 0);
  }
  answerApproval(i) {
    const a = this.s.approval, o = a?.options?.[i];
    if (!o) return;
    this.set({approval: null}); // answered: consume it at once (deep H5, see submitReason)
    // The snapshot option's shape decides, as the local answer() does; the
    // "always" answers go as always: true and the server translates them to
    // the pending approval's own key / the auto-edit switch (gui-server).
    if (!o.allow) {
      // serverfirst-debug R1: the decline option IS "decline and say why"
      // (「いいえ（Muse に伝えることを入力）」) — posting {allow:false}
      // at once made the reason unreachable in remote windows: the
      // approval resolved immediately and no reason was ever asked for.
      // The local Controller opens the reason input instead and posts
      // only when the reason is submitted; the decline completes there.
      // R7: the composer's current draft is stashed and comes back after.
      this._reasonDraft = {text: this.s.text, pos: this.s.pos};
      this._reasonForLocal = a;
      this.set({approval: null, reasonFor: a, text: '', pos: 0});
      return;
    }
    // serverfirst-debug R2: every approval answer names the approval it
    // answers (the snapshot carries its id) — the server binds the
    // answer to that approval only, so a slow answer cannot land on a
    // different approval promoted meanwhile. (The decline-with-reason
    // path does the same in submitReason.)
    if (typeof o.always === 'string' || o.autoEdit) { const body = {decision: {allow: true, always: true}}; if (a.id != null) body.approvalId = a.id; return this.postChecked(this.base() + '/approval', body); }
    { const body = {decision: {allow: true}}; if (a.id != null) body.approvalId = a.id; return this.postChecked(this.base() + '/approval', body); }
  }
  // Answering a menu consumes it at once (deep H5, see submitReason): the
  // buffered digit and its timer go with it, and repeat keys find no menu.
  answerMenu(body) {
    // serverfirst-debug R2: name the menu being answered when the
    // snapshot gave it an id — the server refuses an answer whose menu
    // has since been replaced, instead of applying the pick to the new
    // menu. (Side-page posts are not answers and keep their exact body.)
    const mid = this.s.menu?.id;
    this.menuBuf = ''; clearTimeout(this.menuTimer); this.set({menu: null});
    return this.postChecked(this.base() + '/menu', mid != null ? {...body, menuId: mid} : body);
  }
  menuKey(input, k) {
    const m = this.s.menu, n = m.options?.length || 0;
    // serverfirst-debug R9: escape / ctrl+c cancel even an option-less
    // menu — they sat below the !n early return and were dead there.
    if (k.escape || (k.ctrl && input === 'c')) return this.answerMenu({cancel: true});
    // serverfirst-debug R8: any non-digit key drops a buffered digit —
    // a digit held for a two-digit pick used to outlive keys it was
    // never meant to survive (each branch below cleared it by hand;
    // letters and other keys did not).
    if (!/^[0-9]$/.test(input)) { this.menuBuf = ''; clearTimeout(this.menuTimer); }
    if (!n) return;
    // Browsing cancels a buffered digit (c8 #4): the 400 ms reservation is
    // for the menu as the user left it, not for wherever the highlight
    // has since moved. (Answering — Enter / Esc / a completed digit —
    // already clears it in answerMenu.)
    if (k.upArrow) { this.menuBuf = ''; clearTimeout(this.menuTimer); return this.set({menu: {...m, index: (m.index + n - 1) % n}}); }
    if (k.downArrow || k.tab) { this.menuBuf = ''; clearTimeout(this.menuTimer); return this.set({menu: {...m, index: (m.index + 1) % n}}); }
    // ← / → turn a menu's side pages (the local Controller's m.side branch:
    // /resume's folder pages). A remote menu has no local side() function —
    // the page turn lives server-side — so the key is forwarded through the
    // existing POST /menu mechanism as {key, side}: a server that supports
    // key names / side paging (the snapshot's side/group wire) turns the
    // page and the next snapshot brings it; a server that does not refuses
    // with no side effect. The local menu is NOT consumed: it is replaced
    // by that snapshot, or stays as it is.
    if (k.leftArrow || k.rightArrow) { this.menuBuf = ''; clearTimeout(this.menuTimer); return this.post(this.base() + '/menu', {key: k.leftArrow ? 'left' : 'right', side: k.leftArrow ? -1 : 1}); }
    // R11: a batched digit run is replayed digit by digit (a fast
    // typist or a paste can deliver "12" as one input event).
    if (/^[0-9]{2,}$/.test(input)) { for (const ch of input) this.menuKey(ch, {}); return; }
    if (/^[0-9]$/.test(input)) {
      const buf = (this.menuBuf || '') + input, val = Number(buf);
      if (val >= 1 && val <= n && (buf.length === 2 || val * 10 > n)) return this.answerMenu({index: val - 1});
      if (val >= 1 && val * 10 <= n) {
        this.menuBuf = buf; clearTimeout(this.menuTimer);
        // Judge by fingerprint, not object identity (c8 #4): a state frame
        // re-sends the still-open menu as a NEW object, and the buffered
        // digit must still land on it — but never on a different menu.
        const fp = menuFp(m);
        // R8: the timer also stands down when another modal has covered
        // the menu meanwhile — the buffered digit must not answer a
        // menu the user is no longer looking at.
        this.menuTimer = setTimeout(() => { this.menuBuf = ''; if (this.s.menu && menuFp(this.s.menu) === fp && !this.s.approval && !this.s.question && !this.s.limitInput && !this.s.reasonFor) this.answerMenu({index: val - 1}); }, 400); this.menuTimer.unref?.();
        return this.set({});
      }
      if (buf.length > 1) { this.menuBuf = ''; return this.menuKey(input, k); }
      return;
    }
    if (k.return || input === '\n') return this.answerMenu({index: m.index || 0}); // '\n' confirms too (R10)
    if (k.escape || (k.ctrl && input === 'c')) return this.answerMenu({cancel: true});
  }
  limitKey(input, k) {
    const edit = this.s.limitInput;
    if (k.escape || (k.ctrl && input === 'c')) { this.set({limitInput: null}); return this.postChecked(this.base() + '/limit', {cancel: true, key: edit.key}); }
    if (k.return || input === '\n') { // '\n' confirms too (R10)
      const value = Number(edit.text);
      const range = () => this.flash(t('{min}〜{max} の整数を入力してください', {min: edit.min, max: edit.max}));
      if (!/^\d+$/.test(edit.text) || !Number.isSafeInteger(value)) return edit.min !== undefined ? range() : this.flash(t('0 以上の整数を入力してください（0 は無制限）'));
      if (edit.min !== undefined && (value < edit.min || value > edit.max)) return range();
      this.set({limitInput: null}); // answered: consume it at once (deep H5)
      // First #22: name the input being answered (its key rides in the
      // snapshot) — the server refuses a missing/stale key, so a delayed
      // answer cannot land on a newer limit input.
      return this.postChecked(this.base() + '/limit', {value, key: edit.key});
    }
    if ((k.ctrl && (input === 'a' || input === 'u')) || k.backspace || k.delete)
      return this.set({limitInput: {...edit, selected: false, text: edit.selected || k.ctrl ? '' : edit.text.slice(0, -1)}});
    if (!k.ctrl && !k.meta && /^\d+$/.test(input)) this.set({limitInput: {...edit, selected: false, text: (edit.selected ? '' : edit.text) + input}});
  }

  // ---- selectable questions (focus.ask_user with options), the local
  // Controller's picker mirrored: navigation and editing are local (the
  // snapshot's question state is the seed, applySnapshot keeps the local
  // edits), and answering sends the composed reply as a normal message —
  // POST /send is how a client answers, per gui-server's snapshot comment.
  questionRows(qi) {
    const item = this.s.question.questions[qi];
    if (!item) return [];
    const rows = (item.options || []).map((o, i) => ({kind: 'option', i}));
    rows.push({kind: 'type', i: (item.options || []).length});
    rows.push({kind: 'chat'});
    return rows;
  }
  setQuestion(q) { this.set({question: q}); }
  closeQuestion() {
    // Consume it at once (deep H5, like the other modals) and remember its
    // fingerprint: the server still holds its own copy open, and the state
    // frames re-sending that copy must not reopen it here (applySnapshot).
    // The Focus question itself is not lost — a typed composer reply still
    // resumes the task server-side, as in the local Controller.
    if (this.s.question) this._questionClosedFp = questionFp(this.s.question);
    this.set({question: null});
  }
  questionAnswerText(qi, from = this.s.question) {
    const item = from?.questions?.[qi]; if (!item) return '';
    const parts = [];
    if (item.multi) parts.push(...(Array.isArray(from.checked?.[qi]) ? from.checked[qi] : []).slice().sort((a, b) => a - b).map(i => item.options?.[i]?.label).filter(x => typeof x === 'string'));
    else if (from.picked?.[qi] != null) parts.push(item.options?.[from.picked[qi]]?.label);
    if (from.custom?.[qi]) parts.push(from.custom[qi]);
    return parts.filter(x => typeof x === 'string' && x).join('、');
  }
  patchQuestion(patch, qi) {
    const next = {...this.s.question, ...patch};
    if (qi != null) next.answers = {...next.answers, [qi]: this.questionAnswerText(qi, next)};
    this.setQuestion(next);
  }
  questionTab(dir) {
    const q = this.s.question;
    if (!q || q.questions.length <= 1) return;
    const n = q.questions.length + 1;
    this.setQuestion({...q, tab: (q.tab + dir + n) % n, index: 0});
  }
  questionKey(input, k) {
    const q = this.s.question; if (!q) return;
    if (q.mode !== 'list') return this.questionEditKey(input, k);
    const rows = q.tab >= q.questions.length ? [{kind: 'submit'}] : this.questionRows(q.tab);
    if (k.upArrow) return this.setQuestion({...q, index: (q.index + rows.length - 1) % rows.length});
    if (k.downArrow) return this.setQuestion({...q, index: (q.index + 1) % rows.length});
    if (k.tab) return this.questionTab(k.shift ? -1 : 1);
    if (k.escape || (k.ctrl && input === 'c')) return this.closeQuestion();
    if (input === 'n' && !k.ctrl && !k.meta) return this.setQuestion({...q, mode: 'notes', typeText: q.notes});
    // R11: a batched digit run is replayed digit by digit.
    if (/^[0-9]{2,}$/.test(input)) { for (const ch of input) this.questionKey(ch, {}); return; }
    if (/^[0-9]$/.test(input)) {
      if (q.tab >= q.questions.length) { if (input === '1') return this.questionActivate(rows[0], 0, 'return'); return; }
      const choices = rows.filter(r => r.kind !== 'chat'), i = Number(input) - 1;
      if (i >= 0 && i < choices.length) return this.questionActivate(choices[i], i, 'return');
      return;
    }
    const row = rows[q.index];
    if (!row) return;
    if (k.return || input === '\n') return this.questionActivate(row, q.index, 'return');
    if (input === ' ' && (row.kind === 'option' || row.kind === 'type')) return this.questionActivate(row, q.index, 'space');
  }
  questionActivate(row, at, trigger = 'return') {
    const q = this.s.question; if (!q) return;
    if (q.tab >= q.questions.length) return this.submitQuestionAnswers();
    const qi = q.tab, item = q.questions[qi]; if (!item) return;
    if (row.kind === 'chat') { this.closeQuestion(); return this.flash(t('入力欄で答えてください')); }
    if (row.kind === 'type') {
      if (trigger === 'space' && item.multi && q.custom[qi]) {
        const custom = {...q.custom}; delete custom[qi];
        return this.patchQuestion({custom, index: at}, qi);
      }
      return this.setQuestion({...q, mode: 'type', typeText: q.custom[qi] || '', index: at});
    }
    if (item.multi) {
      if (trigger === 'return') {
        if (!this.questionAnswerText(qi)) return;
        if (q.questions.length <= 1) return this.submitQuestionAnswers();
        const answered = i => this.questionAnswerText(i);
        let next = qi + 1;
        while (next < q.questions.length && answered(next)) next++;
        return this.setQuestion({...q, tab: next, index: 0});
      }
      const cur = new Set(Array.isArray(q.checked[qi]) ? q.checked[qi] : []);
      if (cur.has(row.i)) cur.delete(row.i); else cur.add(row.i);
      return this.patchQuestion({checked: {...q.checked, [qi]: [...cur]}, index: at}, qi);
    }
    const custom = {...q.custom}; delete custom[qi];
    this.patchQuestion({picked: {...q.picked, [qi]: row.i}, custom}, qi);
    if (q.questions.length <= 1) return this.submitQuestionAnswers();
    const answered = i => this.questionAnswerText(i, this.s.question);
    let next = qi + 1;
    while (next < q.questions.length && answered(next)) next++;
    this.setQuestion({...this.s.question, tab: next, index: 0});
  }
  questionEditKey(input, k) {
    const q = this.s.question; if (!q) return;
    // The clipboard paste keys, mirrored from the local questionEditKey:
    // they land in typeText through paste(), which routes to the picker.
    if (k.ctrl && k.shift && (input === 'V' || input === 'v')) { this.pasteFromClipboard(); return; }
    if ((k.meta && input === 'v') || (k.ctrl && input === 'v') || input === '\x16') { this.pasteImage(); return; }
    if (k.escape || (k.ctrl && input === 'c')) return this.setQuestion({...q, mode: 'list', typeText: ''});
    if (k.return || input === '\n') {
      const text = q.typeText.trim();
      if (q.mode === 'notes') return this.setQuestion({...q, mode: 'list', notes: text, typeText: ''});
      const qi = q.tab, custom = {...q.custom};
      if (text) custom[qi] = text; else delete custom[qi];
      const patch = {mode: 'list', custom, typeText: ''};
      if (!q.questions[qi].multi && text) { const picked = {...q.picked}; delete picked[qi]; patch.picked = picked; }
      this.patchQuestion(patch, qi);
      if (text && q.questions.length <= 1 && !q.questions[qi].multi) return this.submitQuestionAnswers();
      return;
    }
    if (k.backspace || k.delete) { const tx = q.typeText; return this.setQuestion({...q, typeText: tx.slice(0, tx.length - lastClusterLen(tx))}); }
    if (input && !k.ctrl && !k.meta) return this.setQuestion({...q, typeText: (q.typeText + input.replace(/\r\n?/g, ' ').replace(/\n/g, ' ')).slice(0, MAX_INPUT)});
  }
  async submitQuestionAnswers() {
    const q = this.s.question; if (!q) return;
    const missing = q.questions.findIndex((_, i) => !this.questionAnswerText(i));
    if (missing >= 0) { this.flash(t('未回答の質問があります')); return this.setQuestion({...q, tab: missing, index: 0}); }
    const lines = q.questions.map((item, i) => item.question + ' → ' + this.questionAnswerText(i));
    if (q.notes) lines.push(t('メモ: {text}', {text: q.notes}));
    // Carry the question's identity when the snapshot gave it one, so the
    // server can tell this answer belongs to the still-open question and
    // refuse a late one (409) once another front-end answered it first.
    const questionId = questionIdOf(q);
    // serverfirst-debug R19: the answer post joins the same in-flight
    // guard as a composer send — it used to bypass _sending entirely,
    // so a question answer and a composer Enter (or a double answer)
    // could race two sends at once. (Set only once the post is certain:
    // the missing-answer return above must not strand the guard.)
    if (this._sending) return;
    this._sending = true;
    this.closeQuestion();
    // Posted directly, not through submit(): the answers are the Focus
    // reply, never a pending decline reason (the local submit's
    // fromQuestion exception, third M25) and never a slash command.
    const body = {text: lines.join('\n')};
    if (questionId !== null) body.questionId = questionId;
    let res = null;
    try { res = await this.post(this.base() + '/send', body); } catch { res = null; } finally { this._sending = false; }
    // Answered elsewhere first: the picker is already closed here, so say
    // so on the flash line instead of letting the refusal pass silently.
    // serverfirst-debug R20: only the question guard's OWN refusal (its
    // code, or its exact error text) means "answered elsewhere" — any
    // other 409 (the server's queue limit, which carries no code) used
    // to flash exactly that and hide the real reason.
    // wave18: a question answer rides the same /send, so an unconfirmed
    // timeout gets the same unknown-delivery wording (the picker is already
    // closed here; whether the answer landed is for the user to judge from
    // the conversation, not something to claim either way).
    if (isUnconfirmed(res)) this.flash(t(UNCONFIRMED_SEND), 8000);
    else if (res && res.status === 409 && (res.json?.code === 'question_answered' || res.json?.error === 'question already answered')) this.flash(t('ほかの画面で答えられました'), 5000);
    else if (res && res.status >= 400) this.flash(res.json?.error || t('送信できませんでした'), 5000);
    return res;
  }

  // ---- the composer ----
  key(input, k = {}) {
    try { this.eventRing?.recordKey(input, k); } catch {} // kind only, never the character (src/ui/event-ring.js)
    if (input && input.includes('\x1b[<')) return this.mouseInput(input);
    if (this.s.approval) return this.approvalKey(input, k);
    // The view's order (approval, then question, then menu, then
    // limitInput), as in the local Controller's key(): the picker the user
    // sees takes the keys, ahead of the composer and the other modals.
    if (this.s.question) return this.questionKey(input, k);
    // #158's remote recurrence (c8 #6): while a decline reason is being
    // typed the composer keys win over a menu that opened meanwhile; the
    // menu is still there when the reason is submitted or escaped.
    // serverfirst-debug R3: the menu takes keys BEFORE limitInput — the
    // local Controller's order, this file's own header comment, and the
    // view all say so; the dispatch here had limitInput first, so with
    // both open the keys went to the modal the user was NOT looking at.
    if (this.s.menu && !this.s.reasonFor) return this.menuKey(input, k);
    if (this.s.limitInput) return this.limitKey(input, k);
    if (!k.tab) this.tabState = null;
    const {text, pos} = this.s;
    if (k.ctrl && input === 'c') {
      // serverfirst-debug R4: ctrl+c cancels an open typed prompt (the
      // local Controller's cancelPrompt) instead of falling through to
      // the exit arming below and leaving the server's prompt pending.
      if (this.s.promptFor) { this.set({promptFor: null}); return this.post(this.base() + '/prompt', {cancel: true}); }
      // c8 #6: ctrl+c while a reason is pending answers it with an empty
      // reason (the local submitReason('')), instead of arming an exit
      // that leaves the server's reason wait unresolved forever.
      if (this.s.reasonFor) return this.submitReason('');
      // serverfirst-debug R15: the turn is interrupted before the bang
      // command — the local Controller's order, and this file's own Esc
      // branch below. Ctrl+C/D had it inverted, so with both running
      // they stopped the shell command and left the turn running.
      if (this.s.busy) { this.post(this.base() + '/interrupt', {target: 'turn'}); return this.flash(t('中断しています…')); }
      if (this.s.bangRunning) { this.post(this.base() + '/interrupt', {target: 'bang'}); return this.flash(t('中断しています…')); }
      if (text) { this.hIndex = -1; return this.setText(''); }
      if (this.exitArmed.key === 'c' && Date.now() - this.exitArmed.at < 1500) return this.onExit();
      this.exitArmed = {key: 'c', at: Date.now()}; return this.flash(t('もう一度 ctrl+c で終了'));
    }
    if (k.ctrl && input === 'd') {
      if (this.s.promptFor) { this.set({promptFor: null}); return this.post(this.base() + '/prompt', {cancel: true}); } // R4, same as ctrl+c
      if (this.s.reasonFor) return this.submitReason(''); // c8 #6, same as ctrl+c
      // The same interrupt branches as ctrl+c above (the local Controller's
      // #160 parity): a running !command or turn is stopped, not exited over.
      if (this.s.busy) { this.post(this.base() + '/interrupt', {target: 'turn'}); return this.flash(t('中断しています…')); }
      if (this.s.bangRunning) { this.post(this.base() + '/interrupt', {target: 'bang'}); return this.flash(t('中断しています…')); }
      if (!text) {
        if (this.exitArmed.key === 'd' && Date.now() - this.exitArmed.at < 1500) return this.onExit();
        this.exitArmed = {key: 'd', at: Date.now()}; return this.flash(t('もう一度 ctrl+d で終了'));
      }
      return;
    }
    if (k.ctrl && input === 'o') return this.showLatestOutput(); // first #25: fetch the server's outputs
    if (k.escape) {
      if (this.s.promptFor) { this.set({promptFor: null}); return this.post(this.base() + '/prompt', {cancel: true}); } // R4
      if (this.s.reasonFor) return this.submitReason('');
      if (this.s.busy) { this.post(this.base() + '/interrupt', {target: 'turn'}); return this.flash(t('中断しています…')); }
      if (this.s.bangRunning) { this.post(this.base() + '/interrupt', {target: 'bang'}); return this.flash(t('中断しています…')); }
      // Esc closes an open $skill list first (the local Controller's branch).
      const dctx = this.dollarContext(text, pos);
      if (dctx) { this.dollarDismissed = dctx.key; return this.set({}); }
      if (text) {
        if (Date.now() - (this.escArmed || 0) < 1500) { this.escArmed = 0; this.hIndex = -1; this.setText(''); return; }
        this.escArmed = Date.now(); return this.flash(t('もう一度 esc で入力を消す'), 1500);
      }
      return;
    }
    if (k.tab && k.shift) return this.cycleMode();
    // ctrl+shift+v (first #24), the local Controller's branch: paste
    // whatever the clipboard holds — text through paste(), an image as
    // an attachment. Plain ctrl+v below stays image-only.
    if (k.ctrl && k.shift && (input === 'V' || input === 'v')) { this.pasteFromClipboard(); return; }
    if ((k.meta && input === 'v') || (k.ctrl && input === 'v') || input === '\x16') { this.pasteImage(); return; }
    if (k.backspace && !text && this.s.attachments.length) return this.set({attachments: this.s.attachments.slice(0, -1)});
    if (k.tab && !k.shift) return this.completeTab(text, pos);
    if (k.return && !k.shift && !k.meta) {
      // Enter while the $skill list is open completes to '$name ', as in the
      // local Controller, instead of sending the fragment.
      const dctx = this.dollarContext(text, pos);
      if (dctx?.list.length) return this.applyDollarPick(dctx.frag, dctx.list[this.dollarIndex(dctx.frag.fragment, dctx.list.length)]);
      const ctx = this.atContext(text, pos);
      const pick = ctx?.list.length ? ctx.list[this.atIndex(ctx.at.fragment, ctx.list.length)] : null;
      if (pick && pick !== ctx.at.fragment) return this.applyAtPick(ctx.at, pick);
      if (text.startsWith('/') && !text.includes(' ')) {
        const list = this.slashList(text);
        const pick = list[this.slashIndex(text, list.length)];
        if (pick && pick !== text) return this.setText(pick, pick.length);
      }
    }
    if (k.return) {
      if (k.shift || k.meta) return this.insert('\n');
      if (text.slice(0, pos).endsWith('\\')) return this.setText(text.slice(0, pos - 1) + '\n' + text.slice(pos), pos);
      const wasReason = !!this.s.reasonFor;
      this.setText(''); this.hIndex = -1;
      if (wasReason) return this.submitReason(text); // R7: submitReason restores the stashed draft
      if (!text.trim() && !this.s.attachments.length) return;
      if (this.history[this.history.length - 1] !== text) { this.history.push(text); if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY); saveHistory(this.history); }
      this.draft = '';
      return this.submit(text);
    }
    if (input === '\n') return this.insert('\n'); // ctrl+j
    // Deletes and caret moves are one grapheme cluster, not one code
    // point (c8 #9, the local Controller's helpers at the top of file).
    if (k.backspace) { if (pos) { const n = lastClusterLen(text.slice(0, pos)); this.setText(text.slice(0, pos - n) + text.slice(pos), pos - n); } return; }
    if (k.delete) { const n = firstClusterLen(text.slice(pos)); if (n) this.setText(text.slice(0, pos) + text.slice(pos + n), pos); return; }
    if (k.leftArrow) { if (pos) this.set({pos: pos - lastClusterLen(text.slice(0, pos))}); return; }
    if (k.rightArrow) { const n = firstClusterLen(text.slice(pos)); if (n) this.set({pos: pos + n}); return; }
    if (k.home || (k.ctrl && input === 'a')) return this.set({pos: text.lastIndexOf('\n', pos - 1) + 1});
    if (k.end || (k.ctrl && input === 'e')) { const e = text.indexOf('\n', pos); return this.set({pos: e < 0 ? text.length : e}); }
    if (k.ctrl && input === 'u') return this.setText(text.slice(pos), 0);
    if (k.ctrl && input === 'k') return this.setText(text.slice(0, pos), pos);
    if (k.ctrl && input === 'w') { const b = text.slice(0, pos).replace(/\S+\s*$/, ''); return this.setText(b + text.slice(pos), b.length); }
    if (k.upArrow || k.downArrow) {
      // ↑↓ while a $fragment is being typed moves in the skill list, not history.
      const dctx = this.dollarContext(text, pos);
      if (dctx?.list.length) {
        const idx = this.dollarIndex(dctx.frag.fragment, dctx.list.length);
        this.dollarPick.idx = (idx + (k.upArrow ? -1 : 1) + dctx.list.length) % dctx.list.length;
        return this.set({});
      }
      const ctx = this.atContext(text, pos);
      if (ctx?.list.length) {
        const idx = this.atIndex(ctx.at.fragment, ctx.list.length);
        this.atPick.idx = (idx + (k.upArrow ? -1 : 1) + ctx.list.length) % ctx.list.length;
        return this.set({});
      }
      if (text.startsWith('/') && !text.includes(' ')) {
        const list = this.slashList(text);
        if (list.length) {
          const idx = this.slashIndex(text, list.length);
          this.slashPick.idx = (idx + (k.upArrow ? -1 : 1) + list.length) % list.length;
          return this.set({});
        }
      }
    }
    // In a multi-line draft ↑/↓ move the caret between lines (c8 #8, the
    // local Controller's recovery-scan block): they used to be dead keys
    // there — history is single-line only — so a pasted multi-line prompt
    // could not be edited without ←→ through every line.
    if ((k.upArrow || k.downArrow) && text.includes('\n')) {
      const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
      // serverfirst-debug R14: the column is counted in grapheme
      // clusters, not UTF-16 code units — on a line holding an emoji or
      // a combining kana the old arithmetic landed the caret inside a
      // cluster's span on the target line.
      const col = clusterCount(text.slice(lineStart, pos));
      if (k.upArrow) {
        if (!lineStart) return;
        const prevEnd = lineStart - 1, prevStart = text.lastIndexOf('\n', prevEnd - 1) + 1;
        const prevLine = text.slice(prevStart, prevEnd);
        return this.set({pos: prevStart + offsetAtClusterCol(prevLine, Math.min(col, clusterCount(prevLine)))});
      }
      const lineEnd = text.indexOf('\n', pos);
      if (lineEnd < 0) return;
      const nextStart = lineEnd + 1, nextEnd = text.indexOf('\n', nextStart);
      const nextLine = text.slice(nextStart, nextEnd < 0 ? text.length : nextEnd);
      return this.set({pos: nextStart + offsetAtClusterCol(nextLine, Math.min(col, clusterCount(nextLine)))});
    }
    if ((k.upArrow || k.downArrow) && !text.includes('\n')) {
      if (!this.history.length) return;
      if (k.upArrow) {
        if (this.hIndex < 0) this.draft = text;
        this.hIndex = this.hIndex < 0 ? this.history.length - 1 : Math.max(0, this.hIndex - 1);
        return this.setText(this.history[this.hIndex]);
      }
      if (this.hIndex < 0) return;
      this.hIndex++;
      if (this.hIndex >= this.history.length) { this.hIndex = -1; return this.setText(this.draft || ''); }
      return this.setText(this.history[this.hIndex]);
    }
    if (input && !k.ctrl && !k.meta) this.insert(input.replace(/\r\n?/g, '\n'));
  }
}
