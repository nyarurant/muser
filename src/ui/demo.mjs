// `muser demo`: the real UI driven by a scripted fake agent (no Muse connection), to try the
// look and the keys. Every turn plays the same short coding session.
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {run} from './view.mjs';
const require = createRequire(import.meta.url);
const {lineDiff} = require('../tools.js');
const sessions = require('../sessions.js');
const i18n = require('../i18n.js');
const {t} = i18n;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const reply1 = () => t('了解、まず `src/math.js` を見ます。\n');
const reply2 = () => t('原因は **割り算の端数処理** でした。\n\n## 直したところ\n- `Math.floor` を `Math.round` に変更\n- 0 で割ったときは `null` を返す\n\n```js\nexport const div = (a, b) => b === 0 ? null : Math.round(a / b);\n```\n\nテストも通りました。ほかに見るところはありますか？');

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
  // The stop check lives here, not only inside stream(): an interrupt during the
  // tool sequence (or while an approval is open) must end the turn before the next
  // approval dialog opens or the next tool runs (deep audit c18 #2).
  checkStopped() { if (this.stopped) throw Object.assign(new Error(t('中断しました')), {name: 'AbortError'}); }
  async stream(id, text) {
    let shown = '';
    for (const ch of text) { this.checkStopped(); shown += ch; this.emit('text', {id, text: shown}); await sleep(18); }
    this.emit('message-done', {id, text});
  }
  async tool(command, params, view, {ask, ms = 600} = {}) {
    this.checkStopped();
    const call = {id: String(Math.random()), command, params, kind: ask ? (command === 'system.run' ? 'exec' : 'edit') : 'read', summary: params.path || params.command || params.pattern || ''};
    if (ask) {
      this.emit('tool-start', call);
      const answer = await this.approver({...call, demoPreview: view});
      this.checkStopped();
      if (!answer.allow) { this.emit('tool-end', {...call, ok: false, declined: true, error: 'The user declined this' + (answer.reason ? ': ' + answer.reason : '.')}); return false; }
    } else this.emit('tool-start', call);
    if (command === 'system.run') for (const l of view.tail) { this.checkStopped(); await sleep(250); this.emit('tool-output', {id: call.id, chunk: l + '\n'}); }
    await sleep(ms);
    this.checkStopped();
    this.emit('tool-end', {...call, ok: true, view, output: (view.tail || []).join('\n')});
    return true;
  }
  // An approval was declined: the scripted success story must not play out — the
  // edit did not happen and the tests did not run, so neither may be claimed
  // (deep audit c18 #1). The unfinished todo goes back to pending and the turn
  // ends with a plain cancellation instead of the "fixed, tests passed" reply.
  async declined(todos, start) {
    for (const td of todos) if (td.status === 'in_progress') td.status = 'pending';
    this.emit('todos', [...todos]);
    const text = t('中止しました。');
    await this.stream('m2', text + '\n');
    this.emit('turn-end', {ok: true, ms: Date.now() - start});
    return {text};
  }
  async send() {
    this.stopped = false; const start = Date.now();
    try {
      this.session.turns++;
      await sleep(900);
      await this.stream('m1', reply1());
      const todos = [{content: t('原因を調べる'), status: 'in_progress'}, {content: t('直す'), status: 'pending'}, {content: t('テストを流す'), status: 'pending'}];
      this.emit('todos', todos); await this.tool('todo.write', {todos: ''}, {todos});
      await this.tool('code.read', {path: 'src/math.js'}, {lines: 42});
      await this.tool('code.grep', {pattern: 'Math\\.floor'}, {count: 3});
      todos[0].status = 'completed'; todos[1].status = 'in_progress'; this.emit('todos', [...todos]);
      const diff = lineDiff('export const add = (a, b) => a + b;\nexport const div = (a, b) => Math.floor(a / b);\n', 'export const add = (a, b) => a + b;\nexport const div = (a, b) => b === 0 ? null : Math.round(a / b);\n');
      const edited = await this.tool('code.edit', {path: 'src/math.js'}, {diff}, {ask: true});
      if (!edited) return await this.declined(todos, start);
      todos[1].status = 'completed'; todos[2].status = 'in_progress'; this.emit('todos', [...todos]);
      const tested = await this.tool('system.run', {command: 'npm test'}, {exit: 0, tail: ['> demo@1.0.0 test', '> node --test', '✔ div rounds (1.2ms)', '✔ div by zero (0.4ms)', 'ℹ pass 2  ℹ fail 0']}, {ask: true, ms: 300});
      if (!tested) return await this.declined(todos, start);
      todos[2].status = 'completed'; this.emit('todos', [...todos]);
      await this.stream('m2', reply2());
      this.emit('turn-end', {ok: true, ms: Date.now() - start});
      return {text: reply2()};
    } catch (e) { this.emit('turn-end', {ok: false, aborted: e.name === 'AbortError', error: e.message, ms: Date.now() - start}); throw e; }
  }
  async interrupt() { this.stopped = true; }
  close() { this.shells.killAll(); }
}

export async function demo({version, cwd, mode}) {
  // Like a real first run: ask for the language if none was picked yet (and keep the choice).
  if (i18n.chosen() === null) await require('../tui/onboard.js').askLanguage();
  // --cd / --mode used to be silently dropped on the way here.
  const agent = new DemoAgent(cwd || process.cwd());
  if (mode) agent.mode = mode;
  // The demo's approval previews come from the script instead of real files.
  const app = run({agent, museName: t('Muse (デモ)'), version});
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
      log(t('Edge でログインを待っています（デモ）')); await sleep(1800);
      log(t('… ログインを確認、VM 情報を取得中')); await sleep(900);
      log(t('… 接続用トークンを取得中')); await sleep(900);
      this.expired = false;
    };
  }
  async ensureConnected() {
    if (this.expired) { this.emit('connection', {state: 'auth', error: t('Muse にログインしてください。')}); throw new Error(t('Muse にログインしてください。')); }
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
    this.emit('connection', {state: 'auth', error: t('Muse にログインしてください。')});
  }
  async send(text, opts) {
    if (this.expired) throw new Error(t('muse.ai のログインが切れています。/login でログインし直してください。'));
    await this.ensureConnected();
    return super.send(text, opts);
  }
}

function demoRegister() {
  return async ui => {
    await ui.busy(t('SDK トークンを確認しています'), () => sleep(900));
    // As in pc-login: declining stops the registration and muser ends with 'Cancelled.'.
    if (!(await ui.confirm(t('SDK トークン「muser CLI」を発行します。利用規約に同意しますか？')))) throw new Error(t('中止しました。'));
    await ui.busy(t('準備しています'), () => sleep(700));
    await ui.ask(t('Muse にログインしているメールアドレス'), {hint: t('デモ: 何を入れても送られません'), placeholder: 'you@example.com'});
    await ui.busy(t('認証コードを送っています'), () => sleep(900));
    await ui.ask(t('届いた認証コード'), {hint: t('デモ: 何でも通ります'), placeholder: '123456'});
    await ui.busy(t('確認しています'), () => sleep(900));
    await ui.pick(t('どのアカウントで Muse を使っていますか？'), [{label: t('Muse（デモのアカウント）')}, {label: t('もう一つのアカウント（デモ）')}]);
    await ui.busy(t('確認しています'), () => sleep(800));
  };
}

export async function demoLogin({version, cwd, mode}) {
  const {onboard, askLanguage} = require('../tui/onboard.js');
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  // The first-run demo always starts with the language question; it changes the saved choice
  // only when there is none yet.
  await askLanguage({save: i18n.chosen() === null});
  await onboard({
    needLogin: true, needDevice: true,
    login: async progress => {
      progress(t('Edge の窓でログインを待っています（デモ: 実際には開きません）')); await sleep(2000);
      progress(t('ログインを確認、VM 情報を取得中')); await sleep(900);
      progress(t('接続用トークンを取得中')); await sleep(900);
    },
    register: demoRegister(),
  });
  await sleep(1200);
  const agent = new LoginDemoAgent(cwd || process.cwd());
  if (mode) agent.mode = mode;
  const app = run({agent, museName: t('Muse (デモ)'), version, connect: async () => {
    await agent.ensureConnected();
    // Then, a while later, the login lapses: the offer to log in again appears.
    setTimeout(() => agent.expireLogin(), 5000);
    return t('Muse (デモ)');
  }});
  return app;
}
