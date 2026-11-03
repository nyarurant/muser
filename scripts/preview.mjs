// Renders sample UI entries and the live area to text, to check layout without a live session.
import React from 'react';
import {renderToString, Box} from 'ink';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
process.stdout.columns = 96; process.stdout.rows = 40;
const {Controller} = await import('../src/ui/controller.mjs');
const view = await import('../src/ui/view.mjs');
const {lineDiff} = require('../src/tools.js');
const {version} = require('../package.json');
class A extends EventEmitter { constructor(){super();this.mode='default';this.cwd='C:/Users/me/proj';this.session={id:'x',turns:0};this.ctx={readFiles:new Set()};this.client={status:'connected'};this.allowAlways=new Set();this.device={connected:true};} }
A.DEVICE='devbox CLI (muser)';
const a=new A(); const ctrl=new Controller({agent:a,museName:'Muse',version,onExit(){}});
ctrl.push({type:'user',text:'テストが落ちてるので直して'});
a.emit('text',{id:'m1',text:'了解、`src/app.js` を見ます。\n## 方針\n- **入力**を検証\n```js\nconst x = 1;\n```\n途中の行'});
a.emit('tool-end',{command:'code.edit',summary:'src/app.js',ok:true,view:{diff:lineDiff('a\nb\nc\nd\n','a\nB\nc\nd\n')}});
a.emit('tool-end',{command:'system.run',params:{command:'npm test'},summary:'npm test',ok:true,view:{exit:1,tail:['> test','1 failing']}});
ctrl.set({busy:true,turnStart:Date.now()-12000,todos:[{content:'調べる',status:'completed'},{content:'直す',status:'in_progress'}]});
// Render the Static entries and the live part as one string for a look.

const h=React.createElement, W=95;
let out='';
for (const e of [{id:0,type:'banner'},...ctrl.get().entries.slice(1)]) out += renderToString(h(view.Entry,{e,ctrl,W}),{columns:96})+'\n';
out += '──── live ────\n' + renderToString(h(view.Live,{s:ctrl.get(),ctrl,W}),{columns:96});
console.log(out);
