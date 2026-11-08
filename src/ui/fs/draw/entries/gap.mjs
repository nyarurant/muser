// Draws the 'gap' entry: mirrors view.mjs Entry case 'gap' (h(Text, null, ' ')).
// Ink's output stage trims the trailing space, so renderToString of the gap
// alone is '' at every width (probed 40/80/120) and reactLines is []. Return []
// — not [''] — to match the fullscreen caller, which turns '' into [] anyway
// (view.mjs renderEntry); [''] would add a blank line the React fallback does
// not produce. (In a classic Ink column the same Text does occupy a blank line,
// but that layout is not the fullscreen per-entry unit under test.)
export function drawGap(e, ctx) {
  return [];
}
