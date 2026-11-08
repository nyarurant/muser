'use strict';
// Evidence badges (design §2): split a turn's reply into sentences, pick
// out the claims that have a fixed shape, and check each against the
// worklog of the same turn.
//   ✓ backed by the record · ? no backing in the record · ✗ contradicts it
// Sentences with no fixed-shape claim get NO mark (design §2 step 2:
// never over-claim). Rule-based only; the --deep Muse extraction of
// §2 step 3 is not implemented (see the DevNote's known limits).
//
// Stale evidence (§2, same idea as focus.js evidenceCurrent): evidence
// from before the turn's last relevant change does not count — a test run
// that predates the final change proves nothing about the final state.
// A "change" is not only an edit event: a system.run that may have
// rewritten files (focus.js changesState: a run that is not Focus-read-only
// and not tree-neutral) counts too, or a test passed before a generator
// script ran would still look fresh (audit wave 8, B11).
const {t} = require('../i18n.js');
let focusReadOnlyCommand = () => false, focusTreeNeutralCommand = () => false;
try { ({focusReadOnlyCommand, focusTreeNeutralCommand} = require('../focus.js')); } catch { /* every run then counts as a change: fail closed */ }

// --- sentences -------------------------------------------------------------
// Japanese and English terminators, one sentence per markdown line at most.
// The terminator stays on its sentence; list markers and heading marks go.
function splitSentences(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const clean = line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)/, '').trim();
    if (!clean) continue;
    // An ASCII '.' only ends a sentence before whitespace: the dot inside
    // a file name (src/a.js) must not split the sentence in two.
    for (const part of clean.split(/(?<=[。．！？!?])\s*|(?<=\.)\s+/)) {
      const s = part.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

// --- test counts -------------------------------------------------------------
// The shapes the main test tools print (design §2): node:test's
// "ℹ pass 128 / ℹ fail 0", mocha's "128 passing", jest's "128 passed",
// and the Japanese phrasings a reply uses ("テスト 128 件通過").
function parseTestCounts(text) {
  let s = String(text || '');
  // Number spellings first (wave 10): fullwidth digits read as halfwidth,
  // and a thousands separator between digits is part of the number, so
  // "10,000" is one count. A comma NOT between digits is a clause
  // separator and survives — it matters for the clause rule below.
  s = s.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  let prev;
  do { prev = s; s = s.replace(/(\d)[,，](?=\d)/g, '$1'); } while (s !== prev);
  // The LAST match of a shape wins, as in expect.js testCounts: a tool's
  // summary sits at the end of its output, and the reader's stored output
  // is head+tail, so a first-match read picks up a stale earlier summary
  // and the two judges disagree on the same output (features-debug #12).
  const pick = pats => { for (const p of pats) { const ms = [...s.matchAll(new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g'))]; if (ms.length) return Number(ms[ms.length - 1][1]); } return null; };
  // The Japanese 件 shapes are clause-local (wave 10): the gap between a
  // count and its keyword may not cross a clause separator (、, ， ;), may
  // not contain another count, and may not run through the OTHER side's
  // keyword. In 『テスト128件通過し、失敗は0件』 the old gap [^。]{0,6}
  // let the fail side borrow the pass side's 128 ("128件通過し、失敗");
  // the fail number must come from the clause near the failure mention
  // (『失敗は0件』), and the mirror-image borrowing is barred the same way.
  const gap = n => `(?:(?!(?:通過|合格|パス|失敗))[^0-9。\n、,，;；]){0,${n}}?`;
  const pass = pick([/pass(?:ed|ing)?[ \t]*:?[ \t]*(\d+)/i, /(\d+)[ \t]*(?:tests?[ \t]+)?pass(?:ed|ing)?\b/i,
    new RegExp(`(\\d+)\\s*件${gap(6)}(?:通過|合格|パス)`), new RegExp(`(?:通過|合格)${gap(4)}(\\d+)\\s*件`)]);
  const fail = pick([/fail(?:ed|ing|s)?[ \t]*:?[ \t]*(\d+)/i, /(\d+)[ \t]*fail(?:ed|ing|ures?)?\b/i,
    new RegExp(`(\\d+)\\s*件${gap(6)}失敗`), new RegExp(`失敗${gap(4)}(\\d+)\\s*件`)]);
  return {pass, fail};
}
const hasCounts = c => c.pass !== null || c.fail !== null;

// --- claim extraction ----------------------------------------------------------
const FILE_RE = /[\w@./\\-]+\.(?:mjs|cjs|js|ts|tsx|jsx|json|md|css|html|py|rs|cs|txt|ya?ml|toml)\b/g;
function extractClaims(sentence) {
  const s = String(sentence || ''), claims = [];
  // The 〜していません forms are NEGATED claims (wave 10): 『作成して
  // いません』『削除していません』『実行していません』『通過してい
  // ません』 say the thing did NOT happen, so judge() inverts them — a
  // record of the thing contradicts (✗), no record backs (✓). Only
  // these four stems: the dedicated no-error form (『エラーはありませ
  // ん』) is a different shape and keeps its own handling below.
  const negatedFile = /(?:作成|削除)していません/.test(s);
  const negatedRun = /実行していません/.test(s);
  const negatedPass = /通過していません/.test(s);
  const testy = /(テスト|\btest)/i.test(s);
  const counts = parseTestCounts(s);
  if ((testy || negatedPass) && (hasCounts(counts) || /(通過|通った|通りました|パス|pass)/i.test(s))) {
    claims.push({kind: 'test', pass: counts.pass, fail: counts.fail,
      allPassed: /(すべて|全部|全件|all)/i.test(s) && /(通過|通|パス|pass)/i.test(s),
      ...(negatedPass ? {negated: true} : {})});
  }
  const files = [...new Set(s.match(FILE_RE) || [])];
  if (files.length && /(直し|修正|変更|追加|作り|作成|書き|削除|消し|実装|直せ|治し)/.test(s)) {
    // A deletion claim is a claim about the record's op, not just its
    // path: judge() must not let an ordinary edit back "削除しました".
    claims.push({kind: 'file', files, ...(/(削除|消し)/.test(s) ? {op: 'delete'} : {}), ...(negatedFile ? {negated: true} : {})});
  }
  if (/(実行|流し|走らせ|ran\b|run\b)/i.test(s)) {
    const bt = /`([^`]{1,80})`/.exec(s);
    const known = /(npm\s+(?:test|run\s+\S+)|node\s+\S+|git\s+\S+|npx\s+\S+|dotnet\s+\S+|pytest\b|cargo\s+\S+)/i.exec(s);
    const token = bt ? bt[1].trim().split(/\s+/).slice(0, 3).join(' ') : known ? known[1].replace(/\s+/g, ' ') : '';
    if (token) claims.push({kind: 'command', token, ...(negatedRun ? {negated: true} : {})});
  }
  if (/(エラー|警告|失敗)(は|が)?\s*(ない|ありません|なし|ゼロ|0\s*件)/.test(s) || /\bno (errors?|warnings?|failures?)\b/i.test(s)) {
    claims.push({kind: 'no-error'});
  }
  return claims;
}

// --- judging -------------------------------------------------------------------
// The shell text a tool event ran: the worklog keeps it as the summary of
// a system.run (its params are not recorded); a live call carries it in
// params.command.
const shellTextOf = e => String((e.params && e.params.command) || (e.command === 'system.run' ? e.summary : '') || '');
const isSystemRun = e => e.type === 'tool' && (e.command === 'system.run' || typeof (e.params && e.params.command) === 'string');
// What counts as a change for freshness, aligned with focus.js: an edit
// event, or a system.run that may have changed files — i.e. not a
// Focus-read-only run (Get-Content, git log, …) and not a tree-neutral
// one (git add/commit/tag). An unrecognised run counts: fail closed.
function isChange(e) {
  if (e.type === 'edit') return true;
  if (!isSystemRun(e)) return false;
  const text = shellTextOf(e);
  return !focusReadOnlyCommand(text) && !focusTreeNeutralCommand(text);
}
function judge(claim, turn) {
  const events = turn.events || [];
  const lastChangeIdx = events.reduce((acc, e, i) => (isChange(e) ? i : acc), -1);
  // Evidence AT or after the last change is current. The slice starts AT
  // the boundary, not after it: the boundary event may itself be the
  // evidence (a test run is a system.run, hence a change in the sense
  // above), and excluding it would stale every passing test. A boundary
  // that is an edit event is filtered out by the type checks below.
  const after = lastChangeIdx < 0 ? events.slice() : events.slice(lastChangeIdx);
  const before = lastChangeIdx < 0 ? [] : events.slice(0, lastChangeIdx);
  if (claim.kind === 'test') {
    const runs = after.filter(e => e.type === 'tool').map(e => ({e, counts: parseTestCounts(e.output || '')})).filter(x => hasCounts(x.counts));
    if (claim.negated) {
      // 『通過していません』 (wave 10): a run that clearly passed
      // contradicts it (✗); a run that did not pass, or no passing
      // record at all, backs it (✓). Stale-only evidence stays '?' —
      // it says nothing about the final state either way.
      if (!runs.length) {
        const stale = before.some(e => e.type === 'tool' && hasCounts(parseTestCounts(e.output || '')));
        if (stale) return {mark: '?', reason: t('テストの記録はありますが、最後の変更より前なので古い証拠です')};
        return {mark: '✓', reason: t('テストが通過した記録がありません')};
      }
      const nActual = runs[runs.length - 1].counts;
      const nShown = [];
      if (nActual.pass !== null) nShown.push('pass ' + nActual.pass);
      if (nActual.fail !== null) nShown.push('fail ' + nActual.fail);
      if (nActual.pass !== null && nActual.pass > 0 && nActual.fail === 0) return {mark: '✗', reason: t('最後の変更より後に流したテストの出力と食い違います（実際: {actual}）', {actual: nShown.join(' / ')})};
      if ((nActual.fail !== null && nActual.fail > 0) || nActual.pass === 0) return {mark: '✓', reason: t('最後の変更より後に流したテストは通過していません（実際: {actual}）', {actual: nShown.join(' / ')})};
      return {mark: '?', reason: t('テストの出力から件数を読み取れませんでした')};
    }
    if (!runs.length) {
      const stale = before.some(e => e.type === 'tool' && hasCounts(parseTestCounts(e.output || '')));
      const anyTool = after.some(e => e.type === 'tool');
      if (stale) return {mark: '?', reason: t('テストの記録はありますが、最後の変更より前なので古い証拠です')};
      if (anyTool) return {mark: '?', reason: t('テストの出力から件数を読み取れませんでした')};
      return {mark: '?', reason: t('最後の変更より後にテストを流した記録がありません')};
    }
    const actual = runs[runs.length - 1].counts;
    const shown = [];
    if (actual.pass !== null) shown.push('pass ' + actual.pass);
    if (actual.fail !== null) shown.push('fail ' + actual.fail);
    if (claim.pass !== null && actual.pass !== null && claim.pass !== actual.pass) return {mark: '✗', reason: t('最後の変更より後に流したテストの出力と食い違います（実際: {actual}）', {actual: shown.join(' / ')})};
    if (claim.fail !== null && actual.fail !== null && claim.fail !== actual.fail) return {mark: '✗', reason: t('最後の変更より後に流したテストの出力と食い違います（実際: {actual}）', {actual: shown.join(' / ')})};
    // No vacuous matches (wave 10): pass 0 / fail 0 means no test ran
    // at all, so 『全件通過』 and 『0件通過』 have nothing behind them —
    // unjudged (?), never ✓. And a 『0件通過』 claim against a run
    // that DID fail is a contradiction (✗), even though the claimed
    // pass count itself matches the recorded 0.
    if (actual.pass === 0 && actual.fail === 0) return {mark: '?', reason: t('テストが1件も実行されていません（pass 0 / fail 0）')};
    if (claim.pass === 0 && actual.fail !== null && actual.fail > 0) return {mark: '✗', reason: t('最後の変更より後に流したテストの出力と食い違います（実際: {actual}）', {actual: shown.join(' / ')})};
    if ((claim.allPassed || claim.fail === 0) && actual.fail !== null && actual.fail > 0) return {mark: '✗', reason: t('最後の変更より後に流したテストの出力と食い違います（実際: {actual}）', {actual: shown.join(' / ')})};
    if (!claim.allPassed && claim.pass === null && claim.fail === null && actual.fail !== null && actual.fail > 0) return {mark: '✗', reason: t('最後の変更より後に流したテストの出力と食い違います（実際: {actual}）', {actual: shown.join(' / ')})};
    return {mark: '✓', reason: t('最後の変更より後に流したテストの出力と一致します（{actual}）', {actual: shown.join(' / ')})};
  }
  if (claim.kind === 'file') {
    // Path-aware, not basename-only: the claim 'src/a.js' must not be
    // backed by an edit to lib/a.js. A claim matches an edit when one
    // normalized path is the other or a path-suffix of it — so a bare
    // file name still matches wherever it lives, an absolute recorded
    // path backs a relative claim, and different folders never collide.
    const norm = p => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    // A deletion claim is backed only by a deletion record: the edit's op
    // must say so (code.apply_patch records op:'delete'; code.edit /
    // code.write record 'edit' / 'write' / 'create'). Other claims keep
    // the old rule — any recorded change to the path backs them, and a
    // record with no op at all (older logs) still counts there — because
    // "直しました" is honestly backed by any write to the file.
    const wantDelete = claim.deleted === true || /(?:^|\b)(?:delete|deleted|deletion|remove|removed)(?:\b|$)|削除/.test(String([claim.op, claim.action, claim.operation, claim.verb].filter(Boolean).join(' ')).toLowerCase());
    const isDeleteOp = e => /(?:delete|remove|unlink)/i.test(String(e.op || ''));
    const edits = turn.edits || [];
    const editedPaths = edits.filter(e => !wantDelete || isDeleteOp(e)).map(e => norm(e.path)).filter(Boolean);
    const backed = f => { const nf = norm(f); return editedPaths.some(ep => ep === nf || ep.endsWith('/' + nf) || nf.endsWith('/' + ep)); };
    const missing = claim.files.filter(f => !backed(f));
    if (claim.negated) {
      // 『作成していません』『削除していません』 (wave 10): a record
      // of exactly the denied change contradicts the sentence (✗);
      // its absence backs it (✓) — including a delete denial backed
      // by a mere edit, which for a POSITIVE delete claim is ✗ below.
      if (!missing.length) return {mark: '✗', reason: t('変更の記録があります')};
      if (wantDelete) return {mark: '✓', reason: t('そのファイルの削除記録がありません')};
      return {mark: '✓', reason: t('そのファイルの変更記録がありません')};
    }
    if (!missing.length) return {mark: '✓', reason: t('変更の記録があります')};
    const pathTouched = f => { const nf = norm(f); return edits.some(e => { const ep = norm(e.path); return !!ep && (ep === nf || ep.endsWith('/' + nf) || nf.endsWith('/' + ep)); }); };
    if (wantDelete && missing.some(pathTouched)) return {mark: '✗', reason: t('そのファイルの削除記録がありません（削除ではない変更の記録だけがあります）')};
    if (edits.length) return {mark: '✗', reason: t('そのファイルの変更記録がありません（ほかのファイルの変更だけがあります）')};
    return {mark: '?', reason: t('変更の記録がありません')};
  }
  if (claim.kind === 'command') {
    const token = claim.token.toLowerCase();
    const matches = e => [e.command, e.summary, e.params && e.params.command].some(v => String(v || '').toLowerCase().includes(token));
    // The same freshness rule as a test claim (wave 8, B2): an execution
    // from before the last change does not back "実行しました" — the
    // state it ran against is gone. `after` starts at the last change,
    // so the execution that IS the last change still counts, as does
    // any run after it. A turn built without an event list (direct
    // judge calls) has no order to judge by: its tool list stands.
    if (claim.negated) {
      // 『実行していません』 (wave 10): a current execution record
      // contradicts the sentence (✗); no record backs it (✓); a
      // stale-only record stays '?' like the positive form.
      if (!events.length) {
        return (turn.tools || []).some(matches) ? {mark: '✗', reason: t('コマンドの実行記録があります')} : {mark: '✓', reason: t('コマンドの実行記録がありません')};
      }
      if (after.some(e => e.type === 'tool' && matches(e))) return {mark: '✗', reason: t('コマンドの実行記録があります')};
      if (before.some(e => e.type === 'tool' && matches(e))) return {mark: '?', reason: t('コマンドの実行記録はありますが、最後の変更より前なので古い証拠です')};
      return {mark: '✓', reason: t('コマンドの実行記録がありません')};
    }
    if (!events.length) {
      return (turn.tools || []).some(matches) ? {mark: '✓', reason: t('コマンドの実行記録があります')} : {mark: '?', reason: t('コマンドの実行記録がありません')};
    }
    if (after.some(e => e.type === 'tool' && matches(e))) return {mark: '✓', reason: t('コマンドの実行記録があります')};
    if (before.some(e => e.type === 'tool' && matches(e))) return {mark: '?', reason: t('コマンドの実行記録はありますが、最後の変更より前なので古い証拠です')};
    return {mark: '?', reason: t('コマンドの実行記録がありません')};
  }
  if (claim.kind === 'no-error') {
    const tools = after.filter(e => e.type === 'tool');
    if (!tools.length) return {mark: '?', reason: t('道具の実行記録がありません')};
    const failed = tools.some(e => e.ok === false || (e.exitCode !== undefined && e.exitCode !== null && Number(e.exitCode) !== 0));
    return failed ? {mark: '✗', reason: t('最後の変更より後に失敗した道具があります')} : {mark: '✓', reason: t('最後の変更より後の道具はすべて成功しています')};
  }
  return {mark: '?', reason: ''};
}

// A whole turn judged: one row per claim (a sentence can carry several).
function proofTurn(turn) {
  const sentences = splitSentences(turn && turn.reply);
  const rows = [];
  let none = 0;
  for (const text of sentences) {
    const claims = extractClaims(text);
    if (!claims.length) { none++; continue; }
    for (const claim of claims) rows.push({text, kind: claim.kind, ...judge(claim, turn)});
  }
  const counts = {ok: rows.filter(r => r.mark === '✓').length, unknown: rows.filter(r => r.mark === '?').length, bad: rows.filter(r => r.mark === '✗').length, none};
  return {turn: turn ? turn.turn : null, rows, counts};
}

const cut = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
// The display lines for a judged turn (shared by /proof, exec --proof and
// the state file's summary text).
function formatProof(result) {
  const lines = [t('裏取り（ターン {turn}）', {turn: result.turn ?? '?'})];
  if (!result.rows.length) lines.push(t('この返事には、記録と突き合わせられる決まった形の主張がありませんでした。'));
  for (const r of result.rows) lines.push(r.mark + ' ' + cut(r.text, 120) + (r.reason ? ' — ' + r.reason : ''));
  const c = result.counts;
  lines.push(t('裏取り: ✓ {ok} / ? {unknown} / ✗ {bad}（印なし {none} 文）', {ok: c.ok, unknown: c.unknown, bad: c.bad, none: c.none}));
  return lines;
}

module.exports = {splitSentences, parseTestCounts, extractClaims, judge, proofTurn, formatProof};
