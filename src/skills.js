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
function sources(cwd) {
  const home = os.homedir();
  return [
    {id: 'project', dir: path.join(cwd, '.muser', 'skills')},
    {id: 'muser', dir: path.join(home, '.muser', 'skills')},
    {id: 'claude-project', dir: path.join(cwd, '.claude', 'skills')},
    {id: 'claude', dir: path.join(home, '.claude', 'skills')},
    {id: 'codex', dir: path.join(home, '.codex', 'skills')},
    {id: 'agents', dir: path.join(home, '.agents', 'skills')},
  ];
}

function configFile() { return path.join(os.homedir(), '.muser', 'config.json'); }
function readConfig() { try { return require('./config').readJson(configFile()) || {}; } catch { return {}; } }
function settings() {
  const s = readConfig().skills || {};
  return {disabled: new Set(Array.isArray(s.disabled) ? s.disabled : []), sources: s.sources && typeof s.sources === 'object' ? s.sources : {}};
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
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return {meta: {}, body: text};
  const meta = {}, lines = m[1].split(/\r?\n/);
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
    // Block header, with an optional indentation indicator (|-2, >2- …) as real YAML allows.
    if (/^[>|](?:[+-]?\d?|\d[+-]?)$/.test(value)) {
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
  return {meta, body: m[2]};
}

const SELF_SKILLS = new Set(['muser-exec']);

// One normalisation for every name a skill is known by: load() registers under it,
// read() must look up under it too, or a skill named 'Foo Bar' (registered 'foo-bar')
// could not be read by the name in its own frontmatter (audit c17 #2).
function normalizeName(name) { return String(name || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '-'); }

function skillFile(dir, onError) {
  try { const f = fs.readdirSync(dir).find(n => n.toLowerCase() === 'skill.md'); return f ? path.join(dir, f) : null; } catch (e) { onError?.(e); return null; }
}

// Skills load() skipped, and why: a name collision after normalisation, or a SKILL.md over
// the size limit. Both used to vanish silently — the skill just looked absent (audit #229,
// #230). Kept per load() like mentions' listDiag, so callers and tests can surface the reason.
let lastDiag = [];
function diagnostics() { return lastDiag; }

// Every skill found, first source winning per name; enabled reflects the user's settings.
function load(cwd) {
  const conf = settings(), seen = new Map();
  lastDiag = [];
  for (const src of sources(cwd)) {
    let dirs = [];
    try { dirs = fs.readdirSync(src.dir, {withFileTypes: true}).filter(e => e.isDirectory() || e.isSymbolicLink()); } catch { continue; }
    for (const e of dirs) {
      const dir = path.join(src.dir, e.name);
      // A skill FOLDER that is itself a link out of a repository-derived source would move
      // guardSkillFile's 'inside' to the link target, letting a cloned repo's skills point
      // anywhere on disk (audit c17 #5): refuse those; the user's own home sources are
      // their own choice and keep working as before.
      if (e.isSymbolicLink() && (src.id === 'project' || src.id === 'claude-project')) {
        let realDir = null, realRoot = null;
        try { realDir = fs.realpathSync(dir); realRoot = fs.realpathSync(src.dir); } catch {}
        const rel = realDir && realRoot ? path.relative(realRoot, realDir) : '..';
        if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) { lastDiag.push({name: normalizeName(e.name), dir, source: src.id, reason: 'linked-folder'}); continue; }
      }
      const file = skillFile(dir, err => lastDiag.push({name: normalizeName(e.name), dir, source: src.id, reason: 'read-error', code: err.code || ''}));
      if (!file) continue;
      let meta = {};
      try {
        const size = fs.statSync(file).size;
        if (size > MAX_FILE) { lastDiag.push({name: normalizeName(e.name), dir, file, source: src.id, reason: 'too-large', size}); continue; }
        ({meta} = frontmatter(fs.readFileSync(file, 'utf8')));
      } catch (err) {
        // A locked or unreadable SKILL.md (editor/antivirus on Windows) used to vanish with
        // no trace at all, unlike the diagnosed size/collision skips (audit c17 #3).
        lastDiag.push({name: normalizeName(e.name), dir, file, source: src.id, reason: 'read-error', code: err.code || ''});
        continue;
      }
      const name = normalizeName(meta.name || e.name);
      if (!name) continue;
      // Name normalisation can merge two different skills ('Foo Bar' and 'foo-bar'): the
      // first still wins, but the dropped one is recorded instead of disappearing quietly.
      if (seen.has(name)) { lastDiag.push({name, dir, file, source: src.id, reason: 'name-collision', keptDir: seen.get(name).dir}); continue; }
      // muser's own skill for OTHER agents (skills/muser-exec: Claude Code / Codex hand work to Muse
      // through `muser exec`). Offered to Muse it would only send Muse's work back to Muse.
      if (SELF_SKILLS.has(name)) continue;
      const sourceOn = conf.sources[src.id] !== false;
      seen.set(name, {name, description: String(meta.description || '').replace(/\s+/g, ' ').trim(), dir, file, source: src.id, enabled: sourceOn && !conf.disabled.has(name)});
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
  const skipped = lastDiag.map(d => '- (skipped) ' + d.name + ': ' + ({'name-collision': 'another skill with the same name was kept (' + (d.keptDir || '') + ')', 'too-large': 'SKILL.md is over the ' + MAX_FILE + '-byte limit', 'read-error': 'SKILL.md could not be read' + (d.code ? ' (' + d.code + ')' : ''), 'linked-folder': 'the skill folder is a link out of its source folder'}[d.reason] || d.reason));
  if (!on.length && !skipped.length) return [];
  const shown = on.slice(0, MAX_LISTED).map(s => '- ' + s.name + ': ' + (s.description.length > DESC_CHARS ? s.description.slice(0, DESC_CHARS - 1) + '…' : s.description));
  return ['', 'Skills the user keeps on this PC (procedures and know-how). When one fits the task, read it with skill.read {name} before acting and follow it; skill.read {name, path} reads a file inside the skill:', ...shown,
    ...(on.length > shown.length ? ['- … and ' + (on.length - shown.length) + ' more (skill.read with a name still works)'] : []), ...skipped];
}

// The guards every skill.read target passes, SKILL.md itself included: the real
// path stays inside the skill's real folder, the file is not a secret, and it
// is at most MAX_FILE. SKILL.md used to skip all of this — it was read raw, so
// a SKILL.md that was a link out of the folder (or into ~/.ssh), or simply a
// huge file, went straight to Muse.
function guardSkillFile(skill, target) {
  const {realOf, isSensitivePath} = require('./tools');
  const real = realOf(target), realDir = realOf(skill.dir), realRel = path.relative(realDir, real);
  // Only a '..' SEGMENT escapes: a name that merely starts with the characters '..'
  // (a '..foo' folder inside the skill) is a legitimate inside path (audit #231).
  if (!realRel || realRel === '..' || realRel.startsWith('..' + path.sep) || path.isAbsolute(realRel)) throw new Error('path must be a file inside the skill folder');
  if (isSensitivePath(target) || isSensitivePath(real)) throw new Error('Refused to read a sensitive file: ' + path.relative(skill.dir, target));
  const st = fs.statSync(target);
  if (st.size > MAX_FILE) throw new Error('File too large to read here (' + st.size + ' bytes)');
}

// skill.read: the SKILL.md (with the list of files in the skill) or one file inside the skill.
function read(cwd, {name, path: rel} = {}) {
  const want = normalizeName(name);
  const skills = load(cwd);
  const skill = skills.find(s => s.name === want);
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
    if (depth > 3 || files.length > 200) return;
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
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

function setEnabled(name, on) { saveSettings(s => { if (on) s.disabled.delete(name); else s.disabled.add(name); }); }
function setSourceEnabled(id, on) { saveSettings(s => { if (on) delete s.sources[id]; else s.sources[id] = false; }); }

module.exports = {load, read, preambleLines, frontmatter, setEnabled, setSourceEnabled, sources, diagnostics, dollarFragmentAt, dollarComplete, dollarRefs, skillSentence};
