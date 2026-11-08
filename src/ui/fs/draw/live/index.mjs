// Live-area drawing: mirrors view.mjs Live() in order and conditions.
// drawLive returns {lines, caret}; a part that cannot draw its block returns
// null and drawLive returns null with it (the screen then draws nothing for
// that part of the frame — there is no other drawing path).
import { drawWorking } from './working.mjs';
import { drawRunning } from './running.mjs';
import { drawApproval } from './approval.mjs';
import { drawMenu } from './menu.mjs';
import { drawQuestion } from './question.mjs';
import { drawChips } from './chips.mjs';
import { drawPrompt } from './prompt.mjs';
import { drawFooter } from './footer.mjs';
import { drawAgentCards } from './agent-cards.mjs';
import { drawAddScreen } from './add-screen.mjs';
import { drawLimitInput } from './limit-input.mjs';
import { drawQueue } from './queue.mjs';
import { drawLiveTodos } from './todos.mjs';
import { drawPreview } from './preview.mjs';
import { drawFocusRow } from './focus-row.mjs';

export function drawLive(s, ctx) {
  const state = s || {};
  const ctrl = ctx?.ctrl;
  const lines = [];
  let caret = null;

  // addFlow branch (Live: AddScreen, then Approval / Menu / Prompt, then Footer).
  if (state.addFlow) {
    const add = drawAddScreen(state, ctx);
    if (add === null) return null;
    lines.push(...add);
    const promptStart = lines.length;
    if (state.approval) {
      const a = drawApproval(state, ctx);
      if (a === null) return null;
      lines.push(...a);
    } else if (state.menu) {
      const m = drawMenu(state, ctx);
      if (m === null) return null;
      lines.push(...m);
    } else {
      const p = drawPrompt(state, ctx);
      if (p === null) return null;
      lines.push(...p.lines);
      if (p.caret) caret = { row: promptStart + p.caret.row, col: p.caret.col };
    }
    const f = drawFooter(state, ctx);
    if (f === null) return null;
    lines.push(...f);
    return { lines, caret };
  }

  // (a) preview: drawPreview reads ctrl.previewRow() itself; null bails only when a preview exists.
  const preview = drawPreview(state, ctx);
  if (preview === null) {
    const row = typeof ctrl?.previewRow === 'function' ? ctrl.previewRow() : null;
    if (row) return null;
  } else {
    lines.push(...preview);
  }

  // (b/c) Running rows: one drawRunning call renders bangRunning then running, in order.
  if ((state.bangRunning || state.running) && !state.approval) {
    const r = drawRunning(state, ctx);
    if (r === null) return null;
    lines.push(...r);
  }

  // (d) Working row when busy and not running.
  if (state.busy && !state.running && !state.approval) {
    const w = drawWorking(state, ctx);
    if (w === null) return null;
    lines.push(...w);
  }

  // (e) Focus progress row while Focus is running.
  if (state.busy && state.focus?.status === 'running' && !state.approval) {
    const fr = drawFocusRow(state, ctx);
    if (fr === null) return null;
    lines.push(...fr);
  }

  // (f) Queue line.
  if (state.queue?.length && !state.approval) {
    const q = drawQueue(state, ctx);
    if (q === null) return null;
    lines.push(...q);
  }

  // (g) Live todo rows when open todos exist.
  const todos = state.todos || [];
  const open = todos.filter((t) => t.status !== 'completed');
  if (todos.length && open.length && !state.approval) {
    const td = drawLiveTodos(state, ctx);
    if (td === null) return null;
    lines.push(...td);
  }

  // (h) AgentCards: always called; null means [] when nothing to show.
  const cards = drawAgentCards(state, ctx);
  if (cards === null) {
    const now = ctx?.now ?? 0;
    const showing = (state.agents || []).filter((x) => x.state === 'working' || now - x.ended < 8000).length;
    if (showing > 0) return null;
  } else {
    lines.push(...cards);
  }

  // (i) Chips, unless an approval / question / menu / limit-input block is showing.
  const overlay = state.approval || state.question || state.menu || state.limitInput;
  if (!overlay) {
    const chips = drawChips(state, ctx);
    if (chips === null) {
      if ((state.attachments || []).length > 0) return null;
    } else {
      lines.push(...chips);
    }
  }

  // (j) Approval / Question / Menu / LimitInput / Prompt, in Live() order.
  const start = lines.length;
  if (state.approval) {
    const a = drawApproval(state, ctx);
    if (a === null) return null;
    lines.push(...a);
  } else if (state.question) {
    const q = drawQuestion(state, ctx);
    if (q === null) return null;
    lines.push(...q);
  } else if (state.menu) {
    const m = drawMenu(state, ctx);
    if (m === null) return null;
    lines.push(...m);
  } else if (state.limitInput) {
    const li = drawLimitInput(state, ctx);
    if (li === null) return null;
    lines.push(...li.lines);
    if (li.caret) caret = { row: start + li.caret.row, col: li.caret.col };
  } else {
    const p = drawPrompt(state, ctx);
    if (p === null) return null;
    lines.push(...p.lines);
    if (p.caret) caret = { row: start + p.caret.row, col: p.caret.col };
  }

  // (k) Footer, unless an approval / question / menu / limit-input block is showing.
  if (!overlay) {
    const f = drawFooter(state, ctx);
    if (f === null) return null;
    lines.push(...f);
  }

  return { lines, caret };
}
