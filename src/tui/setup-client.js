'use strict';
// Terminal driver for the resident Server's first-run setup.
//
// The setup itself lives on the server (src/server/setup.js, SetupFlow) and
// is served as plain state over HTTP (src/gui-server.js):
//   GET  /api/setup         -> {phase, steps, prompt, busy, lines, message,
//                               error, checkpointUrl}
//   POST /api/setup/answer    {promptId, value} for text/confirm prompts,
//                             {promptId, index} for pick prompts
//   POST /api/setup/start     start (or restart, from error/checkpoint)
//   POST /api/setup/cancel    cancel the whole flow
// and the server broadcasts {kind: 'setup', setup} on /api/server/events
// whenever the state changes.
//
// driveSetup() polls that state (a setup event wakes the poll early when
// the client offers serverEvents) and renders each prompt through a
// clack-shaped ui — src/tui/onboard.js's clackUi() ({ask, confirm, pick,
// busy}) fits as-is. Everything is injected so the driver is unit-testable
// with a fake client and a fake ui: no server, no Muse, no network.
const {t} = require('../i18n');

const DEFAULT_POLL_MS = 250;
// How many times one identical error may be retried via start() before the
// driver gives up and reports it, instead of looping on a flow that fails
// the same way every time.
const DEFAULT_MAX_ERROR_RETRIES = 3;

function defaultSleep(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function statusError(res) {
  const e = new Error(res?.json?.error || ('server answered ' + (res?.status ?? 'nothing')));
  e.status = res?.status;
  return e;
}

// client.request() answers discovery-style {status, json}; a direct helper
// may answer the state (or a call result) itself. Both unwrap to the plain
// value, and a non-200 {status, json} becomes a thrown error with .status,
// the same shape SetupFlow's own refusals carry.
function unwrap(res, {notFoundOk = false} = {}) {
  if (res && typeof res === 'object' && 'status' in res && 'json' in res) {
    // serverfirst-debug B15: only the state GET's 404 means "no setup on
    // this server". A 404 from start/answer/cancel is a REAL failure (a
    // server too old for the setup routes) — it used to unwrap to null
    // and read as success, so the driver reported done on a server still
    // sitting in setup.
    if (res.status === 404 && notFoundOk) return null;
    if (res.status >= 400) throw statusError(res);
    return res.json;
  }
  return res;
}

// The four setup operations over whichever client shape the caller has:
// dedicated helpers (getSetup/answerSetup/... or a SetupFlow-shaped
// state/answer/start/cancel) win, the generic request() is the fallback
// main wires bin/muser.js with (src/server/client.js's createClient).
function setupOps(client) {
  const pick = (...fns) => fns.find(f => typeof f === 'function');
  const call = fn => async arg => unwrap(await fn(arg));
  const callGet = fn => async arg => unwrap(await fn(arg), {notFoundOk: true});
  const request = typeof client.request === 'function'
    ? (method, path, body) => client.request(method, path, body)
    : null;
  const get = pick(client.getSetup, client.setupState, client.getSetupState, client.state,
    request && (() => request('GET', '/api/setup')));
  const answer = pick(client.answerSetup, client.setupAnswer, client.answer,
    request && (arg => request('POST', '/api/setup/answer', arg)));
  const start = pick(client.startSetup, client.setupStart, client.start,
    request && (() => request('POST', '/api/setup/start')));
  const cancel = pick(client.cancelSetup, client.setupCancel, client.cancel,
    request && (() => request('POST', '/api/setup/cancel')));
  if (!get || !answer || !start || !cancel) {
    throw new TypeError('driveSetup needs a client with setup helpers or request()');
  }
  return {getState: callGet(get), answer: call(answer), start: call(start), cancel: call(cancel)};
}

// A prompt the user backed out of: clackUi() exits the process itself on a
// real cancel, so a driver-level cancel arrives as an undefined answer
// (a raw clack cancel symbol counts too). false / 0 / '' are real answers.
function isCancelValue(v) { return v === undefined || typeof v === 'symbol'; }

async function driveSetup({
  client,
  ui,
  output,
  sleep = defaultSleep,
  pollMs = DEFAULT_POLL_MS,
  maxErrorRetries = DEFAULT_MAX_ERROR_RETRIES,
} = {}) {
  if (!client) throw new TypeError('driveSetup needs a client');
  if (!ui) throw new TypeError('driveSetup needs a ui');
  const ops = setupOps(client);
  // Progress, waiting, error and checkpoint lines go to one line sink: an
  // explicit output callback wins, then the ui's own log lines.
  const out = typeof output === 'function' ? output
    : typeof ui.info === 'function' ? (s => ui.info(s))
    : typeof ui.note === 'function' ? (s => ui.note(s))
    : typeof ui.output === 'function' ? (s => ui.output(s))
    : () => {};

  // A setup broadcast wakes the current poll sleep early; polling still
  // carries the driver when there is no stream (or it drops).
  let wake = null;
  let closeEvents = null;
  if (typeof client.serverEvents === 'function') {
    try {
      closeEvents = client.serverEvents({onEvent: ev => {
        if (ev && ev.kind === 'setup' && wake) { const w = wake; wake = null; w(); }
      }, onClose: () => {
        // serverfirst-debug S14: the stream reports each drop (it
        // reconnects on its own; an event after a close means the link
        // recovered). Wake the current poll so the driver re-reads the
        // state at once instead of sleeping out the interval on a wake
        // that can no longer come from the dead connection.
        if (wake) { const w = wake; wake = null; w(); }
      }});
    } catch { closeEvents = null; }
  }
  const waitPoll = async () => {
    if (!closeEvents) return sleep(pollMs);
    const woken = new Promise(resolve => { wake = resolve; });
    await Promise.race([sleep(pollMs), woken]);
    wake = null;
  };

  let started = false;       // start() accepted (or a 409: already running)
  let lastAnsweredId = null; // a stale snapshot may re-show the answered prompt
  let prevLines = [];        // state.lines already printed
  let lastBusy = null;       // busy text already shown
  let waitingShown = false;  // the login waiting line, once per login stretch
  let errorKey = null;       // the last error text printed
  // serverfirst-debug S4: retry accounting that flicker cannot reset —
  // a count per error text, plus a total across texts. (The old single
  // counter reset on ANY non-error poll and on every text change, so an
  // error -> busy -> error cycle, or two alternating texts, retried
  // forever.) A successfully answered prompt is real progress and DOES
  // reset both.
  const errorCounts = new Map();
  let errorRestarts = 0;
  let checkpointPrinted = null; // the checkpoint (URL or message) already shown
  let checkpointAsked = null;   // the checkpoint the user already said "done" to
  let cancelledRestarts = 0;    // S5: a stale cancelled flow is restarted at most once
  const promptAttempts = new Map(); // S6: 409s seen per prompt id

  const tryStart = async () => {
    try { await ops.start(); started = true; return true; }
    catch (e) {
      if (e && e.status === 409) { started = true; return true; } // already running
      throw e;
    }
  };

  try {
    for (;;) {
      const state = await ops.getState();
      // No setup on this server (or it vanished): preparation is done.
      if (!state || typeof state !== 'object') return {done: true};
      const phase = state.phase || 'done';

      // Lines the flow pushed (info/note, masked server-side) print once, in
      // order. serverfirst-debug S2: state.lines is a SLIDING tail (the
      // flow keeps only the newest 30), so the old common-prefix diff broke
      // the moment the window slid — the prefix was gone and ~29 old lines
      // printed again on every new line. Diff by overlap instead: the
      // longest suffix of what was printed that is also a prefix of the
      // new window is already on screen; only the rest is new. (A run of
      // identical lines can still over-match by its length; a capped tail
      // cannot do better, and it beats reprinting the window.)
      const lines = Array.isArray(state.lines) ? state.lines : [];
      let overlap = 0;
      const maxOverlap = Math.min(prevLines.length, lines.length);
      for (let k = maxOverlap; k > 0; k--) {
        let ok = true;
        for (let i = 0; i < k; i++) { if (prevLines[prevLines.length - k + i] !== lines[i]) { ok = false; break; } }
        if (ok) { overlap = k; break; }
      }
      for (let i = overlap; i < lines.length; i++) out(String(lines[i]));
      prevLines = lines;

      // Busy / login progress: the latest line only, shown once per change.
      // serverfirst-debug S12: lastBusy is NOT cleared when the busy text
      // momentarily disappears — a busy -> (gap) -> same busy flicker
      // used to print the line again every time.
      const busyText = state.busy != null && state.busy !== '' ? String(state.busy) : null;
      if (busyText && busyText !== lastBusy) { out(busyText); lastBusy = busyText; }
      // serverfirst-debug S12: the login waiting line is per login WAIT,
      // not per login poll — it used to reset on ANY non-login phase, so
      // login -> busy -> login printed it again. Only an interruption
      // that replaces the wait (an error, a checkpoint) re-arms it; a
      // rendered prompt re-arms it in the prompt branch below.
      if (phase === 'error' || phase === 'checkpoint') waitingShown = false;
      if (phase !== 'checkpoint') { checkpointPrinted = null; checkpointAsked = null; }

      // Terminal phases come AFTER the lines/busy printing above:
      // serverfirst-debug S11 — the final lines the flow pushed on its
      // way to done (the login result, the selected account) used to be
      // dropped because the returns sat at the top of the loop.
      if (phase === 'done') return {done: true};
      if (phase === 'cancelled') {
        // serverfirst-debug S5: SetupFlow.start() explicitly allows
        // starting FROM cancelled, but this driver returned at once — a
        // stale cancelled flow (left by an earlier window, a GUI cancel,
        // a killed terminal) bricked every later server-first start
        // while the resident serve sat in setup mode forever. Restart a
        // cancelled flow ONCE; a flow cancelled again after that is a
        // real cancel and is reported as before.
        if (cancelledRestarts >= 1) return {done: false, cancelled: true};
        cancelledRestarts++;
        await tryStart();
        await waitPoll();
        continue;
      }

      const prompt = state.prompt && typeof state.prompt === 'object' ? state.prompt : null;
      if (prompt && prompt.id !== lastAnsweredId) {
        waitingShown = false; // a prompt breaks the login wait (S12)
        let value;
        if (prompt.kind === 'confirm') {
          value = await ui.confirm(prompt.message);
        } else if (prompt.kind === 'pick') {
          value = await ui.pick(prompt.message, Array.isArray(prompt.options) ? prompt.options : []);
          if (value && typeof value === 'object') value = value.index ?? value.value;
        } else { // text (and any future kind that takes a typed answer)
          const opts = {
            hint: prompt.hint ?? undefined,
            placeholder: prompt.placeholder ?? undefined,
            initial: prompt.initial ?? undefined,
            secret: !!prompt.secret,
          };
          if (prompt.secret && typeof ui.password === 'function') value = await ui.password(prompt.message, opts);
          else if (prompt.secret && typeof ui.askSecret === 'function') value = await ui.askSecret(prompt.message, opts);
          else value = await ui.ask(prompt.message, opts);
        }
        if (isCancelValue(value)) {
          // serverfirst-debug S10: a failing cancel POST must not replace
          // the cancel itself with a thrown network error on its way out.
          try { await ops.cancel(); } catch {}
          return {done: false, cancelled: true};
        }
        // serverfirst-debug S6: normalise the answer to what the flow
        // validates — pick wants a safe-integer INDEX (a UI handing back
        // the chosen label string used to be rejected), text a string.
        let arg;
        if (prompt.kind === 'pick') {
          let index = value;
          if (typeof index === 'string') {
            const options = Array.isArray(prompt.options) ? prompt.options : [];
            index = options.findIndex(o => String(o?.label ?? o) === index);
          }
          if (typeof index !== 'number' || !Number.isSafeInteger(index)) { await waitPoll(); continue; }
          arg = {promptId: prompt.id, index};
        } else if (prompt.kind === 'confirm') {
          arg = {promptId: prompt.id, value: !!value};
        } else {
          arg = {promptId: prompt.id, value: typeof value === 'string' ? value : String(value ?? '')};
        }
        try {
          await ops.answer(arg);
          // Only a DELIVERED answer retires the prompt. The old code set
          // lastAnsweredId before posting and swallowed a 409 either
          // way, so a rejected answer was never retried and the prompt
          // stalled on screen until the terminal was killed.
          lastAnsweredId = prompt.id;
          promptAttempts.delete(prompt.id);
          errorCounts.clear(); errorRestarts = 0;
        } catch (e) {
          if (!e || e.status !== 409) throw e;
          // 409: the flow moved on (fine — the next poll shows what it
          // waits on now) OR the answer was rejected while the same
          // prompt is still up (the next poll asks again). Bound the
          // re-asks so a prompt that can never be answered from here
          // does not loop forever.
          const n = (promptAttempts.get(prompt.id) || 0) + 1;
          promptAttempts.set(prompt.id, n);
          if (n >= 2) lastAnsweredId = prompt.id;
        }
        continue;
      }
      if (prompt) { await waitPoll(); continue; } // the answered prompt, not yet replaced

      if (phase === 'idle') {
        // A flow that exists but has not been started yet: start it.
        // serverfirst-debug S1: WAIT for the next poll afterwards — start
        // is accepted (or 409s) while the flow is still spinning up, so
        // the state keeps reading 'idle' for a while, and continuing at
        // once looped GET/POST with no pause at all (tens of thousands of
        // requests inside one poll interval).
        await tryStart();
        await waitPoll();
        continue;
      }
      if (!started) started = true; // a prompt/busy/login phase: it is running already

      if (phase === 'error') {
        const errText = state.error != null ? String(state.error) : state.message != null ? String(state.message) : '';
        if (errText && errText !== errorKey) { out(errText); errorKey = errText; }
        const seen = errorCounts.get(errText) || 0;
        if (seen >= maxErrorRetries || errorRestarts >= maxErrorRetries * 3) return {done: false, error: errText || state.error};
        errorCounts.set(errText, seen + 1);
        errorRestarts++;
        await tryStart(); // start() is the retry: it runs again from error
        continue;
      }

      if (phase === 'checkpoint') {
        // serverfirst-debug S3: a checkpoint means the user must first do
        // something on the web (an additional-verification page). The old
        // code printed the URL and called start() in the SAME poll — no
        // time to act — then, keyed on the URL alone, never started again
        // when the flow landed on the same checkpoint twice (a silent
        // infinite wait), and a checkpoint carrying only a message (no
        // URL) hung with nothing shown at all. Now the URL and/or message
        // is shown once per checkpoint, the user is asked to say when
        // they are done, and only then does start() re-run the flow.
        // Leaving the phase re-arms both for the next checkpoint.
        const url = state.checkpointUrl != null ? String(state.checkpointUrl) : null;
        const msg = state.message != null ? String(state.message) : null;
        const key = url || (msg ? 'msg:' + msg : 'checkpoint');
        if (key !== checkpointPrinted) {
          if (msg) out(msg);
          if (url) out(url);
          checkpointPrinted = key;
        }
        if (checkpointAsked !== key) {
          const answer = await ui.confirm(msg || url || t('追加の確認が必要です。終わったら続けてください'));
          if (isCancelValue(answer)) {
            try { await ops.cancel(); } catch {}
            return {done: false, cancelled: true};
          }
          if (answer) { checkpointAsked = key; await tryStart(); continue; }
          // "Not yet" is the user's own keypress each time, so asking
          // again after a poll wait is a conversation, not a spin.
        }
        await waitPoll();
        continue;
      }

      if (phase === 'login') {
        // serverfirst-debug S13: when the flow publishes a busy text for
        // the login wait (「Edge の窓でログインを待っています」), that
        // line IS the waiting line — the generic one printed next to it
        // was a duplicate saying the same thing twice.
        if (!waitingShown && !busyText) { out(t('ログインを待っています')); waitingShown = true; }
        await waitPoll();
        continue;
      }

      // busy and the prompt-bearing phases with no prompt published yet:
      // progress was shown above, keep polling for the next state.
      await waitPoll();
    }
  } finally {
    if (typeof closeEvents === 'function') { try { closeEvents(); } catch {} }
  }
}

module.exports = {driveSetup};
