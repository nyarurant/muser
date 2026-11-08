// Session setup shared by the classic (Ink) screen and the fullscreen screen:
// the Controller (or the remote facade), exit/reload handling, the
// window-status report and the crash handler. No drawing code lives here, so
// the fullscreen entry (src/ui/fs/run.mjs) never loads React or Ink. The
// screen assigns hooks.unmount once its app exists; exit, reload and crash
// call it before the process goes.
import {createRequire} from 'node:module';
import {Controller} from './controller.mjs';
const require = createRequire(import.meta.url);
const {c} = require('../tui/term.js');
const {t} = require('../i18n.js');

export function bootSession({agent, museName, version, initial, connect, onReload, remoteCtrl, hooks = {}}) {
  // Client mode (remote/DESIGN.md step 4): the conversation lives in the
  // resident server and remoteCtrl (src/ui/remote-controller.mjs) already
  // mirrors it; the view renders it exactly like a local Controller. The
  // facade stands in for the agent everywhere the view reads one.
  if (remoteCtrl) agent = remoteCtrl.agent;
  const ctrl = remoteCtrl || new Controller({agent, museName, version, onExit: async () => {
    hooks.unmount?.();
    const id = agent.session.turns && agent.client.status !== 'demo' ? agent.session.id.slice(0, 8) : '';
    if (id) process.stdout.write(c.faint(t('再開するには: muser resume {id}', {id})) + '\n');
    // Leaving mid-turn only closed the sockets: Muse went on working for nobody.
    if (agent.busy && agent.cancelAll) { process.stdout.write(c.faint(t('Muse の作業を止めています…')) + '\n'); await agent.cancelAll().catch(() => {}); }
    // Graceful when this window owns a node id (the device link goes down first, then the id
    // is unpaired before the sockets go down); a remote client window owns none, so its agent
    // has no graceful close to call.
    if (typeof agent.closeGracefully === 'function') await agent.closeGracefully(); else agent.close();
    setTimeout(() => process.exit(0), 50);
  }, onReload: onReload ? async () => {
    // /reload: hand the terminal to a fresh process on the current code (it resumes this
    // session), then leave. Closing first frees this window's node slot for it; the fresh
    // process registers the same id again.
    hooks.unmount?.();
    let ok = true;
    try { onReload(); } catch { ok = false; }
    if (!ok) { const id = agent.session.turns ? agent.session.id.slice(0, 8) : ''; if (id) process.stdout.write(c.faint(t('再開するには: muser resume {id}', {id})) + '\n'); }
    if (typeof agent.closeGracefully === 'function') await agent.closeGracefully(); else agent.close();
    setTimeout(() => process.exit(0), 50);
  } : undefined});
  if (remoteCtrl) {
    // Detach, never close: /exit and /reload reach the RemoteController's own
    // callbacks; unmount first so the terminal is handed back cleanly.
    const userExit = remoteCtrl.onExit, userReload = remoteCtrl.onReload;
    remoteCtrl.onExit = async () => { try { hooks.unmount?.(); } catch {} if (userExit) await userExit(); else setTimeout(() => process.exit(0), 50); };
    remoteCtrl.onReload = userReload ? () => { try { hooks.unmount?.(); } catch {} userReload(); } : undefined;
  }
  // The end of stdin (audit-cli wave 18): neither main screen watched for
  // it — the fullscreen input (src/ui/fs/input.mjs) took 'data' only, and
  // the classic screen's Ink takes keys only — so a terminal that went away
  // without a SIGHUP (or a closed pipe) left a screen whose input was dead,
  // kept alive forever by its own timers (the spinner ticker, the plan
  // refresh, the window-status writer). No key can ever arrive again once
  // stdin ends, so the session is over: leave through the normal exit, the
  // one /exit and a double Ctrl+C take — unmount first (the fullscreen
  // screen writes its terminal-restore sequence there, Ink hands the
  // terminal back there), the agent's work stopped and closed, then exit
  // 0. Watched the way the setup prompts watch it (audit-cli wave 14,
  // promptWithEof in src/tui/onboard.js): once('end') and once('close'),
  // with a guard so the pair starts the exit only once. The fullscreen
  // input reports the same end to its own handler as well (input.mjs).
  let stdinExitStarted = false;
  const onStdinEnd = () => {
    if (stdinExitStarted) return;
    stdinExitStarted = true;
    process.stdin.off('end', onStdinEnd);
    process.stdin.off('close', onStdinEnd);
    try { const p = ctrl.onExit(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch {}
  };
  process.stdin.once('end', onStdinEnd);
  process.stdin.once('close', onStdinEnd);
  // The window's recent-events ring and freeze watchdog (EXPORT.md stage 2,
  // src/ui/event-ring.js / src/ui/watchdog.js): installed here because this
  // is the one place every window — fullscreen, classic, client — passes
  // through. The ring holds shapes only (key kinds, render times and sizes,
  // changed state field names, error names); state changes are diffed by
  // field name, the same rule ctrl.trail already keeps for crashes.
  const ring = new (require('./event-ring.js').EventRing)();
  try { ctrl.eventRing = ring; } catch {}
  try {
    let prev = {...(ctrl.s || {})};
    ctrl.subscribe(() => {
      const now = ctrl.s || {};
      const changed = Object.keys(now).filter(k => prev[k] !== now[k]);
      prev = {...now};
      if (changed.length) ring.recordState(changed);
    });
  } catch {}
  try { require('./watchdog.js').startWatchdog({version, sessionId: agent.session?.id || null}); } catch {}
  // What this window is doing, live, for `muser status` and other agents (src/window-status.js).
  // A client window's conversation is the server's, which `muser status` lists already; the
  // demo talks to no Muse.
  if (!remoteCtrl && agent.client?.status !== 'demo') { try { const ws = new (require('../window-status.js').WindowStatus)({ctrl, agent}).start(); ws.eventSource = ring; } catch {} }
  // An exception nothing caught ends muser: leave a report (src/crash.js) and the way back into the
  // chat instead of only a stack trace.
  // Re-entry guard (audit wave 12): a second fall while the first one's exit
  // is still being finished (cancelAll is awaited below) used to run this
  // whole handler again — a second record eating a KEEP slot, the guidance
  // printed twice, cancelAll called twice. The first fall owns the exit.
  let crashHandled = false;
  const crashed = e => {
    if (crashHandled) return;
    crashHandled = true;
    try { ring.recordError(e?.name || 'Error'); } catch {}
    let file = '';
    // The record names the fall the way the startup guard's and the server's
    // do (audit wave 12): scope 'turn' — this window died mid-conversation —
    // and the conversation's id, so /crash and /export can say WHICH fall and
    // WHICH chat it was. crash.write keeps only a non-empty string id.
    try { file = require('../crash.js').write({version, error: e, state: ctrl.s, trail: ctrl.trail, scope: 'turn', sessionId: agent.session?.id || null}); } catch {}
    try { hooks.unmount?.(); } catch {}
    const id = agent.session.turns && agent.client.status !== 'demo' ? agent.session.id.slice(0, 8) : '';
    // The terminal print keeps the stack (it is the user's own screen and their way back in) but
    // scrubs secret-shaped values line by line: a raw stack can carry them from the failing
    // operation (audit-cli W5).
    let shown = ''; try { const scrub = require('../crash.js').scrubSecretTextLine; shown = String(e?.stack || e).split('\n').map(l => scrub(l)).join('\n'); } catch { shown = String(e?.name || 'Error'); }
    process.stderr.write('\n' + shown + '\n\n' + t('muser が予期しないエラーで止まりました。') + '\n' +
      (file ? t('記録を保存しました（入力や会話の中身は含みません）: {file}', {file}) + '\n' : '') +
      // Plain `muser resume` rejoins the server's conversation too (the
      // server-first default), so one hint serves both front-ends.
      (id ? t('続きから再開するには: muser resume {id}', {id}) + '\n' : ''));
    // A crash mid-turn stops the work like a normal exit does, instead of leaving Muse
    // running for nobody (third M23). Bounded: a wedged cancel must not hang the exit.
    const finish = () => { try { agent.close(); } catch {} process.exit(1); };
    if (agent.busy && agent.cancelAll) { let done = false; const once = () => { if (!done) { done = true; finish(); } }; setTimeout(once, 2500); try { Promise.resolve(agent.cancelAll()).then(once, once); } catch { once(); } }
    else finish();
  };
  process.on('uncaughtException', crashed);
  process.on('unhandledRejection', crashed);
  globalThis.__muserCrashHandledByApp = true; // the startup guard (src/startup-guard.js) steps aside
  return {ctrl, agent, start() {
    // Drawn before Muse is reached: connect behind the screen; a message sent meanwhile waits for
    // it (runTurn awaits ensureConnected). Then learn Muse's name for next time.
    if (connect) connect().then(name => { if (name && name !== ctrl.museName) { ctrl.museName = name; ctrl.set({}); } }).catch(() => {});
    if (agent.session.turns) ctrl.showResumed(agent.session, {startup: true}); // muser resume / -c
    if (initial) ctrl.submit(initial);
    if (agent.client.status !== 'demo') ctrl.checkUpdate(); // right away, in the background (src/update.js)
    setTimeout(() => ctrl.refreshPlan(), 1500); // after the first frame: loading the login cookies blocks briefly
  }};
}
