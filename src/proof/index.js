'use strict';
// /proof entry point (design §2 + §3): load one conversation's worklog,
// pick the turn, judge its reply. Counter-proof lives in counter.js and
// is only planned here — running it needs the caller's confirmation.
const {t} = require('../i18n.js');
const {readWorklog, splitTurns, pickTurn, formatGapNote} = require('./worklog.js');
const {proofTurn, formatProof} = require('./badge.js');
const {planCounterProof, formatCounter} = require('./counter.js');

// "/proof [ターン] [--yes]" and the same words after `muser exec --proof`
// has finished a turn: a bare number names the turn, --yes pre-approves
// the counter-proof run.
function parseProofArg(arg) {
  const out = {turn: undefined, yes: false};
  for (const w of String(arg || '').split(/\s+/).filter(Boolean)) {
    if (w === '--yes' || w === '-y') out.yes = true;
    else if (/^\d+$/.test(w)) out.turn = Number(w);
  }
  return out;
}

// Judge a reply that is not (yet) in a worklog — `muser exec --proof`
// before the worklog writer is merged, where the run's own tool events
// are all there is. Builds the same turn shape from what exec saw; with
// no edit events and no tool output text, file/test claims honestly
// come out '?' instead of being guessed at.
function syntheticTurn(replyText, tools) {
  const events = [];
  for (const call of tools || []) {
    events.push({type: 'tool', command: call.command, summary: call.summary || '', ok: !!call.ok,
      exitCode: call.ok ? 0 : 1, output: String((call.view && call.view.tail || []).join('\n')), paths: [], atMs: 0});
  }
  if (replyText) events.push({type: 'reply', text: String(replyText)});
  return {turn: 1, prompt: '', agent: 'main', events, tools: events.filter(e => e.type === 'tool'), edits: [], reply: String(replyText || ''), focus: null};
}

// {missing:true} when the conversation has no worklog yet.
function proofConversation(id, {turn, base} = {}) {
  const log = readWorklog(id, {base});
  if (log.missing) return {missing: true, file: log.file};
  const turns = splitTurns(log.events);
  const picked = pickTurn(turns, turn);
  if (!picked) return {missing: false, empty: true, file: log.file};
  if (picked.outOfRange) return {missing: false, outOfRange: true, want: picked.want, count: picked.count, file: log.file};
  if (!picked.reply) return {missing: false, noReply: true, turn: picked.turn, file: log.file};
  const result = proofTurn(picked);
  const counterPlan = planCounterProof(picked);
  return {missing: false, turn: picked, result, counterPlan, lines: [...formatProof(result), ...formatGapNote(picked), ...formatCounter(counterPlan.status === 'ready' ? {status: 'needs-confirm', command: counterPlan.command} : counterPlan)]};
}

function noWorklogLine() { return t('作業ログがまだないため、裏取りできませんでした。'); }
function noReplyLine() { return t('そのターンには返事が記録されていません。'); }
function outOfRangeLine(want, count) { return t('ターン {want} はありません（この会話は {count} ターンです）。', {want, count}); }

module.exports = {parseProofArg, proofConversation, syntheticTurn, noWorklogLine, noReplyLine, outOfRangeLine};
