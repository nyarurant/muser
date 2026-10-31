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
const DEVICE = /\b(devices?|homelink-\w+|muser cli|tool namespace)\b|cli \(muser\)/i; // device names are "<hostname> CLI (muser)"

const clean = s => String(s || '').replace(/[⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();

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
  // At the end of a turn: one last read, then whatever was not shown yet (still running or not).
  // A failed or stopped turn just stops following (show = false).
  async finish(turn, worker, show = true) {
    if (!this.turns.has(turn)) return;
    if (show) { try { await this.read(); } catch {} }
    this.turns.delete(turn);
    if (!this.turns.size) { clearInterval(this.timer); this.timer = null; }
    if (show) for (const a of turn.muse.pending || []) this.show(turn, worker, a, true);
  }
  read() {
    return this.reading ??= this.fetch().finally(() => { this.reading = null; });
  }
  async fetch() {
    const turns = [...this.turns].filter(t => t.muse?.agentId && t.muse.messageId);
    if (!turns.length) return;
    let feed;
    try { feed = await this.client.request('GET', '/activity', {limit: 10, capabilities: CAPS}); } catch { return; }
    const items = (feed?.days || []).flatMap(d => d.activities || []);
    for (const t of turns) {
      const actions = items.filter(x => x.details?.activity_thread_agent_id === t.muse.agentId)
        .flatMap(x => x.details.goal_actions || []).filter(a => String(a.id || '').includes(t.muse.messageId))
        .sort((a, b) => (a.action_index ?? 0) - (b.action_index ?? 0));
      t.muse.pending = actions.filter(a => !t.muse.shown.has(a.id));
      const running = t.muse.pending.find(a => !TERMINAL.has(String(a.status).toUpperCase()));
      t.muse.running = running ? clean(running.title).replace(/^Running:\s*/i, '') : '';
      for (const a of t.muse.pending) if (TERMINAL.has(String(a.status).toUpperCase())) this.show(t, t.worker, a, false);
      this.onStep({worker: t.worker, running: t.muse.running});
    }
  }
  show(turn, worker, a, unfinished) {
    if (turn.muse.shown.has(a.id)) return;
    turn.muse.shown.add(a.id);
    const failed = /^(FAILED|ERROR)$/i.test(a.status), title = clean(a.title).replace(/^Running:\s*/i, ''), subtitle = clean(a.subtitle);
    if (!failed && DEVICE.test(title + ' ' + subtitle)) return;
    const detail = subtitle && subtitle !== '処理中' && !title.toLowerCase().includes(subtitle.toLowerCase()) ? subtitle : '';
    this.onStep({worker, step: {title, detail, failed, unfinished: unfinished && !TERMINAL.has(String(a.status).toUpperCase()), report: String(a.report || '')}});
  }
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
