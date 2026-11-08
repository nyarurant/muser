'use strict';
// Startup: Ink's ink.js does `import {throttle} from 'es-toolkit/compat'`, and that entry point
// re-exports the whole compat library — 413 files opened one by one at every start (157 ms of
// a 0.5 s start on Windows, where each open is scanned). The import from ink.js alone is sent to
// a one-function module instead; every other importer gets es-toolkit unchanged. Without
// module.registerHooks (Node before 22.15 / 23.5) nothing changes.
const mod = require('node:module');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

const SHIM = pathToFileURL(path.join(__dirname, 'ui', 'es-toolkit-throttle.mjs')).href;
const FROM_INK = /[\\/]ink[\\/]build[\\/]ink\.js$/;

if (typeof mod.registerHooks === 'function') {
  try {
    mod.registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === 'es-toolkit/compat' && context.parentURL) {
          let parent = '';
          try { parent = decodeURIComponent(new URL(context.parentURL).pathname); } catch {}
          if (FROM_INK.test(parent)) return {url: SHIM, format: 'module', shortCircuit: true};
        }
        return nextResolve(specifier, context);
      },
    });
  } catch {}
}
