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
const require = createRequire(import.meta.url);
const clip = require('../clipboard.js');
const mention = require('../mentions.js');
const {MODES} = require('../policy.js');
const {t} = require('../i18n.js');

const MAX_HISTORY = 200;
const ATTACH_TOTAL = 11 * 1024 * 1024; // the same per-message cap as the local Controller
// The history file, read at use time (not module load) so tests and a relocated
// MUSER_HISTORY_FILE are honoured — the local Controller's helpers are not
// exported, so this is the small local copy its header comment describes.
function historyFile() { return process.env.MUSER_HISTORY_FILE || path.join(os.homedir(), '.muser', 'history.json'); }
function loadHistory() {
  try { const h = JSON.parse(fs.readFileSync(historyFile(), 'utf8')); return Array.isArray(h) ? h.filter(x => typeof x === 'string').slice(-MAX_HISTORY) : []; } catch { return []; }
}
function saveHistory(history) {
  try {
    const file = historyFile();
    const text = history[history.length - 1], disk = loadHistory();
    if (typeof text === 'string' && disk[disk.length - 1] !== text) disk.push(text);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const temp = file + '.tmp-' + process.pid;
    fs.writeFileSync(temp, JSON.stringify(disk.slice(-MAX_HISTORY))); fs.renameSync(temp, file);
  } catch {}
}
const deviceName = () => os.hostname() + ' CLI (muser)'; // src/agent.js's DEVICE_NAME formula

export class RemoteController {
  constructor({client, sessionId, version, onExit, onReload}) {
    if (!client) throw new Error('RemoteController needs a client (src/server/client.js)');
    this.client = client; this.sessionId = sessionId; this.version = version;
    this.onExit = onExit || (() => {}); this.onReload = onReload;
    this.listeners = new Set();
    this.outputs = []; // the server owns tool outputs; /output is forwarded like any slash command
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
      approval: null, reasonFor: null, promptFor: null, addFlow: null, menu: null, limitInput: null,
      todos: [], flash: '', deviceOk: false, loginNeeded: false,
      account: null, accountReserved: null,
      text: '', pos: 0, mode: 'default', clearCount: 0, attachments: [], agents: [], shells: [], queue: [],
      focus: null, plan: null, update: null, approvalQueue: 0, linkDown: false,
    };
    this.history = loadHistory(); this.hIndex = -1; this.draft = ''; this.exitArmed = {key: null, at: 0}; this.escArmed = 0;
    this.tabState = null; this.atPick = {key: null, idx: 0}; this.slashPick = {key: null, idx: 0};
    this.md = createMd();
    this.linkDownDelayMs = 10000;
    this._closeEvents = null; this._linkTimer = null; this._stopped = false; this._started = false;
    this._allSlash = null; this._slashLoading = null; this.menuBuf = ''; this.menuTimer = null;
  }
  // ---- store (the local Controller's shape, word for word) ----
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  get = () => this.s;
  set(patch) { this.s = {...this.s, ...patch}; this.trace(Object.keys(patch).join(',')); for (const fn of this.listeners) fn(); }
  trace(what) { (this.trail ||= []).push([Date.now(), what]); if (this.trail.length > 400) this.trail.splice(0, 100); }
  flash(msg, ms = 2500) { this.set({flash: msg}); clearTimeout(this.flashTimer); this.flashTimer = setTimeout(() => this.set({flash: ''}), ms); this.flashTimer.unref?.(); }
  setText(text, pos = text.length) { this.set({text, pos}); }
  insert(text) { const {text: cur, pos} = this.s; this.setText(cur.slice(0, pos) + text + cur.slice(pos), pos + text.length); }

  base() { return '/api/s/' + encodeURIComponent(this.sessionId); }
  // Calls the client synchronously (a stub/recorder sees the request in the same
  // tick as the key press) and keeps a failure as a flash instead of a throw
  // escaping a key handler.
  request(method, p, body) {
    let r;
    try { r = this.client.request(method, p, body); }
    catch { this.flash(t('接続が切れました。再接続しています…'), 5000); return Promise.resolve(null); }
    if (r && typeof r.catch === 'function') r.catch(() => { if (!this._stopped) this.flash(t('接続が切れました。再接続しています…'), 5000); });
    return r;
  }
  post(p, body) { return this.request('POST', p, body); }

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
      if (!this._stopped) this.set({linkDown: true, flash: t('接続が切れました。再接続しています…')});
    }, this.linkDownDelayMs);
    this._linkTimer.unref?.();
  }
  handleEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    // Any event after a drop means the stream recovered.
    if (this._linkTimer) { clearTimeout(this._linkTimer); this._linkTimer = null; }
    if (this.s.linkDown) this.set({linkDown: false, flash: ''});
    if (ev.kind === 'entry' && ev.entry) return this.set({entries: [...this.s.entries, ev.entry]});
    if (ev.kind === 'entries-reset' && Array.isArray(ev.entries)) {
      const shrank = ev.entries.length < this.s.entries.length;
      return this.set({entries: [...ev.entries], ...(shrank ? {clearCount: this.s.clearCount + 1} : {})});
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
    if (withEntries && Array.isArray(snap.entries)) patch.entries = [...snap.entries];
    const stream = pick('stream');
    if (stream !== undefined) patch.stream = stream ? {id: stream.id ?? null, started: !!stream.started, partial: stream.partial || '', done: 0, emitted: '', raw: stream.partial || '', table: Array.isArray(stream.table) ? stream.table.map(String) : []} : null;
    for (const key of ['running', 'bangRunning', 'status', 'activity', 'museRunning', 'agentWords', 'turnStart']) {
      const v = pick(key); if (v !== undefined) patch[key] = v;
    }
    if (snap.busy !== undefined) patch.busy = !!snap.busy; else if (live.busy !== undefined) patch.busy = !!live.busy;
    const spinner = pick('spinnerWord'); if (spinner !== undefined) patch.spinnerWord = spinner;
    const flash = live.flash; if (flash !== undefined) patch.flash = flash;
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
    if (snap.reasonFor !== undefined) patch.reasonFor = snap.reasonFor ? (typeof snap.reasonFor === 'object' ? snap.reasonFor : true) : null;
    if (snap.menu !== undefined) {
      const m = snap.menu, prev = this.s.menu;
      // #68: title + option count took a different menu for the same one; the
      // options' labels and values are part of the identity now.
      const fpM = x => x ? JSON.stringify([x.title ?? null, (x.options || []).map(o => [o?.label ?? null, JSON.stringify(o?.value ?? null)])]) : null;
      const same = !!prev && !!m && fpM(prev) === fpM(m);
      patch.menu = m ? {...m, options: m.options || [], index: same ? prev.index : (m.index ?? 0)} : null;
    }
    if (snap.limitInput !== undefined) {
      const li = snap.limitInput, prev = this.s.limitInput;
      // #68: the same key alone took a NEW limit dialog (different label or
      // range) for the one being edited and kept the old local text for it.
      const same = !!prev && !!li && prev.key === li.key && prev.label === li.label && prev.min === li.min && prev.max === li.max;
      patch.limitInput = li ? {...li, ...(same ? {text: prev.text, selected: prev.selected} : {})} : null;
    }
    for (const key of ['queue', 'todos', 'agents', 'shells', 'focus', 'plan', 'approvalQueue']) {
      if (snap[key] !== undefined) patch[key] = snap[key];
    }
    if (snap.account !== undefined) patch.account = snap.account;
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
      const items = res?.json?.items || [];
      this._allSlash = items.map(i => typeof i === 'string' ? i : i?.text).filter(x => typeof x === 'string');
      this._slashLoading = null;
      this.set({}); // a footer already showing a / prefix can draw the candidates now
      return this._allSlash;
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
  atContext(text, pos) {
    const at = mention.fragmentAt(text, pos);
    return at ? {at, list: mention.complete(at.fragment, this.agent.cwd, mention.COMPLETE_LIMIT, () => this.set({}))} : null;
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
    const at = mention.fragmentAt(text, pos);
    if (at) {
      const list = mention.complete(at.fragment, this.agent.cwd, mention.COMPLETE_LIMIT, () => this.set({}));
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
    // Local only: forwarding /exit would close the conversation on the server
    // for every front-end, and /reload restarts this client, not the server.
    if (cmd === '/exit' || cmd === '/quit') return this.onExit();
    if (cmd === '/reload') return this.onReload ? this.onReload() : undefined;
    if (cmd === '/clear') this.set({clearCount: this.s.clearCount + 1}); // the server resets the entries too
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
    try { res = await r; } catch { res = null; }
    if (res && res.status >= 200 && res.status < 300) {
      if (this.s.attachments.length) this.set({attachments: []});
    } else if (!this._stopped) {
      this.flash(t('接続が切れました。再接続しています…'), 5000);
      if (trimmed && !this.s.text) this.setText(trimmed);
    }
    return res;
  }
  submitReason(text) {
    return Promise.resolve(this.post(this.base() + '/approval', {decision: {allow: false, reason: String(text ?? '').trim()}}));
  }
  setMode(m) {
    if (!MODES.includes(m)) return;
    this.agent.mode = m; this.set({mode: m});
    return this.post(this.base() + '/mode', {mode: m});
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
  async pasteImage() {
    this.flash(t('クリップボードを確認しています…'), 5000);
    const {files, error} = await clip.clipboardImages();
    if (error) return this.flash(t('クリップボードを読めませんでした: {error}', {error}), 6000);
    if (!files.length) return this.flash(t('クリップボードに画像がありません'));
    files.forEach(f => this.attach(f.path, f.temporary));
  }
  paste(text) {
    const value = String(text ?? '');
    if (this.s.limitInput) {
      const edit = this.s.limitInput, digits = value.trim();
      if (!/^\d+$/.test(digits)) return this.flash(t('0 以上の整数を入力してください（0 は無制限）'));
      return this.set({limitInput: {...edit, selected: false, text: (edit.selected ? '' : edit.text) + digits}});
    }
    if (this.s.approval || this.s.menu) return;
    const paths = clip.pastedImagePaths(value);
    if (paths) return paths.forEach(p => this.attach(p));
    this.insert(value.replace(/\r\n?/g, '\n'));
  }

  // ---- modal key modes (the local Controller's priority order) ----
  approvalKey(input, k) {
    const a = this.s.approval, n = a.options?.length || 0;
    if (!n) return;
    if (k.upArrow) return this.set({approval: {...a, index: (a.index + n - 1) % n}});
    if (k.downArrow || k.tab) return this.set({approval: {...a, index: (a.index + 1) % n}});
    if (/^[1-9]$/.test(input) && Number(input) <= n) return this.answerApproval(Number(input) - 1);
    if (k.return) return this.answerApproval(a.index || 0);
    if (k.escape || (k.ctrl && input === 'c')) return this.post(this.base() + '/approval', {decision: {allow: false}});
  }
  answerApproval(i) {
    const a = this.s.approval, o = a?.options?.[i];
    if (!o) return;
    // The snapshot option's shape decides, as the local answer() does; the
    // "always" answers go as always: true and the server translates them to
    // the pending approval's own key / the auto-edit switch (gui-server).
    if (!o.allow) return this.post(this.base() + '/approval', {decision: {allow: false}});
    if (typeof o.always === 'string' || o.autoEdit) return this.post(this.base() + '/approval', {decision: {allow: true, always: true}});
    return this.post(this.base() + '/approval', {decision: {allow: true}});
  }
  menuKey(input, k) {
    const m = this.s.menu, n = m.options?.length || 0;
    if (!n) return;
    if (k.upArrow) return this.set({menu: {...m, index: (m.index + n - 1) % n}});
    if (k.downArrow || k.tab) return this.set({menu: {...m, index: (m.index + 1) % n}});
    if (/^[0-9]$/.test(input)) {
      const buf = (this.menuBuf || '') + input, val = Number(buf);
      if (val >= 1 && val <= n && (buf.length === 2 || val * 10 > n)) { this.menuBuf = ''; clearTimeout(this.menuTimer); return this.post(this.base() + '/menu', {index: val - 1}); }
      if (val >= 1 && val * 10 <= n) {
        this.menuBuf = buf; clearTimeout(this.menuTimer);
        this.menuTimer = setTimeout(() => { this.menuBuf = ''; if (this.s.menu) this.post(this.base() + '/menu', {index: val - 1}); }, 400); this.menuTimer.unref?.();
        return this.set({});
      }
      if (buf.length > 1) { this.menuBuf = ''; return this.menuKey(input, k); }
      return;
    }
    if (k.return) return this.post(this.base() + '/menu', {index: m.index || 0});
    if (k.escape || (k.ctrl && input === 'c')) { this.menuBuf = ''; clearTimeout(this.menuTimer); return this.post(this.base() + '/menu', {cancel: true}); }
  }
  limitKey(input, k) {
    const edit = this.s.limitInput;
    if (k.escape || (k.ctrl && input === 'c')) return this.post(this.base() + '/limit', {cancel: true});
    if (k.return) {
      const value = Number(edit.text);
      const range = () => this.flash(t('{min}〜{max} の整数を入力してください', {min: edit.min, max: edit.max}));
      if (!/^\d+$/.test(edit.text) || !Number.isSafeInteger(value)) return edit.min !== undefined ? range() : this.flash(t('0 以上の整数を入力してください（0 は無制限）'));
      if (edit.min !== undefined && (value < edit.min || value > edit.max)) return range();
      return this.post(this.base() + '/limit', {value});
    }
    if ((k.ctrl && (input === 'a' || input === 'u')) || k.backspace || k.delete)
      return this.set({limitInput: {...edit, selected: false, text: edit.selected || k.ctrl ? '' : edit.text.slice(0, -1)}});
    if (!k.ctrl && !k.meta && /^\d+$/.test(input)) this.set({limitInput: {...edit, selected: false, text: (edit.selected ? '' : edit.text) + input}});
  }

  // ---- the composer ----
  key(input, k = {}) {
    if (this.s.approval) return this.approvalKey(input, k);
    if (this.s.limitInput) return this.limitKey(input, k);
    if (this.s.menu) return this.menuKey(input, k);
    if (!k.tab) this.tabState = null;
    const {text, pos} = this.s;
    if (k.ctrl && input === 'c') {
      if (this.s.bangRunning) { this.post(this.base() + '/interrupt', {target: 'bang'}); return this.flash(t('中断しています…')); }
      if (this.s.busy) { this.post(this.base() + '/interrupt', {target: 'turn'}); return this.flash(t('中断しています…')); }
      if (text) { this.hIndex = -1; return this.setText(''); }
      if (this.exitArmed.key === 'c' && Date.now() - this.exitArmed.at < 1500) return this.onExit();
      this.exitArmed = {key: 'c', at: Date.now()}; return this.flash(t('もう一度 ctrl+c で終了'));
    }
    if (k.ctrl && input === 'd' && !text) {
      if (this.exitArmed.key === 'd' && Date.now() - this.exitArmed.at < 1500) return this.onExit();
      this.exitArmed = {key: 'd', at: Date.now()}; return this.flash(t('もう一度 ctrl+d で終了'));
    }
    if (k.ctrl && input === 'o') {
      if (!this.outputs.length) return this.flash(t('まだ PC 操作の出力はありません。'));
      return; // outputs live server-side; /output (forwarded) shows them in the entries
    }
    if (k.escape) {
      if (this.s.reasonFor) { this.setText(''); return this.submitReason(''); }
      if (this.s.busy) { this.post(this.base() + '/interrupt', {target: 'turn'}); return this.flash(t('中断しています…')); }
      if (this.s.bangRunning) { this.post(this.base() + '/interrupt', {target: 'bang'}); return this.flash(t('中断しています…')); }
      if (text) {
        if (Date.now() - (this.escArmed || 0) < 1500) { this.escArmed = 0; this.hIndex = -1; this.setText(''); return; }
        this.escArmed = Date.now(); return this.flash(t('もう一度 esc で入力を消す'), 1500);
      }
      return;
    }
    if (k.tab && k.shift) return this.cycleMode();
    if ((k.meta && input === 'v') || (k.ctrl && input === 'v') || input === '\x16') { this.pasteImage(); return; }
    if (k.backspace && !text && this.s.attachments.length) return this.set({attachments: this.s.attachments.slice(0, -1)});
    if (k.tab && !k.shift) return this.completeTab(text, pos);
    if (k.return && !k.shift && !k.meta) {
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
      if (wasReason) return this.submitReason(text);
      if (!text.trim() && !this.s.attachments.length) return;
      if (this.history[this.history.length - 1] !== text) { this.history.push(text); if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY); saveHistory(this.history); }
      this.draft = '';
      return this.submit(text);
    }
    if (input === '\n') return this.insert('\n'); // ctrl+j
    if (k.backspace) { if (pos) { const ch = [...text.slice(0, pos)].pop(); this.setText(text.slice(0, pos - ch.length) + text.slice(pos), pos - ch.length); } return; }
    if (k.delete) { const ch = [...text.slice(pos)][0]; if (ch) this.setText(text.slice(0, pos) + text.slice(pos + ch.length), pos); return; }
    if (k.leftArrow) { if (pos) this.set({pos: pos - [...text.slice(0, pos)].pop().length}); return; }
    if (k.rightArrow) { const ch = [...text.slice(pos)][0]; if (ch) this.set({pos: pos + ch.length}); return; }
    if (k.home || (k.ctrl && input === 'a')) return this.set({pos: text.lastIndexOf('\n', pos - 1) + 1});
    if (k.end || (k.ctrl && input === 'e')) { const e = text.indexOf('\n', pos); return this.set({pos: e < 0 ? text.length : e}); }
    if (k.ctrl && input === 'u') return this.setText(text.slice(pos), 0);
    if (k.ctrl && input === 'k') return this.setText(text.slice(0, pos), pos);
    if (k.ctrl && input === 'w') { const b = text.slice(0, pos).replace(/\S+\s*$/, ''); return this.setText(b + text.slice(pos), b.length); }
    if (k.upArrow || k.downArrow) {
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
