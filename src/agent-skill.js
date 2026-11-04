'use strict';
// `muser agent-skill`: put muser's skill for other agents (skills/muser-exec — Claude Code and Codex
// hand read-heavy work to Muse through `muser exec`) into their skill folders, show where it is,
// and take it out again. Installed as a link to this package's copy (a directory junction on
// Windows, no admin rights needed), so an update of muser updates the skill too; where a link
// cannot be made the folder is copied. Only what muser put there is ever replaced or removed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const NAME = 'muser-exec';
function source() { return path.join(__dirname, '..', 'skills', NAME); }

// Every skill folder of the two agents on this PC:
// - Claude Code: ~/.claude/skills (CLAUDE_CONFIG_DIR when set)
// - Codex: ~/.codex/skills, $CODEX_HOME/skills, and the homes of a multi-account layout
//   (~/.codex-accounts/<name>, each a CODEX_HOME with its own skills)
// The same physical folder under two spellings (a junction alias in CODEX_HOME
// or CLAUDE_CONFIG_DIR, a case difference) is ONE target (c15 #16): dedupe on
// the canonical path — realpath of the nearest existing ancestor — not just on
// the resolved string. The old string-only dedupe processed the folder twice
// and the second pass cpSync-copied muser's own junction onto itself.
function canonical(p) {
  let d = path.resolve(p); const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(d), ...rest); } catch {}
    const parent = path.dirname(d);
    if (parent === d) return path.resolve(p);
    rest.unshift(path.basename(d)); d = parent;
  }
}
function targets({env = process.env, home = os.homedir()} = {}) {
  const out = [];
  const seen = new Set();
  const add = (agent, dir) => { const d = path.resolve(dir); const c = canonical(d).toLowerCase(); if (seen.has(d.toLowerCase()) || seen.has(c)) return; seen.add(d.toLowerCase()); seen.add(c); out.push({agent, dir: d}); };
  add('claude', path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills'));
  add('codex', path.join(home, '.codex', 'skills'));
  if (env.CODEX_HOME) add('codex', path.join(env.CODEX_HOME, 'skills'));
  const multi = path.join(home, '.codex-accounts');
  let names = [];
  // c15 #15: an account home reached through a junction/symlink has
  // Dirent.isDirectory() === false and silently dropped out of the list, so
  // status/install/remove pretended the account did not exist. Follow links.
  const isDirEntry = e => { if (e.isDirectory()) return true; if (!e.isSymbolicLink()) return false; try { return fs.statSync(path.join(multi, e.name)).isDirectory(); } catch { return false; } };
  try { names = fs.readdirSync(multi, {withFileTypes: true}).filter(isDirEntry).map(e => e.name).sort(); } catch {}
  for (const n of names) {
    const h = path.join(multi, n);
    if (['config.toml', 'auth.json', 'skills'].some(f => fs.existsSync(path.join(h, f)))) add('codex', path.join(h, 'skills'));
  }
  return out;
}
// Is the agent there at all? (its home folder exists) — a skill is not put where nothing reads it.
function agentHome(t) { return path.dirname(t.dir); }

function readSkillMd(dir) {
  try { return fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}
function skillName(dir) {
  const md = readSkillMd(dir);
  if (md == null) return null;
  // c15 #14: a BOM (an editor / PowerShell 5.1 re-save) used to break the ^---
  // anchor, and a trailing comment became part of the captured name — both made
  // a genuine copy read as 'foreign' and stranded it forever. The BOM is
  // stripped above; the name is its first token.
  const m = /^---[\s\S]*?\nname:\s*["']?([^\n"']+)/.exec(md);
  return m ? m[1].trim().split(/[\s#]/)[0].replace(/["']$/, '') || null : null;
}
// "Ours" needs more than the name (c15 #12): a user's own or a third party's
// skill is naturally also called muser-exec in its frontmatter, and the old
// name-only check let install replace it and remove delete it wholesale. A
// folder counts as a muser copy only when the name matches AND it carries the
// distribution's body marker (its distinctive heading / opening line) — or,
// for a minimal older copy, when the folder holds nothing but SKILL.md, the
// distribution's only file. A same-named skill with its own extra files or
// scripts is 'foreign': the safe direction is to leave it alone.
const OURS_MARK = /# Delegate to Muse with `muser exec`|`muser exec` sends one task/;
function isOurCopy(dir) {
  if (skillName(dir) !== NAME) return false;
  const md = readSkillMd(dir);
  if (md != null && OURS_MARK.test(md)) return true;
  try { return fs.readdirSync(dir).every(e => e === 'SKILL.md'); } catch { return false; }
}
// A dangling link is ours only when it POINTS at a muser-exec folder (c15 #12):
// the old code treated every broken link at that path as muser's and deleted
// links it could not inspect at all.
function brokenLinkIsOurs(at) {
  try { const target = fs.readlinkSync(at); const resolved = path.resolve(path.dirname(at), target); return path.basename(resolved) === NAME; } catch { return false; }
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
  if (st.isSymbolicLink() && !real) return brokenLinkIsOurs(at) ? 'broken' : 'foreign'; // a link left by a muser that moved or was removed — when it points at a muser-exec
  // A leftover EMPTY folder is the remnant of an interrupted copy (c15 #13):
  // there is no skill in it to protect, and calling it 'foreign' stranded it —
  // install skipped and remove ignored it forever.
  if (st.isDirectory()) { try { if (fs.readdirSync(at).length === 0) return 'broken'; } catch {} }
  return isOurCopy(at) ? 'copy' : 'foreign';
}

function status(opts = {}) { return targets(opts).map(t => ({...t, path: path.join(t.dir, NAME), state: state(t, opts.src)})); }

function link(src, at) {
  try { fs.symlinkSync(src, at, 'junction'); return 'link'; }
  catch (e) {
    // c15 #13: the cpSync fallback merged INTO whatever folder already sat at
    // the destination (rewriting someone else's skill and making it look like
    // a muser copy), and a copy that died halfway left a partial folder that
    // state() then called 'foreign' — stuck forever. Copy to a temp sibling
    // and rename it into place instead: the destination appears whole or not
    // at all, and a folder that appeared in the meantime is never merged into.
    if (fs.existsSync(at)) throw e;
    const tmp = at + '.muser-tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
    try { fs.cpSync(src, tmp, {recursive: true}); fs.renameSync(tmp, at); }
    catch (e2) { try { fs.rmSync(tmp, {recursive: true, force: true}); } catch {} throw e2; }
    return 'copy';
  }
}
function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { const end = Date.now() + ms; while (Date.now() < end) {} } }
// install/remove used to run check-then-delete-then-link with no lock at all
// (c15 #13): two muser processes (or an agent) working the same folder raced.
// A small lock file per skills folder serializes them; a lock older than 30 s
// is a crashed holder's. Callers re-check state() INSIDE the lock.
function withSkillLock(dir, fn) {
  fs.mkdirSync(dir, {recursive: true});
  const lock = path.join(dir, '.muser-agent-skill.lock');
  const token = process.pid + ':' + crypto.randomBytes(8).toString('hex');
  const until = Date.now() + 3000;
  for (;;) {
    try { const fd = fs.openSync(lock, 'wx'); try { fs.writeSync(fd, token); } finally { fs.closeSync(fd); } break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try { stale = Date.now() - fs.statSync(lock).mtimeMs > 30000; } catch { stale = true; }
      if (stale) { try { fs.unlinkSync(lock); } catch {} continue; }
      if (Date.now() > until) throw new Error('agent-skill folder is busy (locked): ' + dir);
      sleepSync(25);
    }
  }
  try { return fn(); } finally { try { if (fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock); } catch {} }
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
      return withSkillLock(r.dir, () => {
        // Re-check under the lock (c15 #13/#16): the snapshot above may be
        // stale — another install may have finished, or a foreign folder may
        // have appeared — and acting on it is what mixed copies into other
        // skills and double-processed aliased folders.
        const cur = state({agent: r.agent, dir: r.dir}, src);
        if (cur === 'installed') return {...r, state: cur, done: 'kept'};
        if (cur === 'foreign' || cur === 'no-agent') return {...r, state: cur, done: 'skipped'};
        if (cur === 'copy' || cur === 'broken') removeEntry(r.path); // ours, older or dangling: replaced
        return {...r, state: cur, done: link(src, r.path)};
      });
    } catch (e) { return {...r, done: 'failed', error: e.message}; }
  });
}
function remove({agents = ['claude', 'codex'], ...opts} = {}) {
  return status(opts).filter(r => agents.includes(r.agent)).map(r => {
    if (!['installed', 'copy', 'broken'].includes(r.state)) return {...r, done: 'none'};
    try {
      return withSkillLock(r.dir, () => {
        const cur = state({agent: r.agent, dir: r.dir}, opts.src); // re-check under the lock, as in install
        if (!['installed', 'copy', 'broken'].includes(cur)) return {...r, state: cur, done: 'none'};
        removeEntry(r.path); return {...r, state: cur, done: 'removed'};
      });
    }
    catch (e) { return {...r, done: 'failed', error: e.message}; }
  });
}

module.exports = {NAME, source, targets, status, install, remove};
