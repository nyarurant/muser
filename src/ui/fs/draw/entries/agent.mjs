// Draws the 'agent' entry: a finished/stopped agent result box.
// Mirrors view.mjs Entry case 'agent': a column with marginBottom 1 holding a
// round-bordered box at width W (border #3c5a46 when done, #5a3c3c otherwise,
// paddingX 1, so the content column is W - 4). The header is one truncate-end
// line: mark (✓ green / ■ yellow when stopped / ✗ red), the accent bold tag,
// the faint type, the faint elapsed time (from ctx.now, never Date.now()) and
// the gray title. The body is the result (or the error, or a placeholder) run
// through the same createMd + Row rendering as the md entry: at most 12 source
// lines (200 when e.full), then a DIM '… ほか' line. Embed tokens are sanitised
// exactly as view.mjs does.
import {createRequire} from 'node:module';
import {c, elapsed, hanging, pad, roundBox, truncateEnd} from '../primitives.mjs';
import {createMd} from '../../../md.mjs';
import {sanitizeEmbeds} from '../../../sanitize.mjs';
const {t} = createRequire(import.meta.url)('../../../../i18n.js');

export function drawAgent(e, ctx) {
  // An entry without its agent snapshot is not a shape this draw covers:
  // return null so the caller falls back to the React drawing.
  if (!e.snap) return null;
  const x = e.snap;
  const ok = x.state === 'done';
  const mark = ok ? c.green('✓') : x.state === 'stopped' ? c.yellow('■') : c.red('✗');
  const bodyText = String(ok ? x.result ?? '' : x.error || t('停止しました')).trim();
  const body = (bodyText ? sanitizeEmbeds(bodyText) : t('(結果なし)')).split('\n');
  const md = createMd();
  const max = e.full ? 200 : 12;
  const W = ctx.W;
  const cw = Math.max(1, W - 4);
  const inner = [];
  const header = mark + ' ' + c.accent(c.bold(t('エージェント {tag}', {tag: x.tag}))) + c.faint(' ' + (x.type || '')) +
    c.faint('   ' + elapsed((x.ended || ctx.now) - (x.started || 0))) + c.gray('  ' + (x.title || ''));
  inner.push(truncateEnd(header, cw));
  for (const r of md.rows(body.slice(0, max))) {
    inner.push(...hanging(r.prefix, r.text || ' ', {width: cw, wrapMode: r.table ? 'truncate-end' : r.code && !ctx.codeWrap ? 'truncate-end' : 'wrap'}));
  }
  if (body.length > max) inner.push(truncateEnd(c.faint(t('… ほか {n} 行（/agents で全文）', {n: body.length - max})), cw));
  // Close any style left open at a line end before padding: Ink pads the box
  // with plain spaces, so the padding must not inherit a row's last colour.
  const boxed = roundBox(inner.map(l => ' ' + pad(l + '\x1b[0m', cw) + ' '), {width: W, borderColor: ok ? '#3c5a46' : '#5a3c3c'});
  return [...boxed, ''];
}
