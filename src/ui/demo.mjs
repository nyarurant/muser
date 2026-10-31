// `muser demo`: the real UI driven by a scripted fake agent (no Muse connection), to try the
// look and the keys. Every turn plays the same short coding session.
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {run} from './view.mjs';
const require = createRequire(import.meta.url);
const {lineDiff} = require('../tools.js');
const sessions = require('../sessions.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const REPLY_1 = '了解、まず `src/math.js` を見ます。\n';
const REPLY_2 = '原因は **割り算の端数処理** でした。\n\n## 直したところ\n- `Math.floor` を `Math.round` に変更\n- 0 で割ったときは `null` を返す\n\n```js\nexport const div = (a, b) => b === 0 ? null : Math.round(a / b);\n```\n\nテストも通りました。ほかに見るところはありますか？';

class DemoAgent extends EventEmitter {
  static DEVICE = 'demo CLI (muser)';
  constructor(cwd) {
    super();
    this.cwd = cwd; this.mode = 'default'; this.session = sessions.create(cwd); this.session.turns = 0;
    this.shells = new (require('../shells.js').Shells)(); this.shells.on('change', x => this.emit('shell', x));
    this.ctx = {cwd, readFiles: new Set(), todos: [], shells: this.shells}; this.allowAlways = new Set();
    this.client = {status: 'demo'}; this.device = {connected: true};
    this.approver = async () => ({allow: true});
  }
  async stream(id, text) {
    let shown = '';
    for (const ch of text) { if (this.stopped) throw Object.assign(new Error('中断'), {name: 'AbortError'}); shown += ch; this.emit('text', {id, text: shown}); await sleep(18); }
    this.emit('message-done', {id, text});
  }
  async tool(command, params, view, {ask, ms = 600} = {}) {
    const call = {id: String(Math.random()), command, params, kind: ask ? (command === 'system.run' ? 'exec' : 'edit') : 'read', summary: params.path || params.command || params.pattern || ''};
    if (ask) {
      this.emit('tool-start', call);
      const answer = await this.approver({...call, demoPreview: view});
      if (!answer.allow) { this.emit('tool-end', {...call, ok: false, declined: true, error: 'The user declined this' + (answer.reason ? ': ' + answer.reason : '.')}); return false; }
    } else this.emit('tool-start', call);
    if (command === 'system.run') for (const l of view.tail) { await sleep(250); this.emit('tool-output', {id: call.id, chunk: l + '\n'}); }
    await sleep(ms);
    this.emit('tool-end', {...call, ok: true, view});
    return true;
  }
  async send() {
    this.stopped = false; const start = Date.now();
    try {
      this.session.turns++;
      await sleep(900);
      await this.stream('m1', REPLY_1);
      const todos = [{content: '原因を調べる', status: 'in_progress'}, {content: '直す', status: 'pending'}, {content: 'テストを流す', status: 'pending'}];
      this.emit('todos', todos); await this.tool('todo.write', {todos: ''}, {todos});
      await this.tool('code.read', {path: 'src/math.js'}, {lines: 42});
      await this.tool('code.grep', {pattern: 'Math\\.floor'}, {count: 3});
      todos[0].status = 'completed'; todos[1].status = 'in_progress'; this.emit('todos', [...todos]);
      const diff = lineDiff('export const add = (a, b) => a + b;\nexport const div = (a, b) => Math.floor(a / b);\n', 'export const add = (a, b) => a + b;\nexport const div = (a, b) => b === 0 ? null : Math.round(a / b);\n');
      await this.tool('code.edit', {path: 'src/math.js'}, {diff}, {ask: true});
      todos[1].status = 'completed'; todos[2].status = 'in_progress'; this.emit('todos', [...todos]);
      await this.tool('system.run', {command: 'npm test'}, {exit: 0, tail: ['> demo@1.0.0 test', '> node --test', '✔ div rounds (1.2ms)', '✔ div by zero (0.4ms)', 'ℹ pass 2  ℹ fail 0']}, {ask: true, ms: 300});
      todos[2].status = 'completed'; this.emit('todos', [...todos]);
      await this.stream('m2', REPLY_2);
      this.emit('turn-end', {ok: true, ms: Date.now() - start});
      return {text: REPLY_2};
    } catch (e) { this.emit('turn-end', {ok: false, aborted: e.name === 'AbortError', error: e.message, ms: Date.now() - start}); throw e; }
  }
  async interrupt() { this.stopped = true; }
  close() { this.shells.killAll(); }
}

export function demo({version}) {
  const agent = new DemoAgent(process.cwd());
  // The demo's approval previews come from the script instead of real files.
  const app = run({agent, museName: 'Muse (デモ)', version});
  return app;
}
export {DemoAgent};

// `muser demo login`: the login experience with nothing real behind it. First the first-run
// onboarding (the real screens, src/tui/onboard.js) with a scripted Edge login and device
// registration; then the TUI as it comes up and connects behind the screen; then a lapsed
// login, offered for re-login in place (/login), and connected again.
export class LoginDemoAgent extends DemoAgent {
  constructor(cwd) {
    super(cwd);
    this.device = {connected: false}; this.client = {status: 'demo'}; this.expired = false; this.everConnected = false;
    this.loginFlow = async ({log}) => {
      log('Edge でログインを待っています（デモ）'); await sleep(1800);
      log('… ログインを確認、VM 情報を取得中'); await sleep(900);
      log('… 接続用トークンを取得中'); await sleep(900);
      this.expired = false;
    };
  }
  async ensureConnected() {
    if (this.expired) { this.emit('connection', {state: 'auth', error: 'Muse にログインしてください。'}); throw new Error('Muse にログインしてください。'); }
    if (this.device.connected) return;
    const first = !this.everConnected;
    this.emit('connection', {state: first ? 'connecting' : 'reconnecting'});
    await sleep(1600);
    this.device = {connected: true}; this.everConnected = true;
    this.emit('device', {connected: true}); this.emit('connection', {state: 'connected', first});
  }
  expireLogin() {
    this.expired = true; this.device = {connected: false};
    this.emit('device', {connected: false});
    this.emit('connection', {state: 'auth', error: 'Muse にログインしてください。'});
  }
  async send(text, opts) {
    if (this.expired) throw new Error('muse.ai のログインが切れています。/login でログインし直してください。');
    await this.ensureConnected();
    return super.send(text, opts);
  }
}

function demoRegister() {
  return async ui => {
    await ui.busy('SDK トークンを確認しています', () => sleep(900));
    await ui.confirm('SDK トークン「muser CLI」を発行します。利用規約に同意しますか？');
    await ui.busy('準備しています', () => sleep(700));
    await ui.ask('Muse にログインしているメールアドレス', {hint: 'デモ: 何を入れても送られません', placeholder: 'you@example.com'});
    await ui.busy('認証コードを送っています', () => sleep(900));
    await ui.ask('届いた認証コード', {hint: 'デモ: 何でも通ります', placeholder: '123456'});
    await ui.busy('確認しています', () => sleep(900));
    await ui.pick('どのアカウントで Muse を使っていますか？', [{label: 'Muse（デモのアカウント）'}, {label: 'もう一つのアカウント（デモ）'}]);
    await ui.busy('確認しています', () => sleep(800));
  };
}

export async function demoLogin({version}) {
  const {onboard} = require('../tui/onboard.js');
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  await onboard({
    needLogin: true, needDevice: true,
    login: async progress => {
      progress('Edge の窓でログインを待っています（デモ: 実際には開きません）'); await sleep(2000);
      progress('ログインを確認、VM 情報を取得中'); await sleep(900);
      progress('接続用トークンを取得中'); await sleep(900);
    },
    register: demoRegister(),
  });
  await sleep(1200);
  const agent = new LoginDemoAgent(process.cwd());
  const app = run({agent, museName: 'Muse (デモ)', version, connect: async () => {
    await agent.ensureConnected();
    // Then, a while later, the login lapses: the offer to log in again appears.
    setTimeout(() => agent.expireLogin(), 5000);
    return 'Muse (デモ)';
  }});
  return app;
}
