'use strict';
// One logical task, one Muse session. Evidence is captured by the executor, never invented
// by the model. The model still interprets whether an observation meets a requirement.
const crypto = require('node:crypto');
const {readOnlyCommand} = require('./policy');
const {t} = require('./i18n');

const INSTRUCTION = 'AUTOMATIC FOCUS: For code changes or tasks requiring multiple actions, call focus.plan (agent="main") before doing the work. Supply a JSON array of completion criteria with text and kind="inspection", "command", or "manual". For command criteria supply the exact verification command. Preserve every requirement in the original request; do not change scope. Ordinary questions and single simple reads need no plan. Completion tracking stays in this main session; no separate reviewer is needed. Collect any work agents before claiming completion. Successful reads, searches and command runs return muser_evidence_id: use those IDs in focus.checkpoint to report EVERY criterion as met, unmet, unknown, or blocked, with a short reason. Command criteria need an actual successful execution of the declared command (a run that went to the background counts once shell.output shows it finished with exit code 0); inspections need relevant successful tool evidence. A server, watcher or anything else that keeps running never exits, so its start command can never be a command criterion: start it with system.run background=true and make the criterion a check that ends, such as curl.exe -sf http://localhost:<port>/<path> against it (or an inspection of its shell.output), then stop what you started (stopping a background run you started keeps your evidence current). Remove any temporary files before your final verification and checkpoint: a later shell command makes earlier evidence out of date. Do not write helper scripts into the user\'s project only to get an exit code. Builds or tests alone do not prove a visible behavior changed. Use manual for user-only/real-device checks you cannot observe; report unknown and explain what is needed. A manual or unknown criterion never keeps the task going: once nothing else is unmet, the turn ends and waits for the user. So keep work that remains in a criterion of its own: when the user asks you to keep going (until they say OK or stop, until everything is fixed, keep finding more), append that as an inspection criterion with focus.plan (append=true) and report it unmet while there is more to do.Never mark a manual criterion met yourself; only after the user confirms it in their own message may you report it met, quoting what they said. Before your final response call focus.checkpoint, report what was verified and what remains unknown, and do not claim success for unmet criteria. Your reply itself is for the user: never mention Focus or its machinery there (criterion IDs such as c1, the words met/unmet/unknown/blocked, checkpoint, evidence IDs, legs or rounds); say in plain words what you checked, what you could not check and why. muser shows the Focus state to the user on its own. Continue clear unfinished work: the turn ends only when the task is complete — a leg that stops at its round or time limit, or with no verified progress, is continued automatically in a new leg with the same criteria, so never wrap up or summarise as if the work were finished while criteria remain unmet; stop and explain only when blocked or unable to verify after trying the other reasonable ways (a criterion one way cannot meet may be met another safe way). When you need the user\'s answer or decision, call focus.ask_user with the question instead of guessing, but not to pick between safe ways you can take yourself: take the one that reaches the goal; muser then waits for them. When the possible answers are a known set, pass options (or questions for several related choices at once) to focus.ask_user so the user can pick from a menu instead of typing. Do not write a criterion with an escape hatch such as "implement it, or defer it with a reason in the ledger": a criterion that can be met by writing a note instead of doing the work is not a completion criterion. Report deferred items as unmet or blocked and list them for the user, never as met. A criterion about a count (all N items) is verified with a counting command, not by reading the ledger. A read of a file this task itself wrote (its own notes or ledger) cannot by itself prove an implementation or behaviour criterion: prove those with the code, a test, or a command result, unless the criterion itself is about that file. One piece of evidence cannot by itself mark three or more inspection criteria met: give each criterion its own evidence.';

const DEFINITIONS = {
  'focus.plan': {description: 'Record the completion criteria for the current task, without changing the user goal. Define once before work; existing criteria cannot be removed or changed, but new ones may be appended when the user clarifies the task.',
    required: {criteria: {type: 'string', description: 'JSON array: [{"text":"requirement","kind":"inspection|command|manual","command":"exact verification command, for command criteria","cwd":"working directory that command must run in (optional)","shell":"shell that command must run in (optional)"}]. A run in a different directory or shell does not verify a command criterion. IDs c1, c2... are returned.'}}, optional: {new_task: {type: 'boolean', description: 'Only when the user\'s message after an unfinished task starts a DIFFERENT task: true replaces that task with this one. Never use it to drop or weaken criteria of the same task.'}, append: {type: 'boolean', description: 'true adds the given criteria after the existing ones, which stay as they are (do not repeat them). Use it when the user adds a requirement to the same task.'}}},
  'focus.checkpoint': {description: 'Attach actual observations to every completion criterion before ending a focused task. This does not end the turn. Manual/unobservable checks must be unknown or blocked.',
    required: {checks: {type: 'string', description: 'JSON array, one entry per criterion: [{"id":"c1","status":"met|unmet|unknown|blocked","evidence":["e1"],"reason":"what was observed or what is needed"}]. Use focus.status to retrieve evidence IDs.'}}, optional: {}},
  'focus.ask_user': {description: 'You need the user\'s answer or decision before going on (a choice that changes what they asked for, a missing value, permission for something risky): record the question here and end the turn. Not for choosing between safe ways you can take yourself, or for asking whether to go on: take the way that reaches the goal. muser then waits for the user instead of continuing automatically; their reply resumes this task. When the answers are a known set, pass options (or questions, for up to 4 related questions at once): muser shows a selectable question UI (single or multi select, descriptions, previews) and the picks come back as the user\'s reply. Without options it is a plain question: ask it in your reply text.',
    required: {question: {type: 'string', description: 'The question, as you will ask it.'}}, optional: {options: {type: 'string', description: 'JSON array of 2-6 choices for this question: [{\"label\":\"...\",\"description\":\"optional one-liner\",\"preview\":\"optional multi-line text shown beside the choice\"}].'}, multi: {type: 'boolean', description: 'With options: true lets the user pick several.'}, questions: {type: 'string', description: 'JSON array of up to 4 questions at once: [{\"header\":\"short tab label\",\"question\":\"...\",\"multi\":false,\"options\":[{\"label\":\"...\"}]}]. Overrides question/options.'}}},
  'focus.status': {description: 'Read the original goal, completion criteria and recent evidence of the current task.', required: {}, optional: {}},
};

// The bidi / invisible controls go too (U+061C, U+200B, U+200E-200F,
// U+202A-202E, U+2066-2069, U+FEFF): the same set src/focus-log.js
// sanitizeText strips, so a reason or question text cleaned here cannot
// visually reorder or hide the text around it when it is printed back.
const clean = value => String(value || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim();
function array(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 100) throw new Error('Expected a non-empty JSON array (at most 100 entries).');
  return parsed;
}
// Selectable questions for focus.ask_user, normalised once here so the UI, the serve
// state and the transcript only ever see this one shape. Accepts real arrays (the
// device protocol is JSON) or JSON strings, like plan/checkpoint do.
function normalizeAsk(fallbackQuestion, opts) {
  const list = value => { const v = typeof value === 'string' ? JSON.parse(value) : value; return Array.isArray(v) ? v : null; };
  let questions = list(opts?.questions);
  if (!questions) {
    const options = list(opts?.options);
    if (!options) return null;
    questions = [{question: fallbackQuestion, options, multi: opts?.multi === true || opts?.multi === 'true'}];
  }
  if (!questions.length || questions.length > 4) throw new Error('Give 1 to 4 questions.');
  const mapped = questions.map(raw => {
    const question = clean(raw?.question).slice(0, 1000);
    const options = list(raw?.options) || [];
    if (!question || options.length < 2 || options.length > 6) throw new Error('Each question needs its text and 2 to 6 options.');
    // Labels are compared AFTER cleaning and slicing: two spellings that normalise to the
    // same label are one choice to the picker, and its answer (the label text) cannot say
    // which one was picked, so they must not pass as two options (deep #65).
    const labels = options.map(o => clean(o?.label).slice(0, 120));
    if (new Set(labels).size !== labels.length) throw new Error('Option labels must be distinct within a question (after trimming); give each choice its own label.');
    return {
      header: clean(raw?.header).slice(0, 40) || question.slice(0, 16),
      question,
      multi: raw?.multi === true || raw?.multi === 'true',
      options: options.map(o => {
        const label = clean(o?.label).slice(0, 120);
        if (!label) throw new Error('Every option needs a label.');
        return {label, description: clean(o?.description).slice(0, 300) || null, preview: clean(o?.preview).slice(0, 3000) || null};
      }),
    };
  });
  // Headers name the picker tabs: duplicates (an explicit repeat, or two questions whose
  // fallback — the first 16 characters — is shared) leave the questions indistinguishable.
  const headers = mapped.map(q => q.header);
  if (new Set(headers).size !== headers.length) throw new Error('Question headers must be distinct; give each question its own short header.');
  return {questions: mapped};
}
// Whether an ask_user call whose fallback question is empty still carries a
// question of its own in its structured payload: a questions list (over the
// count limit, with a text or header of its own, or not JSON at all) or an
// options payload that is not JSON. normalizeAsk's validation error for such
// a call names the real problem, so askUser must surface it as-is; only a
// call with no question anywhere — no fallback, no structured question —
// earns the generic 'Give the question…' wording.
function askSuppliesQuestion(opts) {
  const rawQuestions = opts?.questions;
  if (rawQuestions != null && !(typeof rawQuestions === 'string' && !rawQuestions.trim())) {
    let parsed = rawQuestions;
    if (typeof rawQuestions === 'string') { try { parsed = JSON.parse(rawQuestions); } catch { return true; } }
    if (Array.isArray(parsed)) return parsed.length > 4 || parsed.some(item => clean(item?.question) || clean(item?.header));
    return false;
  }
  const rawOptions = opts?.options;
  if (typeof rawOptions === 'string' && rawOptions.trim()) { try { JSON.parse(rawOptions); } catch { return true; } }
  return false;
}
function changesState(call) {
  // shell.kill has its own kind ('kill'): stopping a process can change what later
  // observations see, so it counts as a change even though it edits no file.
  return call.kind === 'edit' || call.command === 'shell.kill' || (call.kind === 'mcp' && call.mcp?.readOnly !== true) ||
    (call.command === 'system.run' && !focusReadOnlyCommand(call.params?.command));
}
// Focus-only judgement for shell commands (2026-11-06, weakness 1). This is
// NOT the approval judgement: src/policy.js readOnlyCommand stays fail-closed
// and is never consulted here to allow anything (it is only reused, below,
// for git/rg/npm/version segments, where its strictness is the point). Here
// it only decides whether a system.run counts as a change for Focus evidence
// expiry and stalled detection, so a read-only shell round stops looking like
// progress. A command is Focus-read-only only when every pipe segment is a
// known read, with no redirection, chaining, substitution, assignment,
// method call or variable use anywhere outside quotes. Anything
// unrecognised is a change, exactly as before.
const FOCUS_READ_SEGMENTS = {
  // PowerShell read cmdlets (head -> whether positional tokens are paths).
  // Select-String's positionals are patterns, not paths, so only its -Path
  // is tied to files; the others take their paths positionally too.
  'get-content': true, gc: true, cat: true, type: true,
  'get-childitem': true, gci: true, ls: true, dir: true,
  'get-item': true, gi: true,
  'test-path': true, 'resolve-path': true, 'split-path': true, 'join-path': true,
  'get-filehash': true, 'get-acl': true,
  'select-string': false, sls: false,
  'get-process': false, gps: false, ps: false,
  'get-service': false, 'get-date': false, 'get-location': false, pwd: false, gl: false,
  'get-command': false, gcm: false, 'get-help': false, help: false, man: false,
  'get-member': false, gm: false, 'select-object': false, select: false,
  'where-object': false, where: false, '?': false,
  'sort-object': false, sort: false, 'measure-object': false, measure: false,
  'format-table': false, 'format-list': false, 'format-wide': false, 'format-custom': false,
  'out-string': false, 'write-output': false, echo: false,
  'get-variable': false, gv: false, 'get-history': false, 'get-psdrive': false,
};
// Flags of the cmdlets above that take no value (every other flag is assumed
// to take one, so its value is never mistaken for a positional path).
const FOCUS_READ_SWITCHES = new Set(['-recurse', '-force', '-raw', '-directory', '-file', '-hidden', '-casesensitive', '-simplematch', '-allmatches', '-list', '-quiet', '-unique']);
// Split a command into pipe segments, or null when it contains shell syntax
// that could hide a second command or a write (redirection, chaining,
// substitution, assignment, method calls, variables outside single quotes,
// an unterminated quote). A `#` comment ends the command, as in PowerShell.
function focusPipeSegments(command) {
  const text = String(command || '');
  if (!text.trim()) return null;
  const segments = [];
  let cur = '', inSingle = false, inDouble = false, stopped = false;
  for (let i = 0; i < text.length && !stopped; i++) {
    const ch = text[i];
    if (inSingle) { cur += ch; if (ch === "'") { if (text[i + 1] === "'") cur += text[++i]; else inSingle = false; } continue; }
    if (inDouble) { cur += ch; if (ch === '"') inDouble = false; else if (ch === '$') return null; continue; }
    if (ch === "'") { inSingle = true; cur += ch; continue; }
    if (ch === '"') { inDouble = true; cur += ch; continue; }
    if (ch === '|') { segments.push(cur); cur = ''; continue; }
    if (ch === ';' || ch === '&' || ch === '>' || ch === '<' || ch === '`' || ch === '$' || ch === '(' || ch === ')' || ch === '{' || ch === '}' || ch === '[' || ch === ']' || ch === '\r' || ch === '\n') return null;
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) { stopped = true; continue; }
    cur += ch;
  }
  if (inSingle || inDouble) return null;
  segments.push(cur);
  const trimmed = segments.map(s => s.trim());
  return trimmed.some(s => !s) ? null : trimmed;
}
// One pipe segment, split into tokens; quotes are removed, a token that was
// (partly) quoted is marked so. Null on an unterminated quote.
function focusTokens(segment) {
  const tokens = [];
  let cur = '', quoted = false, inSingle = false, inDouble = false, has = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (inSingle) { if (ch === "'") { if (segment[i + 1] === "'") { cur += "'"; i++; } else inSingle = false; } else cur += ch; continue; }
    if (inDouble) { if (ch === '"') inDouble = false; else cur += ch; continue; }
    if (ch === "'") { inSingle = true; quoted = true; has = true; continue; }
    if (ch === '"') { inDouble = true; quoted = true; has = true; continue; }
    if (/\s/.test(ch)) { if (has) { tokens.push({value: cur, quoted}); cur = ''; quoted = false; has = false; } continue; }
    cur += ch; has = true;
  }
  if (inSingle || inDouble) return null;
  if (has) tokens.push({value: cur, quoted});
  return tokens;
}
const focusHead = tokens => tokens[0].value.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
function focusReadOnlySegment(segment) {
  const tokens = focusTokens(segment);
  if (!tokens || !tokens.length) return false;
  const head = focusHead(tokens);
  if (!head) return false;
  // git/rg/npm/version: the approval judgement's strict read-only check is
  // exactly what a Focus read needs too (flags, subcommands, no chaining).
  if (head === 'git' || head === 'rg' || head === 'npm' || head === 'node' || head === 'python' || head === 'python3') return readOnlyCommand(segment.trim());
  if (head === 'curl') {
    // A fetch only: any write/upload/data flag, or no http(s) URL, is a change.
    const writeFlags = new Set(['-o', '-O', '--output', '-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '-F', '--form', '-T', '--upload-file', '-X', '--request']);
    let url = false;
    for (const tok of tokens.slice(1)) {
      const v = tok.value;
      if (writeFlags.has(v) || v.startsWith('--output=') || v.startsWith('--data') || v.startsWith('--upload-file=') || v.startsWith('--request=') || v.startsWith('--form=')) return false;
      if (v.startsWith('http://') || v.startsWith('https://')) url = true;
    }
    return url;
  }
  if (!(head in FOCUS_READ_SEGMENTS)) return false;
  for (const tok of tokens.slice(1)) {
    if (!tok.quoted && (tok.value.includes('=') || tok.value.includes('::'))) return false;
  }
  return true;
}
function focusReadOnlyCommand(command) {
  const segments = focusPipeSegments(command);
  if (!segments) return false;
  return segments.every(s => focusReadOnlySegment(s));
}
// Focus weakness 10 (2026-11-06): `git add` / `git commit` / `git tag` change
// only .git, never the working tree — but they were classified as changes of
// unknown scope, so a commit after a passing `npm test` expired that test's
// evidence and the whole suite had to be re-run. They are a third kind: the
// revision IS recorded (the change log keeps them), but they expire no
// evidence. `git checkout` / `git reset` / `git push` and friends stay
// changes: checkout and reset rewrite working-tree files, push is out of
// scope. A `;` / `&&` chain counts only when EVERY part is tree-neutral.
// Split a command on top-level `;` and `&&` (outside quotes), or null when it
// holds anything else that could hide a second command (`||`, `|`, a lone
// `&`, a backtick or `$`). Each part is then checked with the same strict
// pipe parser the read-only judgement uses, so redirection, substitution,
// variables and method calls all fail closed.
function focusCommandParts(command) {
  const text = String(command || '');
  if (!text.trim()) return null;
  const parts = [];
  let cur = '', inSingle = false, inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inSingle) { cur += ch; if (ch === "'") { if (text[i + 1] === "'") cur += text[++i]; else inSingle = false; } continue; }
    if (inDouble) { cur += ch; if (ch === '"') inDouble = false; continue; }
    if (ch === "'") { inSingle = true; cur += ch; continue; }
    if (ch === '"') { inDouble = true; cur += ch; continue; }
    if (ch === ';') { parts.push(cur); cur = ''; continue; }
    if (ch === '&') { if (text[i + 1] === '&') { parts.push(cur); cur = ''; i++; continue; } return null; }
    if (ch === '|' || ch === '`' || ch === '$') return null;
    cur += ch;
  }
  if (inSingle || inDouble) return null;
  parts.push(cur);
  const trimmed = parts.map(s => s.trim());
  return trimmed.some(s => !s) ? null : trimmed;
}
const FOCUS_TREE_NEUTRAL_GIT = new Set(['add', 'commit', 'tag']);
function focusTreeNeutralCommand(command) {
  const parts = focusCommandParts(command);
  if (!parts) return false;
  return parts.every(part => {
    const segments = focusPipeSegments(part);
    if (!segments || segments.length !== 1) return false;
    const tokens = focusTokens(segments[0]);
    if (!tokens || !tokens.length || focusHead(tokens) !== 'git') return false;
    let i = 1;
    while (i < tokens.length) {
      const v = tokens[i].value;
      if (v === '-C' || v === '-c') { i += 2; continue; }
      if (/^-[Cc]./.test(v)) { i++; continue; }
      break;
    }
    if (i >= tokens.length) return false;
    return FOCUS_TREE_NEUTRAL_GIT.has(tokens[i].value);
  });
}
// The git subcommands a tree-neutral command ran, for the decision log
// (weakness 9): `git add` -> ['add'], `git add -A; git commit -m x` ->
// ['add', 'commit']. Null when the command is not tree-neutral.
function focusTreeNeutralSubcommands(command) {
  if (!focusTreeNeutralCommand(command)) return null;
  const out = [];
  for (const part of focusCommandParts(command)) {
    const tokens = focusTokens(focusPipeSegments(part)[0]);
    let i = 1;
    while (i < tokens.length) {
      const v = tokens[i].value;
      if (v === '-C' || v === '-c') { i += 2; continue; }
      if (/^-[Cc]./.test(v)) { i++; continue; }
      break;
    }
    out.push(tokens[i].value);
  }
  return out;
}
// The fixed reason name for a Focus-read-only shell run, for the decision
// log (weakness 9): the head of its first segment, with git's subcommand —
// `Get-Content a.js` -> 'read_only:get-content', `git log` -> 'read_only:git_log'.
function focusReadOnlyWhy(command) {
  const segments = focusPipeSegments(command);
  if (!segments || !segments.length) return 'read_only';
  const tokens = focusTokens(segments[0]);
  if (!tokens || !tokens.length) return 'read_only';
  const head = focusHead(tokens);
  if (head === 'git') {
    const sub = tokens.slice(1).find(t => !t.value.startsWith('-'));
    return 'read_only:git_' + (sub ? sub.value : 'command');
  }
  return 'read_only:' + head;
}
// The fixed reason name for a focus.plan / checkpoint / ask_user rejection,
// from its message (weakness 9). The full message is kept in the log entry's
// detail either way, so an unmapped rejection still leaves its wording.
function focusToolRejectionWhy(error) {
  const m = String(error || '');
  if (/out of date/.test(m)) return 'evidence_out_of_date';
  if (/itself wrote|own notes|not your own notes/.test(m)) return 'self_authored_evidence';
  if (/one evidence|three or more/.test(m)) return 'one_evidence_many_criteria';
  if (/needs user confirmation/.test(m)) return 'needs_user_confirmation';
  if (/already waiting/.test(m)) return 'question_already_waiting';
  if (/fixed for this task|cannot be removed or changed/.test(m)) return 'criteria_fixed';
  if (/Call focus\.plan before/.test(m)) return 'no_criteria';
  return 'rejected';
}
const FOCUS_PATH_PARAMS = new Set(['-path', '-literalpath']);
// The files a Focus-read-only shell command read, for tying its evidence to
// them (observedPaths): Get-Content <path>, Select-String -Path <path> and
// the like. Null when the command reads nothing nameable (git log, curl).
function focusReadPaths(command) {
  if (!focusReadOnlyCommand(command)) return null;
  const segments = focusPipeSegments(command);
  const out = [];
  const pushPaths = value => { for (const p of String(value).split(',')) { const v = p.trim(); if (v && !out.includes(v)) out.push(v); } };
  for (const segment of segments || []) {
    const tokens = focusTokens(segment);
    if (!tokens || !tokens.length) continue;
    const head = focusHead(tokens);
    if (!(head in FOCUS_READ_SEGMENTS)) continue;
    const positionalPaths = FOCUS_READ_SEGMENTS[head];
    let skipNext = false, pendingPath = false;
    for (let i = 1; i < tokens.length; i++) {
      const tok = tokens[i];
      if (skipNext) { if (pendingPath) pushPaths(tok.value); skipNext = false; pendingPath = false; continue; }
      if (!tok.quoted && tok.value.startsWith('-')) {
        const name = tok.value.toLowerCase(), colon = name.indexOf(':');
        const base = colon >= 0 ? name.slice(0, colon) : name;
        if (FOCUS_PATH_PARAMS.has(base)) {
          if (colon >= 0) pushPaths(tok.value.slice(tok.value.indexOf(':') + 1));
          else { skipNext = true; pendingPath = true; }
          continue;
        }
        if (FOCUS_READ_SWITCHES.has(base)) continue;
        skipNext = true; // any other flag takes a value
        continue;
      }
      if (positionalPaths) pushPaths(tok.value);
    }
  }
  return out.length ? out : null;
}
// Lexical path normalisation for comparisons: separators and case are normalised, and so
// are the spellings the filesystem itself treats as the same file — `.` segments, `..`
// segments that stay inside the path, doubled separators and the trailing dot/space a
// Win32 name may carry (deep #62: `src/./foo.js`, `src//foo.js`, `src/sub/../foo.js` and
// `src/foo.js.` are all `src/foo.js`).
function normPath(p) {
  const s = String(p ?? '').replace(/\\/g, '/');
  const absolute = s.startsWith('/'), out = [];
  for (let seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!absolute) out.push('..'); continue; }
    seg = seg.replace(/[. ]+$/, '').toLowerCase();
    if (seg) out.push(seg);
  }
  return (absolute ? '/' : '') + out.join('/');
}
// Path comparison for evidence expiry: a path counts as touched when either side contains
// the other, or one is the tail of the other (the same file named relative in one call and
// absolute in another).
function overlaps(a, b) {
  const x = normPath(a), y = normPath(b);
  // An empty normalised path ('.', 'src/..') names the session root: it overlaps
  // everything, instead of nothing as a bare string comparison would say.
  if (!x || !y) return true;
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/') || x.endsWith('/' + y) || y.endsWith('/' + x);
}
// The working directory a run used, normalised; '' is the session default directory. A
// `.` names the default too (deep #64).
const normDir = value => normPath(clean(value));
// The same directory spelled three ways must compare equal: a criterion and a run
// name the session directory by its absolute path, by a path relative to it, or by
// omitting cwd altogether. Absolute spellings are rewritten against sessionCwd
// (the agent's session directory): equal to it becomes '', under it becomes the
// relative remainder; relative spellings stay as normalised.
function normDirForSession(value, sessionCwd) {
  const raw = clean(value);
  if (!raw) return '';
  const absolute = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('\\');
  const n = normPath(raw);
  if (!absolute || !sessionCwd) return n;
  const base = normPath(sessionCwd);
  if (!base) return n;
  if (n === base) return '';
  return n.startsWith(base + '/') ? n.slice(base.length + 1) : n;
}
// The shell a run used, normalised; '' is the default shell (PowerShell), so an explicit
// powershell/pwsh names the same shell as omitting it, and cmd is a different one (#64).
function normShell(value) {
  const v = clean(value).toLowerCase().replace(/\.exe$/, '');
  return v === 'powershell' || v === 'pwsh' ? '' : v;
}
// A verification command is long-lived identity, not display text: the evidence keeps a
// hash of the full command (plus a 250-character head for display), so a multi-KB inline
// script neither bloats the continuation prompt nor loses its identity (deep #67).
const commandHash = command => crypto.createHash('sha256').update(command).digest('hex');
// Whether a piece of evidence is a run of a command criterion: the command itself (by
// hash when one was recorded), the directory it ran in and the shell it ran in must all
// be the criterion's — the same words in another package prove nothing (#64).
function provesCommand(e, c) {
  const same = e.commandHash ? e.commandHash === commandHash(c.command) : e.verificationCommand === c.command;
  return same && (e.cwd || '') === (c.cwd || '') && (e.shell || '') === (c.shell || '');
}
// The paths a state-changing call is known to have touched; null when they cannot be
// known (a shell command, an MCP call, a patch), because then anything may have changed.
function changedPaths(call) {
  const p = call.params?.path;
  return (call.command === 'code.edit' || call.command === 'code.write') && typeof p === 'string' && p ? [p] : null;
}
// The paths a piece of evidence covers; null when it is not tied to paths.
// A Focus-read-only shell run is tied to the files it read (Get-Content
// <path>, Select-String -Path <path>), so an edit to one of them expires
// only that run's evidence; any other system.run stays pathless, which
// keeps such evidence expiring on any later change, as before.
function observedPaths(call) {
  if (call.command === 'system.run') return focusReadPaths(call.params?.command);
  const paths = [];
  const p = call.params?.path;
  if (/^code\.(read|grep|glob)$/.test(call.command) && typeof p === 'string' && p) paths.push(p);
  // A glob's scope is its pattern as much as its path: the leading segments before
  // the first wildcard are a real directory the listing covers ('tests/**' covers
  // 'tests'), so an edit there must expire the listing even with no path param.
  if (call.command === 'code.glob' && typeof call.params?.pattern === 'string' && call.params.pattern) {
    const root = [];
    for (const seg of call.params.pattern.replace(/\\/g, '/').split('/')) { if (/[*?[{]/.test(seg)) break; root.push(seg); }
    if (root.length) paths.push(root.join('/'));
  }
  return paths.length ? paths : null;
}
// Weakness 8 (2026-11-06): a read of the task's own notes proves nothing
// about the work itself. The files this task wrote are the known paths in
// its change log (code.edit / code.write targets); a read of one of those
// files is self-authored evidence, and only when it is a memo/ledger text
// file (.md, .txt and the like) — reading code the task wrote IS the proof
// that the code is there, and a listing (code.glob) proves no content.
const SELF_AUTHORED_TEXT_EXTS = new Set(['.md', '.markdown', '.txt', '.rst', '.adoc', '.org', '.text']);
function isMemoPath(p) {
  const base = String(p).split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 && SELF_AUTHORED_TEXT_EXTS.has(base.slice(dot).toLowerCase());
}
// Whether every path an observation covers is a memo the task itself wrote.
function selfAuthoredMemo(paths, changes) {
  if (!paths || !paths.length) return false;
  const written = [];
  for (const ch of changes || []) for (const p of ch.paths || []) written.push(p);
  return paths.every(p => isMemoPath(p) && written.some(w => overlaps(p, w)));
}
// Whether a criterion's own text names a file (its path or its name): a
// criterion about that file may be proven by reading it.
function criterionNamesFile(text, p) {
  const t = String(text || '').toLowerCase().replace(/\\/g, '/');
  const n = normPath(p), base = n.split('/').pop();
  return !!base && (t.includes(n) || t.includes(base));
}

class Focus {
  constructor(goal, {maxRounds = 3, automatic = true, sessionCwd = '', sharedBackground = null, logger = null, sessionId = ''} = {}) {
    if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 10) throw new Error('Invalid Focus round limit.');
    // Weakness 9 (2026-11-06): the decision log (src/focus-log.js). The logger
    // is handed in by the agent; without one Focus logs nothing. plan /
    // checkpoint / ask_user are wrapped here so every call — accepted or
    // rejected — leaves a why line, without touching each throw site.
    this.logger = logger || null; this.sessionId = sessionId || ''; this.leg = 0;
    for (const [name, tool] of [['plan', 'focus.plan'], ['checkpoint', 'focus.checkpoint'], ['askUser', 'focus.ask_user']]) {
      const orig = this[name].bind(this);
      this[name] = (...args) => {
        try { const out = orig(...args); this._logFocusTool(tool, true, null, args); return out; }
        catch (e) { this._logFocusTool(tool, false, e.message, args); throw e; }
      };
    }
    // Not writable: only a new task (plan with new_task in a resumed leg) replaces the goal.
    Object.defineProperty(this, 'goal', {value: String(goal), enumerable: true, configurable: true});
    this.id = crypto.randomUUID(); this.maxRounds = maxRounds; this.automatic = automatic;
    this.round = 0; this.status = 'running'; this.reason = ''; this.criteria = []; this.evidence = [];
    this.revision = 0; this.changes = []; this.progressRevision = 0; this.operations = 0; this.nextEvidence = 1; this.required = !automatic;
    this.rev = 0; // wave 9 (2): the saved state's version — 0 until first saved, +1 on every successful save (src/agent.js persistFocus owns the increments)
    this.reviewed = false; this.stalled = 0; this.lastSignature = ''; this.halted = false; this.awaitingInput = false;
    this.resumed = false; this.legRevision = 0; this.legReported = false; this.legGoal = ''; this.question = ''; this.ask = null; this.legEngaged = false;
    this.interruptedQuestion = ''; // the question a resumeLeg last cleared without an answer, named in resumeNote so Muse can ask it again
    this.legFromUser = false; this.manualLeg = false; // this leg was started by a real user message (not an automatic continuation)
    this.legCheckpointed = false; // a successful checkpoint this leg: locks the task identity against new_task replacement (a mere plan does not)
    this.criteriaAllMet = false; // the last checkpoint reported every criterion met; cleared when any criterion is reset
    this.sessionCwd = sessionCwd || ''; // the agent's session directory: cwd spellings are compared against it
    // Background runs are shared across Focus instances when the caller hands in a
    // map: a run started under one Focus may finish (and be collected) under another.
    this.background = sharedBackground instanceof Map ? sharedBackground : new Map(); // shell id -> {command, revision}: runs that went to the background
  }
  get active() { return this.required || this.criteria.length > 0; }
  beginRound() {
    this.round++;
    // A task whose criteria are all met stays reviewed across the round boundary:
    // resetting it made a fully-met task that waited on workers end 'stalled'
    // instead of 'complete' in the next round.
    if (!(this.criteria.length && this.criteria.every(c => c.status === 'met'))) this.reviewed = false;
  }
  // Weakness 9 (2026-11-06): one decision-log line. No logger, no line;
  // logging never throws into the task.
  setLogger(logger, sessionId) { this.logger = logger || null; if (sessionId) this.sessionId = sessionId; }
  _log(event, fields = {}) {
    if (!this.logger) return;
    try { this.logger.append(event, {focus: this.id, leg: this.leg, round: this.round, ...fields}); }
    catch { /* logging never breaks the task */ }
  }
  // A focus.plan / checkpoint / ask_user call, accepted or rejected: the
  // outcome, the rejection wording itself, and the per-criterion results
  // (including Muse's reason for each checkpoint entry).
  _logFocusTool(tool, ok, error, args) {
    if (!this.logger) return;
    const detail = {tool, accepted: ok};
    if (!ok) detail.error = String(error || '').slice(0, 500);
    if (tool === 'focus.plan') {
      detail.criteria = ok
        ? this.criteria.map(c => ({id: c.id, text: c.text.slice(0, 200), kind: c.kind, status: c.status}))
        : (Array.isArray(args[0]) ? args[0] : []).map(c => ({text: String(c?.text || '').slice(0, 200), kind: c?.kind || ''}));
    } else if (tool === 'focus.checkpoint') {
      detail.results = (Array.isArray(args[0]) ? args[0] : []).map(x => ({id: x?.id, status: x?.status, reason: String(x?.reason || '').slice(0, 200), evidence: Array.isArray(x?.evidence) ? x.evidence : []}));
      if (ok) detail.criteria = this.criteria.map(c => ({id: c.id, status: c.status}));
    } else if (tool === 'focus.ask_user') {
      detail.question = String(args[0] || '').slice(0, 200);
    }
    this._log('focus_tool', {decision: ok ? 'accepted' : 'rejected', why: ok ? 'accepted' : focusToolRejectionWhy(error), detail});
  }
  // The fixed reason name for one observation (weakness 9): whether it
  // counted as a change, and by which rule.
  _observeWhy(call, {treeNeutral = false, verification = false, bg = null, executorRefused = false, ownCleanup = false} = {}) {
    if (call.declined) return 'declined';
    if (executorRefused) return 'executor_refused';
    if (ownCleanup) return 'own_cleanup';
    if (treeNeutral) return 'tree_neutral:' + (focusTreeNeutralSubcommands(call.params?.command) || []).join('_');
    if (verification) return 'verification_run';
    if (bg && !focusReadOnlyCommand(bg.command)) return 'classified_change:background';
    if (changesState(call)) {
      if (call.kind === 'edit') return 'classified_change:edit';
      if (call.command === 'shell.kill') return 'classified_change:shell_kill';
      if (call.kind === 'mcp') return 'classified_change:mcp_write';
      return 'classified_change:not_allowlisted';
    }
    if (call.command === 'system.run') return focusReadOnlyWhy(call.params?.command);
    if (/^code\.(read|grep|glob)$/.test(call.command)) return 'read_only:code_' + call.command.slice(5);
    return 'no_change';
  }
  // A new leg of the same task, started by the user's next message after this task
  // stopped for their input (or unfinished at its round limit): criteria, evidence
  // and revision carry over — only the round budget and the review flag start fresh.
  resumeLeg(nextGoal = '', {fromUser = true} = {}) {
    this.leg++;
    this.round = 0; this.status = 'running'; this.reason = ''; this.reviewed = false; this.stalled = 0; this.lastSignature = ''; this.awaitingInput = false;
    this.halted = false; // a declined call halted the OLD leg; carrying it over made the resumed task uncompletable, its reason already wiped above
    this.legCheckpointed = false;
    // The question that was waiting when the old leg stopped is remembered
    // before it is cleared, and resumeNote names it: clearing it silently
    // (deep #61) lost the question for good when an interruption — a gateway
    // failure, an abort — fell between asking and the user's answer, and
    // Muse never knew there was anything to ask again. The plain text may
    // already have been consumed by endRound (it clears question, not ask),
    // so the structured payload is the fallback source for its text.
    const waiting = this.ask?.questions?.length > 1 ? this.ask.questions.map(x => x?.question || '').filter(Boolean).join(' / ') : (this.question || this.ask?.questions?.[0]?.question || '');
    this.interruptedQuestion = clean(waiting).replace(/[\r\n]+/g, ' ').slice(0, 1000);
    this.ask = null; // the user answered (or moved on): the picker must not reopen for the old question
    // The plain question text goes with it: a leg that stopped WITHOUT endRound (the agent
    // catch path after a gateway failure or abort) never consumed it, and the resumed leg
    // otherwise stopped again at endRound on the question the user already moved past,
    // with no picker data behind it (deep #61).
    this.question = '';
    this.resumed = true; this.legRevision = this.revision; this.legReported = false; this.legGoal = String(nextGoal); this.legEngaged = false;
    // An automatic continuation leg (afterFocus / afterGoal) also resumes, but no user
    // message stands behind it: it must not satisfy a manual criterion (#33) and must not
    // replace the task with a new one (#36). Only a leg a real user message started may.
    this.legFromUser = !!fromUser; this.manualLeg = !!fromUser;
  }
  // Told to Muse at the start of a resumed leg: without it Muse saw only the follow-up and the
  // generic "call focus.plan" instruction, planned the follow-up and was refused (criteria fixed).
  resumeNote() {
    return '[muser Focus: the previous task in this chat is unfinished and stays open.\nIts goal: ' + this.goal + '\nIts criteria: ' +
      this.criteria.map(c => c.id + ' [' + c.status + '] ' + c.text).join(' | ') +
      (this.interruptedQuestion ? '\n前回、次の質問への回答を待っている途中で止まりました: ' + this.interruptedQuestion + '\nIf the message below does not answer it, ask it again.' : '') +
      '\nIf the message below continues that task, keep these criteria (append new ones with focus.plan append=true if the user added requirements; a request to keep going, keep finding or fix everything is one, reported unmet while work remains) and report them with focus.checkpoint. If it is a different task, call focus.plan with new_task=true and that task\'s criteria. If it needs no work (thanks, a side question), just answer.]';
  }
  // Muse waits on the user. Without this, a clarifying question ended the round like any
  // unfinished work and Focus sent "continue" — Muse then guessed the answer or asked again.
  askUser(question, opts = {}) {
    let q = clean(question);
    // Structured questions carry their own text and override the fallback question
    // (as the tool definition says), so an empty fallback is fine when they
    // normalise; only a plain ask needs the fallback text itself.
    let ask;
    // A validation failure (too many questions, duplicate headers, broken
    // JSON, …) is reported as itself, even when the fallback question is
    // empty: masking it as 'Give the question…' sent Muse fixing the wrong
    // thing. The generic wording is only for a call where no question was
    // given at all (askSuppliesQuestion).
    try { ask = normalizeAsk(q, opts); } catch (e) { if (!q && !askSuppliesQuestion(opts)) throw new Error('Give the question you are asking the user.'); throw e; }
    if (!q) {
      if (!ask) throw new Error('Give the question you are asking the user.');
      q = ask.questions[0].question;
    }
    // One question waits on the user at a time: a second call in the same round used to
    // overwrite the first silently, so it never reached the user at all (deep #66). The
    // first question stands; ask the next one after the user answers.
    if (this.question) throw new Error('A question is already waiting for the user in this round; end the turn and ask the next question after they answer.');
    this.question = q.slice(0, 1000);
    this.ask = ask;
    // Asking makes this a tracked task waiting on the user even before any plan or
    // change activated Focus: otherwise endRound called it inactive, the question
    // was dropped, and the task was never stashed for the user's answer (#34).
    this.required = true;
    return this.snapshot();
  }
  plan(value, {newTask = false, append = false} = {}) {
    // Even a refused re-plan is engagement with this task: the leg tried to work on it,
    // so endRound must not mistake it for a side-question leg that did nothing.
    this.legEngaged = true;
    // append: only the new criteria are given. Appending used to need every existing
    // criterion repeated verbatim first (22 of them on 2026-11-05), so a requirement the
    // user added mid-task often never became a criterion.
    const appended = append && !newTask && this.criteria.length > 0;
    if (appended) {
      // The 100-entry cap is on the TOTAL (existing + appended): array()'s
      // generic wording made an append that only overflowed once the
      // existing criteria were counted read as a cap on the new items
      // alone, so say it is the total that is over the limit, with both
      // counts. An unparseable payload keeps array()'s own error below.
      let incoming = value;
      if (typeof incoming === 'string') { try { const parsed = JSON.parse(incoming); if (Array.isArray(parsed)) incoming = parsed; } catch { /* array() reports it */ } }
      if (Array.isArray(incoming) && this.criteria.length + incoming.length > 100)
        throw new Error('Completion criteria are limited to 100 in total for one task: this task already has ' + this.criteria.length + ', and appending ' + incoming.length + ' more would bring the total to ' + (this.criteria.length + incoming.length) + '.');
      value = [...this.criteria.map(c => ({text: c.text, kind: c.kind, command: c.command, cwd: c.cwd, shell: c.shell})), ...array(value)];
    }
    let items = array(value).map((item, i) => {
      const text = clean(item?.text), kind = item?.kind, command = clean(item?.command);
      if (!text || text.length > 1000 || !['inspection', 'command', 'manual'].includes(kind) || (kind === 'command' && !command))
        throw new Error('Each criterion needs text and kind inspection, command, or manual; command checks need the exact command.');
      // A command criterion is verified by a run of its command in its directory and
      // shell: cwd/shell are part of the criterion's identity (default directory/shell
      // when omitted), never of its display text (deep #64).
      const cwd = kind === 'command' ? normDirForSession(item?.cwd, this.sessionCwd) : '', shell = kind === 'command' ? normShell(item?.shell) : '';
      // A shell spelling that is neither the default (powershell/pwsh) nor cmd can
      // never match a real run, so the criterion could never be met: refuse it at
      // plan time instead of letting the task run into a dead end.
      if (kind === 'command' && shell && shell !== 'cmd') throw new Error('A command criterion\'s shell must be powershell or cmd (or omitted for the default).');

      return {id: 'c' + (i + 1), text, kind, ...(kind === 'command' ? {command, ...(cwd ? {cwd} : {}), ...(shell ? {shell} : {})} : {}), status: 'pending', evidence: [], reason: ''};
    });
    if (appended) {
      // An append caller may still hand in the old-style full list, existing criteria
      // included: those repeats are the recorded criteria themselves, not new ones
      // (the no-append path drops them via its prefix slice), so drop any appended
      // item that matches a recorded criterion — or an earlier appended item — in
      // full (text, kind, command, cwd, shell), and renumber the survivors so their
      // IDs stay contiguous.
      const sameCriterion = (a, b) => a.text === b.text && a.kind === b.kind && a.command === b.command && (a.cwd || '') === (b.cwd || '') && (a.shell || '') === (b.shell || '');
      const keptTail = [];
      for (const item of items.slice(this.criteria.length)) {
        if (this.criteria.some(c => sameCriterion(item, c)) || keptTail.some(c => sameCriterion(item, c))) continue;
        keptTail.push(item);
      }
      items = [...items.slice(0, this.criteria.length), ...keptTail];
      items.forEach((item, i) => { item.id = 'c' + (i + 1); });
    }
    if (!this.criteria.length) {
      // A task that was tracked without criteria yet (an ask_user, a change) still
      // replaces its goal on a resumed user leg: the early return used to swallow
      // the new_task replacement entirely for zero-criteria tasks.
      if (newTask && this.resumed && this.legFromUser && !this.legCheckpointed && this.legGoal) {
        Object.defineProperty(this, 'goal', {value: this.legGoal, enumerable: true, configurable: true});
        Object.assign(this, {id: crypto.randomUUID(), rev: 0, criteria: items, required: true, resumed: false, legGoal: '', reviewed: false, stalled: 0, lastSignature: '', legReported: true, criteriaAllMet: false, round: Math.min(this.round, 1), question: '', ask: null, interruptedQuestion: ''});
        return this.snapshot();
      }
      this.criteria = items; this.required = true; this.legReported = true; return this.snapshot();
    }
    // Existing criteria are fixed: the list may only GROW. A re-plan that keeps every
    // recorded criterion verbatim and appends new ones (the user clarified the task)
    // is accepted; removing, reordering or editing one is still refused.
    const kept = items.length >= this.criteria.length && this.criteria.every((c, i) => items[i].text === c.text && items[i].kind === c.kind && items[i].command === c.command && (items[i].cwd || '') === (c.cwd || '') && (items[i].shell || '') === (c.shell || ''));
    if (!kept && newTask && this.resumed && this.legFromUser && !this.legCheckpointed && this.legGoal) {
      // The follow-up is another task: it becomes the goal, with its own criteria. Only a
      // leg a real user message started may do this (legFromUser): the model's new_task
      // flag alone, on an automatic leg, must not drop the standing criteria (#36). Evidence
      // (and its IDs) carry on, so nothing Muse was already handed changes meaning.
      // The gate is legCheckpointed, not legReported: a plan (even an append) earlier
      // in this leg must not block replacement — only a reported checkpoint settles
      // the leg into the old task. The old task's unanswered question goes with it
      // (question/ask in the assign below): the new task never asked it, so it must
      // not stop needs_input waiting for its answer. The replacement also restarts the round budget:
      // a task replaced in round 3 of 3 is not instantly at its limit.
      Object.defineProperty(this, 'goal', {value: this.legGoal, enumerable: true, configurable: true});
      Object.assign(this, {id: crypto.randomUUID(), rev: 0, criteria: items, required: true, resumed: false, legGoal: '', reviewed: false, stalled: 0, lastSignature: '', legReported: true, criteriaAllMet: false, round: Math.min(this.round, 1), question: '', ask: null, interruptedQuestion: ''});
      return this.snapshot();
    }
    if (!kept) throw new Error('Completion criteria are fixed for this task: existing criteria cannot be removed or changed, but new ones may be appended. Ask the user to clarify the goal instead of removing or weakening a criterion.' +
      (this.resumed && !this.legReported ? ' If the user\'s latest message is a different task, call focus.plan with new_task=true.' : ''));
    this.legReported = true;
    if (items.length === this.criteria.length) return this.snapshot();
    this.criteria = [...this.criteria, ...items.slice(this.criteria.length)];
    this.reviewed = false; // the appended criteria have not been reported yet
    this.criteriaAllMet = false;
    return this.snapshot();
  }
  observe(call, result) {
    if (/^(todo\.|skill\.|shell\.list)/.test(call.command)) return null;
    this.operations++;
    const revBefore = this.revision, progBefore = this.progressRevision;
    if (call.declined) { this.halted = true; this.required = true; this.reason = t('コマンドが却下されました。ユーザーの入力が必要です。'); }
    // Running a criterion's own declared verification command checks the work rather than
    // changing it: counting it as a change of unknown scope made two command criteria
    // (build + publish) expire each other's evidence, so the task could never be closed.
    // They still count as a change for what files say (a publish rewrites its output folder,
    // so a listing taken before it is stale) — only other command results stay current.
    // The run's identity is command + directory + shell: the same words elsewhere are an
    // ordinary change, not this criterion's verification (deep #64).
    const runCommand = call.command === 'system.run' ? clean(call.params?.command) : '';
    const runCwd = call.command === 'system.run' ? normDirForSession(call.params?.cwd, this.sessionCwd) : '';
    // A call the executor refused before anything ran (bad shell, bad cwd, an edit
    // whose old_string is absent) changed nothing: it must not bump the revision or
    // reset criteria. code.apply_patch is the exception — it can partially apply
    // before throwing, so its failures keep the old treat-as-change behaviour.
    const executorRefused = !!result && result.ok === false && result.payload == null && call.command !== 'code.apply_patch';
    const runShell = call.command === 'system.run' ? normShell(call.params?.shell) : '';
    const verification = call.command === 'system.run' && this.criteria.some(c => c.kind === 'command' && c.command === runCommand && (c.cwd || '') === runCwd && (c.shell || '') === runShell);
    // Stopping a background run this session started (start a server, probe it, stop it) is
    // cleanup, not a change: counting it expired the probe it had just passed, and the task
    // went round again to re-check (2026-11-06, 2 of 38 Focus runs). Stopping any other shell
    // still counts, as below.
    const ownCleanup = call.command === 'shell.kill' && this.background.has(String(call.params?.shell_id ?? ''));
    // Weakness 10 (2026-11-06): a tree-neutral git run (add / commit / tag)
    // records its revision but expires no evidence — a commit after a passing
    // test used to expire that test's evidence. It is handled here, ahead of
    // the change block, so the revision bump cannot reset a met criterion. A run
    // that went to the background records nothing yet: the commit has not
    // happened at its start, and the completion below records it instead.
    // The manual-expiry check reads the change log, not the revision alone,
    // so this bump cannot revive later as a manual expiry either.
    const treeNeutral = call.command === 'system.run' && focusTreeNeutralCommand(runCommand);
    if (treeNeutral) {
      this.required = true;
      if (!call.declined && !executorRefused && !result?.payload?.shell_id) {
        this.revision++;
        this.changes.push({revision: this.revision, paths: [], treeNeutral: true});
        if (this.changes.length > 300) this.changes.shift();
      }
    }
    if (changesState(call) && !executorRefused && !ownCleanup && !treeNeutral) {
      // Stopping a background shell changes no file and is no task by itself ("stop the dev
      // server" was pushed into a Focus round asking for completion criteria).
      if (call.command !== 'shell.kill') this.required = true;
      // A failed operation can have partial side effects. Only a declined call is known
      // not to have run; otherwise earlier observations need checking again.
      if (!call.declined) {
        this.revision++;
        this.changes.push({revision: this.revision, paths: call.command === 'shell.kill' ? [] : changedPaths(call), ...(verification ? {verification: true} : {})});
        if (this.changes.length > 300) this.changes.shift();
        if (!verification && call.command !== 'shell.kill' && result.ok && (call.command !== 'system.run' || result.payload?.exit_code === 0)) this.progressRevision++;
        // Only the criteria whose evidence this change actually touches go back to
        // pending: an edit to an unrelated file used to throw away every verification
        // with it, and re-earning it (another full test run, say) bought nothing.
        const expired = this.resetExpiredCriteria();
        // Weakness 9: which criteria, which evidence, and which change expired them.
        if (expired.length) {
          this._log('evidence_expired', {decision: 'criteria_reset', why: this._observeWhy(call, {treeNeutral, verification}),
            detail: {criteria: expired.map(x => x.criterion), evidence: expired.flatMap(x => x.evidence), expired,
              change: {command: call.command === 'system.run' ? runCommand : call.command, paths: changedPaths(call)}}});
        }
      }
    }
    // A failed re-run of a declared command invalidates that command's earlier pass
    // even while the criterion sits pending (reported unmet, say): the recorded
    // change carries the command's hash, so only that command's evidence expires
    // by it. A run that merely went to the background has not failed (yet).
    {
      const p0 = result.payload || {};
      const exit0 = p0.exit_code ?? p0.exitCode;
      if (call.command === 'system.run' && !call.declined && !executorRefused && !p0.shell_id && exit0 != null && exit0 !== 0 &&
        this.criteria.some(c => c.kind === 'command' && c.command === runCommand && (c.cwd || '') === runCwd && (c.shell || '') === runShell)) {
        this.revision++;
        this.changes.push({revision: this.revision, paths: [], failedCommand: commandHash(runCommand)});
        if (this.changes.length > 300) this.changes.shift();
      }
    }
    const payload = result.payload || {};
    // A run that went to the background (asked for, or moved there at its timeout) proves
    // nothing yet; shell.output of it after it ends with exit code 0 is that command's
    // evidence, dated from when it started. Before, such a command criterion could never be met.
    if (call.command === 'system.run' && payload.shell_id && result.ok) {
      this.background.set(String(payload.shell_id), {command: runCommand, cwd: runCwd, shell: runShell, revision: this.revision});
      // The (possibly shared) map is capped, but only runs whose completion was
      // already collected (counted) are forgotten, oldest first: evicting a run
      // that is still running — or finished but not yet collected — made its
      // completion evidence unusable for good, so a task with more than 50
      // background starts could never meet that run's command criterion. While
      // more than 50 runs are still uncollected the map stays over the cap.
      while (this.background.size > 50) {
        let victim;
        for (const [key, entry] of this.background) if (entry && entry.counted) { victim = key; break; }
        if (victim === undefined) break;
        this.background.delete(victim);
      }
    }
    const bgExit = payload.exit_code ?? payload.exitCode ?? payload.backgroundResult?.exit_code ?? payload.backgroundResult?.exitCode;
    const bg = call.command === 'shell.output' && result.ok && (payload.running === false || payload.backgroundResult != null) ? this.background.get(String(payload.id ?? payload.backgroundResult?.id ?? call.params?.shell_id ?? '')) : null;
    if (bg && !bg.counted) {
      // The background run's effects land when it finishes, not when it started:
      // record the change now (once per run), before the completion evidence is
      // created, so evidence from before the completion expires while the
      // completion evidence itself is dated at this new revision. A read-only
      // command changed nothing, so it records no change.
      bg.counted = true;
      // A background run that finished is a change unless it was a
      // Focus-read-only command; a declared verification command is
      // marked as one, so it does not expire read-tool evidence either.
      const bgVerification = this.criteria.some(c => c.kind === 'command' && c.command === bg.command && (c.cwd || '') === (bg.cwd || '') && (c.shell || '') === (bg.shell || ''));
      let bgChanged = false;
      if (focusTreeNeutralCommand(bg.command)) {
        // Weakness 10: a background commit/add/tag records its revision and
        // expires nothing, like a direct one.
        this.revision++;
        this.changes.push({revision: this.revision, paths: [], treeNeutral: true});
        if (this.changes.length > 300) this.changes.shift();
        bg.revision = this.revision;
      } else if (!focusReadOnlyCommand(bg.command)) {
        this.revision++;
        this.changes.push({revision: this.revision, paths: null, ...(bgVerification ? {verification: true} : {})});
        if (this.changes.length > 300) this.changes.shift();
        bg.revision = this.revision;
        bgChanged = true;
      }
      // A background run that finished failing is a failed re-run of its command,
      // exactly like a direct one: its earlier pass stops being current.
      if (bgExit != null && bgExit !== 0 && this.criteria.some(c => c.kind === 'command' && c.command === bg.command && (c.cwd || '') === (bg.cwd || '') && (c.shell || '') === (bg.shell || ''))) {
        this.revision++;
        this.changes.push({revision: this.revision, paths: [], failedCommand: commandHash(bg.command)});
        if (this.changes.length > 300) this.changes.shift();
        bgChanged = true;
      }
      // Wave 8: the change recorded above never went through the change
      // block at the top of observe() (that block keys off the original
      // call, and this call is shell.output), so its expiry reset never ran
      // either: a 'met' whose evidence the completion expired stayed 'met'
      // and the task could still complete on stale proof. Run the same
      // reset a direct change runs — here, before the completion evidence
      // below is created, so that evidence (dated at the new revision)
      // does not expire itself. A tree-neutral completion expires nothing,
      // like a direct one, so it runs no reset.
      if (bgChanged) {
        const expired = this.resetExpiredCriteria();
        if (expired.length) {
          this._log('evidence_expired', {decision: 'criteria_reset', why: this._observeWhy(call, {bg}),
            detail: {criteria: expired.map(x => x.criterion), evidence: expired.flatMap(x => x.evidence), expired,
              change: {command: bg.command, paths: null}}});
        }
      }
    }
    const ok = !!result.ok && (call.command !== 'system.run' || ((payload.exit_code ?? payload.exitCode) === 0 && !payload.killed && !payload.shell_id)) && (call.command !== 'shell.output' || (!!bg && bgExit === 0));
    // A declined (or executor-refused) call ran nothing: it must not reset a met
    // criterion as if its command had been re-run.
    if (call.command === 'system.run' && !call.declined && !executorRefused) {
      let reset = false;
      const rerun = [];
      this.criteria = this.criteria.map(c => {
        if (c.kind !== 'command' || c.command !== runCommand || (c.cwd || '') !== runCwd || (c.shell || '') !== runShell || c.status !== 'met') return c;
        this.reviewed = false; reset = true; rerun.push(c.id);
        return {...c, status: 'pending', evidence: [], reason: t('検証コマンドが再実行されました。最新の結果を報告してください。')};
      });
      // Weakness 9: a re-run supersedes its own earlier pass.
      if (reset) { this.criteriaAllMet = false; this._log('criterion_reset', {decision: 'criteria_reset', why: 'verification_rerun', detail: {criteria: rerun, command: runCommand}}); }
    }
    const usable = ok && (/^code\.(read|grep|glob)$/.test(call.command) || call.command === 'system.run' || !!bg);
    // A run's evidence (direct, or a background run collected through shell.output) keeps
    // the command's identity — a 250-character head plus the full command's hash — and
    // the directory and shell it ran in, when they are not the defaults (deep #64, #67).
    const runOf = call.command === 'system.run' ? {command: runCommand, cwd: runCwd, shell: runShell} : bg ? {command: bg.command, cwd: bg.cwd || '', shell: bg.shell || ''} : null;
    // Weakness 8: a read of a memo this task itself wrote is marked as
    // self-authored when the evidence is created (the change log then holds
    // only writes from before the read), so checkpoint can refuse it as
    // proof of implementation or behaviour.
    const evidencePaths = observedPaths(call);
    const evidence = {id: 'e' + this.nextEvidence++, command: call.command, summary: clean(call.summary).slice(0, 250),
      ...(runOf ? {verificationCommand: runOf.command.slice(0, 250), commandHash: commandHash(runOf.command), ...(runOf.cwd ? {cwd: runOf.cwd} : {}), ...(runOf.shell ? {shell: runOf.shell} : {}), exitCode: (bg ? bgExit : payload.exit_code ?? payload.exitCode) ?? null} : {}),
      ...(evidencePaths ? {paths: evidencePaths} : {}),
      ...(selfAuthoredMemo(evidencePaths, this.changes) ? {selfAuthored: true} : {}),
      ok, usable, revision: bg ? bg.revision : this.revision, round: this.round};
    this.evidence.push(evidence);
    // The evidence list keeps the last 300, like the change log: an entry
    // pushed out by the cap is gone, so a 'met' it supported falls at once
    // — the same rule the change log's sliding window applies to evidence
    // (evidenceCurrent) — instead of standing until some later change
    // happened to run the expiry reset, which let a task complete on
    // proof that no longer exists.
    if (this.evidence.length > 300) {
      const evicted = this.evidence.shift();
      const expired = this.resetExpiredCriteria();
      if (expired.length) {
        this._log('evidence_expired', {decision: 'criteria_reset', why: 'evidence_evicted',
          detail: {criteria: expired.map(x => x.criterion), evidence: expired.flatMap(x => x.evidence), expired, evicted: evicted.id}});
      }
    }
    // Weakness 9: every observation leaves a why line — whether it counted as
    // a change, by which rule, and whether the revisions advanced. Muse's
    // intent (its last progress message, or the todo item it works on) rides
    // on the call when the agent knows it.
    this._log('observe', {decision: treeNeutral ? 'tree_neutral' : changesState(call) ? 'change' : 'no_change',
      why: this._observeWhy(call, {treeNeutral, verification, bg, executorRefused, ownCleanup}),
      detail: {command: call.command, kind: call.kind || '', revisionBefore: revBefore, revision: this.revision,
        progressRevisionBefore: progBefore, progressRevision: this.progressRevision,
        ...(changedPaths(call) ? {paths: changedPaths(call)} : {}),
        ...(observedPaths(call) ? {observedPaths: observedPaths(call)} : {}),
        verification, ...(bg ? {background: String(payload.id ?? payload.backgroundResult?.id ?? call.params?.shell_id ?? '')} : {})},
      ...(call.intent ? {intent: call.intent} : {}),
      ...(this.logger && typeof this.logger.levelNow === 'function' && this.logger.levelNow() === 'verbose'
        ? {params: call.params, result: {ok: result?.ok, ...(result?.payload !== undefined ? {payload: result.payload} : {}), ...(result?.error ? {error: result.error} : {})}} : {})});
    return evidence.id;
  }
  // Whether one recorded change expires one piece of evidence. Path-tied evidence expires
  // only on a change that may have touched what it covers. Pathless evidence (a shell
  // run's answer) survives ONLY a declared verification run, and only when the evidence
  // is itself a verification run's: the exemption used to cover every shell observation,
  // so a directory listing taken before a publish stayed "current" through it (deep #63).
  expiredBy(e, ch) {
    // Weakness 10: a tree-neutral git change (add / commit / tag) touches no
    // working-tree file, so it expires no evidence at all.
    if (ch.treeNeutral) return false;
    // A failed-command change is targeted: it expires only that command's own
    // (pathless) evidence, and nothing else.
    if (ch.failedCommand) return !e.paths && !!e.commandHash && e.commandHash === ch.failedCommand;
    // A declared verification run checks the work; it does not rewrite the
    // source a read tool saw, so code.read/grep evidence (file contents)
    // survives it. A listing does not: code.glob evidence, like shell
    // evidence, still expires on it — a listing taken before a publish
    // must not prove the post-publish state (deep #63, 1102 test).
    if (ch.verification && /^code\.(read|grep)$/.test(e.command)) return false;
    if (!e.paths) return !(ch.verification && this.criteria.some(c => c.kind === 'command' && provesCommand(e, c)));
    return !ch.paths || ch.paths.some(p => e.paths.some(q => overlaps(p, q)));
  }
  // Whether a manual confirmation made at confirmedRevision has been
  // overtaken by a change that actually changed the working tree. The
  // revision alone does not decide it: tree-neutral runs (git add /
  // commit / tag) and failed-command records advance the revision
  // without touching the tree, so keying off the revision dropped a
  // confirmed manual 'met' on a mere commit — at the next expiry reset,
  // or on restore — even though nothing the user confirmed had changed.
  // The change log is the record: a later entry that is neither
  // tree-neutral nor a failed-command record is a real change. When the
  // log's window has slid past the confirmation, a real change can no
  // longer be ruled out, so the confirmation counts as overtaken — the
  // same rule evidenceCurrent applies to slid evidence.
  manualExpired(confirmedRevision) {
    if (!Number.isFinite(confirmedRevision) || this.revision <= confirmedRevision) return false;
    if (!this.changes.length || confirmedRevision < this.changes[0].revision - 1) return true;
    return this.changes.some(ch => ch.revision > confirmedRevision && !ch.treeNeutral && !ch.failedCommand);
  }
  // The expiry reset a recorded change puts 'met' criteria through: a criterion
  // goes back to pending when its proof no longer stands at the current
  // revision. A manual 'met' carries no evidence (the user's word was the
  // proof), so it expires when a later change that actually changed the
  // tree postdates the user's confirmation (manualExpired); any other 'met' expires when a cited
  // evidence item is gone or no longer current. Only the criteria the change
  // actually touches reset: an unrelated change used to throw away every
  // verification with it. Returns the expired list (for the decision log) and
  // clears the reviewed / all-met flags when anything was reset. Every place
  // that records a change — a direct change in observe(), a background run's
  // completion — must run this, or a stale 'met' survives its own expiry.
  resetExpiredCriteria() {
    const expired = [];
    this.criteria = this.criteria.map(c => {
      if (c.status !== 'met') return c;
      const stale = (c.kind === 'manual' && c.confirmedRevision != null && this.manualExpired(c.confirmedRevision)) ||
        c.evidence.some(id => { const e = this.evidence.find(x => x.id === id); return !e || !this.evidenceCurrent(e); });
      if (!stale) return c;
      expired.push({criterion: c.id, kind: c.kind, evidence: c.evidence.filter(id => { const e = this.evidence.find(x => x.id === id); return !e || !this.evidenceCurrent(e); })});
      return {...c, status: 'pending', evidence: [], reason: t('確認のあとで変更がありました。再度確認してください。')};
    });
    if (expired.length) { this.reviewed = false; this.criteriaAllMet = false; }
    return expired;
  }
  // Whether an observation still stands at the current revision. Path-tied evidence
  // (reads, searches) survives changes that provably did not touch what it covers;
  // anything else expires on the first later change, as it always has.
  evidenceCurrent(e) {
    if (e.revision === this.revision) return true;
    // The change log keeps the last 300: evidence older than what it still holds cannot be
    // cleared against the dropped changes, so it counts as expired.
    if (!this.changes.length || e.revision < this.changes[0].revision - 1) return false;
    for (const ch of this.changes) {
      if (ch.revision <= e.revision) continue;
      if (this.expiredBy(e, ch)) return false;
    }
    return true;
  }
  // Why a cited evidence ID cannot prove a criterion, in words Muse can act on: the bare
  // "needs successful, current evidence" left it re-citing the same IDs round after round.
  evidenceProblem(id) {
    const e = this.evidence.find(x => x.id === id);
    if (!e) return id + ' is not a known evidence ID (focus.status lists the current ones)';
    if (!e.usable) return id + ' (' + e.command + ') cannot prove anything: only a successful read, grep, glob or command run counts' + (e.command === 'system.run' && !e.ok ? ' and this run did not succeed or went to the background' : '');
    if (!this.evidenceCurrent(e)) {
      // Window slide first (wave 8): evidenceCurrent counts evidence as
      // expired when the change log no longer reaches back to it — the log
      // keeps only the last 300 changes, so the changes that came after the
      // evidence may already be dropped. That is not a change of unknown
      // scope, and the wording must not claim one: say the log window slid.
      if (!this.changes.length || e.revision < this.changes[0].revision - 1)
        return id + ' is out of date: the change log window has slid past it (older changes were dropped from the log, so it can no longer be checked against them); observe again';
      const later = this.changes.find(ch => ch.revision > e.revision && this.expiredBy(e, ch));
      return id + ' is out of date: a later change' + (later?.paths?.length ? ' to ' + later.paths.join(', ') : ' of unknown scope (a command, patch or MCP call)') + ' came after it; observe again';
    }
    return '';
  }
  checkpoint(value) {
    this.legEngaged = true; // an attempted report is engagement too, even when it is refused
    if (!this.criteria.length) throw new Error('Call focus.plan before reporting completion.');
    const checks = array(value), seen = new Set();
    if (checks.length !== this.criteria.length) throw new Error('Report every criterion exactly once.');
    // Weakness 8: one piece of evidence cannot by itself mark three or more
    // inspection criteria met — each criterion needs its own evidence. A
    // criterion citing that evidence alongside others is not "by itself".
    const soleUse = new Map();
    for (const entry of checks) {
      if (entry?.status !== 'met') continue;
      const c = this.criteria.find(x => x.id === entry.id);
      if (!c || c.kind !== 'inspection') continue;
      const refs = Array.isArray(entry.evidence) ? [...new Set(entry.evidence)] : [];
      if (refs.length !== 1) continue;
      soleUse.set(refs[0], [...(soleUse.get(refs[0]) || []), c.id]);
    }
    for (const [id, ids] of soleUse) {
      if (ids.length >= 3) throw new Error(id + ' alone cannot mark ' + ids.length + ' inspection criteria met (' + ids.join(', ') + '): give each criterion its own evidence.');
    }
    const next = this.criteria.map(c => {
      const entry = checks.find(x => x?.id === c.id);
      if (!entry || seen.has(entry.id) || !['met', 'unmet', 'unknown', 'blocked'].includes(entry.status)) throw new Error('Missing, duplicate or invalid completion criterion.');
      seen.add(entry.id);
      const reason = clean(entry.reason), refs = Array.isArray(entry.evidence) ? [...new Set(entry.evidence)] : [];
      if (!reason) throw new Error('Each criterion needs an observation or a reason it cannot be verified.');
      if (entry.status === 'met') {
        if (c.kind === 'manual') {
          // The user's own word is the only proof a manual check has. It can exist only after
          // the task stopped and the user wrote back (a resumed leg); before, a manual
          // criterion could never be met, so such a task could never complete. A merely
          // resumed leg is not enough: automatic continuations resume too, with no user
          // message behind them, so the leg must be one a user message started (#33).
          if (!this.manualLeg) throw new Error(c.id + ' needs user confirmation; report unknown or blocked.');
          // The leg being user-started is not enough on its own: the criterion must
          // first have been reported unknown/blocked, i.e. the task actually stopped
          // and asked, and this leg is the user's answer to that stop. A brand-new
          // task's manual criterion has no such stop behind it.
          if (!c.awaitingConfirm) throw new Error(c.id + ' needs user confirmation; report unknown or blocked first, so the task stops and the user can confirm.');
          // confirmedRevision is what lets a later change expire this 'met' (fix in
          // observe): with evidence [] the usual expiry check could never fire.
          return {...c, status: 'met', evidence: [], reason: reason.slice(0, 1000), awaitingConfirm: false, confirmedRevision: this.revision};
        }
        const proof = refs.map(id => this.evidence.find(e => e.id === id));
        if (!proof.length) throw new Error(c.id + ' needs successful, current verification tool evidence: cite at least one evidence ID.');
        const problems = refs.map(id => this.evidenceProblem(id)).filter(Boolean);
        if (problems.length) throw new Error(c.id + ' needs successful, current verification tool evidence: ' + problems.join('; ') + '.');
        if (c.kind === 'command' && !proof.some(e => provesCommand(e, c))) {
          // When the same command DID run successfully but in another directory or
          // shell, say so: naming only the command sent Muse re-running it in the
          // same wrong place.
          const mismatch = proof.some(e => e && e.usable && (e.commandHash ? e.commandHash === commandHash(c.command) : e.verificationCommand === c.command));
          throw new Error(c.id + ' needs a successful execution of its exact verification command: ' + c.command +
            (mismatch ? ' (a successful run of this command exists, but its cwd/shell do not match the criterion\'s cwd/shell)' : ''));
        }
        // Weakness 8: evidence that is only a read of a memo this task
        // itself wrote cannot prove an implementation or behaviour
        // criterion — unless the criterion itself is about that file
        // ("write the issues in notes.md" is proven by reading notes.md).
        // One genuine (non-self-authored) piece of evidence alongside it
        // is enough: the memo is then only supporting evidence.
        if (c.kind === 'inspection' && proof.every(e => e && e.selfAuthored) &&
          !proof.some(e => (e.paths || []).some(p => criterionNamesFile(c.text, p)))) {
          const files = [...new Set(proof.flatMap(e => e.paths || []))].join(', ');
          throw new Error(c.id + ' cannot be met by reading a file this task itself wrote (' + files + '): prove it with the code, a test, or a command result, not your own notes.');
        }
      }
      // Reporting a manual criterion unknown/blocked is the stop that asks the user:
      // it arms the confirmation a later user-started leg may act on.
      if (c.kind === 'manual' && (entry.status === 'unknown' || entry.status === 'blocked'))
        return {...c, status: entry.status, evidence: refs, reason: reason.slice(0, 1000), awaitingConfirm: true};
      return {...c, status: entry.status, evidence: refs, reason: reason.slice(0, 1000)};
    });
    this.criteria = next; this.reviewed = true; this.legReported = true; this.legCheckpointed = true;
    this.criteriaAllMet = next.every(c => c.status === 'met');
    return this.snapshot();
  }
  stop(status, reason) {
    this.status = status; this.reason = clean(reason);
    // Every needs_input stop is a wait for the user, whichever branch reached it:
    // callers resume this task on the next message based on this flag.
    if (status === 'needs_input') this.awaitingInput = true;
    // Weakness 9: an error stop leaves a why line. Complete / needs_input /
    // limit / stalled / inactive stops are endRound decisions, not errors,
    // so they log only there.
    if (status === 'blocked' || status === 'stopped') this._log('stop', {decision: status, why: status, detail: {reason: this.reason.slice(0, 500)}});
    return {continue: false, status, reason: this.reason};
  }
  // Weakness 9: the round's end leaves a why line — which branch it took and
  // the values that decided it (workers, the met / unmet / unknown / blocked
  // counts, the stalled count, the signature, round / maxRounds).
  endRound(opts = {}) {
    const before = {question: !!this.question, halted: this.halted,
      resumedPark: this.resumed && !opts.workersPending && !opts.backgroundPending && this.revision === this.legRevision && !this.legReported && !this.legEngaged};
    const result = this._endRound(opts);
    const counts = {met: 0, unmet: 0, unknown: 0, blocked: 0};
    for (const c of this.criteria) if (counts[c.status] != null) counts[c.status]++;
    const detail = {workersPending: !!opts.workersPending, backgroundPending: !!opts.backgroundPending, ...counts,
      stalled: this.stalled, signature: this.lastSignature, round: this.round, maxRounds: this.maxRounds};
    let why = 'unmet_left';
    if (result.status === 'complete') why = 'all_met';
    else if (result.status === 'stalled') why = 'stalled_no_progress';
    else if (result.status === 'limit') why = 'round_limit';
    else if (result.status === 'inactive') why = this.criteria.length ? 'not_a_tracked_task' : 'no_criteria';
    else if (result.status === 'needs_input') why = before.halted ? 'halted_declined' : before.question ? 'awaiting_user_answer' : before.resumedPark ? 'no_work_this_leg' : opts.pendingUserInput ? 'user_message_waiting' : (counts.unmet === 0 && (counts.unknown || counts.blocked)) ? 'manual_only_left' : 'needs_input';
    else if (result.status === 'running') why = opts.workersPending ? 'workers_pending' : opts.backgroundPending ? 'background_pending' : !this.reviewed ? 'not_reviewed' : 'unmet_left';
    this._log('end_round', {decision: result.status, why, detail});
    return result;
  }
  _endRound({workersPending = false, backgroundPending = false, pendingUserInput = false} = {}) {
    if (workersPending || backgroundPending) this.required = true;
    if (this.halted) return this.stop('needs_input', this.reason);
    // Completion outranks a pending question: a task whose criteria are all met is done,
    // and an ask_user recorded along the way must not park it for an extra round (#35).
    if (!workersPending && !backgroundPending && this.criteria.length && (this.reviewed || this.criteriaAllMet) && this.criteria.every(c => c.status === 'met')) return this.stop('complete', t('すべての条件がツールによる証拠で確認できました。'));
    // A question outranks inactivity: ask_user before any plan/change still waits on the
    // user instead of being silently dropped as an untracked round (#34).
    if (this.question) { const q = this.question; this.question = ''; this.awaitingInput = true; return this.stop('needs_input', t('ユーザーの回答を待っています: ') + q); }
    if (!this.active) return this.stop('inactive', t('複数ステップの作業ではないため、完了追跡は行いません。'));
    // A resumed task whose follow-up turn changed nothing and reported nothing (a thank-you,
    // a side question) is not pushed into another round; it stays open for the next message.
    // A leg that reached for the task — a plan or checkpoint attempt, even a refused one —
    // is not that: it continues like any other unfinished work instead of parking here.
    if (this.resumed && !workersPending && !backgroundPending && this.revision === this.legRevision && !this.legReported && !this.legEngaged)
      return this.stop('needs_input', t('このメッセージではタスクの作業が行われなかったため、次のメッセージまで開いたままにします。'));
    if (pendingUserInput) { this.awaitingInput = true; return this.stop('needs_input', t('新しいユーザーメッセージが待機中です。タスクを続ける前にそちらへ対応してください。')); }
    // Waiting on the user only once nothing clear is left to do: an unmet criterion beside a
    // manual "unknown" one used to stop the task here instead of continuing the unmet work.
    // Running workers (or background runs) outrank it too: their results may settle the unknown criteria.
    if (!workersPending && !backgroundPending && this.reviewed && !this.criteria.some(c => c.status === 'unmet') && this.criteria.some(c => ['unknown', 'blocked'].includes(c.status)))
      // Each criterion's reason is flattened to one line first: a reason
      // containing a newline would otherwise read as another criterion's
      // line in this stop message (a fabricated 'c99: …' entry).
      return this.stop('needs_input', this.criteria.filter(c => ['unknown', 'blocked'].includes(c.status)).map(c => c.id + ': ' + String(c.reason || '').replace(/[\r\n]+/g, ' ')).join('\n'));
    // Waiting on task agents — or on a background run this task started — is not
    // inactivity, and it is not the round budget being spent either: while either
    // is still running, the stalled judgment and the round limit do not advance
    // — the leg continues so their results are collected here, not forfeited.
    // (If the leg still ends another way, sendFocused no longer stops the workers
    // with it; a later leg or the resumption collects them instead.) Weakness 4
    // (2026-11-06): before, only workers counted, so a round that only checked
    // shell.output on a running test went stalled and burned a leg.
    if (workersPending || backgroundPending) { this.reason = backgroundPending && !workersPending ? t('バックグラウンド実行がまだ動作中です。完了を報告する前に結果を回収してください。') : t('タスクエージェントがまだ作業中です。完了を報告する前に結果を回収してください。'); return {continue: true, status: 'running', reason: this.reason}; }
    const signature = JSON.stringify([this.progressRevision, this.criteria.filter(c => c.status === 'met').map(c => c.id)]);
    this.stalled = signature === this.lastSignature ? this.stalled + 1 : 0; this.lastSignature = signature;
    if (this.stalled >= 1) return this.stop('stalled', t('2ラウンド続けて、新しく確認できた条件も成功した変更操作もありません。'));
    if (this.round >= this.maxRounds) return this.stop('limit', t('自動続行のラウンド上限に達しました。'));
    // Broad fix (2026-11-04, hung bg-notification session 69ba…): a round with no
    // criteria at all must not continue to another round, even when a state-changing
    // tool made the task "required". A question, a halt, a resumed park, pending user
    // input and waiting workers are all handled above, and the round cap above, so
    // reaching here with no criteria means the model had a round to plan and did not:
    // end the turn as inactive instead of prompting it again and waiting on a reply
    // that may never arrive. The cost is deliberate: a task whose model forgets to
    // plan no longer gets a second round to plan in.
    if (!this.criteria.length) return this.stop('inactive', t('完了条件がまだ記録されていません。'));
    this.reason = workersPending ? t('タスクエージェントがまだ作業中です。完了を報告する前に結果を回収してください。') : !this.reviewed ? t('完了の証拠がまだ提出されていません。') : t('未達成の条件が残っています。');
    return {continue: true, status: 'running', reason: this.reason};
  }
  prompt() {
    // A leg the user's own follow-up started ("keep finding until I say OK") carries that
    // message too: rounds 2+ used to restate only the original request, so the follow-up
    // that reopened the task was missing from every later continuation (2026-11-05 night).
    const followUp = this.resumed && this.legFromUser && this.legGoal ? '\n\nThe user\'s latest message in this task (it wins where it conflicts with the request above):\n' + this.legGoal.slice(0, 2000) : '';
    return '[muser Focus task: same goal, same session. Original user request follows; do not add scope of your own or change existing completion criteria.]\n' + this.goal + followUp +
      '\n\nFocus state:\n' + JSON.stringify(this.modelState()) +
      '\nContinue only clear unfinished work. If one way to a criterion fails, try the other reasonable safe ways first; only when none is left, report unknown/blocked with its reason and stop. Do not retry declined actions. In your reply, use plain words, not Focus terms (c1, met, blocked, checkpoint, leg, round). A message the user sent while you worked is part of this task and wins where it conflicts with the request above; if it asks you to stop or wait, call focus.ask_user instead of continuing.';
  }
  // What Muse is handed (continuation prompt, focus.* results): the evidence it can still cite,
  // not the whole log — 300 entries made every continuation prompt ~100 KB.
  modelState() {
    const s = this.snapshot(), current = s.evidence.filter(e => e.usable && this.evidenceCurrent(e));
    // The older still-current evidence keeps its IDs listed (compactly) even though
    // its entries are trimmed: an ID Muse cannot see is an ID it cannot cite.
    return {...s, evidence: current.slice(-40), ...(current.length > 40 ? {olderCurrentEvidence: current.length - 40, olderCurrentEvidenceIds: current.slice(0, current.length - 40).map(e => e.id)} : {})};
  }
  snapshot() {
    return JSON.parse(JSON.stringify({id: this.id, goal: this.goal, status: this.status, reason: this.reason, round: this.round, maxRounds: this.maxRounds,
      criteria: this.criteria, evidence: this.evidence, revision: this.revision, rev: this.rev, ask: this.ask || null}));
  }
  // Full Focus state as plain JSON, for the per-session side file (weakness 3,
  // 2026-11-06): everything a resumed leg needs — goal, criteria, evidence,
  // revisions, leg flags — with nothing trimmed, unlike snapshot()/modelState().
  // The background map is deliberately NOT saved: shells running when the window
  // closed are gone, and their criteria stay unmet until re-checked. The copy
  // is detached, so mutating the saved form cannot corrupt the live task.
  serialize() {
    return JSON.parse(JSON.stringify({v: 1, rev: this.rev, id: this.id, goal: this.goal, maxRounds: this.maxRounds, automatic: this.automatic,
      round: this.round, status: this.status, reason: this.reason,
      criteria: this.criteria, evidence: this.evidence,
      revision: this.revision, changes: this.changes, progressRevision: this.progressRevision,
      operations: this.operations, nextEvidence: this.nextEvidence, required: this.required,
      reviewed: this.reviewed, stalled: this.stalled, lastSignature: this.lastSignature,
      halted: this.halted, awaitingInput: this.awaitingInput,
      resumed: this.resumed, leg: this.leg, legRevision: this.legRevision, legReported: this.legReported,
      legGoal: this.legGoal, question: this.question, ask: this.ask, interruptedQuestion: this.interruptedQuestion,
      legEngaged: this.legEngaged, legFromUser: this.legFromUser, manualLeg: this.manualLeg,
      legCheckpointed: this.legCheckpointed, criteriaAllMet: this.criteriaAllMet,
      sessionCwd: this.sessionCwd}));
  }
  // Rebuild a Focus from serialize()'s form. Garbage is refused loudly — the
  // caller (Agent.loadResumeFocus) treats that as "no saved task" — and every
  // field falls back to the constructor default when its saved shape is wrong,
  // so a hand-edited file can never produce a half-wired task.
  // Wave 18: the gate follows that same fallback policy instead of refusing
  // the whole task for shapes an older or newer build legitimately writes.
  // A criteria/evidence/changes list that is ABSENT (the initial form had no
  // changes list at all) falls back to the empty default below; a list that
  // is present in the wrong shape (a string, an object, null) is still
  // refused, as are a non-object state, a goal that is not a string, and a
  // version that is not a positive integer. Version 1 and any LATER version
  // are accepted: a newer build's file must not lose the task on downgrade,
  // and fields this build does not know are simply never read.
  static restore(data, {sessionCwd = '', sharedBackground = null} = {}) {
    if (!data || typeof data !== 'object' || !Number.isInteger(data.v) || data.v < 1 || typeof data.goal !== 'string'
      || (data.criteria !== undefined && !Array.isArray(data.criteria))
      || (data.evidence !== undefined && !Array.isArray(data.evidence))
      || (data.changes !== undefined && !Array.isArray(data.changes)))
      throw new Error('Invalid Focus state.');
    const f = new Focus(data.goal, {maxRounds: data.maxRounds, automatic: !!data.automatic, sessionCwd: sessionCwd || data.sessionCwd || '', sharedBackground});
    const num = (v, d) => Number.isFinite(v) ? v : d;
    const str = (v, d = '') => typeof v === 'string' ? v : d;
    const bool = v => !!v;
    f.id = str(data.id, f.id);
    f.round = num(data.round, 0); f.status = ['running', 'complete', 'stopped', 'needs_input', 'limit', 'stalled', 'blocked', 'inactive'].includes(data.status) ? data.status : 'running';
    f.reason = str(data.reason);
    // Element shapes are validated too: a null or string entry inside
    // criteria/evidence used to restore 'successfully' and then crash every
    // leg (resumeNote/beginRound/modelState reading fields of null). Entries
    // that are not objects with the fields the rest of the class reads are
    // dropped; a criterion without a usable id/text cannot be checked, so it
    // cannot stay either.
    const objArray = v => (Array.isArray(v) ? v.filter(e => !!e && typeof e === 'object') : []);
    f.evidence = objArray(data.evidence).filter(e => typeof e.id === 'string');
    f.changes = objArray(data.changes);
    f.criteria = objArray(data.criteria).filter(c => typeof c.id === 'string' && typeof c.text === 'string').map(c => ({...c, kind: ['inspection', 'command', 'manual'].includes(c.kind) ? c.kind : 'inspection', status: typeof c.status === 'string' ? c.status : 'pending', evidence: Array.isArray(c.evidence) ? c.evidence.filter(id => typeof id === 'string') : []}));
    f.revision = num(data.revision, 0); f.progressRevision = num(data.progressRevision, 0);
    f.rev = Number.isFinite(data.rev) && data.rev > 0 ? Math.floor(data.rev) : 0; // a pre-rev file (or a hand edit) reads as version 0
    f.operations = num(data.operations, 0); f.nextEvidence = num(data.nextEvidence, 1); f.required = bool(data.required);
    f.reviewed = bool(data.reviewed); f.stalled = num(data.stalled, 0); f.lastSignature = str(data.lastSignature);
    f.halted = bool(data.halted); f.awaitingInput = bool(data.awaitingInput);
    f.resumed = bool(data.resumed); f.leg = num(data.leg, 0); f.legRevision = num(data.legRevision, 0); f.legReported = bool(data.legReported);
    f.legGoal = str(data.legGoal); f.question = str(data.question); f.interruptedQuestion = str(data.interruptedQuestion);
    // The saved ask is not trusted either (wave 14): restore used to accept any
    // object, so a hand-edited/corrupt side file whose ask the picker can never
    // show (no options, an empty-options entry, no question text) restored into
    // needs_input with a question that could never be answered or even named.
    // Re-run it through normalizeAsk — the same validation askUser enforces on
    // the producing side (the saved form is its {questions:[…]} output; a flat
    // {question, options} shape is judged as the ask_user call it resembles) —
    // and keep only what passes, in the normalised form the producer writes.
    // A save written by serialize() always passes; only a hand-edited or
    // corrupt one hits the drop: the ask, its plain question text and the
    // needs_input wait that rested on it go together, leaving the state a task
    // that ended its round without a question has (running, not awaiting
    // input), so the rest of the task continues exactly as before. (No error
    // is surfaced here, so askSuppliesQuestion's error-wording distinction
    // for live ask_user calls does not apply to the drop.)
    f.ask = null;
    if (data.ask && typeof data.ask === 'object') {
      try {
        const valid = normalizeAsk(str(data.ask.question), data.ask);
        if (!valid) throw new Error('The saved ask carries no structured question.');
        f.ask = valid;
      } catch {
        f.question = '';
        if (f.status === 'needs_input') { f.status = 'running'; f.awaitingInput = false; }
      }
    }
    f.legEngaged = bool(data.legEngaged); f.legFromUser = bool(data.legFromUser); f.manualLeg = bool(data.manualLeg);
    f.legCheckpointed = bool(data.legCheckpointed); f.criteriaAllMet = bool(data.criteriaAllMet);
    // The saved shape of criteria/evidence themselves is not trusted either: a
    // 'met' the checkpoint could never have produced must not survive a restore.
    // A non-manual 'met' stands only on cited evidence that is in the restored
    // evidence list and not marked unusable; a manual 'met' stands only on the
    // user confirmation a checkpoint records (confirmedRevision). Anything else
    // goes back to pending, so a hand-edited file can never restore into an
    // evidence-free 'complete'. Evidence IDs are likewise kept unique going
    // forward: nextEvidence moves past the largest restored ID.
    let maxEvidence = 0;
    for (const e of f.evidence) {
      const m = e && typeof e.id === 'string' ? /^e(\d+)$/.exec(e.id) : null;
      if (m) maxEvidence = Math.max(maxEvidence, Number(m[1]));
    }
    f.nextEvidence = Math.max(f.nextEvidence, maxEvidence + 1);
    let demoted = false;
    f.criteria = f.criteria.map(c => {
      if (!c || typeof c !== 'object' || c.status !== 'met') return c;
      const refs = Array.isArray(c.evidence) ? c.evidence : [];
      // Freshness counts too (wave 8): a 'met' whose cited evidence has since
      // expired — a later change touched what it covers, or the change log's
      // window slid past it — revived as-is and restored into 'complete'.
      // evidenceCurrent is the same check observe() and checkpoint() apply,
      // and every cited item must still stand, as a checkpoint would require.
      // A manual 'met' likewise stands only while no later tree-changing
      // change postdates its confirmation (manualExpired, observe()'s rule).
      const proven = c.kind === 'manual'
        ? Number.isFinite(c.confirmedRevision) && !f.manualExpired(c.confirmedRevision)
        : refs.length > 0 && refs.every(id => { const e = f.evidence.find(x => x && x.id === id); return !!e && e.usable !== false && f.evidenceCurrent(e); });
      if (proven) return c;
      demoted = true;
      return {...c, status: 'pending', evidence: []};
    });
    if (demoted) {
      f.criteriaAllMet = false;
      if (f.status === 'complete') f.status = 'running';
    }
    return f;
  }
}

module.exports = {Focus, INSTRUCTION, DEFINITIONS, focusReadOnlyCommand, focusReadPaths, focusTreeNeutralCommand, focusTreeNeutralSubcommands};
