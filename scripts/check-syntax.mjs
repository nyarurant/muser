// Syntax-check every .js / .mjs file under bin/, src/ and scripts/ with `node --check`.
// Exits 1 (and prints each failure) when any file does not parse.
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries.sort()) {
    const full = path.join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (/\.(?:js|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

const files = ['bin', 'src', 'scripts'].flatMap(d => walk(path.join(root, d))).sort();
const failures = [];
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.error || r.status !== 0) failures.push({ file, output: (r.stderr || r.stdout || String(r.error || '')).trim() });
}

for (const f of failures) {
  console.error('FAIL ' + path.relative(root, f.file));
  if (f.output) console.error(f.output);
}
if (failures.length) {
  console.error(`check-syntax: ${failures.length}/${files.length} file(s) failed`);
  process.exit(1);
}
console.log(`check-syntax: ${files.length} files OK`);
