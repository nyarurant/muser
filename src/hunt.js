'use strict';
// Bug hunt (docs/design/new-features.md §6): `muser hunt` / `/hunt`.
//
// Flow: audit (parallel read-only agents over disjoint file groups, findings
// graded Critical / High / Medium / None with repro steps) -> optional fix
// (`--fix High`: one agent per file, reproduce -> root-cause fix -> regression
// test, and a fix only counts when the counter-proof passes).
// Results land in <cwd>/.muser/hunt/<stamp>/ (report.md, findings.jsonl,
// per-agent tables, state.json) and survive an interrupted run. Nothing is
// committed.
//
// Seams (everything Muse- or machine-specific is injected, so tests run
// with a fake Muse and never touch the network):
//   runAgent({prompt, files, account, kind, tag}) -> reply text
//   quota(accountId) -> {exhausted, percentUsed} | null   (null = unknown)
//   runTests(files, cwd) -> {ok, output}
//   counterProof({cwd, changedFiles, testFiles, runTests}) ->
//       'proven' | 'unproven' | 'unknown'   (default: the built-in one below)
//
// Worklog premise (design §1, built on branch feat-worklog; the writer side
// is NOT here): one JSONL file per conversation at
// %LOCALAPPDATA%\muser\worklog\<conversation id>.jsonl, one event per line
// (turn / tool / edit / expect / reply / focus), pre-edit full text in
// worklog\blobs\<hash>. The reader below is deliberately small and tolerant
// about key spellings (kind|type, path|file) because the writer is still
// being built; see the DevNote for what to check when the two are merged.
// Retention premise (design §12, decided as proposed): 30 days / 500 MB —
// the constants live here for the merge; pruning itself is the worklog
// feature's job, not hunt's.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {t} = require('./i18n');
const {renameRetry} = require('./config');
let isSensitivePath = () => false;
try { ({isSensitivePath} = require('./tools')); } catch {}

const WORKLOG_RETENTION_DAYS = 30;
const WORKLOG_MAX_BYTES = 500 * 1024 * 1024;

// ---------------------------------------------------------------- worklog --
function localAppData() { return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'); }
function worklogDir(base) { return path.join(base || localAppData(), 'muser', 'worklog'); }
function blobFile(base, hash) { return path.join(worklogDir(base), 'blobs', String(hash)); }

function parseWorklogText(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { const ev = JSON.parse(s); if (ev && typeof ev === 'object') out.push(ev); } catch {}
  }
  return out;
}
function listWorklogs(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    try { const st = fs.statSync(file); if (st.isFile()) out.push({id: name.slice(0, -'.jsonl'.length), file, mtimeMs: st.mtimeMs, bytes: st.size}); } catch {}
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
// One conversation's events; without an id, the newest file. null when none.
function readWorklog(dir, id) {
  const list = listWorklogs(dir);
  const pick = id ? list.find(x => x.id === id || x.id.startsWith(id)) : list[0];
  if (!pick) return null;
  let text = '';
  try { text = fs.readFileSync(pick.file, 'utf8'); } catch { return null; }
  return {id: pick.id, file: pick.file, events: parseWorklogText(text)};
}
const eventKind = ev => (ev && (ev.event || ev.kind || ev.type)) || '';
// An edit event names its file in `path`; a tool event in the real shape
// (src/worklog.js) carries a `paths` list instead — take its first entry.
const eventPath = ev => (ev && (ev.path || ev.file || ev.target || (Array.isArray(ev.paths) ? ev.paths[0] : ''))) || '';
const eventAt = ev => (ev && (ev.at || ev.time || ev.ts)) || null;
// Files the worklog says were edited, newest first: rel path -> {count, lastAt, agents}.
// Sensitive paths never surface (design §0: secrets stay out of every record).
function editedFiles(events) {
  const map = new Map();
  for (const ev of events || []) {
    if (eventKind(ev) !== 'edit') continue;
    const p = eventPath(ev);
    if (!p || isSensitivePath(p)) continue;
    const rel = String(p).replace(/\\/g, '/');
    const cur = map.get(rel) || {count: 0, lastAt: null, agents: new Set()};
    cur.count++;
    const at = eventAt(ev);
    if (at && (!cur.lastAt || String(at) > String(cur.lastAt))) cur.lastAt = at;
    if (ev.agent) cur.agents.add(String(ev.agent));
    map.set(rel, cur);
  }
  return map;
}
// Recent edits across the newest few conversations (hunt only needs a ranking).
function recentEditedFiles(dir, {conversations = 5} = {}) {
  const merged = new Map();
  for (const w of listWorklogs(dir).slice(0, conversations)) {
    const got = readWorklog(dir, w.id);
    if (!got) continue;
    for (const [rel, info] of editedFiles(got.events)) {
      const cur = merged.get(rel);
      if (!cur) { merged.set(rel, info); continue; }
      cur.count += info.count;
      if (info.lastAt && (!cur.lastAt || String(info.lastAt) > String(cur.lastAt))) cur.lastAt = info.lastAt;
      for (const a of info.agents) cur.agents.add(a);
    }
  }
  return merged;
}

// ------------------------------------------------------------------ scope --
const CODE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx', '.cs', '.py', '.rs', '.go', '.java', '.rb', '.php', '.c', '.h', '.cc', '.cpp', '.hpp', '.css', '.scss', '.html', '.vue', '.svelte', '.sh', '.ps1',
  // Kotlin / Swift / Dart and the other app languages, XAML views, SQL: a hunt over the
  // Android app or the WPF GUI found no files at all without them (found on a real run).
  '.kt', '.kts', '.swift', '.dart', '.scala', '.lua', '.sql', '.xaml', '.fs', '.vb', '.m', '.mm', '.r', '.pl', '.groovy', '.gradle']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.muser', 'dist', 'build', 'out', 'bin', 'obj', '.next', 'coverage', '.vs', 'vendor']);
const MAX_FILES = 5000;
const relOf = (cwd, abs) => path.relative(cwd, abs).replace(/\\/g, '/');

// counter (optional) tracks how many DISTINCT files matched in total: past
// the cap the walk keeps counting (without collecting) so a truncated scope
// can be reported with the size of the whole tree instead of silently
// presenting the cap as the total (audit wave 3). Files reached twice via
// overlapping scope parts count once, via the shared `seen` set: counting
// the pre-dedup stream made `. .` report a truncated 6000-file scope over a
// 3000-file tree (wave 11).
function walkInto(cwd, absDir, out, counter, seen) {
  const seenSet = seen || new Set(out);
  let entries;
  try { entries = fs.readdirSync(absDir, {withFileTypes: true}); } catch { return; }
  for (const e of entries) {
    const abs = path.join(absDir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walkInto(cwd, abs, out, counter, seenSet); continue; }
    if (!e.isFile()) continue;
    if (!CODE_EXTS.has(path.extname(e.name).toLowerCase())) continue;
    if (isSensitivePath(abs)) continue;
    const rel = relOf(cwd, abs);
    if (seenSet.has(rel)) continue;
    seenSet.add(rel);
    if (counter) counter.total++;
    if (out.length < MAX_FILES) out.push(rel);
    else if (counter) counter.truncated = true;
  }
}
// scope: undefined (whole tree) | 'src, tests/a.js' | ['src', 'a.js'].
// Returns sorted relative paths with '/' separators. The array also carries
// `truncated` (true when the MAX_FILES cap dropped files) and `totalApprox`
// (how many distinct files matched in total, after duplicates from
// overlapping scope parts are removed) as NON-enumerable properties, so
// the result still compares and serialises as a plain array.
function collectFiles(cwd, scope) {
  const parts = scope == null || scope === '' ? [null]
    : Array.isArray(scope) ? scope.flatMap(s => String(s).split(/[\s,]+/)).filter(Boolean)
    : String(scope).split(/[\s,]+/).filter(Boolean);
  const out = [];
  const counter = {total: 0, truncated: false};
  const seen = new Set();
  for (const part of parts) {
    if (part == null) { walkInto(cwd, cwd, out, counter, seen); continue; }
    const abs = path.resolve(cwd, part);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) walkInto(cwd, abs, out, counter, seen);
    else if (st.isFile() && CODE_EXTS.has(path.extname(abs).toLowerCase()) && !isSensitivePath(abs)) {
      const rel = relOf(cwd, abs);
      if (seen.has(rel)) continue;
      seen.add(rel);
      counter.total++;
      if (out.length < MAX_FILES) out.push(rel);
      else counter.truncated = true;
    }
  }
  const files = [...new Set(out)].sort();
  Object.defineProperties(files, {
    truncated: {value: counter.truncated},
    totalApprox: {value: counter.total},
  });
  return files;
}
const isTestFile = rel => /(^|\/)(tests?|__tests__)\//.test(rel) || /\.(test|spec)\.[^.]+$/.test(rel);

// Split files into at most `want` disjoint groups, keeping a folder's files
// together where that fits: units are per-folder lists (oversized folders are
// chunked), largest first, each dealt to the currently smallest group.
function makeGroups(files, want) {
  const n = Math.max(1, Math.min(Number(want) || 0 || Math.ceil(files.length / 8) || 1, files.length || 1));
  if (!files.length) return [];
  const byDir = new Map();
  for (const f of files) {
    const d = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(f);
  }
  const chunk = Math.max(4, Math.ceil(files.length / n));
  const units = [];
  for (const list of byDir.values()) for (let i = 0; i < list.length; i += chunk) units.push(list.slice(i, i + chunk));
  units.sort((a, b) => b.length - a.length);
  const groups = Array.from({length: Math.min(n, units.length)}, () => []);
  for (const u of units) {
    let best = 0;
    for (let i = 1; i < groups.length; i++) if (groups[i].length < groups[best].length) best = i;
    groups[best].push(...u);
  }
  return groups.filter(g => g.length).map(g => g.sort());
}
// The assignment table is machine-checked: no file may appear twice (§6).
function checkDisjoint(groups) {
  const seen = new Set();
  for (const g of groups) for (const f of g) {
    if (seen.has(f)) throw new Error(t('担当のファイルが重なっています: {file}', {file: f}));
    seen.add(f);
  }
}

// --------------------------------------------------------------- findings --
const SEVERITIES = ['Critical', 'High', 'Medium', 'None'];
const RANK = {Critical: 3, High: 2, Medium: 1, None: 0};
function normSeverity(s) {
  const hit = SEVERITIES.find(x => x.toLowerCase() === String(s || '').trim().toLowerCase());
  return hit || null;
}
const atLeast = (finding, level) => (RANK[finding.severity] ?? 0) >= (RANK[level] ?? 0);
// Agents answer with one JSON object per finding (fenced or bare lines).
// Anything that is not a well-formed finding is ignored, never guessed at.
function parseFindings(text, agent) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim().replace(/^```(json|jsonl)?$/, '').trim();
    if (!line.startsWith('{')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const severity = normSeverity(o.severity);
    if (!severity || typeof o.summary !== 'string' || !o.summary.trim()) continue;
    out.push({severity, file: String(o.file || o.path || ''), line: Number.isFinite(o.line) ? o.line : null,
      summary: o.summary.trim(), repro: String(o.repro || ''), agent: agent || o.agent || ''});
  }
  return out;
}
function countBySeverity(findings) {
  const c = {Critical: 0, High: 0, Medium: 0, None: 0, total: 0};
  for (const f of findings || []) { if (c[f.severity] != null) c[f.severity]++; c.total++; }
  return c;
}
// Findings live in two places at once — state.json's `findings` and the
// append-only findings.jsonl — and the writer updates them in sequence, so
// a hunt killed in between leaves the two out of sync (wave 11: jsonl held
// 2, state 1, and status and the fix pass counted different hunts). Every
// reader therefore merges both sources and drops rows that are completely
// identical (same severity, file, line, summary, repro and agent): an
// exact duplicate is one finding, never two.
function findingKey(f) {
  return JSON.stringify([f.severity || '', f.file || '', f.line != null ? f.line : null,
    f.summary || '', f.repro || '', f.agent || '']);
}
function dedupeFindings(list) {
  const seen = new Set();
  const out = [];
  for (const f of list || []) {
    if (!f || typeof f !== 'object') continue;
    const key = findingKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
// The one unified view of a hunt dir's findings: the state's rows first
// (their order is the audit's), then any rows findings.jsonl has that the
// state never got — readFindings is defined with the state helpers below;
// the declaration hoists, so this is safe to call from anywhere here.
function mergeFindings(stateFindings, dir) {
  return dedupeFindings([...(stateFindings || []), ...(dir ? readFindings(dir) : [])]);
}
// ---------------------------------------------------------------- prompts --
// Prompts are instructions to Muse, not UI text, so they stay plain
// Japanese constants (like the agent preamble) instead of going through t().
function auditPrompt({cwd, files, hot}) {
  const lines = [
    'あなたはコード監査エージェントです。次のファイルだけを読み取り専用で監査してください（編集しないこと）:',
    ...files.map(f => '- ' + f),
    '',
    'バグ・セキュリティの問題・信頼性の問題を探してください。',
  ];
  if (hot && hot.length) lines.push('最近の作業で編集されたファイル（特に注意）: ' + hot.join(', '));
  lines.push(
    '所見は、最後に ```json のコードブロックへ 1 行 1 件の JSON でだけ出力してください（説明文は最小限に）:',
    '{"severity":"Critical|High|Medium|None","file":"相対パス","line":行番号または null,"summary":"問題の要約","repro":"再現の手順"}',
    '問題がなければ severity "None" を 1 件だけ出してください。',
    '作業フォルダー: ' + cwd);
  return lines.join('\n');
}
function fixPrompt({cwd, file, findings}) {
  const lines = [
    'あなたはバグ修正エージェントです。ファイル ' + file + ' について、次の所見を直してください:',
    ...findings.map(f => '- [' + f.severity + '] ' + f.summary + (f.repro ? '（再現: ' + f.repro + '）' : '')),
    '',
    '手順: まず再現を確認し、根本原因を直し、回帰テストを足してください。ほかのファイルは、修正とテストに必要な範囲でのみ触ってください。',
    '最後に、所見ごとに 1 行 1 件の JSON を ```json のコードブロックで出力してください:',
    '{"summary":"元の所見の要約（そのまま）","reproduced":true,"fixed":true,"testFile":"足した回帰テストのパスまたは null","note":"一言"}',
    '再現しなかった所見は reproduced:false、直せなかった所見は fixed:false にしてください。',
    '作業フォルダー: ' + cwd,
  ];
  return lines.join('\n');
}
function parseFixResults(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim().replace(/^```(json|jsonl)?$/, '').trim();
    if (!line.startsWith('{')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (typeof o.summary !== 'string' || !o.summary.trim()) continue;
    out.push({summary: o.summary.trim(), reproduced: o.reproduced !== false, fixed: !!o.fixed,
      testFile: o.testFile ? String(o.testFile).replace(/\\/g, '/') : null, note: String(o.note || '')});
  }
  return out;
}

// ------------------------------------------------------------------ state --
function stampOf(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
const huntRoot = cwd => path.join(cwd, '.muser', 'hunt');
function createHuntDir(cwd, now) {
  const root = huntRoot(cwd);
  fs.mkdirSync(root, {recursive: true});
  const base = path.join(root, stampOf(now));
  // Claim the leaf with a plain mkdir: existsSync-then-mkdir left a window in
  // which two hunts started in the same second both picked the same dir and
  // overwrote each other's state. mkdir's EEXIST is the atomic claim — on a
  // clash, move on to -2, -3, ...
  for (let i = 1; ; i++) {
    const dir = i === 1 ? base : base + '-' + i;
    try { fs.mkdirSync(dir); return dir; }
    catch (e) { if (e?.code !== 'EEXIST') throw e; }
  }
}
// Atomic JSON save (lore.js's writeState is the model): a uniquely named temp
// file in the same folder, then rename over the target, so a hunt killed
// mid-write can never leave a truncated file behind for the next read. The
// rename goes through config's renameRetry: on Windows a reader holding the
// target makes a plain rename throw EPERM and the state update is lost.
function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    renameRetry(tmp, file);
  } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}
function saveState(dir, state) {
  state.updatedAt = new Date().toISOString();
  // The writer's pid is the reader's liveness proof: a hunt killed mid-run
  // never writes its final state, so without a pid to check the saved
  // 'audit'/'fix' phase would claim the hunt is running forever (wave 3).
  state.pid = process.pid;
  writeJsonAtomic(path.join(dir, 'state.json'), state);
}
// A corrupt state.json must not silently vanish (lore.js's backupCorruptState
// is the model): its bytes are the only record of the interrupted hunt, so
// move the bad file aside as state.json.corrupt-<time> before reporting no
// state — the next save then starts fresh without destroying the evidence.
function backupCorruptState(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let dest = file + '.corrupt-' + stamp;
  try {
    if (fs.existsSync(dest)) dest += '-' + crypto.randomBytes(3).toString('hex');
    fs.renameSync(file, dest);
    return dest;
  } catch { return null; }
}
function loadState(dir) {
  const file = path.join(dir, 'state.json');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; } // missing = no hunt state yet
  try { const s = JSON.parse(raw); if (s && typeof s === 'object' && !Array.isArray(s)) return s; } catch {}
  backupCorruptState(file);
  return null;
}
// ------------------------------------------------------- stale-run check --
// A state whose phase is still a running one ('audit' / 'fix') is only
// believable while its writer is provably alive: the saved pid exists and
// is alive, and the last save is fresh. One agent run is capped at 30
// minutes (execRunAgent) and every group / fix file re-saves, so an hour
// without a save means the writer is gone (or the pid was reused).
const RUNNING_PHASES = new Set(['audit', 'fix']);
const STALE_MS = 60 * 60 * 1000;
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } }
function staleRunning(state, {now = Date.now(), isAlive = pidAlive} = {}) {
  if (!state || !RUNNING_PHASES.has(state.phase)) return false;
  const pid = state.pid;
  if (!Number.isInteger(pid) || pid <= 0) return true; // no liveness proof was saved
  if (!isAlive(pid)) return true;
  const stamp = Date.parse(state.updatedAt) || Date.parse(state.startedAt);
  if (Number.isFinite(stamp) && Math.abs(now - stamp) > STALE_MS) return true;
  return false;
}
// The view of a stale running state: phase and any still-'running' group
// read as interrupted, so status displays stop claiming work is ongoing.
function interruptedView(state) {
  return {...state, phase: 'interrupted', interrupted: true,
    groups: (state.groups || []).map(g => (g.status === 'running' ? {...g, status: 'interrupted'} : g))};
}
// A hunt dir's state, read for SELECTION only: unlike loadState this never
// moves a corrupt file aside — picking a dir must not mutate the dirs it
// only looked at (the chosen dir still goes through loadState afterwards).
function peekState(dir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, 'state.json'), 'utf8'); } catch { return null; }
  try { const s = JSON.parse(raw); if (s && typeof s === 'object' && !Array.isArray(s)) return s; } catch {}
  return null;
}
// True when the state is a run ANOTHER process is still writing: its phase
// is a running one and staleRunning vouches for the writer (a live pid and
// a fresh save). Our own pid is never "another" — a window must keep
// seeing its own in-progress hunt.
function foreignLiveRun(state) {
  if (!state || !RUNNING_PHASES.has(state.phase)) return false;
  if (!Number.isInteger(state.pid) || state.pid <= 0 || state.pid === process.pid) return false;
  return !staleRunning(state);
}
function latestHuntDir(cwd) {
  let names;
  try { names = fs.readdirSync(huntRoot(cwd)); } catch { return null; }
  const dirs = names.filter(n => /^\d{8}-\d{6}/.test(n)).sort();
  // Cross-window safety (wave 18): status and the fix pass name no dir of
  // their own and reach a run only through here, and with two windows
  // sharing one cwd the newest dir can be the OTHER window's hunt — picking
  // it showed that window's findings in this one, and a fix pass then saved
  // this process's pid over the other run's state.json (saveState). A run a
  // different live process is still writing is therefore never selected;
  // the newest run nobody else is writing (or our own) wins instead. The
  // cost: a status check from a separate process also skips a hunt still
  // running elsewhere and reports the last finished one.
  // LIMIT: state.json records no window/session identity, so once the other
  // window's run has FINISHED it is indistinguishable from our own — the
  // newest finished run is still picked whichever window made it. Only an
  // explicit dir (or a future owner marker in state) could resolve that.
  for (let i = dirs.length - 1; i >= 0; i--) {
    const dir = path.join(huntRoot(cwd), dirs[i]);
    if (!foreignLiveRun(peekState(dir))) return dir;
  }
  return null;
}
function readStatus(cwd) {
  const dir = latestHuntDir(cwd);
  if (!dir) return null;
  const state = loadState(dir);
  if (!state) return null;
  // Status reads the unified findings (state + findings.jsonl, duplicates
  // dropped), not state.json alone — see mergeFindings.
  const merged = {...state, findings: mergeFindings(state.findings, dir)};
  return staleRunning(merged) ? {...interruptedView(merged), dir} : {...merged, dir};
}
function readFindings(dir) {
  let text = '';
  try { text = fs.readFileSync(path.join(dir, 'findings.jsonl'), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { const f = JSON.parse(s); if (f && normSeverity(f.severity)) out.push(f); } catch {}
  }
  return out;
}
const PHASE_LABELS = {audit: () => t('監査中'), 'audit-done': () => t('監査が終わりました'), fix: () => t('修正中'), 'fix-done': () => t('修正が終わりました'), 'quota-stopped': () => t('アカウントの残量不足で停止'), interrupted: () => t('中断されました')};
// The findings count line, shared by the status view and report.md.
// None (problem-free rows) is part of the breakdown, so the parts add up
// to the total — without it a hunt whose agents mostly reported "no
// problem" showed parts summing to less than the headline (wave 11). The
// suffix is spliced inside the closing bracket so the translated string
// keeps working for both bracket spellings. A total of 1 takes the
// singular key so English reads "1 finding", not "1 findings" — the
// Japanese wording is the same either way (wave 12).
function findingsHeadline(counts) {
  const vars = {total: counts.total, critical: counts.Critical, high: counts.High, medium: counts.Medium};
  const line = counts.total === 1
    ? t('所見 1 件（Critical {critical} · High {high} · Medium {medium}）', vars)
    : t('所見 {total} 件（Critical {critical} · High {high} · Medium {medium}）', vars);
  return line.replace(/[）)]$/, m => ' · None ' + counts.None + m);
}
function formatStatusLines(state) {
  if (!state) return [t('バグ狩りはまだ実行されていません。')];
  // A state handed in directly (not via readStatus) gets the same staleness
  // judgement, so a killed run never displays as still auditing/fixing.
  if (staleRunning(state)) state = interruptedView(state);
  // The counts use the unified findings, like every other reader (wave 11).
  const counts = countBySeverity(mergeFindings(state.findings, state.dir));
  const done = (state.groups || []).filter(g => ['done', 'failed', 'skipped'].includes(g.status)).length;
  const lines = [
    t('バグ狩り: {state}', {state: (PHASE_LABELS[state.phase] || (() => state.phase || ''))()}),
    findingsHeadline(counts),
    t('担当 {done}/{groups} が完了', {done, groups: (state.groups || []).length}),
  ];
  // A truncated scope must stay visible after the run too: without this,
  // status read as a clean complete audit over a capped sample (wave 11).
  const est = state.estimate || {};
  if (est.truncated || state.truncated) lines.push(t('対象は上限 {max} 件で打ち切られました（本来は約 {total} 件）', {max: est.maxFiles || MAX_FILES, total: est.totalFiles ?? est.approxTotal ?? state.totalFiles ?? est.files ?? counts.total}));
  if (state.dir) lines.push(t('結果: {dir}', {dir: state.dir}));
  return lines;
}
function formatEstimateLines(estimate) {
  // One agent takes the singular key, like the findings count (wave 12).
  const lines = [estimate && estimate.agents === 1
    ? t('見込み: エージェント 1 体 · アカウント {account} · 対象 {files} ファイル', estimate)
    : t('見込み: エージェント {agents} 体 · アカウント {account} · 対象 {files} ファイル', estimate)];
  // A truncated scope must not read as the whole tree: the cap is a sample,
  // and the estimate says so with the approximate original count (wave 3).
  if (estimate && estimate.truncated) lines.push(t('対象は上限 {max} 件で打ち切られました（本来は約 {total} 件）', {max: estimate.maxFiles || MAX_FILES, total: estimate.totalFiles ?? estimate.approxTotal ?? estimate.files}));
  return lines;
}
function formatFixSummaryLines(summary) {
  const lines = [t('直した {fixed} 件 · 直せなかった {failed} 件 · 後回し {deferred} 件 · 再現しなかった {notReproduced} 件', summary),
    t('反証で確かめられなかった {unverified} 件は「直した」に数えていません', {unverified: summary.unverified})];
  // Out-of-scope findings (e.g. no file name) are counted here too, with
  // the reason carried in fix-report.md, instead of vanishing (wave 11).
  if (summary && summary.excluded) lines.push(t('対象外 {excluded} 件（ファイル名がない所見など。理由は修正結果の報告にあります）', {excluded: summary.excluded}));
  return lines;
}

// ------------------------------------------------------------------ audit --
// Everything before a single agent starts: scope, groups, the estimate the
// user confirms (design §0: show agents + account first, allow a cap).
function prepareAudit({cwd, scope, agents, account, accountLabel, worklogBase}) {
  const edited = recentEditedFiles(worklogDir(worklogBase));
  const collected = collectFiles(cwd, scope);
  let files = collected;
  if (!files.length) throw new Error(t('監査できるファイルがありません。'));
  // Capture the truncation facts before the hot-first reorder (a spread,
  // which would drop the metadata collectFiles attached to its array).
  const truncated = !!collected.truncated;
  const totalFiles = collected.totalApprox ?? files.length;
  // Recently edited files are audited first (their groups are dealt first);
  // the ranking comes from the worklog and changes nothing else.
  const hot = new Set(edited.keys());
  files = [...files.filter(f => hot.has(f)), ...files.filter(f => !hot.has(f))];
  const groups = makeGroups(files, agents);
  checkDisjoint(groups);
  return {cwd, files, groups, hotFiles: files.filter(f => hot.has(f)), truncated, totalFiles,
    estimate: {agents: groups.length, account: accountLabel || account || 'default', files: files.length,
      ...(truncated ? {truncated: true, totalFiles, approxTotal: totalFiles, maxFiles: MAX_FILES} : {})}};
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function runAudit(prepared, {runAgent, quota, account, maxConcurrent = 3, staggerMs = 0, now = new Date(), onProgress} = {}) {
  if (typeof runAgent !== 'function') throw new Error('runAgent is required');
  const {cwd, groups} = prepared;
  const dir = createHuntDir(cwd, now);
  const state = {version: 1, cwd, dir, phase: 'audit', startedAt: now.toISOString(),
    estimate: prepared.estimate, findings: [],
    groups: groups.map((files, i) => ({index: i + 1, tag: 'h' + (i + 1), files, status: 'pending', findings: 0}))};
  saveState(dir, state);
  writeJsonAtomic(path.join(dir, 'plan.json'), {estimate: prepared.estimate, groups: state.groups.map(g => ({tag: g.tag, files: g.files}))});
  const hot = new Set(prepared.hotFiles || []);
  let next = 0, quotaStopped = false;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= groups.length) return;
      const g = state.groups[i];
      if (quotaStopped) { g.status = 'skipped'; saveState(dir, state); continue; }
      if (quota) {
        let q = null;
        try { q = await quota(account); } catch {}
        if (q && q.exhausted) { quotaStopped = true; state.phase = 'quota-stopped'; g.status = 'skipped'; saveState(dir, state); continue; }
      }
      g.status = 'running';
      saveState(dir, state);
      if (onProgress) onProgress({type: 'group-start', tag: g.tag, index: g.index});
      if (staggerMs) await sleep(staggerMs);
      try {
        const text = await runAgent({prompt: auditPrompt({cwd, files: g.files, hot: g.files.filter(f => hot.has(f))}),
          files: g.files, account, kind: 'audit', tag: g.tag});
        // Completely identical rows from one reply are one finding (wave 11).
        const found = dedupeFindings(parseFindings(text, g.tag));
        g.status = 'done';
        g.findings = found.length;
        state.findings.push(...found);
        if (found.length) fs.appendFileSync(path.join(dir, 'findings.jsonl'), found.map(f => JSON.stringify(f)).join('\n') + '\n', 'utf8');
      } catch (e) {
        g.status = 'failed';
        g.error = String((e && e.message) || e).slice(0, 300);
      }
      // The per-agent table lands even when the run dies later (§6).
      fs.writeFileSync(path.join(dir, 'agent-' + g.tag + '.md'), agentTableMarkdown(g, state.findings.filter(f => f.agent === g.tag)), 'utf8');
      saveState(dir, state);
      if (onProgress) onProgress({type: 'group-done', tag: g.tag, index: g.index, status: g.status});
    }
  };
  const lanes = Math.max(1, Math.min(maxConcurrent || 1, groups.length));
  await Promise.all(Array.from({length: lanes}, () => worker()));
  if (state.phase === 'audit') state.phase = 'audit-done';
  saveState(dir, state);
  fs.writeFileSync(path.join(dir, 'report.md'), reportMarkdown(state), 'utf8');
  return state;
}
function agentTableMarkdown(g, findings) {
  // The report files are written in the UI language (wave 12): every
  // heading and fixed line goes through t(), so an English-mode hunt
  // leaves English reports. Finding summaries and file names stay as-is.
  const lines = ['# ' + t('バグ狩り 担当 {tag}', {tag: g.tag}), '', t('状態: {status} · 対象 {files} ファイル', {status: g.status, files: g.files.length}), '', '## ' + t('対象'), '', ...g.files.map(f => '- ' + f), '', '## ' + t('所見'), ''];
  if (!findings.length) lines.push(t('（なし）'));
  else for (const f of findings) lines.push('- [' + f.severity + '] ' + (f.file || '') + (f.line ? ':' + f.line : '') + ' — ' + f.summary + (f.repro ? t('（再現: {repro}）', {repro: f.repro}) : ''));
  return lines.join('\n') + '\n';
}
function reportMarkdown(state) {
  // The report counts the unified findings (state + findings.jsonl,
  // duplicates dropped), so its numbers match status and the fix pass.
  const findings = mergeFindings(state.findings, state.dir);
  const counts = countBySeverity(findings);
  const lines = ['# ' + t('バグ狩り 報告'), '', t('開始: {at} · 対象: {cwd}', {at: state.startedAt, cwd: state.cwd}), '',
    findingsHeadline(counts), ''];
  // The result carries the truncation too, not just the estimate (wave 3).
  if (state.estimate && state.estimate.truncated) lines.push(t('対象ファイルは上限 {max} 件で打ち切りました（本来は約 {total} 件）。監査されていないファイルがあります。', {max: state.estimate.maxFiles || MAX_FILES, total: state.estimate.totalFiles ?? state.estimate.approxTotal ?? state.estimate.files}), '');
  lines.push('## ' + t('所見'), '');
  const real = findings.filter(f => f.severity !== 'None');
  if (!real.length) lines.push(t('（問題の所見はありません）'));
  for (const f of [...real].sort((a, b) => RANK[b.severity] - RANK[a.severity]))
    lines.push('- [' + f.severity + '] ' + (f.file || '') + (f.line ? ':' + f.line : '') + ' — ' + f.summary + (f.repro ? '\n  - ' + t('再現: {repro}', {repro: f.repro}) : '') + t('（担当 {agent}）', {agent: f.agent || '?'}));
  lines.push('', '## ' + t('担当'), '');
  for (const g of state.groups) lines.push('- ' + t('{tag}: {status} · {files} ファイル · 所見 {findings} 件', {tag: g.tag, status: g.status, files: g.files.length, findings: g.findings}) + (g.error ? ' · ' + g.error : ''));
  if (state.phase === 'quota-stopped') lines.push('', t('アカウントの残量が閾値を下回ったため、残りの担当は起動しませんでした。'));
  return lines.join('\n') + '\n';
}
// -------------------------------------------------------------------- fix --
const hashOf = text => crypto.createHash('sha256').update(text).digest('hex');
// The fix flow's change detection watches EVERY file, not only the audit's
// code-extension scope: a fixer can change package.json, a README, or
// delete a file, and all of that belongs in the report and the counter-
// proof (features-debug #25). Sensitive paths stay out, as everywhere.
const SNAPSHOT_MAX_TEXT = 1024 * 1024;
// The walk keeps scanning past the cap (without collecting) purely to
// learn whether anything was dropped: a capped snapshot used to be
// indistinguishable from a complete one, so changes outside the cap were
// silently missed and the fix report claimed no files changed (wave 11).
function walkAllInto(cwd, absDir, out, counter) {
  let entries;
  try { entries = fs.readdirSync(absDir, {withFileTypes: true}); } catch { return; }
  for (const e of entries) {
    const abs = path.join(absDir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walkAllInto(cwd, abs, out, counter); continue; }
    if (!e.isFile()) continue;
    if (isSensitivePath(abs)) continue;
    if (out.length < MAX_FILES) out.push(relOf(cwd, abs));
    else if (counter) counter.truncated = true;
  }
}
function snapshotTree(cwd) {
  const map = new Map();
  const files = [];
  const counter = {truncated: false};
  walkAllInto(cwd, cwd, files, counter);
  // Carried on the Map itself: true when the cap dropped files, so callers
  // can warn that change detection only covered part of the tree.
  map.truncated = counter.truncated;
  for (const rel of files) {
    const abs = path.join(cwd, rel);
    try {
      const st = fs.statSync(abs);
      // Big files are fingerprinted, not held: their text is never needed
      // (the counter-proof only reverts files a fixer could have edited).
      map.set(rel, st.size > SNAPSHOT_MAX_TEXT ? '\0stat:' + st.size + ':' + st.mtimeMs : fs.readFileSync(abs, 'utf8'));
    } catch {}
  }
  return map;
}
function changedSince(cwd, before) {
  const nowMap = snapshotTree(cwd);
  const changed = [], added = [], deleted = [];
  for (const [rel, text] of nowMap) {
    if (!before.has(rel)) added.push(rel);
    else if (hashOf(before.get(rel)) !== hashOf(text)) changed.push(rel);
  }
  for (const rel of before.keys()) if (!nowMap.has(rel)) deleted.push(rel);
  return {changed, added, deleted, nowMap, snapshotTruncated: !!(before.truncated || nowMap.truncated)};
}
// The proof copy's tree walk, replacing a plain recursive copy: links are
// never carried into the copy AS links (wave 18). fs.cpSync copied a
// junction/symlink as a link to the SAME target, so a write inside the copy
// through that link landed on the real entity — for a link pointing outside
// the tree, on files the hunt was never asked to touch; for one pointing
// back into the tree (junctions store absolute paths), on the user's own
// files — breaking the "user's own tree is never written" rule below. Here
// a link whose real target stays INSIDE the tree is copied as the real file
// or folder it points at, and a link pointing outside the tree is left out
// of the copy entirely (its outside content is not imported either). A link
// whose target is a folder already being copied above it would expand
// forever, so it is left out too, as is a dangling link.
function copyProofTree(srcRoot, destRoot) {
  const fold = p => (process.platform === 'win32' ? p.toLowerCase() : p);
  let rootReal;
  try { rootReal = fs.realpathSync(srcRoot); } catch { rootReal = path.resolve(srcRoot); }
  const insideRoot = real => {
    const rel = path.relative(fold(rootReal), fold(real));
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
  };
  const walk = (srcDir, destDir, dirStack) => {
    fs.mkdirSync(destDir, {recursive: true});
    let entries;
    try { entries = fs.readdirSync(srcDir, {withFileTypes: true}); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue; // the cpSync filter's basename skips (.git is in SKIP_DIRS)
      const src = path.join(srcDir, e.name);
      const dest = path.join(destDir, e.name);
      let st;
      try { st = fs.lstatSync(src); } catch { continue; }
      if (st.isSymbolicLink()) {
        let real;
        try { real = fs.realpathSync(src); } catch { continue; } // dangling: nothing safe to copy
        if (!insideRoot(real)) continue; // points out of the tree: excluded
        let rst;
        try { rst = fs.statSync(real); } catch { continue; }
        if (rst.isDirectory()) {
          if (dirStack.includes(fold(real))) continue; // link cycle: expanding it never ends
          walk(real, dest, [...dirStack, fold(real)]);
        } else if (rst.isFile()) {
          try { fs.copyFileSync(real, dest); } catch {}
        }
        continue;
      }
      if (st.isDirectory()) {
        let real;
        try { real = fs.realpathSync(src); } catch { real = src; }
        if (dirStack.includes(fold(real))) continue;
        walk(src, dest, [...dirStack, fold(real)]);
        continue;
      }
      if (st.isFile()) { try { fs.copyFileSync(src, dest); } catch {} }
    }
  };
  walk(srcRoot, destRoot, [fold(rootReal)]);
}
// The built-in counter-proof (design §3's seam, minimal hunt-local version):
// in a THROWAWAY COPY of the tree, put the pre-fix text of the changed
// non-test files back, and the new regression tests must FAIL; the caller's
// re-run in the real tree (where nothing was ever reverted) must PASS.
// The user's own tree is never written here: an earlier version reverted
// the files in place, so a process killed mid-proof left the fix undone
// and a concurrent user edit was restored over (features-debug #24).
async function builtinCounterProof({cwd, before, changedFiles, testFiles, runTests}) {
  const targets = changedFiles.filter(f => !isTestFile(f) && before.has(f));
  if (!targets.length || !testFiles.length) return 'unknown';
  let root = null;
  try {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-hunt-proof-'));
    const dir = path.join(root, 'tree');
    fs.mkdirSync(dir, {recursive: true});
    copyProofTree(cwd, dir);
    const nm = path.join(cwd, 'node_modules');
    if (fs.existsSync(nm)) { try { fs.symlinkSync(nm, path.join(dir, 'node_modules'), 'junction'); } catch {} }
    for (const f of targets) { const dest = path.join(dir, f); fs.mkdirSync(path.dirname(dest), {recursive: true}); fs.writeFileSync(dest, before.get(f), 'utf8'); }
    const reverted = await runTests(testFiles, dir);
    if (reverted.ok) return 'unproven'; // passed without the fix: the test is not watching it
    return 'proven-pending';
  } catch { return 'unknown'; }
  finally { if (root) { try { fs.rmSync(root, {recursive: true, force: true}); } catch {} } }
}
function defaultRunTests(files, cwd) {
  const {spawnSync} = require('node:child_process');
  const list = (files || []).filter(Boolean);
  if (!list.length) return {ok: false, output: 'no test files'};
  const setup = path.join(cwd, 'tests', 'setup.mjs');
  const args = list.every(f => f.startsWith('tests/')) && fs.existsSync(setup)
    ? ['--import', './tests/setup.mjs', '--test', ...list] : ['--test', ...list];
  // A hunt launched from inside a test run (NODE_TEST_CONTEXT set) would make
  // the child runner skip its files and report a hollow pass; the regression
  // tests hunt runs are real runs, so the marker does not carry over.
  const env = {...process.env};
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, args, {cwd, encoding: 'utf8', timeout: 180000, shell: false, env});
  const output = String((r.stdout || '') + (r.stderr || '')).slice(-4000);
  return {ok: r.status === 0, output};
}
function prepareFix({cwd, level, dir}) {
  const lvl = normSeverity(level) || 'High';
  const huntDir = dir || latestHuntDir(cwd);
  if (!huntDir) throw new Error(t('バグ狩りの結果がありません。先に /hunt を実行してください。'));
  // The fix pass reads the same unified findings as status and the report
  // (state + findings.jsonl merged, exact duplicates dropped) — reading
  // findings.jsonl alone made it disagree with status whenever the two
  // stores had drifted apart (wave 11).
  const state = loadState(huntDir);
  const findings = mergeFindings(state ? state.findings : [], huntDir);
  const targets = findings.filter(f => f.severity !== 'None' && atLeast(f, lvl) && f.file);
  const byFile = new Map();
  for (const f of targets) { if (!byFile.has(f.file)) byFile.set(f.file, []); byFile.get(f.file).push(f); }
  // A finding at or above the level but with no file name cannot be queued
  // (fixers work one file at a time) — it used to fall between targets and
  // deferred and vanish from every count. It is now counted apart, with
  // its reason, and listed in the fix report (wave 11).
  const excluded = findings.filter(f => f.severity !== 'None' && atLeast(f, lvl) && !f.file)
    .map(f => ({finding: f, reason: t('ファイル名がないため、ファイル単位の修正対象にできません')}));
  return {cwd, dir: huntDir, level: lvl, findings, targets, byFile, excluded, excludedCount: excluded.length,
    deferred: findings.filter(f => f.severity !== 'None' && !atLeast(f, lvl)).length,
    estimate: {agents: byFile.size, account: 'default', files: byFile.size}};
}
// Fix runs one file at a time: two fixers never share the tree's diff, and a
// file never has two writers (design §6). Outcomes per finding:
// fixed (counter-proof passed) / failed / not-reproduced / unproven (the
// regression test passes even without the fix) / unverified (no usable test).
async function runFix(prepared, {runAgent, quota, account, runTests = defaultRunTests, counterProof, onProgress} = {}) {
  if (typeof runAgent !== 'function') throw new Error('runAgent is required');
  const {cwd, dir, byFile} = prepared;
  const state = loadState(dir) || {version: 1, cwd, dir, groups: [], findings: prepared.findings};
  state.phase = 'fix';
  saveState(dir, state);
  const outcomes = [];
  const changedAll = new Set();
  let stopped = false;
  let snapshotTruncated = false;
  for (const [file, findings] of byFile) {
    if (stopped) { for (const f of findings) outcomes.push({finding: f, status: 'failed', note: 'quota'}); continue; }
    if (quota) {
      let q = null;
      try { q = await quota(account); } catch {}
      if (q && q.exhausted) { stopped = true; state.phase = 'quota-stopped'; for (const f of findings) outcomes.push({finding: f, status: 'failed', note: 'quota'}); continue; }
    }
    if (onProgress) onProgress({type: 'fix-start', file});
    // Re-save per file: a long fix run must keep its state's pid/updatedAt
    // fresh, or the read side would judge its own live run stale (wave 3).
    saveState(dir, state);
    const before = snapshotTree(cwd);
    if (before.truncated) snapshotTruncated = true;
    let results = [];
    try {
      const text = await runAgent({prompt: fixPrompt({cwd, file, findings}), files: [file], account, kind: 'fix', tag: 'fix-' + file});
      results = parseFixResults(text);
    } catch (e) {
      for (const f of findings) outcomes.push({finding: f, status: 'failed', note: String((e && e.message) || e).slice(0, 200)});
      continue;
    }
    const {changed, added, deleted, snapshotTruncated: snapCut} = changedSince(cwd, before);
    if (snapCut) snapshotTruncated = true;
    const touched = [...changed, ...added, ...deleted];
    for (const f of touched) changedAll.add(f);
    const claimed = new Map();
    for (const f of findings) {
      const r = results.find(x => x.summary === f.summary) || results.find(x => x.summary && f.summary.startsWith(x.summary.slice(0, 24))) || null;
      claimed.set(f, r);
    }
    const anyFixed = findings.some(f => claimed.get(f) && claimed.get(f).fixed && claimed.get(f).reproduced);
    const testFiles = [...new Set([...changed, ...added].filter(isTestFile)
      .concat(results.map(r => r.testFile).filter(Boolean)))].filter(f => fs.existsSync(path.join(cwd, f)));
    let proof = 'unknown';
    if (anyFixed && testFiles.length) {
      const baseRun = await runTests(testFiles, cwd);
      if (baseRun.ok) {
        if (counterProof) {
          try { proof = await counterProof({cwd, changedFiles: touched, testFiles, runTests}); } catch { proof = 'unknown'; }
        } else {
          proof = await builtinCounterProof({cwd, before, changedFiles: touched, testFiles, runTests});
          if (proof === 'proven-pending') {
            const again = await runTests(testFiles, cwd);
            proof = again.ok ? 'proven' : 'unknown';
          }
        }
      }
    }
    for (const f of findings) {
      const r = claimed.get(f);
      let status;
      if (!r) status = 'failed';
      else if (!r.reproduced) status = 'not-reproduced';
      else if (!r.fixed) status = 'failed';
      else if (proof === 'proven') status = 'fixed';
      else if (proof === 'unproven') status = 'unproven';
      else status = 'unverified';
      outcomes.push({finding: f, status, note: r ? r.note : '', testFiles, changedFiles: touched});
    }
    if (onProgress) onProgress({type: 'fix-done', file});
  }
  const summary = {fixed: 0, failed: 0, deferred: prepared.deferred || 0, notReproduced: 0, unverified: 0,
    excluded: prepared.excludedCount != null ? prepared.excludedCount : (prepared.excluded || []).length};
  for (const o of outcomes) {
    if (o.status === 'fixed') summary.fixed++;
    else if (o.status === 'not-reproduced') summary.notReproduced++;
    else if (o.status === 'unproven' || o.status === 'unverified') summary.unverified++;
    else summary.failed++;
  }
  state.phase = state.phase === 'quota-stopped' ? 'quota-stopped' : 'fix-done';
  state.fix = {level: prepared.level, at: new Date().toISOString(), summary, outcomes: outcomes.map(o => ({status: o.status, summary: o.finding.summary, file: o.finding.file, note: o.note || ''})),
    excluded: (prepared.excluded || []).map(x => ({severity: x.finding.severity, summary: x.finding.summary, reason: x.reason})),
    snapshotTruncated};
  saveState(dir, state);
  fs.appendFileSync(path.join(dir, 'fix-results.jsonl'), outcomes.map(o => JSON.stringify({status: o.status, severity: o.finding.severity, file: o.finding.file, summary: o.finding.summary, note: o.note || '', testFiles: o.testFiles || [], changedFiles: o.changedFiles || []})).join('\n') + (outcomes.length ? '\n' : ''), 'utf8');
  fs.writeFileSync(path.join(dir, 'fix-report.md'), fixReportMarkdown(state, outcomes, [...changedAll]), 'utf8');
  return {state, outcomes, summary, changedFiles: [...changedAll], dir, excluded: prepared.excluded || [], snapshotTruncated};
}
function fixReportMarkdown(state, outcomes, changedFiles) {
  const pick = s => outcomes.filter(o => o.status === s);
  const lines = ['# ' + t('バグ狩り 修正結果'), '', t('重要度 {level} 以上 · {at}', {level: state.fix ? state.fix.level : '', at: state.fix ? state.fix.at : ''}), ''];
  // A capped snapshot means the changed-file list below may be incomplete:
  // the report says so instead of presenting a partial list as the whole
  // tree's diff (wave 11).
  if (state.fix && state.fix.snapshotTruncated) lines.push(t('注意: 修正前後のファイル一覧は上限 {max} 件で打ち切られました。変わったファイルの検出が不完全な場合があります。', {max: MAX_FILES}), '');
  const section = (title, list, fmt) => { lines.push('## ' + title + t('（{n}）', {n: list.length}), ''); if (!list.length) lines.push(t('（なし）')); for (const o of list) lines.push(fmt(o)); lines.push(''); };
  section(t('直した'), pick('fixed'), o => '- [' + o.finding.severity + '] ' + o.finding.file + ' — ' + o.finding.summary);
  section(t('直せなかった'), pick('failed'), o => '- [' + o.finding.severity + '] ' + o.finding.file + ' — ' + o.finding.summary + (o.note ? '（' + o.note + '）' : ''));
  section(t('反証で確かめられなかった'), [...pick('unproven'), ...pick('unverified')], o => '- [' + o.finding.severity + '] ' + o.finding.file + ' — ' + o.finding.summary + t('（{status}）', {status: o.status}));
  section(t('再現しなかった'), pick('not-reproduced'), o => '- [' + o.finding.severity + '] ' + o.finding.file + ' — ' + o.finding.summary);
  // Findings that never entered the fix queue (e.g. no file name) are
  // listed with their reason, not silently dropped from the tally.
  const excluded = (state.fix && state.fix.excluded) || [];
  lines.push('## ' + t('対象外') + t('（{n}）', {n: excluded.length}), '');
  if (!excluded.length) lines.push(t('（なし）'));
  for (const x of excluded) lines.push('- [' + x.severity + '] ' + x.summary + t('（対象外: {reason}）', {reason: x.reason}));
  lines.push('');
  lines.push('## ' + t('変わったファイル'), '');
  if (!changedFiles.length) lines.push(t('（なし）'));
  for (const f of changedFiles) lines.push('- ' + f);
  lines.push('', t('コミットはしていません。'));
  return lines.join('\n') + '\n';
}

// --------------------------------------------------------------- adapters --
// CLI adapter: one headless `muser exec --json` child per agent. Audit runs
// in plan mode (read-only is enforced by the mode, not just the prompt);
// fix runs in auto-edit (folder edits pass, commands are declined headless,
// and hunt itself runs the regression tests).
function execRunAgent({binFile, cwd, timeoutMs = 30 * 60 * 1000} = {}) {
  const bin = binFile || path.join(__dirname, '..', 'bin', 'muser.js');
  return async ({prompt, account, kind}) => {
    const {spawn} = require('node:child_process');
    const args = [bin, 'exec', '--json', '--mode', kind === 'fix' ? 'auto-edit' : 'plan'];
    if (account) args.push('--account', account);
    args.push(prompt);
    const r = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {cwd, shell: false, windowsHide: true});
      let out = '';
      // A hung child must not hang the whole hunt (features-debug #26;
      // race's runner has had a timeout from the start).
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', () => {});
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => { clearTimeout(timer); resolve({out, code}); });
    });
    let result = null;
    for (const line of r.out.split(/\r?\n/)) { try { const o = JSON.parse(line); if (o && o.type === 'result') result = o; } catch {} }
    if (!result || !result.ok) throw new Error(String((result && result.error) || ('muser exec failed (exit ' + r.code + ')')).slice(0, 300));
    return String(result.reply || '');
  };
}
// Quota guard backed by account-pool statuses(), cached for a minute:
// reading a plan costs one server action per account, so launches within a
// hunt share one reading. Unknown (null) never blocks, matching accounts.js.
function makeDefaultQuota({cacheMs = 60000} = {}) {
  let at = 0, cached = null, inflight = null;
  return async accountId => {
    const nowMs = Date.now();
    if (cached && nowMs - at < cacheMs) return pick(cached, accountId);
    if (!inflight) {
      inflight = (async () => {
        try {
          const pool = require('./account-pool');
          const sts = await pool.statuses();
          cached = sts; at = Date.now();
          return sts;
        } catch { return null; }
        finally { inflight = null; }
      })();
    }
    const sts = await inflight;
    return pick(sts, accountId);
  };
  function pick(sts, accountId) {
    if (!Array.isArray(sts)) return null;
    let accounts;
    try { accounts = require('./accounts'); } catch { return null; }
    const id = accountId || accounts.activeId();
    const s = sts.find(x => x.id === id);
    if (!s) return null;
    return {exhausted: accounts.exhausted(s), percentUsed: s.percentUsed != null ? s.percentUsed : null};
  }
}
// Optional lore seam (design §5, built on another branch): when a lore
// module with recordScar appears, fixed findings are offered to it. Absent
// is normal — hunt works the same without it.
function offerScarsToLore(outcomes, cwd) {
  let lore = null;
  try { lore = require('./lore'); } catch { return 0; }
  if (!lore || typeof lore.recordScar !== 'function') return 0;
  let n = 0;
  for (const o of outcomes || []) {
    if (o.status !== 'fixed') continue;
    try { lore.recordScar({cwd, file: o.finding.file, summary: o.finding.summary, tests: o.testFiles || []}); n++; } catch {}
  }
  return n;
}

module.exports = {WORKLOG_RETENTION_DAYS, WORKLOG_MAX_BYTES, worklogDir, blobFile, parseWorklogText, listWorklogs,
  readWorklog, editedFiles, recentEditedFiles, collectFiles, isTestFile, makeGroups, checkDisjoint,
  SEVERITIES, normSeverity, atLeast, parseFindings, countBySeverity, dedupeFindings, mergeFindings, auditPrompt, fixPrompt, parseFixResults,
  huntRoot, latestHuntDir, loadState, readStatus, readFindings, formatStatusLines, formatEstimateLines, formatFixSummaryLines, MAX_FILES, staleRunning,
  prepareAudit, runAudit, prepareFix, runFix, defaultRunTests, execRunAgent, makeDefaultQuota, offerScarsToLore};
