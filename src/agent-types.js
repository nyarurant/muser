'use strict';
// Kinds of parallel agent, like Claude Code's subagent types: a role prompt, an optional tool
// allowlist and a read-only flag, both enforced by muser (not just asked of the model).
// Custom types: ~/.muser/agents/*.md and <project>/.muser/agents/*.md, Claude Code style:
//   ---
//   name: docs
//   description: Writes and fixes documentation
//   tools: code.read, code.grep, code.edit      (optional; default all; mcp.* allowed as a pattern)
//   readonly: false                              (optional)
//   ---
//   <role prompt>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {t} = require('./i18n');

const READ_TOOLS = ['code.read', 'code.grep', 'code.glob', 'skill.read', 'system.run', 'todo.write', 'progress.report', 'spinner.set', 'mcp.*'];
const BUILTIN = {
  general: {description: '何でもやる（既定）', readOnly: false, tools: null,
    prompt: 'You are a general-purpose agent. Complete the task end to end.'},
  explore: {description: 'コードを調べるだけ（読み取り専用）', readOnly: true, tools: READ_TOOLS,
    prompt: 'You are an explorer. Search and read to answer the question; never modify anything. Report findings with file paths and line numbers, as briefly as the answer allows.'},
  plan: {description: '調べて実装計画を立てる（読み取り専用）', readOnly: true, tools: READ_TOOLS,
    prompt: 'You are a planner. Investigate the code, then reply with a step-by-step implementation plan: files to change, what changes, risks, and how to verify. Do not modify anything.'},
  review: {description: '変更をレビューする（読み取り専用）', readOnly: true, tools: READ_TOOLS,
    prompt: 'You are a code reviewer. Read the change (git diff / git log via system.run, and the files) and report real problems ranked by severity with file:line and a concrete fix. Skip style nits. Do not modify anything.'},
  test: {description: 'テストを流して、落ちたら直す', readOnly: false, tools: null,
    prompt: 'You run and fix tests. Find how this project runs its tests, run them, investigate each failure, make the smallest correct fix, and re-run until they pass. Report what failed, what you changed, and the final result.'},
};

function parse(file) {
  // A BOM hid the frontmatter: "readonly: true" was lost and the whole file became the prompt.
  let text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m && text.startsWith('---') && !text.split('\n').slice(1).some(line => line.trim() === '---'))
    throw new Error(t('frontmatter が閉じていません（終わりの --- がありません）'));
  const meta = {};
  if (m) for (const line of m[1].split('\n')) { const kv = /^(\w+)\s*:\s*(.*)$/.exec(line.trim()); if (kv) meta[kv[1].toLowerCase()] = kv[2].trim(); }
  const name = String(meta.name || path.basename(file, '.md')).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const tools = meta.tools ? meta.tools.split(',').map(s => s.trim()).filter(Boolean) : null;
  return {name, def: {description: meta.description || name, readOnly: /^(true|yes|1)$/i.test(meta.readonly || ''), tools, prompt: (m ? m[2] : text).trim(), file}};
}

// Does the allowed pattern `a` cover the requested tool/pattern `x`? Exact match, or `a`
// is a wildcard whose prefix covers `x` — where `x` may itself be a wildcard, in which case
// its prefix must start with `a`'s prefix (so 'mcp.*' covers 'mcp.foo.*' and 'mcp.foo',
// but 'mcp.foo.*' does not cover the broader 'mcp.*').
function patternCovers(a, x) {
  if (a === x) return true;
  if (typeof a !== 'string' || typeof x !== 'string' || !a.endsWith('*')) return false;
  const prefix = a.slice(0, -1);
  return (x.endsWith('*') ? x.slice(0, -1) : x).startsWith(prefix) || x.startsWith(prefix);
}

// Each warning once per process: types are loaded again for every agent and /agent, and the same
// notice piled up on the screen each time.
const warned = new Set();
function warnOnce(key, text) { if (warned.has(key)) return; warned.add(key); console.error(text); }
function load(cwd) {
  const types = Object.fromEntries(Object.entries(BUILTIN).map(([k, v]) => [k, {...v, builtin: true}]));
  const userDir = path.join(os.homedir(), '.muser', 'agents'), projectDir = path.join(cwd, '.muser', 'agents');
  for (const dir of [userDir, projectDir]) {
    let files = []; try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch {}
    // A project's types come with the repository: one may replace a type's prompt, but a type that
    // was read-only stays read-only, with no tools beyond the ones it had (a repo's review.md turned
    // the read-only built-in reviewer into one that writes).
    const fromProject = path.resolve(dir) === path.resolve(projectDir) && path.resolve(dir) !== path.resolve(userDir);
    for (const f of files) {
      const file = path.join(dir, f);
      let parsed;
      try { parsed = parse(file); } catch (e) {
        warnOnce('bad:' + file, t('muser: エージェント定義を読み込めませんでした: {file}: {reason}', {file, reason: String(e?.message || e).replace(/\s*\n\s*/g, ' ')}));
        continue;
      }
      const {name, def} = parsed;
      // A name that sanitises to nothing (a Japanese file name and no frontmatter name, say)
      // was skipped in silence: the agent simply never appeared, with no clue why. Parse errors
      // and builtin shadowing already warn once; this does too.
      if (!name) { warnOnce('noname:' + file, t('muser: エージェント定義をスキップしました（名前が決められません）: {file}', {file})); continue; }
      const before = types[name];
      if (fromProject && before?.readOnly) {
        def.readOnly = true;
        const allowed = before.tools;
        // Narrowing is pattern-aware: an allowed entry may be a wildcard (READ_TOOLS has
        // 'mcp.*'), and allowed.includes(x) dropped everything it covered except the literal
        // pattern itself — a project type asking for 'mcp.fixture.echo' (covered by 'mcp.*')
        // lost it, while one asking for a broader pattern than allowed must still be dropped.
        def.tools = !def.tools ? allowed : allowed ? def.tools.filter(x => allowed.some(a => patternCovers(a, x))) : def.tools;
      }
      if (Object.prototype.hasOwnProperty.call(BUILTIN, name))
        warnOnce('shadow:' + file, t('muser: 組み込みエージェント {name} は {file} で上書きされます', {name, file}));
      types[name] = def;
    }
  }
  return types;
}

function allows(type, command) {
  if (!type?.tools) return true;
  return type.tools.some(t => t === command || (t.endsWith('*') && command.startsWith(t.slice(0, -1))));
}

module.exports = {load, allows, BUILTIN, patternCovers};
