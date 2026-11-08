// The fullscreen screen (the default; /settings "fullscreen" off or MUSER_CLASSIC=1 for classic): muser draws the whole
// terminal itself instead of handing a React tree to Ink. The Controller is the same one the
// classic screen uses — state, keys, commands — only the drawing differs:
//   - the history is virtualized (history.mjs): only what is visible is laid out, per width
//   - each frame is written as a diff of lines (screen.mjs), inside a synchronized update
//   - keys, paste and the wheel come from input.mjs (Ink's own parser, so keys match)
// Entries and the live area are drawn by src/ui/fs/draw/ (renderEntry /
// renderLive hand this screen plain strings). renderLive returns {lines,
// caret}: the caret comes with the lines, from the same computation that
// drew the prompt.
import {Screen} from './screen.mjs';
import {History} from './history.mjs';
import {attachInput} from './input.mjs';
import {highlight, rowRange, selectedText} from './select.mjs';
import {createRequire} from 'node:module';
const {copyText} = createRequire(import.meta.url)('../../clipboard.js');
const {t} = createRequire(import.meta.url)('../../i18n.js');
import {truncateEnd} from './draw/primitives.mjs';

import fs from 'node:fs';

const TRACE = process.env.MUSER_FS_TRACE || '';
const traceLines = []; let traceTimer = null;
function flushTrace() { clearTimeout(traceTimer); traceTimer = null; if (!traceLines.length) return; try { fs.appendFileSync(TRACE, traceLines.splice(0).join('\n') + '\n'); } catch {} }
function trace(line) { traceLines.push(Math.round(performance.now()) + 'ms ' + line); if (!traceTimer) traceTimer = setTimeout(flushTrace, 300); }

// ctrl: the Controller. renderEntry(e, W): an array of lines. renderLive(s, W):
// {lines, caret}. dim(text): the faint style. Returns {unmount(), screen,
// history} — the shape run() needs.
export function runFullscreen({ctrl, renderEntry, renderLive, dim = s => s, labels = {}, out = process.stdout, stdin = process.stdin}) {
  const screen = new Screen(out), history = new History(renderEntry);
  let scheduled = null, scheduledAt = 0, scheduledWhy = '', ticker = null, unmounted = false, last = {W: 0, H: 0, entries: []};
  // The mouse selection: anchor and head as {ref: {idx, off}, col} (conversation terms, so it
  // survives scrolling); pointer is where the dragging mouse is, resolved to a head each frame.
  let sel = null, lastRefs = [], edgeTimer = null, lastSid, bannerRow = -1;
  // MUSER_FS_TRACE=<file>: where the time goes, from this process's start — each frame's parts,
  // keys, resizes, and any stretch the event loop was blocked (startup work, a heavy turn).
  let stallTimer = null;
  if (TRACE) {
    trace('start: screen opens ' + Math.round(performance.now()) + ' ms after the process started');
    let tick = performance.now();
    stallTimer = setInterval(() => { const now = performance.now(), late = now - tick - 50; tick = now; if (late > 80) trace('event loop blocked ' + Math.round(late) + ' ms'); }, 50);
    stallTimer.unref?.();
  }
  const width = () => Math.max(20, screen.columns - 1);

  function frame() {
    const waited = scheduledAt ? performance.now() - scheduledAt : 0, why = scheduledWhy;
    scheduled = null; scheduledAt = 0; scheduledWhy = '';
    if (unmounted) return;
    lastFrameAt = performance.now();
    const t0 = performance.now(), laidOut0 = history.rendered, bytes0 = screen.stats.bytes;
    const s = ctrl.get(), W = width(), R = screen.rows;
    // A different conversation in this window (/resume, /new, /clear gives the
    // agent a new session) starts followed at its newest output: the scroll
    // anchor names an entry of the PREVIOUS conversation by index, so without
    // this the new conversation opened held at that index, its newest output
    // off screen (master-debug #9). A controller without a session id (demo)
    // never triggers it.
    const sid = ctrl.agent?.session?.id;
    if (sid !== undefined) { if (lastSid !== undefined && sid !== lastSid) history.reset(); lastSid = sid; }
    let liveRes = renderLive(s, W);
    const liveCaret = Array.isArray(liveRes) ? null : liveRes.caret || null;
    let live = Array.isArray(liveRes) ? liveRes : liveRes.lines;
    const t1 = performance.now();
    // The frame gives its rows to the live area first and to the history
    // second (wave 7): when the two do not fit, history lines are what give
    // way — never the prompt, a selection, a warning or the footer. A live
    // area taller than the whole window keeps a window of `avail` lines
    // ending at its bottom, except that the draft caret's row is always
    // inside the window, so the user never types blind (the old top cut
    // could take the caret row, and with it the IME anchor, on terminals
    // 6-12 rows tall; master-debug #4 was the first report of that shape).
    // Below 8 rows nothing fits usefully, so the top line becomes a
    // one-line notice asking for a bigger terminal, and the live window
    // and the caret get the remaining rows.
    const tiny = R < 8;
    const avail = tiny ? Math.max(1, R - 1) : R;
    let cut = 0;
    if (live.length > avail) {
      cut = live.length - avail;
      const caretRow = liveCaret && !s.approval && !s.question && !s.menu ? liveCaret.row : null;
      if (caretRow != null && caretRow < cut) cut = Math.max(0, caretRow - avail + (avail > 1 ? 2 : 1));
      live = live.slice(cut, cut + avail);
    }
    const H = tiny || live.length >= avail ? 0 : R - live.length;
    const {lines: hist, refs, unseen} = history.view(s.entries, W, H);
    const t2 = performance.now();
    last = {W, H, entries: s.entries}; lastRefs = refs;
    if (sel?.dragging) resolveHead(refs, H);
    if (sel) for (let r = 0; r < H; r++) { const range = rowRange(sel, refs[r]); if (range) hist[r] = highlight(hist[r], range[0], range[1]); }
    bannerRow = -1;
    if (!history.follow && H > 0) {
      const label = unseen ? (labels.unseen || '↓ new output: {n} · PgDn / Ctrl+End').replace('{n}', unseen) : (labels.scrolled || '↑ scrolled · PgDn / Ctrl+End to the bottom');
      hist[H - 1] = dim('── ' + label + ' ──');
      // The banner REPLACES the history row at H - 1, but refs[H - 1] still names the
      // covered line: a selection started there would copy a line that is not on the
      // screen. The mouse handler refuses that row as an anchor (see bannerRow).
      bannerRow = H - 1;
    }
    // The IME composes at the terminal cursor: it goes to the caret of the prompt box.
    // The draw returns the caret with the lines (row in live-area coordinates,
    // so the cut from the top is subtracted). The window above is chosen so
    // the caret row is inside it; the bounds check here is the last guard.
    let cursor = null;
    if (liveCaret && !s.approval && !s.question && !s.menu && liveCaret.row >= cut && liveCaret.row < cut + live.length) {
      const y = (tiny ? 1 : 0) + H + liveCaret.row - cut;
      if (y < R) cursor = {x: liveCaret.col, y};
    }
    const frameLines = tiny ? [dim(truncateEnd(labels.tooSmall || t('端末が小さすぎます。広げてください'), W)), ...live] : [...hist, ...live];
    screen.draw(frameLines.slice(0, R), cursor);
    // The events ring keeps this frame's cost and size (coalesced there;
    // src/ui/event-ring.js). Shapes only — no line of what was drawn.
    try { ctrl.eventRing?.recordRender({ms: performance.now() - t0, columns: screen.columns, rows: R, entries: s.entries.length}); } catch {}
    if (TRACE) trace('frame ' + screen.stats.frames + ' why=' + (why || '-') + ' wait=' + waited.toFixed(1) + ' live=' + (t1 - t0).toFixed(1) + ' hist=' + (t2 - t1).toFixed(1) + '(+' + (history.rendered - laidOut0) + ' laid out) draw=' + (performance.now() - t2).toFixed(1) + ' bytes=' + (screen.stats.bytes - bytes0) + ' size=' + screen.columns + 'x' + R + ' entries=' + s.entries.length);
    // Spinners and elapsed times move while something runs.
    const moving = s.busy || s.running || s.bangRunning || (s.agents || []).some(a => a.state === 'working');
    if (moving && !ticker) ticker = setInterval(schedule, 120);
    else if (!moving && ticker) { clearInterval(ticker); ticker = null; }
  }
  // A frame goes out on the next turn of the event loop (setImmediate), so a burst of state
  // changes in one tick still makes one frame. It used to be setTimeout(8), which Windows
  // timers stretch to ~15 ms: every key and every streamed delta was drawn a beat late.
  // Frames stay at least 16 ms apart (about 60 a second) while output streams in.
  let lastFrameAt = 0;
  function schedule(why) {
    if (scheduled || unmounted) return;
    scheduledAt = performance.now(); scheduledWhy = typeof why === 'string' ? why : 'state';
    const since = scheduledAt - lastFrameAt;
    scheduled = since >= 16 ? {immediate: setImmediate(frame)} : {timer: setTimeout(frame, 16 - since)};
  }
  const cancelScheduled = () => { if (scheduled?.immediate) clearImmediate(scheduled.immediate); if (scheduled?.timer) clearTimeout(scheduled.timer); scheduled = null; };

  const page = () => Math.max(1, last.H - 2);
  const scroll = delta => { const t = performance.now(), n = history.rendered; history.scroll(delta, last.entries, last.W, last.H); if (TRACE) trace('scroll ' + delta + ' took ' + (performance.now() - t).toFixed(1) + 'ms (+' + (history.rendered - n) + ' laid out)'); schedule('scroll'); };
  // The ref of the row at y, or the nearest row that has one: the top of a short
  // conversation is padding (refs null), and a pointer there still means the closest
  // real line. Shared by the anchor (mouse down) and the head, so a drag that starts
  // on a padding row selects from that line instead of not starting at all — the
  // head already had this rescue; the anchor did not.
  const nearestRef = (refs, y, H) => {
    let ref = refs[y];
    for (let d = 1; !ref && d < H; d++) ref = refs[y + d] || refs[y - d];
    return ref || null;
  };
  // Resolve the drag pointer to a selection head against a frame's row refs:
  // the row the pointer is over (nearest ref when it sits on a padding row),
  // the pointer's own column.
  const resolveHead = (refs, H) => {
    if (!sel?.dragging || !sel.pointer || H <= 0) return;
    const y = Math.max(0, Math.min(H - 1, sel.pointer.y));
    const ref = nearestRef(refs, y, H);
    if (ref) sel.head = {ref, col: Math.max(0, sel.pointer.x)};
  };
  const copySelection = () => {
    if (!sel) return;
    const text = selectedText(sel, history.linesBetween(last.entries, last.W, sel.anchor.ref, sel.head.ref));
    if (!text) return;
    copyText(text).then(ok => { try { ctrl.flash?.(ok ? (labels.copied || 'Copied ({n})').replace('{n}', [...text].length) : (labels.copyFailed || 'Could not copy')); } catch {} });
  };
  const clearSelection = () => { if (!sel) return false; sel = null; clearInterval(edgeTimer); edgeTimer = null; schedule('select'); return true; };
  // While the drag rests on the top or bottom row of the history, keep scrolling that way.
  // Only a pointer ON those rows counts: below the history is the live area, and a pointer
  // resting there (y past the last history row) used to read as "bottom edge" forever, so
  // the view kept scrolling down while the user was simply holding the pointer over the
  // composer. The edge is the history's own first / last row, nothing past it.
  const edgeScroll = () => {
    clearInterval(edgeTimer); edgeTimer = null;
    if (!sel?.dragging || !sel.pointer || last.H <= 0) return;
    const dir = sel.pointer.y <= 0 ? -1 : sel.pointer.y === last.H - 1 ? 1 : 0;
    if (!dir) return;
    scroll(dir);
    edgeTimer = setInterval(() => { if (!sel?.dragging) { clearInterval(edgeTimer); edgeTimer = null; return; } scroll(dir); }, 50);
  };
  // Is a completion list open under the composer? The footer draws one exactly when one
  // of the Controller's own contexts has candidates (the same helpers its ↑↓ handling
  // consults, on both the local and the remote Controller), so the wheel agrees with
  // the arrows about when a list is there to move in.
  const completionOpen = s => {
    const text = typeof s?.text === 'string' ? s.text : '', pos = typeof s?.pos === 'number' ? s.pos : text.length;
    try { if (ctrl.dollarContext?.(text, pos)?.list?.length) return true; } catch {}
    try { if (ctrl.atContext?.(text, pos)?.list?.length) return true; } catch {}
    if (text.startsWith('/') && !text.includes(' ')) { try { if (ctrl.slashList?.(text)?.length) return true; } catch {} }
    return false;
  };
  const detach = attachInput(stdin, {
    mouse({kind, x, y, button}) {
      if (TRACE) trace('mouse ' + kind + ' ' + x + ',' + y);
      // A right click pastes, as on the classic screen: the press means nothing, the
      // RELEASE asks the Controller for the clipboard paste (its own paste() refuses on
      // the screens that take no paste). The guards mirror Controller.mouseInput, so a
      // right click over an approval / menu / limit input / question list does not even
      // start a clipboard read. A right click never starts or moves a selection.
      if (button === 'right') {
        if (kind === 'up') {
          const s = ctrl.get();
          if (!s.approval && !s.menu && !s.limitInput && !(s.question && s.question.mode === 'list')) {
            try { const p = ctrl.pasteFromClipboard?.(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch {}
          }
        }
        return;
      }
      if (kind === 'down') {
        // The scrolled banner row shows no history line (frame() covered it), so no
        // selection starts there; a drag from the top padding rows starts at the
        // nearest real line instead (nearestRef, the head's rescue applied to the anchor).
        const ref = y !== bannerRow && y < last.H ? nearestRef(lastRefs, y, last.H) : null;
        sel = ref ? {anchor: {ref, col: x}, head: {ref, col: x}, pointer: {x, y}, dragging: true, moved: false} : null;
        clearInterval(edgeTimer); edgeTimer = null;
        return schedule('select');
      }
      if (!sel?.dragging) return;
      if (kind === 'drag') { sel.pointer = {x, y}; sel.moved = true; edgeScroll(); return schedule('select'); }
      // up: a click without a drag selects nothing; a drag copies at once. The
      // head is resolved from THIS event's own coordinates first (master-debug
      // #6): it used to keep whatever the last frame had resolved — a frame is
      // at least 16 ms old, and a terminal that sends no final drag event left
      // the head a whole drag behind — so a fast drag copied a stale end.
      sel.pointer = {x, y}; resolveHead(lastRefs, last.H);
      sel.dragging = false; clearInterval(edgeTimer); edgeTimer = null;
      if (!sel.moved) { sel = null; return schedule('select'); }
      copySelection(); schedule('select');
    },
    key(input, key) {
      // A finished selection is cleared by any key, and the key is then handled
      // normally (master-debug #7): the copy already happened at mouse-up, so
      // swallowing the first Esc / Ctrl+C after a drag only ate the user's
      // cancel / interrupt and made them press it twice.
      if (sel && !sel.dragging) clearSelection();
      if (TRACE) trace('key ' + JSON.stringify(input.length > 8 ? input.slice(0, 8) + '…' : input) + Object.entries(key).filter(([, v]) => v === true).map(([k]) => ' ' + k).join(''));
      if (key.pageUp) return scroll(-page());
      if (key.pageDown) return scroll(page());
      if (key.ctrl && key.end) { history.toBottom(); return schedule(); }
      if (key.ctrl && key.home) { history.toTop(last.entries); return schedule(); }
      // Writing or sending goes back to the newest output, as a chat does.
      if (!history.follow && (key.return || (input && !key.ctrl && !key.meta))) history.toBottom();
      ctrl.key(input, key);
    },
    paste(text) { history.toBottom(); ctrl.paste(text); },
    wheel(lines) {
      // While an approval, a menu or a question owns the live area, the wheel is that
      // screen's business, not the history's: scrolling the conversation behind it
      // moved a view the user was not looking at and lost their place. The event is
      // swallowed. A completion list is different — it has a selection to move — so
      // the wheel steps it, through the same key path the ↑↓ arrows take (the
      // Controller moves the highlight and re-renders).
      const s = ctrl.get();
      if (s.approval || s.menu || s.question) return;
      if (completionOpen(s)) { ctrl.key('', lines < 0 ? {upArrow: true} : {downArrow: true}); return; }
      scroll(lines);
    },
  });

  // A resize redraws one screen at once. ConPTY first sends its own reflowed copy of the old
  // frame (within a millisecond), so ours lands after it; a second, delayed redraw was tried
  // and dropped: it only doubled the clears, each a chance of a black frame.
  // A resize drops any selection, finished or still dragging: the anchor/head are
  // (entry, line, cell) at the OLD width, and at the new width those lines wrap
  // differently, so the same coordinates name different text — keeping the selection
  // across the resize highlighted, and on release copied, a range the user never
  // picked. clearSelection also stops an in-flight edge scroll.
  const onResize = () => { if (TRACE) trace('resize ' + screen.columns + 'x' + screen.rows); clearSelection(); screen.invalidate(); schedule('resize'); };

  out.on('resize', onResize);
  const unsubscribe = ctrl.subscribe(schedule);
  // console output would land in the middle of the frame: it becomes a note in the history.
  const consoleBackup = {};
  for (const name of ['log', 'info', 'warn', 'error']) {
    consoleBackup[name] = console[name];
    console[name] = (...args) => { try { ctrl.note?.(args.map(a => typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()).join(' ')); } catch {} };
  }
  const restore = () => { if (screen.active) screen.leave(); };
  process.on('exit', restore);
  screen.enter();
  frame();

  return {
    screen, history,
    rerender: schedule,
    unmount() {
      if (unmounted) return;
      unmounted = true;
      cancelScheduled(); clearInterval(ticker); clearInterval(stallTimer); clearInterval(edgeTimer);
      if (TRACE) { trace('unmount'); flushTrace(); }
      try { unsubscribe?.(); } catch {}
      out.off('resize', onResize);
      try { detach(); } catch {}
      Object.assign(console, consoleBackup);
      screen.leave();
      process.off('exit', restore);
    },
    waitUntilExit() { return new Promise(() => {}); },
  };
}
