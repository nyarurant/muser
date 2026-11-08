// Entry registry: maps each entry type to its per-part draw function.
// drawEntry returns the entry's lines, or null for an unknown type.
import { drawUser } from './entries/user.mjs';
import { drawMd } from './entries/md.mjs';
import { drawGap } from './entries/gap.mjs';
import { drawNote } from './entries/note.mjs';
import { drawLore } from './entries/lore.mjs';
import { drawRace } from './entries/race.mjs';
import { drawOvernight } from './entries/overnight.mjs';
import { drawEnd } from './entries/end.mjs';
import { drawProgress } from './entries/progress.mjs';
import { drawTool } from './entries/tool.mjs';
import { drawPast } from './entries/past.mjs';
import { drawFocus } from './entries/focus.mjs';
import { drawTodos } from './entries/todos.mjs';
import { drawAgent } from './entries/agent.mjs';
import { drawShellout } from './entries/shellout.mjs';
import { drawMuse } from './entries/muse.mjs';
import { drawSources } from './entries/sources.mjs';
import { drawHelp } from './entries/help.mjs';
import { drawStatus } from './entries/status.mjs';
import { drawHunt } from './entries/hunt.mjs';
import { drawCrash } from './entries/crash.mjs';
import { drawBanner } from './entries/banner.mjs';
import { drawProof } from './entries/proof.mjs';
import { drawParity } from './entries/parity.mjs';
import { drawLive } from './live/index.mjs';

export function drawEntry(e, ctx) {
  switch (e?.type) {
    case 'user': return drawUser(e, ctx);
    case 'md': return drawMd(e, ctx);
    case 'gap': return drawGap(e, ctx);
    case 'note': return drawNote(e, ctx);
    case 'lore': return drawLore(e, ctx);
    case 'race': return drawRace(e, ctx);
    case 'overnight': return drawOvernight(e, ctx);
    case 'end': return drawEnd(e, ctx);
    case 'progress': return drawProgress(e, ctx);
    case 'tool': return drawTool(e, ctx);
    case 'past': return drawPast(e, ctx);
    case 'focus': return drawFocus(e, ctx);
    case 'todos': return drawTodos(e, ctx);
    case 'agent': return drawAgent(e, ctx);
    case 'shellout': return drawShellout(e, ctx);
    case 'muse': return drawMuse(e, ctx);
    case 'sources': return drawSources(e, ctx);
    case 'help': return drawHelp(e, ctx);
    case 'status': return drawStatus(e, ctx);
    case 'hunt': return drawHunt(e, ctx);
    case 'crash': return drawCrash(e, ctx);
    case 'banner': return drawBanner(e, ctx);
    case 'proof': return drawProof(e, ctx);
    case 'parity': return drawParity(e, ctx);
    default: return null;
  }
}

export { drawLive };
