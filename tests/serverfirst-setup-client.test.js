'use strict';
// driveSetup (src/tui/setup-client.js): the terminal driver for the Server
// first-run setup, tested with a fake client in src/server/client.js's
// request() shape ({status, json} over the /api/setup routes) serving a
// scripted state sequence, and a fake clack-shaped ui with scripted
// answers. No real server, no real Muse, no network.
const test = require('node:test');
const assert = require('node:assert');
const {driveSetup} = require('../src/tui/setup-client');

function plainState(patch = {}) {
  return {
    phase: 'busy',
    steps: {login: 'done', device: 'now'},
    prompt: null, busy: null, lines: [], message: null, error: null, checkpointUrl: null,
    ...patch,
  };
}
function plainPrompt(patch = {}) {
  return {
    id: 'p1', kind: 'text', message: 'メールアドレスを入力してください',
    hint: null, placeholder: null, initial: null, options: [], secret: false,
    ...patch,
  };
}

// Each GET /api/setup serves the next scripted state (the last one repeats);
// POSTs are recorded and answered {ok: true}, like the real routes.
function fakeClient(script) {
  const calls = [];
  let served = 0;
  return {
    calls,
    async request(method, path, body) {
      calls.push(body !== undefined ? [method, path, body] : [method, path]);
      if (method === 'GET' && path === '/api/setup') {
        const state = script[Math.min(served++, script.length - 1)];
        return state === null ? {status: 404, json: {error: 'setup is not running'}} : {status: 200, json: JSON.parse(JSON.stringify(state))};
      }
      return {status: 200, json: {ok: true}};
    },
  };
}
function posts(client, path) { return client.calls.filter(c => c[0] === 'POST' && c[1] === path); }

function fakeUi(answers = {}, {password = true} = {}) {
  const calls = [];
  const take = (kind, fallback) => (answers[kind] && answers[kind].length ? answers[kind].shift() : fallback);
  const ui = {
    calls,
    ask: async (message, opts) => { calls.push(['ask', message, opts]); return take('ask', 'typed'); },
    confirm: async message => { calls.push(['confirm', message]); return take('confirm', true); },
    pick: async (message, options) => { calls.push(['pick', message, options]); return take('pick', 0); },
  };
  if (password) ui.password = async (message, opts) => { calls.push(['password', message, opts]); return take('password', '000000'); };
  return ui;
}
function uiCalls(ui, kind) { return ui.calls.filter(c => c[0] === kind); }

async function drive(client, ui, extra = {}) {
  const outputs = [];
  const result = await driveSetup({client, ui, output: s => outputs.push(s), sleep: async () => {}, pollMs: 1, ...extra});
  return {result, outputs};
}

test('done phase returns at once, and an absent setup counts as done', async () => {
  const client = fakeClient([plainState({phase: 'done'})]);
  const ui = fakeUi();
  const {result} = await drive(client, ui);
  assert.deepEqual(result, {done: true});
  assert.equal(ui.calls.length, 0);
  assert.equal(posts(client, '/api/setup/start').length, 0);

  const gone = fakeClient([null]);
  const {result: result2} = await drive(gone, fakeUi());
  assert.deepEqual(result2, {done: true});
});

test('text prompt: an idle flow is started, the ask answer goes back by promptId', async () => {
  const client = fakeClient([
    plainState({phase: 'idle'}),
    plainState({phase: 'contact', prompt: plainPrompt({initial: 'prev@example.com'})}),
    plainState({phase: 'done'}),
  ]);
  const ui = fakeUi({ask: ['me@example.com']});
  const {result} = await drive(client, ui);
  assert.deepEqual(result, {done: true});
  assert.equal(posts(client, '/api/setup/start').length, 1);
  const asks = uiCalls(ui, 'ask');
  assert.equal(asks.length, 1);
  assert.equal(asks[0][1], 'メールアドレスを入力してください');
  assert.equal(asks[0][2].initial, 'prev@example.com');
  assert.equal(asks[0][2].secret, false);
  assert.deepEqual(posts(client, '/api/setup/answer').map(c => c[2]), [{promptId: 'p1', value: 'me@example.com'}]);
});

test('confirm prompt: a false answer is a real answer, not a cancel', async () => {
  const client = fakeClient([
    plainState({phase: 'terms', prompt: plainPrompt({id: 'p7', kind: 'confirm', message: '利用規約に同意しますか'})}),
    plainState({phase: 'done'}),
  ]);
  const ui = fakeUi({confirm: [false]});
  const {result} = await drive(client, ui);
  assert.deepEqual(result, {done: true});
  assert.equal(uiCalls(ui, 'confirm').length, 1);
  assert.deepEqual(posts(client, '/api/setup/answer').map(c => c[2]), [{promptId: 'p7', value: false}]);
  assert.equal(posts(client, '/api/setup/cancel').length, 0);
});

test('pick prompt: options reach ui.pick and the answer goes back as an index', async () => {
  const options = [{label: 'メール', hint: null}, {label: 'SMS', hint: '携帯'}];
  const client = fakeClient([
    plainState({phase: 'two_factor_method', prompt: plainPrompt({id: 'p3', kind: 'pick', message: '追加認証の方法を選んでください', options})}),
    plainState({phase: 'done'}),
  ]);
  const ui = fakeUi({pick: [1]});
  const {result} = await drive(client, ui);
  assert.deepEqual(result, {done: true});
  const picks = uiCalls(ui, 'pick');
  assert.equal(picks.length, 1);
  assert.deepEqual(picks[0][2], options);
  assert.deepEqual(posts(client, '/api/setup/answer').map(c => c[2]), [{promptId: 'p3', index: 1}]);
});

test('secret prompt: a password-style ask wins when the ui supports one', async () => {
  const client = fakeClient([
    plainState({phase: 'code', prompt: plainPrompt({id: 'p9', kind: 'text', message: '届いた認証コードを入力してください', secret: true})}),
    plainState({phase: 'done'}),
  ]);
  const ui = fakeUi({password: ['123456']});
  const {result} = await drive(client, ui);
  assert.deepEqual(result, {done: true});
  assert.equal(uiCalls(ui, 'password').length, 1);
  assert.equal(uiCalls(ui, 'ask').length, 0);
  assert.deepEqual(posts(client, '/api/setup/answer').map(c => c[2]), [{promptId: 'p9', value: '123456'}]);
});

test('secret prompt: without a password ask, plain ask carries secret: true', async () => {
  const client = fakeClient([
    plainState({phase: 'code', prompt: plainPrompt({id: 'p9', kind: 'text', message: '届いた認証コードを入力してください', secret: true})}),
    plainState({phase: 'done'}),
  ]);
  const ui = fakeUi({ask: ['654321']}, {password: false});
  const {result} = await drive(client, ui);
  assert.deepEqual(result, {done: true});
  const asks = uiCalls(ui, 'ask');
  assert.equal(asks.length, 1);
  assert.equal(asks[0][2].secret, true);
  assert.deepEqual(posts(client, '/api/setup/answer').map(c => c[2]), [{promptId: 'p9', value: '654321'}]);
});

test('idle (debug S1): starting an idle flow waits for the next poll instead of spinning', async () => {
  // The flow stays 'idle' for several polls after start is accepted (it is
  // still spinning up server-side); without a wait the driver looped
  // GET/POST with no pause at all.
  let sleeps = 0;
  const client = fakeClient([
    plainState({phase: 'idle'}),
    plainState({phase: 'idle'}),
    plainState({phase: 'idle'}),
    plainState({phase: 'done'}),
  ]);
  const outputs = [];
  const result = await driveSetup({client, ui: fakeUi(), output: s => outputs.push(s), sleep: async () => { sleeps++; }, pollMs: 1});
  assert.deepEqual(result, {done: true});
  assert.equal(posts(client, '/api/setup/start').length, 3, 'one start attempt per poll, not thousands');
  assert.ok(sleeps >= 3, 'each idle poll waited');
});

test('lines (debug S2): a sliding 30-line window prints each line once, not the window over and over', async () => {
  // The flow keeps only the newest 30 lines; feed 35 one at a time, each
  // poll showing the current tail, exactly as the real flow serves it.
  const script = [];
  const all = [];
  for (let n = 1; n <= 35; n++) {
    all.push('line-' + n);
    script.push(plainState({phase: 'busy', lines: all.slice(-30)}));
  }
  script.push(plainState({phase: 'done', lines: all.slice(-30)}));
  const client = fakeClient(script);
  const {result, outputs} = await drive(client, fakeUi());
  assert.deepEqual(result, {done: true});
  assert.equal(outputs.length, 35, 'each line printed exactly once (was ~180 with the prefix diff)');
  assert.deepEqual(outputs, all);
});

test('busy states show their progress line once, then the prompt is rendered', async () => {
  const client = fakeClient([
    plainState({phase: 'busy', busy: 'この PC を登録しています…'}),
    plainState({phase: 'busy', busy: 'この PC を登録しています…'}),
    plainState({phase: 'contact', prompt: plainPrompt({})}),
    plainState({phase: 'done'}),
  ]);
  const ui = fakeUi({ask: ['me@example.com']});
  const {result, outputs} = await drive(client, ui);
  assert.deepEqual(result, {done: true});
  assert.deepEqual(outputs, ['この PC を登録しています…']);
  assert.equal(uiCalls(ui, 'ask').length, 1);
});

test('error state: the error is shown and start() retries the flow', async () => {
  const client = fakeClient([
    plainState({phase: 'error', error: 'ログインに失敗しました'}),
    plainState({phase: 'contact', prompt: plainPrompt({})}),
    plainState({phase: 'done'}),
  ]);
  const ui = fakeUi({ask: ['me@example.com']});
  const {result, outputs} = await drive(client, ui);
  assert.deepEqual(result, {done: true});
  assert.ok(outputs.includes('ログインに失敗しました'));
  assert.equal(posts(client, '/api/setup/start').length, 1);
  assert.deepEqual(posts(client, '/api/setup/answer').map(c => c[2]), [{promptId: 'p1', value: 'me@example.com'}]);
});

test('error (debug S4): flicker between error and busy cannot reset the retry cap', async () => {
  // error -> busy -> error with the SAME text: the old accounting reset on
  // the busy poll and retried forever. The cap is per error text now.
  const script = [];
  for (let i = 0; i < 10; i++) { script.push(plainState({phase: 'error', error: 'ログインに失敗しました'})); script.push(plainState({phase: 'busy', busy: '再試行しています'})); }
  const client = fakeClient(script);
  const {result} = await drive(client, fakeUi(), {maxErrorRetries: 3});
  assert.equal(result.done, false);
  assert.equal(result.error, 'ログインに失敗しました');
  assert.equal(posts(client, '/api/setup/start').length, 3, 'three retries for the same error, then it gives up');
});

test('error (debug S4): alternating error texts are bounded by the total cap', async () => {
  const script = [];
  for (let i = 0; i < 40; i++) script.push(plainState({phase: 'error', error: i % 2 ? '失敗A' : '失敗B'}));
  const client = fakeClient(script);
  const {result} = await drive(client, fakeUi(), {maxErrorRetries: 2});
  assert.equal(result.done, false);
  assert.ok(posts(client, '/api/setup/start').length <= 6, 'the total cap (3x per-text) stops the alternation');
});

test('busy (debug S12): a busy line that flickers out and back is printed once, not per flicker', async () => {
  const client = fakeClient([
    plainState({phase: 'busy', busy: 'ログインしています'}),
    plainState({phase: 'busy', busy: null}),
    plainState({phase: 'busy', busy: 'ログインしています'}),
    plainState({phase: 'done'}),
  ]);
  const {outputs} = await drive(client, fakeUi());
  assert.equal(outputs.filter(x => x === 'ログインしています').length, 1);
});

test('login (debug S12): login -> busy -> login prints the waiting line once per wait', async () => {
  const client = fakeClient([
    plainState({phase: 'login'}),
    plainState({phase: 'busy'}),
    plainState({phase: 'login'}),
    plainState({phase: 'done'}),
  ]);
  const {outputs} = await drive(client, fakeUi());
  assert.equal(outputs.filter(x => x === 'ログインを待っています').length, 1);
});

test('login (debug S13): a busy text for the login wait replaces the generic waiting line', async () => {
  const client = fakeClient([
    plainState({phase: 'login', busy: 'Edge の窓でログインを待っています'}),
    plainState({phase: 'done'}),
  ]);
  const {outputs} = await drive(client, fakeUi());
  assert.deepEqual(outputs, ['Edge の窓でログインを待っています'], 'one waiting line, not the same wait said twice');
});

test('login phase with no prompt shows the waiting line once and keeps polling', async () => {
  const client = fakeClient([
    plainState({phase: 'login'}),
    plainState({phase: 'login'}),
    plainState({phase: 'login'}),
    plainState({phase: 'done'}),
  ]);
  const ui = fakeUi();
  const {result, outputs} = await drive(client, ui);
  assert.deepEqual(result, {done: true});
  assert.deepEqual(outputs, ['ログインを待っています']);
  assert.equal(ui.calls.length, 0);
});

test('checkpoint state prints the checkpoint URL and resumes the flow', async () => {
  const url = 'https://muse.ai/checkpoint?x=1';
  const client = fakeClient([
    plainState({phase: 'checkpoint', checkpointUrl: url, message: '追加の確認が必要です'}),
    plainState({phase: 'done'}),
  ]);
  const {result, outputs} = await drive(client, fakeUi());
  assert.deepEqual(result, {done: true});
  assert.ok(outputs.includes(url));
  assert.equal(posts(client, '/api/setup/start').length, 1);
});

test('checkpoint (debug S3): start waits until the user says they are done', async () => {
  const url = 'https://muse.ai/checkpoint?x=2';
  const client = fakeClient([
    plainState({phase: 'checkpoint', checkpointUrl: url, message: '追加の確認が必要です'}),
    plainState({phase: 'checkpoint', checkpointUrl: url, message: '追加の確認が必要です'}),
    plainState({phase: 'checkpoint', checkpointUrl: url, message: '追加の確認が必要です'}),
    plainState({phase: 'done'}),
  ]);
  const ui = fakeUi({confirm: [false, true]});
  const {result, outputs} = await drive(client, ui);
  assert.deepEqual(result, {done: true});
  assert.equal(uiCalls(ui, 'confirm').length, 2, 'asked, told "not yet", asked again after a wait');
  assert.equal(posts(client, '/api/setup/start').length, 1, 'start only after the user said done');
  assert.equal(outputs.filter(x => x === url).length, 1, 'the URL is shown once per checkpoint');
});

test('checkpoint (debug S3): a checkpoint with only a message is shown and resumable, not a silent hang', async () => {
  const client = fakeClient([
    plainState({phase: 'checkpoint', checkpointUrl: null, message: '追加の確認が必要です（ブラウザで承認してください）'}),
    plainState({phase: 'done'}),
  ]);
  const ui = fakeUi({confirm: [true]});
  const {result, outputs} = await drive(client, ui);
  assert.deepEqual(result, {done: true});
  assert.ok(outputs.some(x => x.includes('ブラウザで承認')), 'the message is shown');
  assert.equal(posts(client, '/api/setup/start').length, 1);
});

test('cancelled (debug S5): a stale cancelled flow is restarted once instead of bricking the start', async () => {
  const client = fakeClient([
    plainState({phase: 'cancelled'}),
    plainState({phase: 'busy', busy: '進めています'}),
    plainState({phase: 'done'}),
  ]);
  const {result} = await drive(client, fakeUi());
  assert.deepEqual(result, {done: true});
  assert.equal(posts(client, '/api/setup/start').length, 1, 'start() runs from cancelled, as SetupFlow allows');
});

test('cancelled (debug S5): a flow cancelled again after the restart is reported as cancelled', async () => {
  const client = fakeClient([
    plainState({phase: 'cancelled'}),
    plainState({phase: 'cancelled'}),
  ]);
  const {result} = await drive(client, fakeUi());
  assert.deepEqual(result, {done: false, cancelled: true});
  assert.equal(posts(client, '/api/setup/start').length, 1, 'restarted once, not in a loop');
});

test('done (debug S11): the final lines the flow pushed are printed before returning', async () => {
  const client = fakeClient([
    plainState({phase: 'busy', lines: ['準備中です']}),
    plainState({phase: 'done', lines: ['準備中です', 'ログインできました']}),
  ]);
  const {result, outputs} = await drive(client, fakeUi());
  assert.deepEqual(result, {done: true});
  assert.ok(outputs.includes('ログインできました'), 'the terminal state\'s new lines are not dropped');
});

test('prompt (debug S6): a pick answered with the option label is sent as its index', async () => {
  const client = fakeClient([
    plainState({phase: 'busy', prompt: {id: 'p1', kind: 'pick', message: 'アカウントは？', options: [{label: 'アカウント A'}, {label: 'アカウント B'}]}}),
    plainState({phase: 'done'}),
  ]);
  const ui = fakeUi({pick: ['アカウント B']});
  const {result} = await drive(client, ui);
  assert.deepEqual(result, {done: true});
  const answers = posts(client, '/api/setup/answer');
  assert.equal(answers.length, 1);
  assert.deepEqual(answers.map(c => c[2]), [{promptId: 'p1', index: 1}], 'the label maps to the index the flow validates');
});

test('prompt (debug S6): a 409 answer does not retire the prompt — it is asked again', async () => {
  const states = [
    plainState({phase: 'busy', prompt: {id: 'p1', kind: 'text', message: '名前は？'}}),
    plainState({phase: 'busy', prompt: {id: 'p1', kind: 'text', message: '名前は？'}}),
    plainState({phase: 'done'}),
  ];
  let gets = 0, answers = 0;
  const client = {request: async (method, p) => {
    if (method === 'GET') return {status: 200, json: states[Math.min(gets++, states.length - 1)]};
    if (p.endsWith('/answer')) { answers++; if (answers === 1) { const e = new Error('stale'); e.status = 409; throw e; } return {status: 200, json: {}}; }
    return {status: 200, json: {}};
  }};
  const ui = fakeUi({ask: ['なまえ', 'なまえ']});
  const {result} = await drive(client, ui);
  assert.deepEqual(result, {done: true});
  assert.equal(answers, 2, 'the rejected answer is retried instead of stalling the prompt forever');
});

test('cancel (debug S10): a failing cancel request does not mask the cancel', async () => {
  const client = {request: async (method, p) => {
    if (method === 'GET') return {status: 200, json: plainState({phase: 'busy', prompt: {id: 'p1', kind: 'text', message: '名前は？'}})};
    if (p.endsWith('/cancel')) throw new Error('network down');
    return {status: 200, json: {}};
  }};
  const ui = fakeUi({ask: [undefined]});
  const {result} = await drive(client, ui);
  assert.deepEqual(result, {done: false, cancelled: true});
});

test('start (debug B15): a 404 from a POST is a failure, not "no setup"', async () => {
  const client = {request: async (method, p) => {
    if (method === 'GET') return {status: 200, json: plainState({phase: 'idle'})};
    return {status: 404, json: {error: 'unknown route'}};
  }};
  await assert.rejects(() => drive(client, fakeUi()), e => e && e.status === 404, 'only the state GET may treat 404 as absence');
});

test('events (debug S14): the driver subscribes to stream drops, not just events', async () => {
  let seenOpts = null;
  const client = fakeClient([plainState({phase: 'done'})]);
  client.serverEvents = opts => { seenOpts = opts; return () => {}; };
  const {result} = await drive(client, fakeUi());
  assert.deepEqual(result, {done: true});
  assert.equal(typeof seenOpts?.onClose, 'function');
});

test('an undefined prompt answer cancels the setup and reports cancelled', async () => {
  const client = fakeClient([
    plainState({phase: 'contact', prompt: plainPrompt({})}),
    plainState({phase: 'done'}),
  ]);
  const ui = fakeUi({ask: [undefined]});
  const {result} = await drive(client, ui);
  assert.deepEqual(result, {done: false, cancelled: true});
  assert.equal(posts(client, '/api/setup/cancel').length, 1);
  assert.equal(posts(client, '/api/setup/answer').length, 0);
});
