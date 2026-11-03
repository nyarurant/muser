'use strict';
// What Muse does on its own side during a turn (web and memory searches, its view of the calls to
// this PC), from the gateway's /activity feed: each tool call is an action with a title ("Found 19
// web results for …"), a one-line subtitle and a Markdown report. Nothing pushes feed changes to us,
// so, like the web client, it is read again on agent.status and every few seconds while a turn runs.
// Actions are matched to a turn by Muse's agent id and the id of the message that started the turn.
const CAPS = ['ACTIVITY_FEED_GOALS', 'ACTIVITY_FEED_PEER_CONVERSATIONS'];
const POLL_MS = 2000;
const TERMINAL = new Set(['SUCCESS', 'FAILED', 'ERROR', 'CANCELLED']);
// Muse's record of calls to this PC repeats what muser already shows; only its failures are kept.
// Only phrasing about calls to devices: a bare "devices?" also hid Muse's own web searches ("Found 16
// web results for best Android devices"). Records this misses are still dropped by duringToolCall.
const DEVICE = /\b(paired devices?|device commands?|devices? (?:link|tools?|calls?)|homelink-\w+|muser cli|tool namespace)\b|cli \(muser\)/i; // device names are "<hostname> CLI (muser)"

// Strip Unicode bidi isolate controls U+2066..U+2069 (written as escapes: the literal
// characters are invisible in source and easy to corrupt in an editor).
const clean = s => String(s || '').replace(/[\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();

class MuseSteps {
  constructor(client, onStep) {
    this.client = client; this.onStep = onStep;
    this.turns = new Set(); this.timer = null; this.soon = null; this.reading = null;
  }
  // From each agent.status of a turn: which Muse agent runs it and which message started it.
  note(worker, {agent_id: agentId, message_id: messageId}) {
    const turn = worker.turn;
    if (!turn) return;
    turn.worker = worker;
    if (!turn.muse) turn.muse = {agentId: '', messageId: '', shown: new Set(), running: ''};
    if (agentId) turn.muse.agentId = agentId;
    if (messageId) turn.muse.messageId = messageId;
    this.turns.add(turn); this.start();
    clearTimeout(this.soon); this.soon = setTimeout(() => void this.read(), 150);
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.read(), POLL_MS); this.timer.unref?.();
  }
  // At the end of a turn: one last read, then whatever was not shown yet. The reply is already on
  // screen by then, so more than one late step becomes a single "+N steps" line (all of them still
  // go to the transcript). A failed or stopped turn just stops following (show = false).
  async finish(turn, worker, show = true) {
    if (!this.turns.has(turn)) return;
    turn.muse.finishing = true; // the last read collects instead of showing one by one
    if (show) { try { await this.read(); } catch {} }
    this.turns.delete(turn);
    if (!this.turns.size) { clearInterval(this.timer); this.timer = null; }
    if (!show) return;
    const late = (turn.muse.pending || []).map(a => this.prepare(turn, a, true)).filter(Boolean);
    if (late.length === 1) this.onStep({worker, step: late[0]});
    else if (late.length > 1) {
      const {t} = require('./i18n');
      this.onStep({worker, step: {title: t('Muse 側の手順 +{n} 件', {n: late.length}), detail: late.slice(0, 3).map(s => s.title).join(' · ') + (late.length > 3 ? ' …' : ''), late: true, items: late}});
    }
  }
  read() {
    return this.reading ??= this.fetch().finally(() => { this.reading = null; });
  }
  async fetch() {
    const turns = [...this.turns].filter(t => t.muse?.agentId && t.muse.messageId);
    if (!turns.length) return;
    let feed;
    // 30, not 10: during a long turn, parallel agents and other chats (a companion checking in every
    // few minutes) push the turn's own item out of the newest ten, and its steps then only showed
    // up, all at once, after the reply.
    try { feed = await this.client.request('GET', '/activity', {limit: 30, capabilities: CAPS}); } catch { return; }
    const items = (feed?.days || []).flatMap(d => d.activities || []);
    // Group the feed by agent id once, instead of filtering the whole feed per turn.
    const byAgent = new Map();
    for (const x of items) {
      const aid = x.details?.activity_thread_agent_id;
      if (!aid) continue;
      if (!byAgent.has(aid)) byAgent.set(aid, []);
      byAgent.get(aid).push(x);
    }
    for (const t of turns) {
      const actions = (byAgent.get(t.muse.agentId) || [])
        .flatMap(x => x.details.goal_actions || []).filter(a => String(a.id || '').includes(t.muse.messageId))
        .sort((a, b) => (a.action_index ?? 0) - (b.action_index ?? 0));
      t.muse.pending = actions.filter(a => !t.muse.shown.has(a.id));
      const running = t.muse.pending.find(a => !TERMINAL.has(String(a.status).toUpperCase()));
      t.muse.running = running ? clean(running.title).replace(/^Running:\s*/i, '') : '';
      if (!t.muse.finishing) for (const a of t.muse.pending) if (TERMINAL.has(String(a.status).toUpperCase())) this.show(t, t.worker, a, false);
      this.onStep({worker: t.worker, running: t.muse.running});
    }
  }
  show(turn, worker, a, unfinished) {
    const step = this.prepare(turn, a, unfinished);
    if (step) this.onStep({worker, step});
  }
  // The step to show for an action, or null: already shown, or Muse's own record of a call to this
  // PC, which repeats muser's tool line. Those are told by name (DEVICE) and, since Muse titles
  // them freely ("Ran npm test and git status"), by time: created while muser ran a tool call.
  prepare(turn, a, unfinished) {
    if (turn.muse.shown.has(a.id)) return null;
    turn.muse.shown.add(a.id);
    const failed = /^(FAILED|ERROR)$/i.test(a.status), title = clean(a.title).replace(/^Running:\s*/i, ''), subtitle = clean(a.subtitle);
    if (!failed && (DEVICE.test(title + ' ' + subtitle) || duringToolCall(turn, a.created_at))) return null;
    const detail = subtitle && subtitle !== '処理中' && !title.toLowerCase().includes(subtitle.toLowerCase()) ? subtitle : '';
    return {title, detail, failed, unfinished: unfinished && !TERMINAL.has(String(a.status).toUpperCase()), report: String(a.report || '')};
  }
}

// turn.calls: [{start, end}] of the tool calls muser ran for this turn (Agent.toolStart / toolEnd).
// Muse stamps an action when it issues the call; allow a few seconds for clocks and latency.
const SLACK_MS = 4000;
function duringToolCall(turn, createdAt) {
  const at = Date.parse(createdAt || '');
  if (!Number.isFinite(at)) return false;
  return (turn.calls || []).some(c => at >= c.start - SLACK_MS && at <= (c.end ?? Date.now()) + SLACK_MS);
}

// Sources Muse cited in a reply (delta.message_done resources of kind "citation").
function citations(resources) {
  const out = [];
  for (const r of Array.isArray(resources) ? resources : []) {
    if (r?.kind !== 'citation' || typeof r.uri !== 'string' || !/^https?:\/\//.test(r.uri)) continue;
    let domain = '';
    try { domain = JSON.parse(r.metadata || '{}').domain || ''; } catch {}
    try { domain ||= new URL(r.uri).hostname; } catch {}
    out.push({uri: r.uri, label: clean(r.label), domain});
  }
  return out;
}

module.exports = {MuseSteps, citations, clean};
