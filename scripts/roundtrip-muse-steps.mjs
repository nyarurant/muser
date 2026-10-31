// Live check: Muse's own tool calls (web / memory search) and cited sources reach the TUI.
// Runs one "テストです" turn through the real Agent and Controller and prints the scrollback.
import React from 'react';
import {renderToString} from 'ink';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
process.stdout.columns = 100;
const {createWeb} = require('../src/web');
const {connectChat} = require('../src/session');
const {createAuth} = require('../src/pc-login');
const {Agent} = require('../src/agent');
const {Controller} = await import('../src/ui/controller.mjs');
const view = await import('../src/ui/view.mjs');
const web = createWeb(), client = await connectChat(web); await client.subscribe();
const agent = new Agent({client, auth: createAuth(web), cwd: require('node:path').join(import.meta.dirname, '..'), mode: 'plan'});
const t0 = Date.now(), at = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
agent.on('muse-running', r => r && console.log(at(), 'running:', r));
agent.on('muse-step', s => console.log(at(), 'step:', s.title, '|', s.detail));
await agent.connectDevice();
const ctrl = new Controller({agent, museName: 'Muse', version: 'test', onExit() {}});
await ctrl.submit(process.argv[2] || 'テストです。code.read で package.json の "name" を確認し、Web 検索で「Ink React CLI 最新バージョン」を調べて、"name / Ink のバージョン" の形で一言で答えてください。');
while (ctrl.get().busy) await new Promise(r => setTimeout(r, 300));
const h = React.createElement;
let out = '';
for (const e of ctrl.get().entries.slice(1)) out += renderToString(h(view.Entry, {e, ctrl, W: 99}), {columns: 100}) + '\n';
console.log('──── scrollback ────\n' + out + '\nsession ' + agent.session.id);
agent.close(); process.exit(0);
