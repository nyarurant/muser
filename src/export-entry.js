'use strict';
// The standalone entry for `muser export` (EXPORT.md stage 2). bin/muser.js
// hands `export` to this file in a child process before loading anything
// else, because the report exists precisely for the case where the body
// will not start. The rich CLI (src/export-cli.js) is tried first — it is
// a normal muser module and loads the whole body with it; when that LOAD
// fails (a broken require anywhere in its chain, a missing dependency),
// the fallback is src/export-standalone.js, which uses only Node
// built-ins and reads the stores from disk. A failure while RUNNING the
// rich CLI (no such conversation, a refused confirmation) is a real
// answer, not a broken body: it is reported as-is, never retried through
// the fallback.
async function main(argv) {
  let cli = null, loadError = null;
  try { cli = require('./export-cli'); } catch (e) { loadError = e; }
  if (cli) return cli.runArgs(argv);
  process.stderr.write('muser の本体を読み込めなかったため、最小限のレポートで続けます（' + (loadError && loadError.name ? loadError.name : 'Error') + '）。\n');
  return require('./export-standalone').run(argv, {loadError});
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(e => { console.error('muser: ' + ((e && e.message) || String(e))); process.exitCode = 1; });
}

module.exports = {main};
