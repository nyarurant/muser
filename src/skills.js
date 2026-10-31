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
function readConfig() { try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')) || {}; } catch { return {}; } }
function settings() {
  const s = readConfig().skills || {};
  return {disabled: new Set(Array.isArray(s.disabled) ? s.disabled : []), sources: s.sources && typeof s.sources === 'object' ? s.sources : {}};
}
function saveSettings(mutate) {
  const cfg = readConfig(), s = settings();
  mutate(s);
  cfg.skills = {disabled: [...s.disabled].sort(), sources: s.sources};
  fs.mkdirSync(path.dirname(configFile()), {recursive: true});
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
}

// The frontmatter as the skills in the wild write it: key: value, quoted values, and folded or
// literal blocks (description: >- followed by indented lines).
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return {meta: {}, body: text};
  const meta = {}, lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim());
      value = value[0] === '>' ? block.filter(Boolean).join(' ') : block.join('\n').trim();
    } else if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1).replace(/\\"/g, '"');
    meta[kv[1].toLowerCase()] = value;
  }
  return {meta, body: m[2]};
}

function skillFile(dir) {
  try { const f = fs.readdirSync(dir).find(n => n.toLowerCase() === 'skill.md'); return f ? path.join(dir, f) : null; } catch { return null; }
}

// Every skill found, first source winning per name; enabled reflects the user's settings.
function load(cwd) {
  const conf = settings(), seen = new Map();
  for (const src of sources(cwd)) {
    let dirs = [];
    try { dirs = fs.readdirSync(src.dir, {withFileTypes: true}).filter(e => e.isDirectory() || e.isSymbolicLink()); } catch { continue; }
    for (const e of dirs) {
      const dir = path.join(src.dir, e.name), file = skillFile(dir);
      if (!file) continue;
      let meta = {};
      try { ({meta} = frontmatter(fs.readFileSync(file, 'utf8'))); } catch { continue; }
      const name = String(meta.name || e.name).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
      if (!name || seen.has(name)) continue;
      const sourceOn = conf.sources[src.id] !== false;
      seen.set(name, {name, description: String(meta.description || '').replace(/\s+/g, ' ').trim(), dir, file, source: src.id, enabled: sourceOn && !conf.disabled.has(name)});
    }
  }
  return [...seen.values()];
}

// The preamble's list: enabled skills only, descriptions cut short.
function preambleLines(cwd) {
  const on = load(cwd).filter(s => s.enabled);
  if (!on.length) return [];
  const shown = on.slice(0, MAX_LISTED).map(s => '- ' + s.name + ': ' + (s.description.length > DESC_CHARS ? s.description.slice(0, DESC_CHARS - 1) + '…' : s.description));
  return ['', 'Skills the user keeps on this PC (procedures and know-how). When one fits the task, read it with skill.read {name} before acting and follow it; skill.read {name, path} reads a file inside the skill:', ...shown,
    ...(on.length > shown.length ? ['- … and ' + (on.length - shown.length) + ' more (skill.read with a name still works)'] : [])];
}

// skill.read: the SKILL.md (with the list of files in the skill) or one file inside the skill.
function read(cwd, {name, path: rel} = {}) {
  const want = String(name || '').trim().toLowerCase();
  const skill = load(cwd).find(s => s.name === want);
  if (!skill) throw new Error('No skill named "' + name + '". Skills: ' + load(cwd).filter(s => s.enabled).map(s => s.name).join(', '));
  if (!skill.enabled) throw new Error('The skill "' + skill.name + '" is turned off by the user.');
  if (rel) {
    const target = path.resolve(skill.dir, String(rel));
    const inside = path.relative(skill.dir, target);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('path must be a file inside the skill folder');
    const st = fs.statSync(target);
    if (st.size > MAX_FILE) throw new Error('File too large to read here (' + st.size + ' bytes)');
    return {name: skill.name, path: inside.replace(/\\/g, '/'), content: fs.readFileSync(target, 'utf8')};
  }
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

function setEnabled(name, on) { saveSettings(s => { if (on) s.disabled.delete(name); else s.disabled.add(name); }); }
function setSourceEnabled(id, on) { saveSettings(s => { if (on) delete s.sources[id]; else s.sources[id] = false; }); }

module.exports = {load, read, preambleLines, frontmatter, setEnabled, setSourceEnabled, sources};
