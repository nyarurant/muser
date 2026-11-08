// Keyboard, paste and wheel input for the fullscreen screen. The bytes are split into events by
// Ink's own input parser and keypress decoder — vendored beside this file
// (input-parser.mjs / parse-keypress.mjs) so the fullscreen screen loads no
// file from the ink package — so every key reaches the Controller in exactly
// the shape the classic screen's useInput hands it, and the two screens
// cannot disagree about a key. Wheel reports (SGR mouse) are taken out
// first: they scroll the history and never reach the Controller.
import {createInputParser} from './input-parser.mjs';
import parseKeypress, {nonAlphanumericKeys} from './parse-keypress.mjs';

const MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([mM])$/;

// The same mapping as Ink's useInput (ink/build/hooks/use-input.js), so a key means the same
// on both screens.
export function toKey(sequence) {
  const keypress = parseKeypress(sequence);
  const key = {
    upArrow: keypress.name === 'up', downArrow: keypress.name === 'down', leftArrow: keypress.name === 'left', rightArrow: keypress.name === 'right',
    pageDown: keypress.name === 'pagedown', pageUp: keypress.name === 'pageup', home: keypress.name === 'home', end: keypress.name === 'end',
    return: keypress.name === 'return', escape: keypress.name === 'escape', ctrl: keypress.ctrl, shift: keypress.shift, tab: keypress.name === 'tab',
    backspace: keypress.name === 'backspace', delete: keypress.name === 'delete', meta: keypress.meta,
    super: keypress.super ?? false, hyper: keypress.hyper ?? false, capsLock: keypress.capsLock ?? false, numLock: keypress.numLock ?? false, eventType: keypress.eventType,
  };
  let input;
  if (keypress.isKittyProtocol) input = keypress.isPrintable ? (keypress.text ?? keypress.name) : '';
  else if (keypress.ctrl) input = keypress.name === 'space' ? ' ' : (keypress.name ?? '');
  else input = keypress.sequence;
  if (!keypress.isKittyProtocol && nonAlphanumericKeys.includes(keypress.name)) input = '';
  if (input.startsWith('\x1b')) input = input.slice(1);
  if (!keypress.isKittyProtocol && input.length === 1 && /[A-Z]/.test(input)) key.shift = true;
  return {input, key};
}

// handlers: {key(input, key), paste(text), wheel(lines), mouse({kind: 'down'|'drag'|'up', x, y, button: 'left'|'right'}), end()}
// — wheel is negative upwards; x/y are 0-based cells. The right button is reported too (its
// release is the paste gesture); the middle button is ignored. end() is called once when
// stdin itself ends or closes: no key can ever arrive again, so the screen is over — the
// session's exit path (src/ui/boot.mjs) watches the same events on the same stream and
// leaves through the normal exit; this layer reports it too so the end is not lost if a
// handler wants it, and detach() takes the watchers back off.
export function attachInput(stdin, handlers) {
  const parser = createInputParser();
  let flushTimer = null;
  const emit = seq => {
    const m = MOUSE.exec(seq);
    if (m) {
      const button = Number(m[1]), x = Number(m[2]) - 1, y = Number(m[3]) - 1, press = m[4] === 'M';
      // 64 / 65 are the wheel (plus modifier bits 4, 8, 16).
      if (button & 64) { if (press) handlers.wheel((button & 1) ? 3 : -3); return; }
      // The left (0) and right (2) buttons: pressed, moved while held (+32, reported under
      // ?1002h), released. The middle button (1) is ignored. Dropping the right button here
      // made right-click paste impossible on this screen: the classic screen pastes on a
      // right click (Controller.mouseInput), so the release is handed on and app.mjs asks
      // the Controller for the clipboard paste there.
      const btn = button & 3;
      if (btn === 0 || btn === 2) handlers.mouse?.({kind: !press ? 'up' : (button & 32) ? 'drag' : 'down', x, y, shift: !!(button & 4), button: btn === 2 ? 'right' : 'left'});
      return;
    }
    const {input, key} = toKey(seq);
    if (key.eventType === 'release') return;
    handlers.key(input, key);
  };
  const onData = chunk => {
    clearTimeout(flushTimer); flushTimer = null;
    for (const ev of parser.push(String(chunk))) {
      if (typeof ev === 'object' && ev && 'paste' in ev) handlers.paste(ev.paste);
      else emit(ev);
    }
    // A lone ESC is the escape key only once nothing follows it (Ink waits 20 ms too).
    // A LONGER pending fragment is the head of a sequence split across reads —
    // terminals and ConPTY do deliver '\x1b[' on its own — and flushing it as a
    // key typed its bytes into the composer ('[A' for a slow Up arrow). Put it
    // back instead: when the rest of the sequence arrives, however late, it
    // still parses as one key (master-debug #5).
    if (parser.hasPendingEscape()) flushTimer = setTimeout(() => { flushTimer = null; const p = parser.flushPendingEscape(); if (!p) return; if (p === '\x1b') emit(p); else parser.push(p); }, 20);
  };
  // The end of stdin (audit-cli wave 18): a terminal that goes away without a
  // SIGHUP — or a closed pipe — fires 'end' and then 'close' here, and nothing
  // else in the main screen was watching for either, so the input died and the
  // screen's timers kept the dead frame alive forever. Report it once, the
  // same once('end')/once('close') pairing the setup prompts use (audit-cli
  // wave 14, src/tui/onboard.js promptWithEof).
  let ended = false;
  const onEnd = () => { if (ended) return; ended = true; try { handlers.end?.(); } catch {} };
  const wasRaw = stdin.isRaw;
  if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(true);
  stdin.setEncoding?.('utf8');
  stdin.on('data', onData);
  stdin.once('end', onEnd);
  stdin.once('close', onEnd);
  stdin.resume?.();
  return () => {
    clearTimeout(flushTimer);
    stdin.off('data', onData);
    stdin.off('end', onEnd);
    stdin.off('close', onEnd);
    if (stdin.isTTY && stdin.setRawMode) { try { stdin.setRawMode(!!wasRaw); } catch {} }
    stdin.pause?.();
  };
}
