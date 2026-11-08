// Heap snapshot summary for /debug heap snapshots (docs/design/memory.md, stage 0).
// Not shipped (package.json "files" covers only bin/, src/, skills/).
//
//   node scripts/heap-summary.mjs <file.heapsnapshot> [--top N]
//
// Prints the snapshot's total size, the node names/types with the largest RETAINED
// sizes (dominator tree over the object graph, weak edges excluded — a weak edge
// does not retain), and the retained size behind every property named `entries`
// or `outputs` (the two holders the memory design blames), largest first.
// Dominators are computed with Lengauer–Tarjan over a CSR graph: an iterative
// dataflow (Cooper) pass over a real window's snapshot (~500k nodes, millions of
// edges) did not finish in minutes, and this script exists to be run on exactly
// those snapshots.
// Retained sizes are exact for the graph as parsed; what a holder is CALLED in the
// source (s.entries vs some other object's .entries) cannot be told from a snapshot,
// so each hit names its source node and the reader judges which one it is.
import fs from 'node:fs';

const file = process.argv[2];
const topAt = process.argv.indexOf('--top');
const TOP = topAt >= 0 ? (Number(process.argv[topAt + 1]) || 30) : 30;
if (!file) { console.error('usage: node scripts/heap-summary.mjs <file.heapsnapshot> [--top N]'); process.exit(2); }

const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
const meta = snap.snapshot.meta;
const strings = snap.strings;
const nf = meta.node_fields, ef = meta.edge_fields;
const nStride = nf.length, eStride = ef.length;
const nType = nf.indexOf('type'), nName = nf.indexOf('name'), nSelf = nf.indexOf('self_size'), nEdges = nf.indexOf('edge_count');
const eType = ef.indexOf('type'), eName = ef.indexOf('name_or_index'), eTo = ef.indexOf('to_node');
const nodeTypes = meta.node_types[nType], edgeTypes = meta.edge_types[eType];
const weakType = edgeTypes.indexOf('weak');
const count = snap.snapshot.node_count;
const nodes = snap.nodes, edges = snap.edges;

const typeOf = i => nodeTypes[nodes[i * nStride + nType]] || '?';
const nameOf = i => strings[nodes[i * nStride + nName]] ?? '';
const selfOf = i => nodes[i * nStride + nSelf] || 0;

// Pass 1: out/in degrees (weak edges excluded — they do not retain) and the named
// `entries` / `outputs` property edges the retainer section reports on.
const outDeg = new Int32Array(count), inDeg = new Int32Array(count);
const named = {entries: [], outputs: []};
{
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const n = nodes[i * nStride + nEdges] || 0;
    for (let k = 0; k < n; k++, pos += eStride) {
      const to = edges[pos + eTo] / nStride;
      if (!Number.isInteger(to) || to < 0 || to >= count) continue;
      const et = edgeTypes[edges[pos + eType]];
      if (et === 'property' || et === 'internal') {
        const en = strings[edges[pos + eName]];
        if (en === 'entries' || en === 'outputs') named[en].push({from: i, to});
      }
      if (edges[pos + eType] === weakType) continue;
      outDeg[i]++; inDeg[to]++;
    }
  }
}
// CSR layouts for successors and predecessors.
const csr = deg => { const start = new Int32Array(count + 1); for (let i = 0; i < count; i++) start[i + 1] = start[i] + deg[i]; return {start, flat: new Int32Array(start[count]), fill: Int32Array.from(start)}; };
const succ = csr(outDeg), pred = csr(inDeg);
{
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const n = nodes[i * nStride + nEdges] || 0;
    for (let k = 0; k < n; k++, pos += eStride) {
      const to = edges[pos + eTo] / nStride;
      if (!Number.isInteger(to) || to < 0 || to >= count || edges[pos + eType] === weakType) continue;
      succ.flat[succ.fill[i]++] = to; pred.flat[pred.fill[to]++] = i;
    }
  }
}

// DFS from the root (node 0), marking on push: gives a DFS tree (parent[]) and a
// numbering (dfsOf / vertex) for Lengauer–Tarjan. Iterative — real snapshots are
// far too deep for recursion.
const dfsOf = new Int32Array(count).fill(0);
const vertex = new Int32Array(count + 1);
const parent = new Int32Array(count + 1);
let N = 0;
{
  const stack = [0]; dfsOf[0] = ++N; vertex[N] = 0; parent[N] = 0;
  while (stack.length) {
    const v = stack.pop();
    for (let e = succ.start[v]; e < succ.start[v + 1]; e++) {
      const w = succ.flat[e];
      if (!dfsOf[w]) { dfsOf[w] = ++N; vertex[N] = w; parent[N] = dfsOf[v]; stack.push(w); }
    }
  }
}

// Lengauer–Tarjan (Appel's formulation, dfs-number space, 1-based).
const semi = new Int32Array(N + 1), idom = new Int32Array(N + 1), ancestor = new Int32Array(N + 1), label = new Int32Array(N + 1);
const bucket = new Array(N + 1).fill(null);
for (let i = 1; i <= N; i++) { semi[i] = label[i] = i; }
function compress(v) {
  const stack = [];
  let x = v;
  while (ancestor[ancestor[x]] !== 0) { stack.push(x); x = ancestor[x]; }
  while (stack.length) {
    const y = stack.pop();
    if (semi[label[ancestor[y]]] < semi[label[y]]) label[y] = label[ancestor[y]];
    ancestor[y] = ancestor[ancestor[y]];
  }
}
function evalNode(v) { if (ancestor[v] === 0) return label[v]; compress(v); return label[v]; }
for (let w = N; w >= 2; w--) {
  const node = vertex[w];
  for (let e = pred.start[node]; e < pred.start[node + 1]; e++) {
    const p = dfsOf[pred.flat[e]];
    if (!p) continue;
    const u = evalNode(p);
    if (semi[u] < semi[w]) semi[w] = semi[u];
  }
  (bucket[semi[w]] ||= []).push(w);
  ancestor[w] = parent[w]; // link(parent[w], w)
  const b = bucket[parent[w]];
  if (b && b.length) {
    for (const v of b) { const u = evalNode(v); idom[v] = semi[u] < semi[v] ? u : parent[w]; }
    b.length = 0;
  }
}
idom[1] = 1;
for (let i = 2; i <= N; i++) if (idom[i] !== semi[i]) idom[i] = idom[idom[i]];

// Retained sizes: accumulate into dominators, deepest dfs number first, so a node's
// retained size is complete before it flows into its dominator.
const retained = new Float64Array(count);
for (let i = 0; i < count; i++) retained[i] = selfOf(i);
for (let i = N; i >= 2; i--) retained[vertex[idom[i]]] += retained[vertex[i]];

const fmt = n => n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(2) + ' MB' : n >= 1024 ? (n / 1024).toFixed(2) + ' KB' : n + ' B';
let totalSelf = 0;
for (let i = 0; i < count; i++) totalSelf += selfOf(i);
console.log(`snapshot: ${file}`);
console.log(`nodes: ${count}  edges: ${edges.length / eStride}  total self size: ${fmt(totalSelf)}  reachable retained (root): ${fmt(N ? retained[0] : 0)}`);
console.log('');
console.log(`top ${TOP} by retained size (type / name):`);
const agg = new Map();
for (let d = 1; d <= N; d++) {
  const v = vertex[d];
  const name = String(nameOf(v)).replace(/\s+/g, ' ').slice(0, 60);
  const key = typeOf(v) + ' ' + name;
  const row = agg.get(key) || {key, count: 0, self: 0, retained: 0};
  row.count++; row.self += selfOf(v); row.retained += retained[v]; agg.set(key, row);
}
// A node's retained size counts everything under it, so rows overlap (a class row
// includes its members' rows); this ranks suspects, it does not partition the heap.
for (const row of [...agg.values()].sort((a, b) => b.retained - a.retained).slice(0, TOP))
  console.log(`  ${fmt(row.retained).padStart(10)}  retained  ${fmt(row.self).padStart(10)} self  x${row.count}  ${row.key}`);
console.log('');
console.log('retainers (property targets):');
let held = 0;
for (const name of ['entries', 'outputs']) {
  const hits = named[name].map(h => ({...h, retained: retained[h.to] || 0})).sort((a, b) => b.retained - a.retained);
  if (!hits.length) { console.log(`  ${name}: (none found)`); continue; }
  held += hits[0].retained;
  for (const h of hits.slice(0, 5))
    console.log(`  ${name}: ${fmt(h.retained)} retained  (from ${typeOf(h.from)} ${String(nameOf(h.from)).replace(/\s+/g, ' ').slice(0, 40)}, node ${h.to})`);
  if (hits.length > 5) console.log(`  ${name}: … and ${hits.length - 5} smaller`);
}
const other = (N ? retained[0] : 0) - held;
console.log(`  other: ${fmt(Math.max(0, other))} (root retained minus the largest entries/outputs holders above; holders nested inside each other would make this overlap)`);
