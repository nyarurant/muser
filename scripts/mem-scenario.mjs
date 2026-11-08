// The memory measurement script (docs/design/memory.md, stage 0): the same work
// before and after a change, so the numbers compare. Not shipped.
//
//   node --expose-gc scripts/mem-scenario.mjs [--heap]
//
// Drives the demo agent's memScenario (200 tool calls: 50 x 50 KB writes,
// 50 x 2,000-line diffs, 50 x 5,000-line outputs, 50 small reads) through a real
// Controller, headlessly, then records the /debug mem report, the heap used after
// GC, and this process's Private Bytes (Windows). --heap also writes a heap
// snapshot next to the report's numbers, for scripts/heap-summary.mjs.
// Run it on the code BEFORE a stage-1/2 change and again after; stage 0's job is
// the baseline, not the verdict.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The Controller loads the input history from ~/.muser by default: point it at a
// throwaway file so a measurement never touches (or is polluted by) the real one.
process.env.MUSER_HISTORY_FILE = path.join(os.tmpdir(), 'muser-mem-scenario-history.json');
try { fs.unlinkSync(process.env.MUSER_HISTORY_FILE); } catch {}

const {Controller} = await import('../src/ui/controller.mjs');
const {DemoAgent} = await import('../src/ui/demo.mjs');
const {memReportLines, heapSnapshotPath, writeHeapSnapshot} = await import('../src/ui/mem-report.mjs');

const agent = new DemoAgent(process.cwd());
const ctrl = new Controller({agent, museName: 'mem-scenario', version: 'scenario', onExit() {}});
await agent.memScenario();

if (typeof globalThis.gc === 'function') { globalThis.gc(); globalThis.gc(); }
const mem = process.memoryUsage();
console.log('mem-scenario: 200 tool calls (50 x 50KB write, 50 x 2000-line diff, 50 x 5000-line output, 50 x small read)');
console.log(memReportLines({entries: ctrl.get().entries, outputs: ctrl.outputs, mem}).join('\n'));
console.log(`heapUsed after GC: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB${typeof globalThis.gc === 'function' ? '' : '  (no --expose-gc: this is live heap, not after-GC)'}`);

// Private Bytes: the figure the design compares (working set is mostly shared
// libraries). Windows-only, like muser; read it from the process itself.
try {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${process.pid}).PrivateMemorySize64`], {encoding: 'utf8', timeout: 15000});
  const bytes = Number(String(out).trim());
  console.log(`Private Bytes: ${Number.isFinite(bytes) ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : 'unavailable'}`);
} catch { console.log('Private Bytes: unavailable'); }

if (process.argv.includes('--heap')) {
  const {file, bytes} = writeHeapSnapshot(heapSnapshotPath());
  console.log(`heap snapshot: ${file} (${(bytes / 1024 / 1024).toFixed(1)} MB) — summarise with: node scripts/heap-summary.mjs "${file}"`);
}
agent.close();
