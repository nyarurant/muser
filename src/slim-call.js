'use strict';
// Memory reduction stage 1 (docs/design/memory.md): a finished tool call, as kept in the
// window's history, only needs what the screen and the /resume headings read. The params
// payloads (a written file's whole content, a patch, replaced strings) and the long tail
// of a diff are NOT among those — the full text of every call, diff included, is kept
// separately in the outputs store (Controller.keepOutput), so /output and Ctrl+O are
// unchanged. This is the one place that knows the slim shape: the Controller applies it
// to every history entry as it is pushed, which also covers the history the serve/GUI
// and phone surfaces hand out, because they all read the Controller's entries.
const PARAM_MAX = 500; // characters: a kept params string is a heading-sized value (cwd, path, command)
const DIFF_KEEP = 30;  // lines: the most any history rendering shows (view Diff max is 30, files 24)
const DIFF_LINE_MAX = 2000; // characters per kept diff line (mirrors tools.js MAX_LINE / cutLine)

// Cut one kept diff line at DIFF_LINE_MAX, with '…' marking the cut and
// without splitting a surrogate pair. The line count was already capped
// (DIFF_KEEP), but a single 5MB line otherwise stayed whole in history.
function cutDiffLine(l) {
  if (typeof l !== 'string' || l.length <= DIFF_LINE_MAX) return l;
  let n = DIFF_LINE_MAX;
  const hi = l.charCodeAt(n - 1), lo = l.charCodeAt(n);
  if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) n--;
  return l.slice(0, n) + '…';
}
function cutDiffEntry(d) {
  if (!d || typeof d !== 'object' || typeof d.l !== 'string' || d.l.length <= DIFF_LINE_MAX) return d;
  return {...d, l: cutDiffLine(d.l)};
}

function slimParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string') { if (v.length <= PARAM_MAX) out[k] = v; }
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    // Objects, arrays and long strings are payload, not headings: dropped.
  }
  return out;
}

function slimDiff(diff) {
  if (!Array.isArray(diff)) return null; // null: unchanged
  const kept = diff.slice(0, DIFF_KEEP);
  const lines = kept.map(cutDiffEntry);
  // Unchanged only when neither the line count nor any kept line's length
  // had to be cut — a short diff holding one huge line still needs slimming.
  if (diff.length <= DIFF_KEEP && lines.every((d, i) => d === kept[i])) return null;
  return {lines, omitted: Math.max(0, diff.length - DIFF_KEEP)};
}

function slimToolCall(call) {
  if (!call || typeof call !== 'object') return call;
  let out = call;
  if (call.params && typeof call.params === 'object') out = {...out, params: slimParams(call.params)};
  const v = call.view;
  if (v && typeof v === 'object') {
    let nv = null;
    const sd = slimDiff(v.diff);
    if (sd) {
      // The header over a lone diff counts + and - over the WHOLE diff (view Tool), so the
      // totals travel with the trimmed lines; the Diff body gets the omitted count.
      let added = 0, removed = 0;
      for (const d of v.diff) {
        if (!d) continue;
        if (d.t === '+') added++;
        else if (d.t === '-') removed++;
        // A lineDiff summary entry ('…') carries the counts of the lines it
        // stands for (tools.js fallback cap); count them, not just the entry.
        else if (d.t === '…') { if (Number.isFinite(d.added)) added += d.added; if (Number.isFinite(d.removed)) removed += d.removed; }
      }
      nv = {...v, diff: sd.lines, diffOmitted: sd.omitted, diffAdded: added, diffRemoved: removed};
    }
    if (Array.isArray(v.files)) {
      let changed = false;
      const files = v.files.map(f => {
        const s = f && typeof f === 'object' ? slimDiff(f.diff) : null;
        if (!s) return f;
        changed = true;
        return {...f, diff: s.lines, diffOmitted: s.omitted}; // file headers already carry added/removed
      });
      if (changed) nv = {...(nv || v), files};
    }
    if (nv) out = {...out, view: nv};
  }
  return out;
}

module.exports = {slimToolCall, slimParams, slimDiff, cutDiffLine, PARAM_MAX, DIFF_KEEP, DIFF_LINE_MAX};
