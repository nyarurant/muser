'use strict';
// `muser agent-skill`: put muser's skill for other agents (skills/muser-exec — Claude Code and Codex
// hand read-heavy work to Muse through `muser exec`) into their skill folders, show where it is,
// and take it out again. Installed as a link to this package's copy (a directory junction on
// Windows, no admin rights needed), so an update of muser updates the skill too; where a link
// cannot be made the folder is copied. Only what muser put there is ever replaced or removed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NAME = 'muser-exec';
function source() { return path.join(__dirname, '..', 'skills', NAME); }

// Every skill folder of the two agents on this PC:
// - Claude Code: ~/.claude/skills (CLAUDE_CONFIG_DIR when set)
// - Codex: ~/.codex/skills, $CODEX_HOME/skills, and the homes of a multi-account layout
//   (~/.codex-accounts/<name>, each a CODEX_HOME with its own skills)
function targets({env = process.env, home = os.homedir()} = {}) {
  const out = [];
  const add = (agent, dir) => { const d = path.resolve(dir); if (!out.some(t => t.dir.toLowerCase() === d.toLowerCase())) out.push({agent, dir: d}); };
  add('claude', path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills'));
  add('codex', path.join(home, '.codex', 'skills'));
  if (env.CODEX_HOME) add('codex', path.join(env.CODEX_HOME, 'skills'));
  const multi = path.join(home, '.codex-accounts');
  let names = [];
  try { names = fs.readdirSync(multi, {withFileTypes: true}).filter(e => e.isDirectory()).map(e => e.name).sort(); } catch {}
  for (const n of names) {
    const h = path.join(multi, n);
    if (['config.toml', 'auth.json', 'skills'].some(f => fs.existsSync(path.join(h, f)))) add('codex', path.join(h, 'skills'));
  }
  return out;
}
// Is the agent there at all? (its home folder exists) — a skill is not put where nothing reads it.
function agentHome(t) { return path.dirname(t.dir); }

function skillName(dir) {
  try {
    const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    const m = /^---[\s\S]*?\nname:\s*["']?([^\n"']+)/.exec(md);
    return m ? m[1].trim() : null;
  } catch { return null; }
}
function realpath(p) { try { return fs.realpathSync.native(p); } catch { return null; } }

// installed (link to this copy) / copy (a copied muser-exec) / foreign (something else by that name) / missing / no-agent
function state(t, src = source()) {
  const at = path.join(t.dir, NAME);
  let st = null;
  try { st = fs.lstatSync(at); } catch {}
  if (!st) return fs.existsSync(agentHome(t)) ? 'missing' : 'no-agent';
  const real = realpath(at), mine = realpath(src);
  if (real && mine && real.toLowerCase() === mine.toLowerCase()) return 'installed';
  if (st.isSymbolicLink() && !real) return 'broken'; // a link left by a muser that moved or was removed
  return skillName(at) === NAME ? 'copy' : 'foreign';
}

function status(opts = {}) { return targets(opts).map(t => ({...t, path: path.join(t.dir, NAME), state: state(t, opts.src)})); }

function link(src, at) {
  try { fs.symlinkSync(src, at, 'junction'); return 'link'; }
  catch { fs.cpSync(src, at, {recursive: true}); return 'copy'; }
}
function removeEntry(at) {
  const st = fs.lstatSync(at);
  // A link goes on its own; rmSync on it would follow into muser's copy on some platforms.
  if (st.isSymbolicLink()) { try { fs.unlinkSync(at); } catch { fs.rmdirSync(at); } }
  else fs.rmSync(at, {recursive: true, force: true});
}

// agents: ['claude', 'codex'] (both by default). Returns one row per folder with what was done.
function install({agents = ['claude', 'codex'], ...opts} = {}) {
  const src = opts.src || source();
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error('skill source missing: ' + src);
  return status({...opts, src}).filter(r => agents.includes(r.agent)).map(r => {
    if (r.state === 'installed') return {...r, done: 'kept'};
    if (r.state === 'foreign') return {...r, done: 'skipped'};
    if (r.state === 'no-agent') return {...r, done: 'skipped'};
    try {
      if (r.state === 'copy' || r.state === 'broken') removeEntry(r.path); // ours, older or dangling: replaced
      fs.mkdirSync(r.dir, {recursive: true});
      return {...r, done: link(src, r.path)};
    } catch (e) { return {...r, done: 'failed', error: e.message}; }
  });
}
function remove({agents = ['claude', 'codex'], ...opts} = {}) {
  return status(opts).filter(r => agents.includes(r.agent)).map(r => {
    if (!['installed', 'copy', 'broken'].includes(r.state)) return {...r, done: 'none'};
    try { removeEntry(r.path); return {...r, done: 'removed'}; }
    catch (e) { return {...r, done: 'failed', error: e.message}; }
  });
}

module.exports = {NAME, source, targets, status, install, remove};
