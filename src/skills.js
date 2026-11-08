'use strict';
// Skills: folders with a SKILL.md (frontmatter name + description, then instructions), the format
// Claude Code, Codex and others share. muser reads them where those tools keep them, so skills the
// user already has work here unchanged; it never writes to those folders.
// Muse gets only "name: description" in the preamble and reads a skill with skill.read when it
// needs it, so a long list costs little. Which skills are on is kept in ~/.muser/config.json
// ("skills": {"disabled": [...], "sources": {"codex": false}}).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_LISTED = 60, DESC_CHARS = 140, MAX_FILE = 256 * 1024;

// Earlier sources win on a name clash: the project's own, then muser's, then the other tools'.
// A UNC spelling of this machine's own admin shares (\\localhost\C$\…, \\127.0.0.1\C$\…,
// \\?\UNC\localhost\C$\…) names a local drive path: return that path, or the input
// unchanged for any other spelling — the same fold tell.js / policy.js apply, because
// realpath keeps the UNC form and it never matches the drive spelling of the same folder.
function uncLocalDrivePath(s) {
  if (process.platform !== 'win32') return s;
  let str = String(s).replace(/\\/g, '/');
  str = str.replace(/^\/\/[?.]\/unc\//i, '//');
  str = str.replace(/^\/\/[?.]\/(?=[a-z]:\/)/i, '');
  const m = /^\/\/([^/]+)\/([^/]+)\/(.*)$/.exec(str);
  if (!m) return s;
  const hosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '.']);
  try { hosts.add(os.hostname().toLowerCase()); } catch {}
  if (!hosts.has(m[1].toLowerCase())) return s;
  const share = /^([a-z])\$$/i.exec(m[2]);
  if (!share) return s;
  return share[1].toUpperCase() + ':/' + m[3];
}

// The native real path of a path that exists, folded to the drive spelling, or null
// when it cannot be resolved. The .native form is required (wave 18): the plain
// realpathSync keeps an 8.3 short-name spelling (LONGHO~1), so a cwd spelled that
// way keyed differently from the same folder spelled long.
function realNative(p) {
  try { return path.resolve(uncLocalDrivePath(fs.realpathSync.native(p))); } catch { return null; }
}

// A folder's physical identity: a link or a differently-spelled path to the same folder
// counts as that folder (wave 15 (1)). Resolved through the deepest part that exists
// (the tools.js realOf walk), so a source folder that does not exist yet still keys by
// its folder's real spelling and only the missing tail is kept as written (wave 18).
function physicalKey(dir) {
  let cur = path.resolve(uncLocalDrivePath(String(dir))), rest = [], key = null;
  for (;;) {
    const real = realNative(cur);
    if (real) { key = path.join(real, ...rest); break; }
    const up = path.dirname(cur);
    if (up === cur) { key = cur; break; }
    rest.unshift(path.basename(cur)); cur = up;
  }
  key = path.resolve(uncLocalDrivePath(key));
  if (process.platform === 'win32') key = key.toLowerCase();
  return key.replace(/[\\/]+$/, '');
}

function sources(cwd) {
  const home = os.homedir();
  const all = [
    {id: 'project', dir: path.join(cwd, '.muser', 'skills')},
    {id: 'muser', dir: path.join(home, '.muser', 'skills')},
    {id: 'claude-project', dir: path.join(cwd, '.claude', 'skills')},
    {id: 'claude', dir: path.join(home, '.claude', 'skills')},
    {id: 'codex', dir: path.join(home, '.codex', 'skills')},
    {id: 'agents', dir: path.join(home, '.agents', 'skills')},
  ];
  // 同じ物理フォルダーは1回だけ数える。cwd がホームそのもののとき、プロジェクト側と
  // ホーム側が同じフォルダーを指すので、プロジェクト側を残すと自分のスキルに (project)
  // 印が付き、2回目が偽の名前衝突になる。ホーム側を残す (wave 15 (1))。
  const out = [], byKey = new Map();
  for (const src of all) {
    const key = physicalKey(src.dir), at = byKey.get(key);
    if (at === undefined) { byKey.set(key, out.length); out.push(src); continue; }
    const keptIsProject = out[at].id === 'project' || out[at].id === 'claude-project';
    const curIsProject = src.id === 'project' || src.id === 'claude-project';
    if (keptIsProject && !curIsProject) out[at] = src;
  }
  return out;
}

function configFile() { return path.join(os.homedir(), '.muser', 'config.json'); }
function readConfig() { try { return require('./config').readJson(configFile()) || {}; } catch { return {}; } }
function settings() {
  const s = readConfig().skills || {};
  // Disabled names are the normalised names load() registers under; normalise on the
  // way in too, so a name stored unnormalised (written before wave 15 (3), or by hand)
  // still matches the skill it names.
  return {disabled: new Set((Array.isArray(s.disabled) ? s.disabled : []).map(n => normalizeName(n)).filter(Boolean)), sources: s.sources && typeof s.sources === 'object' ? s.sources : {}};
}
function saveSettings(mutate) {
  const s = settings();
  mutate(s);
  require('./config').update(cfg => { cfg.skills = {disabled: [...s.disabled].sort(), sources: s.sources}; });
}

// The frontmatter as the skills in the wild write it: key: value, quoted values, and folded or
// literal blocks (description: >- followed by indented lines).
function frontmatter(text) {
  // A BOM (Notepad and some editors save one) hid the frontmatter, so the skill had no description.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // Trailing spaces on a delimiter line ('--- ' from an editor's trailing-whitespace
  // habits) still delimit: requiring the line to end right after the dashes made the
  // whole frontmatter vanish. Only spaces/tabs are allowed — '----' or '---x' is not
  // a delimiter, as before.
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/.exec(text);
  if (!m) {
    // 開く区切りはあるのに閉じる区切りの行がどこにもないものは、frontmatter が
    // 無いファイルとは違う: load() が診断で知らせられるよう印を付ける (wave 15 (4))。
    const unclosed = /^---[ \t]*(\r?\n|$)/.test(text) && !text.split(/\r?\n/).slice(1).some(l => /^---[ \t]*$/.test(l));
    return {meta: {}, body: text, duplicates: [], ...(unclosed ? {unclosed: true} : {})};
  }
  const meta = {}, lines = m[1].split(/\r?\n/);
  const seenKeys = new Set(), duplicates = [];
  let lastKey = null, lastPlain = false;
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) {
      // A plain scalar folded over several lines (no > or |): YAML joins the indented
      // continuation lines into the value; dropping them cut descriptions mid-sentence
      // (audit c17 #4).
      if (lastPlain && /^\s+\S/.test(lines[i])) meta[lastKey] = (meta[lastKey] + ' ' + lines[i].trim()).trim();
      continue;
    }
    let value = kv[2].trim();
    lastKey = kv[1].toLowerCase(); lastPlain = false;
    // A repeated name / description key: the later value wins, as before, but the
    // repetition itself is not silent — load() surfaces it through diagnostics()
    // (wave 10). Another tool reading the same file may keep the FIRST value, so
    // the skill can be known by a different name / description there.
    if ((lastKey === 'name' || lastKey === 'description') && seenKeys.has(lastKey) && !duplicates.includes(lastKey)) duplicates.push(lastKey);
    seenKeys.add(lastKey);
    // A quoted value may carry a trailing comment ('description: "hello" # note'):
    // the quote branches below only fire when the value ENDS at the closing quote,
    // so the comment left the quotes in the value as literal characters (and a '#'
    // inside the quotes was cut as a comment by the plain branch). Cut a comment
    // that sits after the closing quote, honouring \" and '' escapes while looking
    // for it. A value whose quotes never close, or that has other text after them,
    // is left exactly as written.
    if (value[0] === '"' || value[0] === "'") {
      const q = value[0];
      for (let j = 1; j < value.length; j++) {
        if (q === '"' && value[j] === '\\') { j++; continue; }
        if (value[j] === q) {
          if (q === "'" && value[j + 1] === "'") { j++; continue; }
          const rest = value.slice(j + 1).trim();
          if (rest === '' || rest.startsWith('#')) value = value.slice(0, j + 1);
          break;
        }
      }
    }
    // Block header, with an optional indentation indicator (|-2, >2- …) as real YAML allows.
    // A trailing comment after the header ('>- # note') is part of neither the
    // header nor the block: without allowing it here the header fell through to
    // the plain branch and the value came out as the literal '>- …' (Wave 16 (5)).
    if (/^[>|](?:[+-]?\d?|\d[+-]?)(?:\s+#.*)?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim());
      value = value[0] === '>' ? block.filter(Boolean).join(' ') : block.join('\n').trim();
    } else if (/^"[\s\S]*"$/.test(value)) {
      value = value.slice(1, -1).replace(/\\(.)/g, (_, c) => ({n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '0': '\0'})[c] ?? c);
    } else if (/^'[\s\S]*'$/.test(value)) {
      value = value.slice(1, -1).replace(/''/g, "'");
    } else {
      // An unquoted value's trailing comment is not part of the value: 'name: foo # memo'
      // registered the skill under a mangled name (audit c17 #4). A '#' inside a word stays.
      value = value.replace(/\s+#.*$/, '').trim();
      lastPlain = true;
    }
    meta[lastKey] = value;
  }
  return {meta, body: m[2], duplicates};
}

const SELF_SKILLS = new Set(['muser-exec']);

// One normalisation for every name a skill is known by: load() registers under it,
// read() must look up under it too, or a skill named 'Foo Bar' (registered 'foo-bar')
// could not be read by the name in its own frontmatter (audit c17 #2).
function normalizeName(name) {
  const raw = String(name || '').trim();
  // Accented letters fold to their base letter first (wave 17): lowercasing turns
  // 'İ' into 'i' + a combining dot, and NFD splits 'é' into 'e' + a combining
  // accent — stripping the combining marks (U+0300–U+036F) after that, and
  // mapping 'ß' to 'ss' (NFD leaves it alone), gives 'aeb' / 'cafe' / 'istanbul'
  // instead of replacing the whole letter with '-'. A name with no such letters
  // at all (翻訳) is unchanged by this and still falls through to the hash key
  // below, exactly as in wave 16 (3).
  const key = raw.toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9_.-]/g, '-');
  if (key && !/^-+$/.test(key)) return key;
  // A name with no ASCII name characters at all (翻訳, 要約) normalises to '' or
  // nothing but dashes, so every such name shared one key ('--') and all but
  // the first vanished as a false collision (Wave 16 (3)). Give those a
  // deterministic key hashed from the original name instead, so each keeps
  // its own key and the same name always maps to it. An empty name, and one
  // already written with nothing but dashes, keep their key exactly as before.
  if (!raw || raw.toLowerCase() === key) return key;
  let h = 0x811c9dc5; // FNV-1a over the original's code points
  for (const ch of raw) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return 'skill-' + h.toString(16).padStart(8, '0');
}

function skillFile(dir, onError) {
  try { const f = fs.readdirSync(dir).find(n => n.toLowerCase() === 'skill.md'); return f ? path.join(dir, f) : null; } catch (e) { onError?.(e); return null; }
}

// Skills load() skipped, and why: a name collision after normalisation, or a SKILL.md over
// the size limit. Both used to vanish silently — the skill just looked absent (audit #229,
// #230). Kept per load() like mentions' listDiag, so callers and tests can surface the reason.
// The same list also carries warnings about skills that DID load (reason 'duplicate-key' /
// 'missing-description', wave 10): those are notes, not skips — preambleLines tells the two
// apart by reason, and a warned-about skill stays in the loaded list.
let lastDiag = [];
function diagnostics() { return lastDiag; }

// SKILL.md files sitting in subfolders of a folder that has none of its own: load()
// only reads the folder itself, so these would vanish without a trace (wave 15 (5)).
function nestedSkillFiles(dir) {
  const found = [];
  (function walk(d, depth) {
    if (depth > 3 || found.length >= 20) return;
    let entries = [];
    try { entries = fs.readdirSync(d, {withFileTypes: true}); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.toLowerCase() === 'skill.md') found.push(p);
    }
  })(dir, 0);
  return found;
}

// Every skill found, first source winning per name; enabled reflects the user's settings.
function load(cwd) {
  const conf = settings(), seen = new Map(), claimed = new Set();
  lastDiag = [];
  for (const src of sources(cwd)) {
    const sourceOn = conf.sources[src.id] !== false;
    // A source ROOT that is itself a link (e.g. <proj>/.muser/skills junctioned
    // elsewhere) would let everything under it load from outside the folder it
    // claims to be, and the per-folder link check below never sees the root:
    // do not load through it at all (Wave 16 (2)). A root that simply does not
    // exist is not a link — lstat fails and the read below stays the absent case.
    let rootStat = null;
    try { rootStat = fs.lstatSync(src.dir); } catch {}
    if (rootStat && rootStat.isSymbolicLink()) { lastDiag.push({dir: src.dir, source: src.id, reason: 'linked-source'}); continue; }
    let dirs = [];
    try { dirs = fs.readdirSync(src.dir, {withFileTypes: true}).filter(e => e.isDirectory() || e.isSymbolicLink()); } catch (err) {
      // An absent source folder is normal (most tools' folders do not exist),
      // but a source that is there and cannot be read used to vanish silently:
      // record why it was skipped (Wave 16 (4)).
      if (err.code !== 'ENOENT') lastDiag.push({dir: src.dir, source: src.id, reason: 'read-error', code: err.code || ''});
      continue;
    }
    for (const e of dirs) {
      const dir = path.join(src.dir, e.name);
      // A skill FOLDER that is itself a link out of a repository-derived source would move
      // guardSkillFile's 'inside' to the link target, letting a cloned repo's skills point
      // anywhere on disk (audit c17 #5): refuse those; the user's own home sources are
      // their own choice and keep working as before.
      if (e.isSymbolicLink() && (src.id === 'project' || src.id === 'claude-project')) {
        let realDir = null, realRoot = null;
        realDir = realNative(dir); realRoot = realNative(src.dir);
        const rel = realDir && realRoot ? path.relative(realRoot, realDir) : '..';
        if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) { lastDiag.push({name: normalizeName(e.name), dir, source: src.id, reason: 'linked-folder'}); continue; }
      }
      const file = skillFile(dir, err => lastDiag.push({name: normalizeName(e.name), dir, source: src.id, reason: 'read-error', code: err.code || ''}));
      if (!file) {
        // 直下に SKILL.md が無いフォルダーでも、中のフォルダーに SKILL.md があれば
        // 入れ子として読み込まれていないことを診断で知らせる (wave 15 (5))。
        for (const nf of nestedSkillFiles(dir)) lastDiag.push({name: normalizeName(e.name), dir, file: nf, nestedDir: path.dirname(nf), source: src.id, reason: 'nested-skill', detail: '入れ子フォルダーの SKILL.md は読み込まれません'});
        continue;
      }
      let meta = {}, fmDuplicates = [], fmUnclosed = false;
      try {
        const size = fs.statSync(file).size;
        if (size > MAX_FILE) { lastDiag.push({name: normalizeName(e.name), dir, file, source: src.id, reason: 'too-large', size}); continue; }
        const fm = frontmatter(fs.readFileSync(file, 'utf8'));
        meta = fm.meta; fmDuplicates = fm.duplicates || []; fmUnclosed = fm.unclosed === true;
      } catch (err) {
        // A locked or unreadable SKILL.md (editor/antivirus on Windows) used to vanish with
        // no trace at all, unlike the diagnosed size/collision skips (audit c17 #3).
        lastDiag.push({name: normalizeName(e.name), dir, file, source: src.id, reason: 'read-error', code: err.code || ''});
        continue;
      }
      const rawName = String(meta.name || e.name);
      const name = normalizeName(rawName);
      if (!name) continue;
      // Name normalisation can merge two different skills ('Foo Bar' and 'foo-bar'): the
      // first still wins, but the dropped one is recorded instead of disappearing quietly.
      // Only a copy from a source that is ON claims the name (wave 15 (2)): a copy in a
      // source the user switched off used to sit in seen and keep a lower source's
      // same-named skill from ever appearing.
      if (claimed.has(name)) { lastDiag.push({name, dir, file, source: src.id, reason: 'name-collision', keptDir: seen.get(name).dir}); continue; }
      // muser's own skill for OTHER agents (skills/muser-exec: Claude Code / Codex hand work to Muse
      // through `muser exec`). Offered to Muse it would only send Muse's work back to Muse.
      if (SELF_SKILLS.has(name)) continue;
      if (!sourceOn && seen.has(name)) continue;
      const description = String(meta.description || '').replace(/\s+/g, ' ').trim();
      // Warnings about a skill that DOES load, recorded next to the skips above so
      // diagnostics() shows them too (wave 10): a repeated frontmatter key (the later
      // value won) and a skill with no description — the preamble and the menus list
      // skills by that description, so a missing one left the skill unexplained and
      // indistinguishable from a broken file.
      const warnings = [];
      for (const key of fmDuplicates) warnings.push({name, dir, file, source: src.id, reason: 'duplicate-key', key, detail: 'frontmatter key "' + key + '" is repeated; the later value wins'});
      if (fmUnclosed) warnings.push({name, dir, file, source: src.id, reason: 'unclosed-frontmatter', detail: 'frontmatter が読めていない（閉じる --- がありません）'});
      else if (!description) warnings.push({name, dir, file, source: src.id, reason: 'missing-description', key: 'description', detail: 'the skill has no description'});
      if (sourceOn) {
        // This copy replaces a switched-off source's placeholder for the same name:
        // the placeholder's warnings were about a copy that is no longer the skill.
        if (seen.has(name)) {
          const prevDir = seen.get(name).dir;
          for (let i = lastDiag.length - 1; i >= 0; i--) if (lastDiag[i].dir === prevDir && ['duplicate-key', 'missing-description', 'unclosed-frontmatter'].includes(lastDiag[i].reason)) lastDiag.splice(i, 1);
        }
        claimed.add(name);
      }
      lastDiag.push(...warnings);
      // originalName keeps the name as written (Wave 16 (3)): a skill whose key
      // was hashed from a non-ASCII name stays reachable by that name in read().
      seen.set(name, {name, originalName: rawName, description, dir, file, source: src.id, enabled: sourceOn && !conf.disabled.has(name)});
    }
  }
  return [...seen.values()];
}

// The preamble's list: enabled skills only, descriptions cut short.
function preambleLines(cwd) {
  const on = load(cwd).filter(s => s.enabled);
  // Skipped skills (audit c17 #1): diagnostics() existed but no production path ever
  // showed it, so a collided or oversized skill just looked absent. The preamble is
  // the one list every session sees — name the skips and why there.
  // Only the real skips are listed as skipped: the wave-10 warnings (duplicate-key /
  // missing-description) are about skills that DID load and are already in the list
  // above — naming them '(skipped)' here would be a lie. They stay in diagnostics().
  const skipped = lastDiag.filter(d => ['name-collision', 'too-large', 'read-error', 'linked-folder', 'linked-source', 'nested-skill'].includes(d.reason)).map(d => '- (skipped) ' + (d.name || d.dir || d.source) + ': ' + ({'name-collision': 'another skill with the same name was kept (' + (d.keptDir || '') + ')', 'too-large': 'SKILL.md is over the ' + MAX_FILE + '-byte limit', 'read-error': (d.name ? 'SKILL.md could not be read' : 'the skill source folder could not be read') + (d.code ? ' (' + d.code + ')' : ''), 'linked-folder': 'the skill folder is a link out of its source folder', 'linked-source': 'the skill source folder is a link; its skills were not loaded', 'nested-skill': '入れ子フォルダーの SKILL.md は読み込まれません'}[d.reason] || d.reason));
  if (!on.length && !skipped.length) return [];
  // Project skills come with the repository, not from the user: mark them so the
  // preamble does not present them as the user's own skills (audit wave5-F).
  const shown = on.slice(0, MAX_LISTED).map(s => '- ' + s.name + (s.source === 'project' || s.source === 'claude-project' ? ' (project)' : '') + ': ' + (s.description.length > DESC_CHARS ? s.description.slice(0, DESC_CHARS - 1) + '…' : s.description));
  // The skipped list is capped the same way as the loaded list above (wave 17):
  // appended in full it grew a line per skip with no limit and no count.
  const shownSkipped = skipped.slice(0, MAX_LISTED);
  return ['', 'Skills the user keeps on this PC (procedures and know-how). When one fits the task, read it with skill.read {name} before acting and follow it; skill.read {name, path} reads a file inside the skill:', ...shown,
    ...(on.length > shown.length ? ['- … and ' + (on.length - shown.length) + ' more (skill.read with a name still works)'] : []), ...shownSkipped,
    ...(skipped.length > shownSkipped.length ? ['- … and ' + (skipped.length - shownSkipped.length) + ' more skipped'] : [])];
}

// The guards every skill.read target passes, SKILL.md itself included: the real
// path stays inside the skill's real folder, the file is not a secret, and it
// is at most MAX_FILE. SKILL.md used to skip all of this — it was read raw, so
// a SKILL.md that was a link out of the folder (or into ~/.ssh), or simply a
// huge file, went straight to Muse.
function guardSkillFile(skill, target) {
  // tools is required lazily here, not at the top: tools requires skills back
  // (its skill.read tool), so a top-level require would be a cycle (Wave 16 (1)).
  const {realOf, isSensitivePath, hardlinkVerdict} = require('./tools');
  const real = realOf(target), realDir = realOf(skill.dir), realRel = path.relative(realDir, real);
  // Only a '..' SEGMENT escapes: a name that merely starts with the characters '..'
  // (a '..foo' folder inside the skill) is a legitimate inside path (audit #231).
  if (!realRel || realRel === '..' || realRel.startsWith('..' + path.sep) || path.isAbsolute(realRel)) throw new Error('path must be a file inside the skill folder');
  if (isSensitivePath(target) || isSensitivePath(real)) throw new Error('Refused to read a sensitive file: ' + path.relative(skill.dir, target));
  // A hard link has no escape for the realpath check above to catch: the name
  // inside the folder IS its real path, while another name for the same file can
  // be a secret anywhere on disk. Apply tools' hardlink check, the same rule as
  // the read tools (Wave 16 (1)): a 'sensitive' verdict refuses like the check
  // above, and an 'unknown' one (the other names could not all be listed)
  // refuses too rather than reading blind.
  const verdict = hardlinkVerdict(target);
  if (verdict === 'sensitive') throw new Error('Refused to read a sensitive file: ' + path.relative(skill.dir, target));
  if (verdict === 'unknown') throw new Error('Refused to read a file linked under another name (hard link) whose other names could not be verified: ' + path.relative(skill.dir, target));
  const st = fs.statSync(target);
  if (st.size > MAX_FILE) throw new Error('File too large to read here (' + st.size + ' bytes)');
}

// skill.read: the SKILL.md (with the list of files in the skill) or one file inside the skill.
function read(cwd, {name, path: rel} = {}) {
  const want = normalizeName(name);
  const skills = load(cwd);
  // Match the original name as written too (Wave 16 (3)): a non-ASCII name's
  // key is a hash of it, so the name in the frontmatter must still find it.
  const skill = skills.find(s => s.name === want || s.originalName === String(name || '').trim() || (s.originalName && normalizeName(s.originalName) === want));
  if (!skill) {
    // A SKILL.md over the size limit is skipped by load(): say so, instead of the
    // misleading "no skill named" the user got for a skill that is right there (#230).
    const big = lastDiag.find(d => d.reason === 'too-large' && d.name === want);
    if (big) throw new Error('The skill "' + name + '" was skipped: its SKILL.md is ' + big.size + ' bytes, over the ' + MAX_FILE + '-byte limit.');
    const unreadable = lastDiag.find(d => d.reason === 'read-error' && d.name === want);
    if (unreadable) throw new Error('The skill "' + name + '" could not be read' + (unreadable.code ? ' (' + unreadable.code + ')' : '') + ': its SKILL.md may be locked or unreadable.');
    throw new Error('No skill named "' + name + '". Skills: ' + skills.filter(s => s.enabled).map(s => s.name).join(', '));
  }
  if (!skill.enabled) throw new Error('The skill "' + skill.name + '" is turned off by the user.');
  if (rel) {
    const target = path.resolve(skill.dir, String(rel));
    const inside = path.relative(skill.dir, target);
    if (!inside || inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw new Error('path must be a file inside the skill folder');
    // skill.read runs unasked, and a project's .claude/skills comes with the repository: a link
    // inside a skill must not lead out of it, nor to a secret.
    guardSkillFile(skill, target);
    return {name: skill.name, path: inside.replace(/\\/g, '/'), content: fs.readFileSync(target, 'utf8')};
  }
  guardSkillFile(skill, skill.file);
  const files = [];
  (function walk(dir, depth) {
    // The cap is checked inside the loop as well as on entry (wave 17): on
    // entry alone a flat folder blew straight past it in a single walk() call.
    if (depth > 3 || files.length >= 200) return;
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      if (files.length >= 200) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1); else files.push(path.relative(skill.dir, p).replace(/\\/g, '/'));
    }
  })(skill.dir, 0);
  return {name: skill.name, source: skill.source, dir: skill.dir, content: fs.readFileSync(skill.file, 'utf8'), files};
}

// ---- $name skill calls in the composer (Codex style) ----
// A $ only counts at the start of the text or after whitespace, so a$b, $HOME-style
// variables glued to a word, and shell text keep their plain meaning. A skill name
// starts with a letter, so $5 is a price, never a skill.
const DOLLAR_FRAGMENT = /(^|\s)\$([A-Za-z][A-Za-z0-9_.-]*)?$/;
// The $fragment the caret is in, if any: {start, fragment}, start being the index
// just after the '$' (the fragment's first character), like mentions.fragmentAt.
function dollarFragmentAt(text, pos) {
  const m = DOLLAR_FRAGMENT.exec(String(text).slice(0, pos));
  if (!m) return null;
  const fragment = (m[2] || '').toLowerCase();
  return {start: pos - (m[2] || '').length, fragment};
}
// The enabled skills whose name starts with the fragment, in name order.
function dollarComplete(fragment, cwd) {
  const q = String(fragment || '').toLowerCase();
  return load(cwd).filter(s => s.enabled && s.name.startsWith(q)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
// What may end a $name token in a sent message: whitespace, the end of the text, or
// sentence punctuation. ':' is NOT an end ($env:PATH is one shell-style word), and
// neither are name characters, '/', '\\', '=' or '$' (the token just continues).
const DOLLAR_END = /[\s.,;!?"'()\[\]{}<>、。，．！？；』」）】〉》…]/;
// Every $name token in a message, resolved against the skills on this PC:
// {names: enabled skills, in order, no duplicates; disabled: disabled ones, same}.
// Unknown or misspelled names, $HOME, $env:PATH and $5 are not tokens at all here.
function dollarRefs(text, cwd) {
  const all = load(cwd), byName = new Map(all.map(s => [s.name, s]));
  const names = [], disabled = [], re = /(^|\s)\$([A-Za-z][A-Za-z0-9_.-]*)/g;
  let m;
  while ((m = re.exec(String(text)))) {
    let name = m[2].toLowerCase();
    // A trailing '.' is sentence punctuation more often than part of a name
    // ('$review. 次' / '$review.'): hand it back to the end check below.
    while (name.endsWith('.')) name = name.slice(0, -1);
    if (!name) continue;
    const end = m.index + m[1].length + 1 + name.length;
    const next = String(text)[end];
    if (next !== undefined && !DOLLAR_END.test(next)) continue;
    const s = byName.get(name);
    if (!s) continue;
    if (s.enabled) { if (!names.includes(name)) names.push(name); }
    else if (!disabled.includes(name)) disabled.push(name);
  }
  return {names, disabled};
}
// The sentence /skill puts in front of a request, one per $name skill.
function skillSentence(name) { return 'Use the skill "' + name + '" (read it with skill.read first).'; }

function setEnabled(name, on) { const n = normalizeName(name); saveSettings(s => { if (on) s.disabled.delete(n); else s.disabled.add(n); }); }
function setSourceEnabled(id, on) { saveSettings(s => { if (on) delete s.sources[id]; else s.sources[id] = false; }); }

module.exports = {load, read, preambleLines, frontmatter, normalizeName, setEnabled, setSourceEnabled, sources, diagnostics, dollarFragmentAt, dollarComplete, dollarRefs, skillSentence};
