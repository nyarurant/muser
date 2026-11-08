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

const MAX_FILE = 256 * 1024;

// A frontmatter scalar as skills.js's parser reads it (Wave 16): values were stored raw
// here, so readonly: "true" failed the boolean test below (a read-only type silently
// became writable) and tools: "code.read", "code.grep" produced entries still wearing
// their quotes, which never match a real tool name. A value wrapped in matching quotes
// loses them: double quotes decode \-escapes the way skills.js does (\n, \t, \r, \",
// \\, \0; any other escaped character keeps just the character), single quotes double
// a quote to escape it ('' -> '). A comment after the closing quote is not part of the
// value. Anything else is returned exactly as written.
function unquote(value) {
  let v = value;
  if (v[0] === '"' || v[0] === "'") {
    const q = v[0];
    for (let j = 1; j < v.length; j++) {
      if (q === '"' && v[j] === '\\') { j++; continue; }
      if (v[j] === q) {
        if (q === "'" && v[j + 1] === "'") { j++; continue; }
        const rest = v.slice(j + 1).trim();
        if (rest === '' || rest.startsWith('#')) v = v.slice(0, j + 1);
        break;
      }
    }
  }
  if (/^"[\s\S]*"$/.test(v)) return v.slice(1, -1).replace(/\\(.)/g, (_, c) => ({n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '0': '\0'})[c] ?? c);
  if (/^'[\s\S]*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

// Whether a value is ONE quoted scalar: its closing quote (found with unquote's
// escape rules) is its last character. '"code.read", "code.grep"' closes early, so
// it is a list of two scalars, not one — the tools handling in parse() needs the
// difference, or unquoting it whole would leave the inner quotes in place.
function isQuotedScalar(v) {
  if (v[0] !== '"' && v[0] !== "'") return false;
  const q = v[0];
  for (let j = 1; j < v.length; j++) {
    if (q === '"' && v[j] === '\\') { j++; continue; }
    if (v[j] === q) {
      if (q === "'" && v[j + 1] === "'") { j++; continue; }
      return j === v.length - 1;
    }
  }
  return false;
}

function parse(file) {
  // No size cap (Wave 16): the whole file was read and parsed on every load() — every
  // spawn and /agent list — however large it grew. skills.js caps SKILL.md at the same
  // 256 KB; refuse a file over it instead of reading it whole (load() surfaces this
  // error as its per-file diagnostic, which names the file again).
  const size = fs.statSync(file).size;
  if (size > MAX_FILE) throw new Error(t('ファイルが大きすぎるため読み取りを拒否しました: {file}（{size} バイト; 上限は 256KB / {max} バイトです）', {file, size, max: MAX_FILE}));
  // A BOM hid the frontmatter: "readonly: true" was lost and the whole file became the prompt.
  let text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // Trailing spaces/tabs on a delimiter line still delimit (Wave 16), mirroring
  // skills.js: a first line '--- ' used to match nothing here, so ALL frontmatter was
  // lost and the whole file became the prompt. '----' / '---x' are still not
  // delimiters, and an opening delimiter with no closing one still throws, as before.
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?([\s\S]*)$/.exec(text);
  if (!m && /^---[ \t]*(\n|$)/.test(text) && !text.split('\n').slice(1).some(line => line.trim() === '---'))
    throw new Error(t('frontmatter が閉じていません（終わりの --- がありません）'));
  const meta = {};
  if (m) for (const line of m[1].split('\n')) { const kv = /^(\w+)\s*:\s*(.*)$/.exec(line.trim()); if (kv) meta[kv[1].toLowerCase()] = kv[2].trim(); }
  // Fold accents to their base letter before the deletion below (Wave 17): deleting
  // every non-[a-z0-9_-] character dropped the accented letters themselves, so 'café'
  // and 'cafè' both became 'caf' and 'straße' became 'strae' (never 'strasse'). NFD
  // splits a letter from its combining marks, the marks go, and ß maps to ss first.
  const name = String(unquote(meta.name || path.basename(file).replace(/\.md$/i, ''))).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9_-]/g, '');
  // Unquote before the list interpretation (Wave 16): the whole tools value may be
  // one quoted scalar ('"code.read, code.grep"'), and each comma-separated entry may
  // be quoted itself ('"code.read", "code.grep"') — the first shape is unquoted here
  // (isQuotedScalar keeps the second from being unquoted whole), the second per entry.
  let toolsRaw = meta.tools || '';
  if (toolsRaw && isQuotedScalar(toolsRaw)) toolsRaw = unquote(toolsRaw);
  const tools = toolsRaw ? toolsRaw.split(',').map(s => unquote(s.trim())).filter(Boolean) : null;
  return {name, def: {description: meta.description ? unquote(meta.description) : name, readOnly: /^(true|yes|1)$/i.test(unquote(meta.readonly || '')), tools, prompt: (m ? m[2] : text).trim(), file}};
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
  const userNames = new Set();
  for (const dir of [userDir, projectDir]) {
    // Case-insensitive: NTFS does not distinguish Review.MD from review.md, and a
    // definition saved with an upper-case extension was silently never loaded (c11 #8).
    let files = []; try { files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.md')); } catch {}
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
      // Replacing just the prompt must not widen the type: when an override of an existing
      // type (builtin or user-defined, from either directory) says nothing about tools, it
      // inherits the tools the type already had instead of falling back to null (= all tools).
      // A brand-new type has no `before`, so it keeps the traditional default.
      if (before && !def.tools) def.tools = before.tools;
      if (Object.prototype.hasOwnProperty.call(BUILTIN, name))
        warnOnce('shadow:' + file, t('muser: 組み込みエージェント {name} は {file} で上書きされます', {name, file}));
      // A project file replacing the USER's own type was silent, unlike the builtin
      // case above (c11 #7): the repo's prompt/tools silently took over a type the
      // user believed was theirs. Warn the same way; the replacement still happens.
      else if (fromProject && userNames.has(name))
        warnOnce('shadow-user:' + file, t('muser: ユーザーのエージェント {name} は {file} で上書きされます', {name, file}));
      types[name] = def;
      if (!fromProject && path.resolve(dir) === path.resolve(userDir)) userNames.add(name);
    }
  }
  return types;
}

function allows(type, command) {
  if (!type?.tools) return true;
  return type.tools.some(t => t === command || (t.endsWith('*') && command.startsWith(t.slice(0, -1))));
}

module.exports = {load, allows, BUILTIN, patternCovers};
