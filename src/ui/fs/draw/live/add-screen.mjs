// Draws the live add-flow screen.
// Mirrors view.mjs AddScreen({f, W}): a column with marginTop 1 holding a
// round-bordered (accent) box of width W with paddingX 1 — the bold accent
// title, a blank line, the flow lines wrapped whole at the content width
// W - 4, and a dim truncated busy line when busy.
import {createRequire} from 'node:module';
import {c, pad, roundBox, truncateEnd, wrapInk} from '../primitives.mjs';
const require = createRequire(import.meta.url);
const {t} = require('../../../../i18n.js');

export function drawAddScreen(s, ctx) {
  const f = s?.addFlow;
  if (!f) return [];
  const W = ctx.W, contentW = W - 4;
  const contents = [truncateEnd(c.accent(c.bold(t('アカウントを追加'))), contentW), ' '];
  for (const l of f.lines || []) contents.push(...wrapInk(String(l), contentW));
  if (f.busy) contents.push(truncateEnd(c.faint(f.busy + '…'), contentW));
  const boxed = roundBox(contents.map(l => ' ' + pad(l, contentW) + ' '), {width: W, borderColor: '#b4a0ff'});
  return ['', ...boxed];
}
