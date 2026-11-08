'use strict';
// SetupFlow: the first-run setup (Edge web login, then this PC's device
// registration) as a plain state machine that answers over HTTP.
//
// The GUI's serve cannot drive the terminal prompts in src/tui/onboard.js
// (clack waits for keys) and cannot call process.exit the way the CLI's
// cancellation does, so the whole flow lives here behind injected deps:
//   needs()    which stages are still missing; asked again after the login
//              stage, because a fresh login can change whose device
//              registration is in place (same rule as onboard).
//   login(cb)  the Edge login (src/login.js); cb receives progress lines.
//   register(ui) the device registration (pcLogin(web, ui, {file})); ui is
//              this flow's httpUi below, shaped exactly like the ui object
//              src/pc-login.js already drives ({info, note, ask, confirm,
//              pick, busy, close} — cf. Controller.accountUi()).
//
// Questions become a `prompt` in state() and a pending promise; answer()
// resolves the one whose promptId matches. Nothing secret ever enters the
// state: answers are never copied into lines/message, and contacts are
// masked with maskContact before an info/note line is kept.
const {EventEmitter} = require('node:events');

function conflict(message) {
  const e = new Error(message);
  e.status = 409;
  return e;
}

// Mask a contact for display: an email keeps its first 2 local characters
// and its domain (so***@example.com), a phone keeps only its last 2 digits,
// anything else keeps its first 2 characters.
function maskContact(s) {
  const str = String(s ?? '');
  if (!str) return str;
  const at = str.indexOf('@');
  if (at > 0) return str.slice(0, at).slice(0, 2) + '***@' + str.slice(at + 1);
  const digits = str.replace(/\D/g, '');
  if (/^\+?[\d\s().-]+$/.test(str) && digits.length >= 7) {
    let seen = 0, out = '';
    for (let i = str.length - 1; i >= 0; i--) {
      const ch = str[i];
      if (/\d/.test(ch)) { seen++; out = (seen <= 2 ? ch : '*') + out; }
      else out = '*' + out;
    }
    return out;
  }
  return str.slice(0, 2) + '***';
}

// Mask any contact appearing inside a longer line (pc-login announces
// "{contact} にコードを送りました。" through info before the code is asked).
function maskLine(text) {
  let out = String(text ?? '');
  // Any address-shaped token is masked (master-debug #16: the old pattern
  // required a 2+ letter TLD, so a@b.c went out verbatim), and a phone-shaped
  // run may carry parentheses — (090) 1234-5678 used to slip through the same
  // way. Dots are not part of a phone run, so IPs and versions are untouched,
  // and the >= 9 digit gate keeps dates (2026-11-08 has 8) out.
  out = out.replace(/[^\s@]+@[^\s@]+/g, m => maskContact(m));
  out = out.replace(/\+?\(?\d[\d\s()-]*\d/g, m => (m.replace(/\D/g, '').length >= 9 ? maskContact(m) : m));
  return out;
}

// The checkpoint (Meta-side extra confirmation) reaches pc-login as a
// PcAuth snapshot whose checkpointUrl was already validated in
// src/core/pc-auth.js, and pc-login rethrows it as a sentence carrying
// that URL. Pull the URL back out the same way pc-auth validated it:
// https only, muse.ai (or a subdomain) or auth.meta.com.
function checkpointUrlOf(e) {
  const candidates = [];
  if (typeof e?.checkpointUrl === 'string') candidates.push(e.checkpointUrl);
  if (typeof e?.checkpoint_url === 'string') candidates.push(e.checkpoint_url);
  const msg = String(e?.message ?? '');
  for (const m of msg.matchAll(/https:\/\/[^\s'"<>]+/g)) candidates.push(m[0].replace(/[。、.]$/, ''));
  for (const c of candidates) {
    try {
      const u = new URL(c);
      if (u.protocol === 'https:' && (u.hostname === 'muse.ai' || u.hostname.endsWith('.muse.ai') || u.hostname === 'auth.meta.com')) return u.href;
    } catch {}
  }
  return null;
}

function isCheckpointError(e) {
  if (!e || typeof e !== 'object') return false;
  if (e.checkpoint === true || e.phase === 'checkpoint') return true;
  if (checkpointUrlOf(e)) return true;
  const msg = String(e.message ?? '');
  return msg.includes('追加の確認が必要です') || /additional (verification|confirmation)/i.test(msg);
}

// Which phase a question belongs to, from the question's own wording
// (src/pc-login.js and src/i18n, Japanese and English). A question whose
// wording is not recognised keeps the phase the flow is already in; the
// prompt itself is still published for the UI to draw and answer.
function phaseForPrompt(message) {
  const m = String(message ?? '');
  if (m.includes('追加認証コード') || /additional verification code/i.test(m)) return 'two_factor_code';
  if (m.includes('追加認証の方法') || /additional verification method/i.test(m)) return 'two_factor_method';
  if (m.includes('どのアカウント') || /which account/i.test(m)) return 'account';
  if (m.includes('利用規約') || /terms of use/i.test(m)) return 'terms';
  if (m.includes('届いた認証コード') || /verification code you received/i.test(m)) return 'code';
  if (m.includes('メールアドレス') || /email address you use to log in/i.test(m)) return 'contact';
  return null;
}

class SetupFlow extends EventEmitter {
  constructor({needs, login, register} = {}) {
    super();
    if (typeof needs !== 'function' || typeof login !== 'function' || typeof register !== 'function') {
      throw new TypeError('SetupFlow には needs / login / register の関数が必要です。');
    }
    this._needs = needs;
    this._login = login;
    this._register = register;
    this._running = false;
    this._cancelled = false;
    this._abort = null; // per-start AbortController; cancel() aborts the login stage too (master-debug #3)
    this._pending = null; // {prompt, resolve, reject} of the waiting question
    this._promptSeq = 0;
    this._busyStack = [];
    this._reset();
    // The ui object register() is driven through. Never calls process.exit:
    // cancellation is cancel() rejecting the waiting question instead.
    this.httpUi = {
      info: s => this._pushLine(s),
      note: s => this._pushLine(s),
      ask: (message, opts = {}) => this._askPrompt('text', message, opts).then(v => String(v).trim()),
      confirm: message => this._askPrompt('confirm', message),
      pick: (message, items) => this._askPrompt('pick', message, {items}),
      busy: (label, fn) => this._busy(label, fn),
      close: () => {},
    };
  }

  _reset() {
    this._phase = 'idle';
    this._steps = {login: 'later', device: 'later'};
    this._prompt = null;
    this._busyText = null;
    this._lines = [];
    this._message = null;
    this._error = null;
    this._checkpointUrl = null;
  }

  // A fresh plain copy on every call; mutating it cannot touch the flow.
  state() {
    return {
      phase: this._phase,
      steps: {...this._steps},
      prompt: this._prompt ? {...this._prompt, options: this._prompt.options.map(o => ({...o}))} : null,
      busy: this._busyText,
      lines: [...this._lines],
      message: this._message,
      error: this._error,
      checkpointUrl: this._checkpointUrl,
    };
  }

  _pushLine(text) {
    const line = maskLine(text);
    if (!line) return;
    this._lines.push(line);
    if (this._lines.length > 30) this._lines.splice(0, this._lines.length - 30);
    this._message = line;
    this.emit('change');
  }

  _askPrompt(kind, message, opts = {}) {
    if (this._cancelled) return Promise.reject(new Error('中止しました。'));
    if (this._pending) return Promise.reject(conflict('別の質問が待ち中です。'));
    const phase = phaseForPrompt(message);
    if (phase) this._phase = phase;
    const prompt = {
      id: 'p' + (++this._promptSeq),
      kind,
      message: String(message ?? ''),
      hint: opts.hint != null ? String(opts.hint) : null,
      placeholder: opts.placeholder != null ? String(opts.placeholder) : null,
      initial: opts.initial != null && String(opts.initial) !== '' ? String(opts.initial) : null,
      options: kind === 'pick' ? (opts.items || []).map(it => ({
        label: String(it?.label ?? ''),
        hint: it?.hint != null ? String(it.hint) : it?.description != null ? String(it.description) : null,
      })) : [],
      secret: phase === 'code' || phase === 'two_factor_code',
    };
    this._prompt = prompt;
    this.emit('change');
    return new Promise((resolve, reject) => { this._pending = {prompt, resolve, reject}; });
  }

  // Synchronous: a wrong promptId, no waiting question, or an answer of the
  // wrong kind for the waiting question is a 409 and the wait is untouched.
  answer({promptId, value, index} = {}) {
    const pending = this._pending;
    if (!pending || !this._prompt) throw conflict('待ち中の質問がありません。');
    if (promptId !== pending.prompt.id) throw conflict('promptId が一致しません。');
    let result;
    if (pending.prompt.kind === 'text') {
      if (typeof value !== 'string') throw conflict('この質問には文字列の答えが必要です。');
      result = value;
    } else if (pending.prompt.kind === 'confirm') {
      if (typeof value !== 'boolean') throw conflict('この質問には真偽値の答えが必要です。');
      result = value;
    } else { // pick
      if (!Number.isSafeInteger(index) || index < 0 || index >= pending.prompt.options.length) throw conflict('この質問には選択肢の番号が必要です。');
      result = index;
    }
    this._pending = null;
    this._prompt = null;
    this.emit('change');
    pending.resolve(result);
  }

  cancel() {
    this._cancelled = true;
    try { this._abort?.abort(); } catch {}
    const pending = this._pending;
    this._pending = null;
    this._prompt = null;
    this._busyText = null;
    if (this._running || pending) this._phase = 'cancelled';
    this.emit('change');
    if (pending) pending.reject(new Error('中止しました。'));
  }

  async _busy(label, fn) {
    this._busyStack.push(this._phase);
    this._phase = 'busy';
    this._busyText = String(label ?? '');
    this.emit('change');
    try { return await fn(); }
    finally {
      const prev = this._busyStack.pop();
      this._busyText = null;
      this._phase = this._cancelled ? 'cancelled' : (prev ?? this._phase);
      this.emit('change');
    }
  }

  _finishCancelled() {
    this._phase = 'cancelled';
    this._prompt = null;
    this._pending = null;
    this._busyText = null;
    this.emit('change');
  }

  // Runs from idle / error / cancelled / checkpoint; a run already in
  // flight (or a finished one) is a 409. The promise resolves when the
  // flow stops: done, checkpoint, error and cancelled all land in state().
  async start() {
    if (this._running) throw conflict('初回セットアップは既に実行中です。');
    if (!['idle', 'error', 'cancelled', 'checkpoint'].includes(this._phase)) throw conflict('初回セットアップは既に実行中です。');
    this._running = true;
    this._cancelled = false;
    this._abort = new AbortController();
    this._pending = null;
    this._busyStack = [];
    this._reset();
    this.emit('change');
    try {
      const first = await this._needs();
      if (this._cancelled) return this._finishCancelled();
      const loginNeeded = !!first?.login;
      let deviceNeeded = !!first?.device;
      this._steps.login = loginNeeded ? 'now' : 'done';
      this._steps.device = deviceNeeded ? (loginNeeded ? 'later' : 'now') : 'done';
      this.emit('change');
      if (loginNeeded) {
        this._phase = 'login';
        this.emit('change');
        await this._login(line => {
          const s = String(line ?? '').trim();
          if (!s) return;
          this._busyText = s; // only the latest progress line is kept
          this.emit('change');
        }, this._abort.signal);
        this._busyText = null;
        if (this._cancelled) return this._finishCancelled();
        this._steps.login = 'done';
        const again = await this._needs();
        if (this._cancelled) return this._finishCancelled();
        deviceNeeded = !!again?.device;
        this._steps.device = deviceNeeded ? 'now' : 'done';
        this.emit('change');
      }
      if (deviceNeeded) {
        this._steps.device = 'now';
        this._phase = 'busy';
        this.emit('change');
        await this._register(this.httpUi);
        if (this._cancelled) return this._finishCancelled();
        this._steps.device = 'done';
      }
      this._prompt = null;
      this._busyText = null;
      this._error = null;
      this._phase = 'done';
      this.emit('change');
      this.emit('done');
    } catch (e) {
      if (this._cancelled) { this._finishCancelled(); return; }
      this._prompt = null;
      this._pending = null;
      this._busyText = null;
      if (isCheckpointError(e)) {
        this._phase = 'checkpoint';
        this._checkpointUrl = checkpointUrlOf(e);
        this._message = e && e.message ? String(e.message) : String(e);
        this._error = null;
      } else {
        this._phase = 'error';
        const msg = e && e.message ? String(e.message) : String(e);
        this._error = msg;
        this._message = msg;
      }
      this.emit('change');
    } finally {
      this._running = false;
    }
  }
}

module.exports = {SetupFlow, maskContact};
