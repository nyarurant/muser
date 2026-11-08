// Draws the live agent cards for working / recently-ended agents.
// Mirrors view.mjs AgentCards: the list is filtered here (working, or ended
// within 8000ms of ctx.now), room is max(3, ctx.rows - 20), and the header /
// second line are truncate-end at W (the Live root is width W). The tick is
// the production clockTicks one: spinTick(ctx.now) when some agent is working
// and motion is on, else 0. In renderToString probes the React tick is always
// 0 (clockTicks is only set by runFullscreen), so a probe/test must use a
// fixed now whose spinTick is a multiple of 10 (e.g. 1700000000000) for the
// spinner glyph to agree.
import {createRequire} from 'node:module';
import {c, SPIN, THINKING_WORDS, spinnerWord, spinTick, elapsed, truncateEnd} from '../primitives.mjs';
const require = createRequire(import.meta.url);
const {t} = require('../../../../i18n.js');
const {switchValue} = require('../../../../settings.js');

export function drawAgentCards(s, ctx) {
  const now = ctx?.now ?? 0;
  const list = (s?.agents || []).filter(x => x.state === 'working' || now - x.ended < 8000);
  if (!list.length) return [];
  const W = ctx?.W ?? 80;
  const room = Math.max(3, (ctx?.rows ?? 30) - 20);
  const compact = list.length * 2 > room;
  const working = list.some(x => x.state === 'working');
  const n = working && switchValue('motion') ? spinTick(now) : 0;
  const shown = [...list].sort((x, y) => (y.state === 'working') - (x.state === 'working')).slice(0, list.length > room ? room - 1 : room);
  const words = s?.agentWords;
  const out = [''];
  for (const x of shown) {
    const isWorking = x.state === 'working';
    const mark = isWorking ? c.accent(SPIN[(n + (x.tag?.length ?? 0)) % SPIN.length]) : x.state === 'done' ? c.green('✓') : x.state === 'stopped' ? c.yellow('■') : c.red('✗');
    const last = String(x.text || '').trim().split('\n').pop() || '';
    const what = isWorking ? (x.lastTool ? c.gray(x.lastTool) : c.gray(words?.[x.tag] ? words[x.tag] + '…' : spinnerWord(THINKING_WORDS, x.started))) : c.faint(x.state === 'done' ? t('完了') : x.state === 'stopped' ? t('停止') : t('失敗'));
    const header = mark + ' ' + c.bold(x.tag ?? '') + c.faint(' ' + (x.type || '')) + ' ' + (x.title ?? '') + c.faint('  ' + elapsed((isWorking ? now : x.ended) - x.started)) + '  ' + what;
    out.push(truncateEnd(header, W));
    if (isWorking && last && !compact) out.push(truncateEnd(c.faint('   ' + last), W));
  }
  if (list.length > shown.length) out.push(c.faint(t('… ほか {n} 件（/agents で一覧）', {n: list.length - shown.length})));
  return out;
}
