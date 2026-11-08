// The fullscreen screen: muser owns the whole terminal (the alternate screen, like vim or
// Claude Code's fullscreen mode) and writes a frame of exactly `rows` lines. Only the lines
// that changed since the last frame are written, inside one synchronized update, so a
// spinner tick or a keystroke costs a line or two and a resize costs one screen — never
// the whole conversation, which the classic renderer reprints from the top.

const ESC = '\x1b[';
// Entering: the alternate screen, no autowrap (a line one cell too wide must not push the
// frame down), bracketed paste, and wheel reports (SGR mouse). The cursor is hidden while a
// frame is drawn and shown again at the caret.
// ?1002h reports motion while a button is held, which a drag selection needs.
const ENTER = ESC + '?1049h' + ESC + '?7l' + ESC + '?2004h' + ESC + '?1002h' + ESC + '?1006h' + ESC + '?25l' + ESC + '2J' + ESC + 'H';
const LEAVE = ESC + '?1006l' + ESC + '?1002l' + ESC + '?1000l' + ESC + '?2004l' + ESC + '?7h' + ESC + '0m' + ESC + '?25h' + ESC + '?1049l';

export class Screen {
  constructor(out = process.stdout) {
    this.out = out; this.prev = []; this.active = false; this.stats = {frames: 0, bytes: 0, lines: 0};
  }
  get columns() { return this.out.columns || 100; }
  get rows() { return this.out.rows || 30; }
  write(s) { if (s) { this.stats.bytes += s.length; this.out.write(s); } }
  enter() { if (this.active) return; this.active = true; this.prev = []; this.write(ENTER); }
  leave() { if (!this.active) return; this.active = false; this.prev = []; this.write(LEAVE); }
  // After a resize the terminal has reflowed (or cleared) what was on the screen: forget the
  // last frame so the next one is written whole, onto a cleared screen.
  invalidate() { this.prev = []; this.needsClear = true; }
  // lines: exactly the frame's rows (already cut to the width). cursor: {x, y} (0-based) to
  // show the caret there — the IME composes at the caret — or null to keep it hidden.
  draw(lines, cursor) {
    if (!this.active) return;
    let buf = ESC + '?2026h' + ESC + '?25l';
    if (this.needsClear) { buf += ESC + '2J'; this.needsClear = false; }
    let changed = 0;
    for (let r = 0; r < lines.length; r++) {
      if (lines[r] === this.prev[r]) continue;
      // The row is erased BEFORE it is written: an erase after a line that fills the whole
      // width (the cursor then rests on the last column) wiped that column, so a wide
      // character ending there vanished (seen through ConPTY). Each line ends with a reset
      // so a coloured span does not leak into the next row.
      buf += ESC + (r + 1) + ';1H' + ESC + '2K' + lines[r] + ESC + '0m';
      changed++;
    }
    // A frame shorter than the last one (a smaller window) clears the rows left below it.
    for (let r = lines.length; r < this.prev.length; r++) { buf += ESC + (r + 1) + ';1H' + ESC + 'K'; changed++; }
    this.prev = lines.slice();
    if (cursor) buf += ESC + (cursor.y + 1) + ';' + (cursor.x + 1) + 'H' + ESC + '?25h';
    buf += ESC + '?2026l';
    this.stats.frames++; this.stats.lines += changed;
    this.write(buf);
  }
}
