// Memory measurement for the hidden /debug commands (docs/design/memory.md, stage 0).
// Deliberately plain, language-neutral labels: this is a developer diagnostic, and the
// numbers must be comparable between runs, so nothing here goes through i18n.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';

// JSON length of one value, without ever throwing: scrollback entries are plain data,
// but a measurement command must not crash on a circular structure, a BigInt or a
// function it cannot serialise — those count as their String() length instead, and
// the entry is flagged so the total is read as the approximation it is.
function jsonLength(value) {
  const seen = new Set();
  try {
    const s = JSON.stringify(value, (k, v) => {
      if (typeof v === 'function' || typeof v === 'undefined') return undefined;
      if (typeof v === 'bigint') return String(v);
      if (v && typeof v === 'object') { if (seen.has(v)) return '[circular]'; seen.add(v); }
      return v;
    });
    return s ? s.length : 0;
  } catch { try { return String(value).length; } catch { return 0; } }
}

// Entries by type: count and total JSON length (the design's "rough size").
// Sorted by size, biggest first — the point is seeing WHAT holds the memory.
export function summarizeEntries(entries) {
  const byType = new Map();
  let total = 0;
  for (const e of entries || []) {
    const type = e && typeof e.type === 'string' ? e.type : '(none)';
    const n = jsonLength(e);
    total += n;
    const row = byType.get(type) || {type, count: 0, chars: 0};
    row.count++; row.chars += n; byType.set(type, row);
  }
  return {count: (entries || []).length, chars: total, byType: [...byType.values()].sort((a, b) => b.chars - a.chars)};
}

// The kept full outputs (Controller.outputs): count, total and largest single text.
export function summarizeOutputs(outputs) {
  let total = 0, max = 0;
  for (const o of outputs || []) { const n = o ? (typeof o.text === 'string' ? o.text.length : (o.size || 0)) : 0; total += n; if (n > max) max = n; }
  return {count: (outputs || []).length, chars: total, max};
}

const mb = n => (n / 1024 / 1024).toFixed(1);
const num = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// The /debug mem display, as lines (the controller notes them verbatim).
// `mem` is a process.memoryUsage() result, passed in so tests can fix it.
export function memReportLines({entries, outputs, mem}) {
  const e = summarizeEntries(entries), o = summarizeOutputs(outputs);
  const lines = [
    'memory (process.memoryUsage):',
    `  rss ${mb(mem.rss)} MB  heapTotal ${mb(mem.heapTotal)} MB  heapUsed ${mb(mem.heapUsed)} MB  external ${mb(mem.external)} MB  arrayBuffers ${mb(mem.arrayBuffers || 0)} MB`,
    `entries: ${num(e.count)}, ~${num(e.chars)} chars (JSON length, by type)`,
    ...e.byType.map(r => `  ${r.type}: ${num(r.count)}, ~${num(r.chars)} chars`),
    `outputs: ${num(o.count)}, ${num(o.chars)} chars total, largest ${num(o.max)} chars`,
  ];
  return lines;
}

// Where /debug heap writes: the temp folder (%TEMP% on Windows), never the config
// folder — a snapshot holds the window's whole heap, file contents included.
export function heapSnapshotPath(dir = os.tmpdir(), pid = process.pid) {
  return path.join(dir, `muser-heap-${pid}.heapsnapshot`);
}

// Writes a heap snapshot and returns {file, bytes}. v8.writeHeapSnapshot with an
// explicit name writes exactly there (creating it); the size is read back so the
// caller can show it.
export function writeHeapSnapshot(file = heapSnapshotPath()) {
  const written = v8.writeHeapSnapshot(file);
  const target = written || file;
  let bytes = 0;
  try { bytes = fs.statSync(target).size; } catch {}
  return {file: target, bytes};
}
