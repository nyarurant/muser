// The conversation history of the fullscreen screen, virtualized: only the entries that fall in
// the visible window are turned into lines, and each entry's lines are kept per width. A resize
// therefore costs the visible entries at the new width, however long the conversation is (the
// classic screen reprints every entry from the first one).
//
// The view's position is an anchor — which entry, which line of it is the top row — or
// "follow", the bottom, where new output keeps arriving into view. Scrolling moves the anchor
// entry by entry, so an entry far above is only measured if the reader actually scrolls to it.

export class History {
  // render(entry, width) -> array of lines (each already at most `width` cells wide)
  constructor(render) {
    this.render = render; this.cache = new WeakMap(); this.follow = true; this.anchor = null; this.unseen = 0; this.lastLen = 0;
    this.rendered = 0;
  }
  lines(e, W) {
    let c = this.cache.get(e);
    if (!c || c.W !== W) { c = {W, lines: this.render(e, W)}; this.cache.set(e, c); this.rendered++; }
    return c.lines;
  }
  // The entries were replaced (/clear, a resumed chat): back to the bottom.
  reset() { this.follow = true; this.anchor = null; this.unseen = 0; this.lastLen = 0; }
  // Returns {lines: exactly H rows, refs, unseen} for the window of height H. refs[r] says which
  // entry line row r shows ({idx, off}, or null for padding), so a selection can be kept in
  // conversation terms and survive scrolling.
  view(entries, W, H) {
    if (entries.length < this.lastLen) this.reset();
    if (!this.follow && entries.length > this.lastLen) this.unseen += entries.length - this.lastLen;
    this.lastLen = entries.length;
    if (H <= 0) return {lines: [], refs: [], unseen: this.unseen};
    if (!this.follow && this.anchor) {
      const out = [], refs = [];
      let {idx, off} = this.anchor;
      if (idx >= entries.length) { this.follow = true; return this.view(entries, W, H); }
      while (out.length < H && idx < entries.length) {
        const ls = this.lines(entries[idx], W);
        for (let k = off; k < ls.length && out.length < H; k++) { out.push(ls[k]); refs.push({idx, off: k}); }
        idx++; off = 0;
      }
      // Scrolled back down to the end: follow again.
      if (out.length < H) { this.follow = true; this.unseen = 0; return this.view(entries, W, H); }
      return {lines: out, refs, unseen: this.unseen};
    }
    // Following: walk back from the newest entry until the window is full.
    const chunks = []; let n = 0, idx = entries.length - 1;
    while (idx >= 0 && n < H) { const ls = this.lines(entries[idx], W); chunks.push({idx, ls}); n += ls.length; idx--; }
    chunks.reverse();
    const all = [], allRefs = []; for (const ch of chunks) ch.ls.forEach((l, k) => { all.push(l); allRefs.push({idx: ch.idx, off: k}); });
    const skip = Math.max(0, all.length - H);
    // Remember where the top row is, so a scroll up starts from what is on the screen.
    let rest = skip; this.top = null;
    for (const ch of chunks) { if (rest < ch.ls.length) { this.top = {idx: ch.idx, off: rest}; break; } rest -= ch.ls.length; }
    const lines = all.slice(skip), refs = allRefs.slice(skip);
    while (lines.length < H) { lines.unshift(''); refs.unshift(null); }
    this.unseen = 0;
    return {lines, refs, unseen: 0};
  }
  // delta < 0 scrolls up (back in time), > 0 down. Needs the same entries/W/H as the last view.
  scroll(delta, entries, W, H) {
    if (!entries.length) return;
    let pos = this.follow ? this.top : this.anchor;
    if (!pos) { if (delta > 0) return; pos = {idx: 0, off: 0}; }
    let {idx, off} = pos;
    if (delta < 0) {
      let n = -delta;
      while (n > 0) {
        if (off >= n) { off -= n; n = 0; break; }
        n -= off; if (idx === 0) { off = 0; break; }
        idx--; off = this.lines(entries[idx], W).length;
        if (off === 0) continue;
        off--; n--;
      }
      this.anchor = {idx, off}; this.follow = false;
    } else {
      if (this.follow) return;
      let n = delta;
      while (n > 0 && idx < entries.length) {
        const len = this.lines(entries[idx], W).length;
        if (off + n < len) { off += n; n = 0; break; }
        n -= len - off; idx++; off = 0;
      }
      this.anchor = {idx, off};
    }
  }
  toBottom() { this.follow = true; this.anchor = null; this.unseen = 0; }
  toTop(entries) { if (entries.length) { this.anchor = {idx: 0, off: 0}; this.follow = false; } }
  // The text of the entry lines from a to b (each {idx, off}, inclusive, in either order).
  // Wave 14 (W13-12): the drawn lines are already truncated, so copying them
  // loses whatever the cut took. An 'md' entry carries its Markdown source
  // (e.src); when the span covers ALL of such an entry's lines, each of its
  // rows is tagged with that src so selectedText (select.mjs, which knows
  // the selection's columns) can copy the source instead of the drawn
  // lines for that entry. A span that starts or ends inside the entry is
  // not tagged, and neither is any other entry type.
  linesBetween(entries, W, a, b) {
    if (a.idx > b.idx || (a.idx === b.idx && a.off > b.off)) [a, b] = [b, a];
    const out = [];
    for (let idx = a.idx; idx <= b.idx && idx < entries.length; idx++) {
      const e = entries[idx];
      const ls = this.lines(e, W);
      const from = idx === a.idx ? a.off : 0, to = idx === b.idx ? b.off : ls.length - 1;
      const src = from === 0 && to === ls.length - 1 && ls.length > 0 && e?.type === 'md' && typeof e.src === 'string' && e.src ? e.src : null;
      for (let k = from; k <= to && k < ls.length; k++) out.push(src ? {ref: {idx, off: k}, line: ls[k], src} : {ref: {idx, off: k}, line: ls[k]});
    }
    return out;
  }
}
