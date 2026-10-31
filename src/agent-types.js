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

const READ_TOOLS = ['code.read', 'code.grep', 'code.glob', 'system.run', 'todo.write', 'mcp.*'];
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
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m && text.startsWith('---') && !text.split('\n').slice(1).some(line => line.trim() === '---'))
    throw new Error('frontmatter が閉じていません（終わりの --- がありません）');
  const meta = {};
  if (m) for (const line of m[1].split('\n')) { const kv = /^(\w+)\s*:\s*(.*)$/.exec(line.trim()); if (kv) meta[kv[1].toLowerCase()] = kv[2].trim(); }
  const name = String(meta.name || path.basename(file, '.md')).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const tools = meta.tools ? meta.tools.split(',').map(s => s.trim()).filter(Boolean) : null;
  return {name, def: {description: meta.description || name, readOnly: /^(true|yes|1)$/i.test(meta.readonly || ''), tools, prompt: (m ? m[2] : text).trim(), file}};
}

function load(cwd) {
  const types = Object.fromEntries(Object.entries(BUILTIN).map(([k, v]) => [k, {...v, builtin: true}]));
  for (const dir of [path.join(os.homedir(), '.muser', 'agents'), path.join(cwd, '.muser', 'agents')]) {
    let files = []; try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch {}
    for (const f of files) {
      const file = path.join(dir, f);
      let parsed;
      try { parsed = parse(file); } catch (e) {
        console.error(`muser: エージェント定義を読み込めませんでした: ${file}: ${String(e?.message || e).replace(/\s*\n\s*/g, ' ')}`);
        continue;
      }
      const {name, def} = parsed;
      if (!name) continue;
      if (Object.prototype.hasOwnProperty.call(BUILTIN, name))
        console.error(`muser: 組み込みエージェント ${name} は ${file} で上書きされます`);
      types[name] = def;
    }
  }
  return types;
}

function allows(type, command) {
  if (!type?.tools) return true;
  return type.tools.some(t => t === command || (t.endsWith('*') && command.startsWith(t.slice(0, -1))));
}

module.exports = {load, allows, BUILTIN};
