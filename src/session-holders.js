'use strict';
// Who on this PC already holds a conversation (2026-11-09, found on the phone): every
// muser that opens a chat connects to Muse as a device of its own, and Muse sends the
// chat's tool calls to the device that sent the message. Two of them on one chat —
// a standalone window and the resident Server (which the GUI and the phone share) —
// fight over it: the work of one never arrives, and Muse reports the other's device
// offline. Sharing is the Server's job; this module only lets each opener see who has
// the chat already, so the Server does not open what a standalone window or a
// `muser exec` holds, and a standalone window / exec does not open what the Server
// or another one holds.
//
// The sources are the ones `muser status` reads: windows/<pid>.json (written only by
// standalone windows — a Server-backed window writes none), the running exec status
// files, and the resident Servers' own conversation lists.

/** A holder in the user's words: 「muser の窓（pid 123）」 etc. */
function holderText(h, t = require('./i18n').t) {
  if (h.kind === 'server') return t('Muser Server（pid {pid}）', {pid: h.pid});
  if (h.kind === 'exec') return t('muser exec（pid {pid}）', {pid: h.pid});
  return t('muser の窓（pid {pid}）', {pid: h.pid});
}

function sameId(a, b) { return !!a && !!b && String(a) === String(b); }

/** Standalone windows and running execs that hold [sessionId] (synchronous; no Servers).
 *  [excludePid] is the asker itself. */
function localHolders(sessionId, {excludePid = process.pid, readWindows, readExecs} = {}) {
  if (!sessionId) return [];
  const out = [];
  let windows = [];
  try { windows = (readWindows || (() => require('./window-status').readAll()))(); } catch {}
  for (const w of windows) if (w && w.pid !== excludePid && sameId(w.session?.id, sessionId)) out.push({kind: 'window', pid: w.pid, title: w.session?.title || null});
  let execs = [];
  try { execs = (readExecs || (() => require('./server/status').execRuns()))(); } catch {}
  for (const e of execs) {
    const id = typeof e?.session === 'string' ? e.session : e?.session?.id;
    if (e && e.pid !== excludePid && sameId(id, sessionId)) out.push({kind: 'exec', pid: e.pid, title: null});
  }
  return out;
}

/** localHolders plus the resident Servers whose open conversations include [sessionId]. */
async function allHolders(sessionId, {excludePid = process.pid, gatherServers, ...rest} = {}) {
  const out = localHolders(sessionId, {excludePid, ...rest});
  if (!sessionId) return out;
  let servers = [];
  try { servers = await (gatherServers || (() => require('./server/status').gatherWindowStatus()))(); } catch {}
  for (const s of servers || []) {
    if (!s || s.pid === excludePid) continue;
    if ((s.sessions || []).some(x => sameId(x?.id, sessionId))) out.push({kind: 'server', pid: s.pid, title: null});
  }
  return out;
}

module.exports = {localHolders, allHolders, holderText};
