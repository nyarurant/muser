'use strict';
// One logical task, one Muse session. Evidence is captured by the executor, never invented
// by the model. The model still interprets whether an observation meets a requirement.
const crypto = require('node:crypto');
const {readOnlyCommand} = require('./policy');
const {t} = require('./i18n');

const INSTRUCTION = 'AUTOMATIC FOCUS: For code changes or tasks requiring multiple actions, call focus.plan (agent="main") before doing the work. Supply a JSON array of completion criteria with text and kind="inspection", "command", or "manual". For command criteria supply the exact verification command. Preserve every requirement in the original request; do not change scope. Ordinary questions and single simple reads need no plan. Completion tracking stays in this main session; no separate reviewer is needed. Collect any work agents before claiming completion. Successful reads, searches and command runs return muser_evidence_id: use those IDs in focus.checkpoint to report EVERY criterion as met, unmet, unknown, or blocked, with a short reason. Command criteria need an actual successful execution of the declared command (a run that went to the background counts once shell.output shows it finished with exit code 0); inspections need relevant successful tool evidence. Builds or tests alone do not prove a visible behavior changed. Use manual for user-only/real-device checks you cannot observe; report unknown and explain what is needed. Never mark a manual criterion met yourself; only after the user confirms it in their own message may you report it met, quoting what they said. Before your final response call focus.checkpoint, report what was verified and what remains unknown, and do not claim success for unmet criteria. Continue clear unfinished work: the turn ends only when the task is complete — a leg that stops at its round or time limit, or with no verified progress, is continued automatically in a new leg with the same criteria, so never wrap up or summarise as if the work were finished while criteria remain unmet; stop and explain only when blocked or unable to verify. When you need the user\'s answer or decision, call focus.ask_user with the question instead of guessing; muser then waits for them. When the possible answers are a known set, pass options (or questions for several related choices at once) to focus.ask_user so the user can pick from a menu instead of typing.';

const DEFINITIONS = {
  'focus.plan': {description: 'Record the completion criteria for the current task, without changing the user goal. Define once before work; existing criteria cannot be removed or changed, but new ones may be appended when the user clarifies the task.',
    required: {criteria: {type: 'string', description: 'JSON array: [{"text":"requirement","kind":"inspection|command|manual","command":"exact verification command, for command criteria","cwd":"working directory that command must run in (optional)","shell":"shell that command must run in (optional)"}]. A run in a different directory or shell does not verify a command criterion. IDs c1, c2... are returned.'}}, optional: {new_task: {type: 'boolean', description: 'Only when the user\'s message after an unfinished task starts a DIFFERENT task: true replaces that task with this one. Never use it to drop or weaken criteria of the same task.'}}},
  'focus.checkpoint': {description: 'Attach actual observations to every completion criterion before ending a focused task. This does not end the turn. Manual/unobservable checks must be unknown or blocked.',
    required: {checks: {type: 'string', description: 'JSON array, one entry per criterion: [{"id":"c1","status":"met|unmet|unknown|blocked","evidence":["e1"],"reason":"what was observed or what is needed"}]. Use focus.status to retrieve evidence IDs.'}}, optional: {}},
  'focus.ask_user': {description: 'You need the user\'s answer or decision before going on (which option, a missing value, permission for something risky): record the question here and end the turn. muser then waits for the user instead of continuing automatically; their reply resumes this task. When the answers are a known set, pass options (or questions, for up to 4 related questions at once): muser shows a selectable question UI (single or multi select, descriptions, previews) and the picks come back as the user\'s reply. Without options it is a plain question: ask it in your reply text.',
    required: {question: {type: 'string', description: 'The question, as you will ask it.'}}, optional: {options: {type: 'string', description: 'JSON array of 2-6 choices for this question: [{\"label\":\"...\",\"description\":\"optional one-liner\",\"preview\":\"optional multi-line text shown beside the choice\"}].'}, multi: {type: 'boolean', description: 'With options: true lets the user pick several.'}, questions: {type: 'string', description: 'JSON array of up to 4 questions at once: [{\"header\":\"short tab label\",\"question\":\"...\",\"multi\":false,\"options\":[{\"label\":\"...\"}]}]. Overrides question/options.'}}},
  'focus.status': {description: 'Read the original goal, completion criteria and recent evidence of the current task.', required: {}, optional: {}},
};

const clean = value => String(value || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').trim();
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
function changesState(call) {
  return call.kind === 'edit' || (call.kind === 'mcp' && call.mcp?.readOnly !== true) ||
    (call.command === 'system.run' && !readOnlyCommand(call.params?.command));
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
  if (!x || !y) return x === y;
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/') || x.endsWith('/' + y) || y.endsWith('/' + x);
}
// The working directory a run used, normalised; '' is the session default directory. A
// `.` names the default too (deep #64).
const normDir = value => normPath(clean(value));
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
// The paths a piece of evidence covers; null when it is not tied to paths (system.run),
// which keeps such evidence expiring on any later change, as before.
function observedPaths(call) {
  const p = call.params?.path;
  return /^code\.(read|grep|glob)$/.test(call.command) && typeof p === 'string' && p ? [p] : null;
}

class Focus {
  constructor(goal, {maxRounds = 3, automatic = true} = {}) {
    if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 10) throw new Error('Invalid Focus round limit.');
    // Not writable: only a new task (plan with new_task in a resumed leg) replaces the goal.
    Object.defineProperty(this, 'goal', {value: String(goal), enumerable: true, configurable: true});
    this.id = crypto.randomUUID(); this.maxRounds = maxRounds; this.automatic = automatic;
    this.round = 0; this.status = 'running'; this.reason = ''; this.criteria = []; this.evidence = [];
    this.revision = 0; this.changes = []; this.progressRevision = 0; this.operations = 0; this.nextEvidence = 1; this.required = !automatic;
    this.reviewed = false; this.stalled = 0; this.lastSignature = ''; this.halted = false; this.awaitingInput = false;
    this.resumed = false; this.legRevision = 0; this.legReported = false; this.legGoal = ''; this.question = ''; this.ask = null; this.legEngaged = false;
    this.legFromUser = false; this.manualLeg = false; // this leg was started by a real user message (not an automatic continuation)
    this.background = new Map(); // shell id -> {command, revision}: runs that went to the background
  }
  get active() { return this.required || this.criteria.length > 0; }
  beginRound() { this.round++; this.reviewed = false; }
  // A new leg of the same task, started by the user's next message after this task
  // stopped for their input (or unfinished at its round limit): criteria, evidence
  // and revision carry over — only the round budget and the review flag start fresh.
  resumeLeg(nextGoal = '', {fromUser = true} = {}) {
    this.round = 0; this.status = 'running'; this.reason = ''; this.reviewed = false; this.stalled = 0; this.lastSignature = ''; this.awaitingInput = false;
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
      '\nIf the message below continues that task, keep these criteria (append new ones with focus.plan if the user added requirements) and report them with focus.checkpoint. If it is a different task, call focus.plan with new_task=true and that task\'s criteria. If it needs no work (thanks, a side question), just answer.]';
  }
  // Muse waits on the user. Without this, a clarifying question ended the round like any
  // unfinished work and Focus sent "continue" — Muse then guessed the answer or asked again.
  askUser(question, opts = {}) {
    const q = clean(question);
    if (!q) throw new Error('Give the question you are asking the user.');
    const ask = normalizeAsk(q, opts); // throws on a bad shape, before anything is recorded
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
  plan(value, {newTask = false} = {}) {
    // Even a refused re-plan is engagement with this task: the leg tried to work on it,
    // so endRound must not mistake it for a side-question leg that did nothing.
    this.legEngaged = true;
    const items = array(value).map((item, i) => {
      const text = clean(item?.text), kind = item?.kind, command = clean(item?.command);
      if (!text || text.length > 1000 || !['inspection', 'command', 'manual'].includes(kind) || (kind === 'command' && !command))
        throw new Error('Each criterion needs text and kind inspection, command, or manual; command checks need the exact command.');
      // A command criterion is verified by a run of its command in its directory and
      // shell: cwd/shell are part of the criterion's identity (default directory/shell
      // when omitted), never of its display text (deep #64).
      const cwd = kind === 'command' ? normDir(item?.cwd) : '', shell = kind === 'command' ? normShell(item?.shell) : '';
      return {id: 'c' + (i + 1), text, kind, ...(kind === 'command' ? {command, ...(cwd ? {cwd} : {}), ...(shell ? {shell} : {})} : {}), status: 'pending', evidence: [], reason: ''};
    });
    if (!this.criteria.length) { this.criteria = items; this.required = true; this.legReported = true; return this.snapshot(); }
    // Existing criteria are fixed: the list may only GROW. A re-plan that keeps every
    // recorded criterion verbatim and appends new ones (the user clarified the task)
    // is accepted; removing, reordering or editing one is still refused.
    const kept = items.length >= this.criteria.length && this.criteria.every((c, i) => items[i].text === c.text && items[i].kind === c.kind && items[i].command === c.command && (items[i].cwd || '') === (c.cwd || '') && (items[i].shell || '') === (c.shell || ''));
    if (!kept && newTask && this.resumed && this.legFromUser && !this.legReported && this.legGoal) {
      // The follow-up is another task: it becomes the goal, with its own criteria. Only a
      // leg a real user message started may do this (legFromUser): the model's new_task
      // flag alone, on an automatic leg, must not drop the standing criteria (#36). Evidence
      // (and its IDs) carry on, so nothing Muse was already handed changes meaning.
      Object.defineProperty(this, 'goal', {value: this.legGoal, enumerable: true, configurable: true});
      Object.assign(this, {id: crypto.randomUUID(), criteria: items, required: true, resumed: false, legGoal: '', reviewed: false, stalled: 0, lastSignature: '', legReported: true});
      return this.snapshot();
    }
    if (!kept) throw new Error('Completion criteria are fixed for this task: existing criteria cannot be removed or changed, but new ones may be appended. Ask the user to clarify the goal instead of removing or weakening a criterion.' +
      (this.resumed && !this.legReported ? ' If the user\'s latest message is a different task, call focus.plan with new_task=true.' : ''));
    this.legReported = true;
    if (items.length === this.criteria.length) return this.snapshot();
    this.criteria = [...this.criteria, ...items.slice(this.criteria.length)];
    this.reviewed = false; // the appended criteria have not been reported yet
    return this.snapshot();
  }
  observe(call, result) {
    if (/^(todo\.|skill\.|shell\.list)/.test(call.command)) return null;
    this.operations++;
    if (call.declined) { this.halted = true; this.required = true; this.reason = t('コマンドが却下されました。ユーザーの入力が必要です。'); }
    // Running a criterion's own declared verification command checks the work rather than
    // changing it: counting it as a change of unknown scope made two command criteria
    // (build + publish) expire each other's evidence, so the task could never be closed.
    // They still count as a change for what files say (a publish rewrites its output folder,
    // so a listing taken before it is stale) — only other command results stay current.
    // The run's identity is command + directory + shell: the same words elsewhere are an
    // ordinary change, not this criterion's verification (deep #64).
    const runCommand = call.command === 'system.run' ? clean(call.params?.command) : '';
    const runCwd = call.command === 'system.run' ? normDir(call.params?.cwd) : '';
    const runShell = call.command === 'system.run' ? normShell(call.params?.shell) : '';
    const verification = call.command === 'system.run' && this.criteria.some(c => c.kind === 'command' && c.command === runCommand && (c.cwd || '') === runCwd && (c.shell || '') === runShell);
    if (changesState(call)) {
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
        let reset = false;
        this.criteria = this.criteria.map(c => {
          if (c.status !== 'met') return c;
          const stale = c.evidence.some(id => { const e = this.evidence.find(x => x.id === id); return !e || !this.evidenceCurrent(e); });
          if (!stale) return c;
          reset = true;
          return {...c, status: 'pending', evidence: [], reason: t('確認のあとで変更がありました。再度確認してください。')};
        });
        if (reset) this.reviewed = false;
      }
    }
    const payload = result.payload || {};
    // A run that went to the background (asked for, or moved there at its timeout) proves
    // nothing yet; shell.output of it after it ends with exit code 0 is that command's
    // evidence, dated from when it started. Before, such a command criterion could never be met.
    if (call.command === 'system.run' && payload.shell_id && result.ok) this.background.set(String(payload.shell_id), {command: runCommand, cwd: runCwd, shell: runShell, revision: this.revision});
    const bg = call.command === 'shell.output' && result.ok && payload.running === false ? this.background.get(String(payload.id)) : null;
    const ok = !!result.ok && (call.command !== 'system.run' || (payload.exit_code === 0 && !payload.killed && !payload.shell_id)) && (call.command !== 'shell.output' || (!!bg && payload.exit_code === 0));
    if (call.command === 'system.run') {
      this.criteria = this.criteria.map(c => {
        if (c.kind !== 'command' || c.command !== runCommand || (c.cwd || '') !== runCwd || (c.shell || '') !== runShell || c.status !== 'met') return c;
        this.reviewed = false;
        return {...c, status: 'pending', evidence: [], reason: t('検証コマンドが再実行されました。最新の結果を報告してください。')};
      });
    }
    const usable = ok && (/^code\.(read|grep|glob)$/.test(call.command) || call.command === 'system.run' || !!bg);
    // A run's evidence (direct, or a background run collected through shell.output) keeps
    // the command's identity — a 250-character head plus the full command's hash — and
    // the directory and shell it ran in, when they are not the defaults (deep #64, #67).
    const runOf = call.command === 'system.run' ? {command: runCommand, cwd: runCwd, shell: runShell} : bg ? {command: bg.command, cwd: bg.cwd || '', shell: bg.shell || ''} : null;
    const evidence = {id: 'e' + this.nextEvidence++, command: call.command, summary: clean(call.summary).slice(0, 250),
      ...(runOf ? {verificationCommand: runOf.command.slice(0, 250), commandHash: commandHash(runOf.command), ...(runOf.cwd ? {cwd: runOf.cwd} : {}), ...(runOf.shell ? {shell: runOf.shell} : {}), exitCode: payload.exit_code ?? null} : {}),
      ...(observedPaths(call) ? {paths: observedPaths(call)} : {}),
      ok, usable, revision: bg ? bg.revision : this.revision, round: this.round};
    this.evidence.push(evidence); if (this.evidence.length > 300) this.evidence.shift();
    return evidence.id;
  }
  // Whether one recorded change expires one piece of evidence. Path-tied evidence expires
  // only on a change that may have touched what it covers. Pathless evidence (a shell
  // run's answer) survives ONLY a declared verification run, and only when the evidence
  // is itself a verification run's: the exemption used to cover every shell observation,
  // so a directory listing taken before a publish stayed "current" through it (deep #63).
  expiredBy(e, ch) {
    if (!e.paths) return !(ch.verification && this.criteria.some(c => c.kind === 'command' && provesCommand(e, c)));
    return !ch.paths || ch.paths.some(p => e.paths.some(q => overlaps(p, q)));
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
          return {...c, status: 'met', evidence: [], reason: reason.slice(0, 1000)};
        }
        const proof = refs.map(id => this.evidence.find(e => e.id === id));
        if (!proof.length) throw new Error(c.id + ' needs successful, current verification tool evidence: cite at least one evidence ID.');
        const problems = refs.map(id => this.evidenceProblem(id)).filter(Boolean);
        if (problems.length) throw new Error(c.id + ' needs successful, current verification tool evidence: ' + problems.join('; ') + '.');
        if (c.kind === 'command' && !proof.some(e => provesCommand(e, c)))
          throw new Error(c.id + ' needs a successful execution of its exact verification command: ' + c.command);
      }
      return {...c, status: entry.status, evidence: refs, reason: reason.slice(0, 1000)};
    });
    this.criteria = next; this.reviewed = true; this.legReported = true; return this.snapshot();
  }
  stop(status, reason) { this.status = status; this.reason = clean(reason); return {continue: false, status, reason: this.reason}; }
  endRound({workersPending = false, pendingUserInput = false} = {}) {
    if (workersPending) this.required = true;
    if (this.halted) return this.stop('needs_input', this.reason);
    // Completion outranks a pending question: a task whose criteria are all met is done,
    // and an ask_user recorded along the way must not park it for an extra round (#35).
    if (!workersPending && this.criteria.length && this.reviewed && this.criteria.every(c => c.status === 'met')) return this.stop('complete', t('すべての条件がツールによる証拠で確認できました。'));
    // A question outranks inactivity: ask_user before any plan/change still waits on the
    // user instead of being silently dropped as an untracked round (#34).
    if (this.question) { const q = this.question; this.question = ''; this.awaitingInput = true; return this.stop('needs_input', t('ユーザーの回答を待っています: ') + q); }
    if (!this.active) return this.stop('inactive', t('複数ステップの作業ではないため、完了追跡は行いません。'));
    // A resumed task whose follow-up turn changed nothing and reported nothing (a thank-you,
    // a side question) is not pushed into another round; it stays open for the next message.
    // A leg that reached for the task — a plan or checkpoint attempt, even a refused one —
    // is not that: it continues like any other unfinished work instead of parking here.
    if (this.resumed && !workersPending && this.revision === this.legRevision && !this.legReported && !this.legEngaged)
      return this.stop('needs_input', t('このメッセージではタスクの作業が行われなかったため、次のメッセージまで開いたままにします。'));
    if (pendingUserInput) { this.awaitingInput = true; return this.stop('needs_input', t('新しいユーザーメッセージが待機中です。タスクを続ける前にそちらへ対応してください。')); }
    // Waiting on the user only once nothing clear is left to do: an unmet criterion beside a
    // manual "unknown" one used to stop the task here instead of continuing the unmet work.
    if (this.reviewed && !this.criteria.some(c => c.status === 'unmet') && this.criteria.some(c => ['unknown', 'blocked'].includes(c.status)))
      return this.stop('needs_input', this.criteria.filter(c => ['unknown', 'blocked'].includes(c.status)).map(c => c.id + ': ' + c.reason).join('\n'));
    // Waiting on task agents is not inactivity, and it is not the round budget being
    // spent either: while workers of this task are still running, the stalled
    // judgment and the round limit do not advance — the leg continues so their
    // results are collected here, not forfeited. (If the leg still ends another
    // way, sendFocused no longer stops the workers with it; a later leg or the
    // resumption collects them instead.)
    if (workersPending) { this.reason = t('タスクエージェントがまだ作業中です。完了を報告する前に結果を回収してください。'); return {continue: true, status: 'running', reason: this.reason}; }
    const signature = JSON.stringify([this.progressRevision, this.criteria.filter(c => c.status === 'met').map(c => c.id)]);
    this.stalled = signature === this.lastSignature ? this.stalled + 1 : 0; this.lastSignature = signature;
    if (this.stalled >= 1) return this.stop('stalled', t('2ラウンド続けて、新しく確認できた条件も成功した変更操作もありません。'));
    if (this.round >= this.maxRounds) return this.stop('limit', t('自動続行のラウンド上限に達しました。'));
    this.reason = workersPending ? t('タスクエージェントがまだ作業中です。完了を報告する前に結果を回収してください。') : !this.criteria.length ? t('完了条件がまだ記録されていません。') : !this.reviewed ? t('完了の証拠がまだ提出されていません。') : t('未達成の条件が残っています。');
    return {continue: true, status: 'running', reason: this.reason};
  }
  prompt() {
    return '[muser Focus task: same goal, same session. Original user request follows; do not add scope or change completion criteria.]\n' + this.goal +
      '\n\nFocus state:\n' + JSON.stringify(this.modelState()) +
      '\nContinue only clear unfinished work. If you cannot verify a criterion, report unknown/blocked with its reason and stop. Do not retry declined actions. A message the user sent while you worked is part of this task and wins where it conflicts with the request above; if it asks you to stop or wait, call focus.ask_user instead of continuing.';
  }
  // What Muse is handed (continuation prompt, focus.* results): the evidence it can still cite,
  // not the whole log — 300 entries made every continuation prompt ~100 KB.
  modelState() {
    const s = this.snapshot(), current = s.evidence.filter(e => e.usable && this.evidenceCurrent(e));
    return {...s, evidence: current.slice(-40), ...(current.length > 40 ? {olderCurrentEvidence: current.length - 40} : {})};
  }
  snapshot() {
    return JSON.parse(JSON.stringify({id: this.id, goal: this.goal, status: this.status, reason: this.reason, round: this.round, maxRounds: this.maxRounds,
      criteria: this.criteria, evidence: this.evidence, revision: this.revision, ask: this.ask || null}));
  }
}

module.exports = {Focus, INSTRUCTION, DEFINITIONS};
