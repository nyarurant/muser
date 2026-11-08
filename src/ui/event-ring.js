'use strict';
// The window's recent-events ring (EXPORT.md stage 2): the last ~200
// things that HAPPENED to the window, kept in memory only, for the case
// "it runs but does not respond" — the user pressed keys and nothing
// visibly happened, a render took a second, a state kept flipping. What
// a ring entry may hold is only ever a shape:
//   key:    the KIND of key (a character is recorded as 'char', never the
//           character itself; Enter / arrows / Esc keep their names)
//   render: how long a draw took and the screen size it drew
//   state:  the NAMES of the state fields that changed (the Controller's
//           trail already keeps exactly this for crashes)
//   error:  an error's NAME, never its message
// Nothing here can hold a sentence, so /export carries the ring the same
// with or without the conversation body. Consecutive renders coalesce
// into one entry (a screen redraws constantly; 200 raw renders would
// evict everything else in seconds), and so do repeated identical state
// changes inside a second.
const CAP = 200;

const KEY_NAMES = ['return', 'escape', 'tab', 'backspace', 'delete', 'pageUp', 'pageDown', 'home', 'end', 'upArrow', 'downArrow', 'leftArrow', 'rightArrow'];
// The kind of a key press, from the parsed key object both views hand to
// Controller.key (input is the raw text — it is classified, never kept).
function keyKind(input, k = {}) {
  for (const name of KEY_NAMES) if (k[name]) return name;
  if (k.ctrl) return 'ctrl';
  if (k.meta || k.super) return 'meta';
  if (k.shift) return 'shift';
  const s = typeof input === 'string' ? input : '';
  if (s.length > 1) return 'sequence'; // a paste chunk reaches key() whole only outside usePaste; never its text
  if (s.length === 1) return 'char';
  return 'other';
}

class EventRing {
  constructor(cap = CAP) { this.cap = cap; this.items = []; }
  push(entry) {
    this.items.push(entry);
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
  }
  recordKey(input, k) {
    try { this.push({type: 'key', kind: keyKind(input, k), at: Date.now()}); } catch {}
  }
  recordRender({ms = 0, columns = null, rows = null, entries = null} = {}) {
    try {
      const now = Date.now();
      const last = this.items[this.items.length - 1];
      const rounded = Math.round(ms);
      if (last && last.type === 'render' && now - last.at < 1000) { last.at = now; last.ms = rounded; last.columns = columns; last.rows = rows; last.entries = entries; last.count = (last.count || 1) + 1; return; }
      this.push({type: 'render', ms: rounded, columns, rows, entries, at: now});
    } catch {}
  }
  recordState(keys) {
    try {
      if (!Array.isArray(keys) || !keys.length) return;
      const now = Date.now();
      const names = keys.slice(0, 12).map(String);
      const last = this.items[this.items.length - 1];
      if (last && last.type === 'state' && now - last.at < 1000 && last.keys.join(',') === names.join(',')) { last.at = now; last.count = (last.count || 1) + 1; return; }
      this.push({type: 'state', keys: names, at: now});
    } catch {}
  }
  recordError(name) {
    try { this.push({type: 'error', name: String(name || 'Error'), at: Date.now()}); } catch {}
  }
  list() { return this.items.slice(); }
}

module.exports = {EventRing, keyKind, CAP};
