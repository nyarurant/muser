// `muser demo`: the real UI driven by a scripted fake agent (no Muse connection), to try the
// look and the keys. Every turn plays the same short coding session.
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
// The demo shows the screen the user actually gets: the entry follows the
// fullscreen switch, so the default demo loads no Ink/React either.
const screenRun = async () => (await import(require('../settings.js').switchValue('fullscreen') ? './fs/run.mjs' : './view.mjs')).run;
const {lineDiff} = require('../tools.js');
const sessions = require('../sessions.js');
const i18n = require('../i18n.js');
const {t} = i18n;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const reply1 = () => t("了解。webhook の受け口と、決済を保存するところを見ます。\n");
const reply2 = () => t("原因は **Stripe の再送** でした。応答が遅れると、Stripe は同じ webhook をもう一度送ります。今のコードは同じイベントでも毎回 `markPaid` と領収書のメールを実行するので、注文が二重に「支払い済み」になり、メールも 2 通届いていました。\n\n## 直したところ\n- `handleWebhook` の最初でイベントの id を記録し、記録済みなら何もしない\n- `webhook_events` 表の `event_id` を主キーにして、同時に 2 通届いても 1 通だけ通す\n- 同じイベントを 2 回送っても処理が 1 回になる試験を追加\n\n```ts\nconst first = await payments.recordEvent(event.id);\nif (!first) return; // already handled\n```\n\nテストも通りました（128 件）。本番のデータベースには、マイグレーション `0042_webhook_events.sql` の適用が必要です。");

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
      const todos = [{content: t('原因を調べる'), status: 'in_progress'}, {content: t('二重の処理を止める'), status: 'pending'}, {content: t('試験を足して流す'), status: 'pending'}];
      this.emit('todos', todos); await this.tool('todo.write', {todos: ''}, {todos});
      await this.tool('code.read', {path: 'src/webhooks/stripe.ts'}, {lines: 186});
      await this.tool('code.read', {path: 'src/payments/repository.ts'}, {lines: 94});
      await this.tool('code.grep', {pattern: 'markPaid\\('}, {count: 4});
      todos[0].status = 'completed'; todos[1].status = 'in_progress'; this.emit('todos', [...todos]);
      const before = [
        'export async function handleWebhook(event: Stripe.Event) {',
        "  if (event.type !== 'payment_intent.succeeded') return;",
        '  const intent = event.data.object;',
        '  await payments.markPaid(intent.metadata.orderId, intent.amount);',
        '  await mailer.sendReceipt(intent.metadata.orderId);',
        '}',
      ].join('\n') + '\n';
      const after = [
        'export async function handleWebhook(event: Stripe.Event) {',
        "  if (event.type !== 'payment_intent.succeeded') return;",
        '  // Stripe retries a webhook until it gets a 2xx: the same event can arrive twice.',
        '  const first = await payments.recordEvent(event.id);',
        '  if (!first) return; // already handled',
        '  const intent = event.data.object;',
        '  await payments.markPaid(intent.metadata.orderId, intent.amount);',
        '  await mailer.sendReceipt(intent.metadata.orderId);',
        '}',
      ].join('\n') + '\n';
      const edited = await this.tool('code.edit', {path: 'src/webhooks/stripe.ts'}, {diff: lineDiff(before, after)}, {ask: true});
      if (!edited) return await this.declined(todos, start);
      const migration = ['CREATE TABLE webhook_events (', '  event_id    text PRIMARY KEY,', '  received_at timestamptz NOT NULL DEFAULT now()', ');'];
      const wrote = await this.tool('code.write', {path: 'migrations/0042_webhook_events.sql'}, {diff: migration.map((l, j) => ({t: '+', n: j + 1, l})), created: true}, {ask: true});
      if (!wrote) return await this.declined(todos, start);
      todos[1].status = 'completed'; todos[2].status = 'in_progress'; this.emit('todos', [...todos]);
      const tested = await this.tool('system.run', {command: 'npm test'}, {exit: 0, tail: ['> shop-api@2.4.0 test', '> vitest run', ' ✓ src/webhooks/stripe.test.ts (7 tests) 412ms', '   ✓ ignores a retried event (same id)', ' ✓ src/payments/repository.test.ts (11 tests) 238ms', ' Test Files  14 passed (14)', '      Tests  128 passed (128)']}, {ask: true, ms: 300});
      if (!tested) return await this.declined(todos, start);
      todos[2].status = 'completed'; this.emit('todos', [...todos]);
      await this.stream('m2', reply2());
      this.emit('turn-end', {ok: true, ms: Date.now() - start});
      return {text: reply2()};
    } catch (e) { this.emit('turn-end', {ok: false, aborted: e.name === 'AbortError', error: e.message, ms: Date.now() - start}); throw e; }
  }
  // The memory-measurement scenario (docs/design/memory.md, stage 0): 200 tool calls
  // with the heavy shapes a long-used window accumulates — 50 writes of a 50 KB file,
  // 50 diffs of 2,000 lines, 50 command outputs of 5,000 lines, 50 small reads.
  // Emitted directly (no sleeps, no approvals, no turn around them):
  // scripts/mem-scenario.mjs drives it headlessly through a real Controller and
  // records what the window retains. Diffs are built in view shape directly —
  // running lineDiff 200 times would measure the diff algorithm, not the memory.
  async memScenario() {
    const line = (tag, j, n) => (tag + ' ' + j + ' ').padEnd(n, 'x');
    const emit = (command, kind, params, view, output) => {
      const call = {id: 'mem-' + (this.memSeq = (this.memSeq || 0) + 1), command, params, kind, summary: params.path || params.command || ''};
      this.emit('tool-start', call);
      this.emit('tool-end', {...call, ok: true, view, output});
    };
    // Interleaved, like a real window: grouped in fifties, the 30 kept outputs
    // would all be the last group's small reads and the heavy outputs would
    // measure as zero — they were pushed out, not absent.
    for (let i = 0; i < 50; i++) {
      const rows = Array.from({length: 1250}, (_, j) => line('write' + i, j, 39));
      emit('code.write', 'edit', {path: 'mem/write-' + i + '.txt', content: rows.join('\n') + '\n'},
        {diff: rows.map((l, j) => ({t: '+', n: j + 1, l})), created: true}, '');
      const diff = [];
      for (let j = 0; j < 1000; j++) diff.push({t: '-', n: j + 1, l: line('old' + i, j, 29)});
      for (let j = 0; j < 1000; j++) diff.push({t: '+', n: j + 1, l: line('new' + i, j, 29)});
      emit('code.edit', 'edit', {path: 'mem/edit-' + i + '.txt', old_string: 'old ' + i, new_string: 'new ' + i}, {diff}, '');
      const out = Array.from({length: 5000}, (_, j) => line('run' + i, j, 19)).join('\n');
      emit('system.run', 'exec', {command: 'mem-run ' + i}, {exit: 0, tail: out.split('\n').slice(-4)}, out);
      emit('code.read', 'read', {path: 'mem/read-' + i + '.txt'}, {lines: 42}, 'read ' + i);
    }
  }
  async interrupt() { this.stopped = true; }
  close() { this.shells.killAll(); }
}

export async function demo({version, cwd, mode}) {
  // Like a real first run: ask for the language if none was picked yet — but never save
  // the pick: a demo run must not write lang into the real ~/.muser/config.json (wave 10).
  if (i18n.chosen() === null) await require('../tui/onboard.js').askLanguage({save: false});
  // --cd / --mode used to be silently dropped on the way here.
  const agent = new DemoAgent(cwd || process.cwd());
  if (mode) agent.mode = mode;
  // The demo's approval previews come from the script instead of real files.
  const run = await screenRun();
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
    this.turnRunning = false; this.expirePending = false;
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
    // A lapse that lands mid-turn waits until the turn ends (wave 10): flipping to the
    // disconnected/auth state while the scripted turn is still running would leave the
    // rest of the turn — its success story included — playing out on a dead connection.
    // send() applies the deferred lapse right after the turn's turn-end.
    if (this.turnRunning) { this.expirePending = true; return; }
    this.expired = true; this.device = {connected: false};
    this.emit('device', {connected: false});
    this.emit('connection', {state: 'auth', error: t('Muse にログインしてください。')});
  }
  async send(text, opts) {
    if (this.expired) throw new Error(t('muse.ai のログインが切れています。/login でログインし直してください。'));
    this.turnRunning = true;
    try {
      await this.ensureConnected();
      return await super.send(text, opts);
    } finally {
      this.turnRunning = false;
      // The turn has ended (super.send emits turn-end before returning/throwing):
      // a lapse deferred by expireLogin() lands now, not mid-turn.
      if (this.expirePending) { this.expirePending = false; this.expireLogin(); }
    }
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
  // The first-run demo always starts with the language question, but never saves the
  // pick: a demo run must not write lang into the real ~/.muser/config.json (wave 10).
  await askLanguage({save: false});
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
  const run = await screenRun();
  const app = run({agent, museName: t('Muse (デモ)'), version, connect: async () => {
    await agent.ensureConnected();
    // Then, a while later, the login lapses: the offer to log in again appears.
    setTimeout(() => agent.expireLogin(), 5000);
    return t('Muse (デモ)');
  }});
  return app;
}
