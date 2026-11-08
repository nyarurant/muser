'use strict';
// SetupFlow (src/server/setup.js): the first-run setup as an HTTP-answerable
// state machine. The registration stage is driven two ways: the real
// pcLogin with a fake web (the loginWeb shape from fix2-login.test.js), and
// scripted fake deps for the flow's own mechanics (cancel, restart, ...).
const test = require('node:test');
const assert = require('node:assert');
const {SetupFlow, maskContact} = require('../src/server/setup');
const {pcLogin} = require('../src/pc-login');

// Poll the plain state until a condition holds (prompts stay up until they
// are answered, so polling can never miss one).
async function waitFor(flow, pred, label) {
  for (let i = 0; i < 2000; i++) {
    const st = flow.state();
    if (pred(st)) return st;
    await new Promise(r => setImmediate(r));
  }
  throw new Error('timed out waiting for ' + label + '; last state: ' + JSON.stringify(flow.state()));
}
const waitPrompt = (flow, kind, notId) => waitFor(flow,
  st => !!st.prompt && (!kind || st.prompt.kind === kind) && st.prompt.id !== notId, 'prompt ' + (kind || ''));

// A fake muse.ai web in the fix2-login.test.js shape.
function loginWeb(over = {}) {
  const counts = {confirm_otp: 0};
  const web = {
    sdkRequest: async method => method === 'GET' ? {tokens: [], maxActiveTokens: 2} : {token: 'mgst_test', sdkToken: {id: 'id1'}},
    nativeRequest: async (scope, route, body) => {
      if (route.endsWith('/auth/start')) return {access_token: 'at'};
      if (route.endsWith('/login_options')) return {};
      if (route.endsWith('/send_otp')) return {auth_state: 'as'};
      if (route.endsWith('/confirm_otp')) { counts.confirm_otp++; return over.confirm ? over.confirm(counts.confirm_otp, body) : {abra_access_token: 'abra', abra_user_id: 'u1'}; }
      if (route.endsWith('/select_account')) return over.select ? over.select(body) : {abra_access_token: 'abra', abra_user_id: 'u1'};
      if (route.endsWith('/two_factor/send_code')) return {};
      if (route.endsWith('/two_factor')) return over.twoFactor ? over.twoFactor(body) : {abra_access_token: 'abra', abra_user_id: 'u1'};
      if (route.endsWith('/device_token/mint')) return {access_token: 'dat', refresh_token: 'drt'};
      if (route.endsWith('/fetch_vms')) return {vm_list: []};
      throw new Error('unexpected ' + route);
    },
    fetchJson: async () => ({}),
  };
  return {web, counts};
}
let fileSeq = 0;
const nextFile = () => 'setup-flow-' + (++fileSeq) + '/device.enc';
const noLogin = {needs: async () => ({login: false, device: true}), login: async () => { throw new Error('login must not run'); }};

test('setup-flow maskContact: email keeps 2 local chars + domain, phone keeps last 2 digits, else 2 chars', () => {
  assert.equal(maskContact('taro.yamada@example.com'), 'ta***@example.com');
  assert.equal(maskContact('ab@example.com'), 'ab***@example.com');
  assert.equal(maskContact('+819012345678'), '***********78');
  assert.equal(maskContact('090-1234-5678'), '***********78');
  assert.equal(maskContact('somebody'), 'so***');
});

test('setup-flow: login -> terms -> contact -> code -> done with the real pcLogin', async () => {
  const {web} = loginWeb();
  const file = nextFile();
  let needsCalls = 0, busyInLogin = null;
  const flow = new SetupFlow({
    needs: async () => { needsCalls++; return needsCalls === 1 ? {login: true, device: false} : {login: false, device: true}; },
    login: async progress => { progress('Edge の窓を開いています'); progress('ログインを待っています'); busyInLogin = flow.state(); },
    register: ui => pcLogin(web, ui, {file}),
  });
  let doneFired = false, changes = 0;
  flow.on('done', () => { doneFired = true; });
  flow.on('change', () => { changes++; });
  const startP = flow.start();
  // Terms consent (the SDK token confirm).
  let st = await waitPrompt(flow, 'confirm');
  assert.equal(st.phase, 'terms');
  assert.equal(st.prompt.secret, false);
  assert.deepEqual(st.steps, {login: 'done', device: 'now'}, 'login step done, device step current');
  flow.answer({promptId: st.prompt.id, value: true});
  // Contact.
  st = await waitPrompt(flow, 'text');
  assert.equal(st.phase, 'contact');
  assert.equal(st.prompt.placeholder, 'you@example.com');
  flow.answer({promptId: st.prompt.id, value: 'taro@example.com'});
  // Code: the "code sent" line is masked, the full contact is nowhere in state.
  st = await waitPrompt(flow, 'text');
  assert.equal(st.phase, 'code');
  assert.equal(st.prompt.secret, true, 'the code prompt is marked secret');
  assert.ok(st.lines.some(l => l === 'ta***@example.com にコードを送りました。'), 'masked code-sent line: ' + JSON.stringify(st.lines));
  assert.ok(!JSON.stringify(st).includes('taro@example.com'), 'full contact never enters state');
  flow.answer({promptId: st.prompt.id, value: '654321'});
  await startP;
  st = flow.state();
  assert.equal(st.phase, 'done');
  assert.deepEqual(st.steps, {login: 'done', device: 'done'});
  assert.equal(st.prompt, null);
  assert.equal(doneFired, true, 'done event fired');
  assert.ok(changes > 0, 'change events fired');
  assert.equal(needsCalls, 2, 'needs asked again after the login');
  assert.equal(busyInLogin.phase, 'login', 'phase is login while the Edge login runs');
  assert.equal(busyInLogin.busy, 'ログインを待っています', 'busy keeps only the latest progress line');
  assert.ok(!JSON.stringify(st).includes('654321'), 'the answered code never enters state');
});

test('setup-flow: account choice and two-factor branch', async () => {
  const acct = {account_selection_required: true, accounts: [{account_ref: 'r1', display_name: 'Work'}, {account_ref: 'r2', display_name: 'Personal'}], selection_state: 'ss'};
  const tf = {two_factor_required: true, two_factor_methods: [{method_id: 'm1', method_type: 'SMS', display_name: 'SMS'}], two_factor_state: 'ts'};
  const {web} = loginWeb({confirm: () => acct, select: () => tf});
  const flow = new SetupFlow({...noLogin, register: ui => pcLogin(web, ui, {file: nextFile()})});
  const startP = flow.start();
  let st = await waitPrompt(flow, 'confirm'); // terms
  flow.answer({promptId: st.prompt.id, value: true});
  st = await waitPrompt(flow, 'text'); // contact
  flow.answer({promptId: st.prompt.id, value: 'a@b.c'});
  st = await waitPrompt(flow, 'text'); // code
  flow.answer({promptId: st.prompt.id, value: '111111'});
  st = await waitPrompt(flow, 'pick');
  assert.equal(st.phase, 'account');
  assert.deepEqual(st.prompt.options.map(o => o.label), ['Work', 'Personal']);
  // A pick answered with a value instead of an index is a 409 and the wait survives.
  assert.throws(() => flow.answer({promptId: st.prompt.id, value: 1}), e => e.status === 409);
  assert.equal(flow.state().prompt.id, st.prompt.id);
  flow.answer({promptId: st.prompt.id, index: 1});
  st = await waitPrompt(flow, 'pick');
  assert.equal(st.phase, 'two_factor_method');
  flow.answer({promptId: st.prompt.id, index: 0});
  st = await waitPrompt(flow, 'text');
  assert.equal(st.phase, 'two_factor_code');
  assert.equal(st.prompt.secret, true);
  flow.answer({promptId: st.prompt.id, value: '999999'});
  await startP;
  assert.equal(flow.state().phase, 'done');
});

test('setup-flow: answer with a wrong promptId (or no wait, or a second start) is a 409 and the wait survives', async () => {
  let received = null;
  const flow = new SetupFlow({...noLogin, register: async ui => { received = await ui.ask('Muse にログインしているメールアドレス', {placeholder: 'you@example.com'}); }});
  assert.throws(() => flow.answer({promptId: 'p1', value: 'x'}), e => e.status === 409, 'no waiting question');
  const startP = flow.start();
  const st = await waitPrompt(flow, 'text');
  assert.equal(st.phase, 'contact');
  await assert.rejects(flow.start(), e => e.status === 409, 'a second start while running');
  assert.throws(() => flow.answer({promptId: 'wrong', value: 'x@y.z'}), e => e.status === 409, 'promptId mismatch');
  assert.throws(() => flow.answer({promptId: st.prompt.id, index: 0}), e => e.status === 409, 'a text question answered with an index');
  assert.equal(flow.state().prompt.id, st.prompt.id, 'the wait is untouched by the failed answers');
  flow.answer({promptId: st.prompt.id, value: '  x@y.z  '});
  await startP;
  assert.equal(received, 'x@y.z', 'ask answers are trimmed like the other UIs');
  assert.equal(flow.state().phase, 'done');
});

test('setup-flow: a wrong code re-asks in phase code, with the retry sentence in message and lines', async () => {
  const {web} = loginWeb({confirm: n => { if (n === 1) throw Object.assign(new Error('コードが違います'), {status: 400}); return {abra_access_token: 'abra', abra_user_id: 'u1'}; }});
  const flow = new SetupFlow({...noLogin, register: ui => pcLogin(web, ui, {file: nextFile()})});
  const startP = flow.start();
  let st = await waitPrompt(flow, 'confirm');
  flow.answer({promptId: st.prompt.id, value: true});
  st = await waitPrompt(flow, 'text');
  flow.answer({promptId: st.prompt.id, value: 'a@b.c'});
  st = await waitPrompt(flow, 'text');
  assert.equal(st.phase, 'code');
  flow.answer({promptId: st.prompt.id, value: '000000'});
  st = await waitPrompt(flow, 'text', st.prompt.id);
  assert.equal(st.phase, 'code', 'still in the code phase for the re-entry');
  assert.ok(st.message && st.message.includes('もう一度入力してください'), 'retry sentence in message: ' + st.message);
  assert.ok(st.lines.some(l => l.includes('もう一度入力してください')), 'retry sentence in lines');
  flow.answer({promptId: st.prompt.id, value: '111111'});
  await startP;
  assert.equal(flow.state().phase, 'done');
});

test('setup-flow: cancel rejects the wait, lands in cancelled, and start runs it again from the top', async () => {
  let runs = 0;
  const flow = new SetupFlow({...noLogin, register: async ui => { runs++; await ui.ask('Muse にログインしているメールアドレス'); }});
  const first = flow.start();
  const st = await waitPrompt(flow, 'text');
  assert.equal(st.phase, 'contact');
  flow.cancel();
  assert.equal(flow.state().phase, 'cancelled');
  assert.equal(flow.state().prompt, null);
  await first; // the cancelled run settles instead of hanging or rejecting
  assert.equal(flow.state().phase, 'cancelled');
  const second = flow.start();
  const st2 = await waitPrompt(flow, 'text', st.prompt.id);
  flow.answer({promptId: st2.prompt.id, value: 'a@b.c'});
  await second;
  assert.equal(runs, 2, 'register ran again from the top');
  assert.equal(flow.state().phase, 'done');
});

test('setup-flow: kept lines mask short-TLD emails and parenthesised phones too (master-debug #16)', async () => {
  const flow = new SetupFlow({...noLogin, register: async ui => {
    ui.info('a@b.c にコードを送りました。');
    ui.info('(090) 1234-5678 にコードを送りました。');
    ui.info('someone@example.com にコードを送りました。');
    ui.info('期限 2026-11-08 / 接続 127.0.0.1');
  }});
  await flow.start();
  const lines = flow.state().lines;
  assert.equal(lines.length, 4);
  assert.ok(!lines[0].includes('a@b.c') && lines[0].includes('a***@b.c'), 'short-TLD email masked: ' + lines[0]);
  assert.ok(!lines[1].includes('090') && !lines[1].includes('1234') && lines[1].includes('78'), 'parenthesised phone masked to its last 2 digits: ' + lines[1]);
  assert.ok(lines[2].includes('so***@example.com'), 'ordinary email still masked: ' + lines[2]);
  assert.ok(lines[3].includes('2026-11-08') && lines[3].includes('127.0.0.1'), 'dates and IPs are not contacts: ' + lines[3]);
});

test('setup-flow: a pick answer outside the option range is a 409 and the wait survives (master-debug #15)', async () => {
  let picked = null;
  const flow = new SetupFlow({...noLogin, register: async ui => { picked = await ui.pick('どのアカウント', [{label: 'A'}, {label: 'B'}]); }});
  const run = flow.start();
  const st = await waitPrompt(flow, 'pick');
  assert.equal(st.prompt.options.length, 2);
  assert.throws(() => flow.answer({promptId: st.prompt.id, index: 999}), e => e.status === 409);
  assert.throws(() => flow.answer({promptId: st.prompt.id, index: -1}), e => e.status === 409);
  flow.answer({promptId: st.prompt.id, index: 1});
  await run;
  assert.equal(picked, 1);
  assert.equal(flow.state().phase, 'done');
});

test('setup-flow: cancel during the login stage aborts the login and frees the flow (master-debug #3)', async () => {
  let sawSignal = null, loginCalls = 0;
  const flow = new SetupFlow({
    needs: async () => ({login: true, device: false}),
    login: (progress, signal) => {
      loginCalls++;
      if (loginCalls > 1) return Promise.resolve(); // the re-run's login completes at once
      return new Promise((resolve, reject) => {
        sawSignal = signal;
        signal.addEventListener('abort', () => { const e = new Error('中止しました。'); e.reasonKind = 'cancelled'; reject(e); });
      });
    },
    register: async () => { throw new Error('register must not run'); },
  });
  const first = flow.start();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(flow.state().phase, 'login');
  assert.ok(sawSignal instanceof AbortSignal, 'the login dep received an AbortSignal');
  flow.cancel();
  await first; // settles promptly as cancelled instead of waiting out the login
  assert.equal(flow.state().phase, 'cancelled');
  await flow.start(); // not stuck at 409: a fresh run is accepted and completes
  assert.equal(flow.state().phase, 'done');
});

test('setup-flow: a checkpoint stops the flow with its public URL, not as an error', async () => {
  const url = 'https://muse.ai/checkpoint/abc123';
  const {web} = loginWeb({confirm: () => ({checkpoint_required: true, checkpoint_url: url})});
  const flow = new SetupFlow({...noLogin, register: ui => pcLogin(web, ui, {file: nextFile()})});
  const startP = flow.start();
  let st = await waitPrompt(flow, 'confirm');
  flow.answer({promptId: st.prompt.id, value: true});
  st = await waitPrompt(flow, 'text');
  flow.answer({promptId: st.prompt.id, value: 'a@b.c'});
  st = await waitPrompt(flow, 'text');
  flow.answer({promptId: st.prompt.id, value: '111111'});
  await startP;
  st = flow.state();
  assert.equal(st.phase, 'checkpoint');
  assert.equal(st.checkpointUrl, url);
  assert.equal(st.error, null);
  assert.equal(st.steps.device, 'now', 'the device step is not done');
});

test('setup-flow: nothing needed is done at once, without login or register running', async () => {
  let needsCalls = 0, doneFired = false;
  const flow = new SetupFlow({
    needs: async () => { needsCalls++; return {login: false, device: false}; },
    login: async () => { throw new Error('login must not run'); },
    register: async () => { throw new Error('register must not run'); },
  });
  flow.on('done', () => { doneFired = true; });
  await flow.start();
  const st = flow.state();
  assert.equal(st.phase, 'done');
  assert.deepEqual(st.steps, {login: 'done', device: 'done'});
  assert.equal(needsCalls, 1);
  assert.equal(doneFired, true);
});

test('setup-flow: an unrecognised question keeps the current phase and is still published', async () => {
  const flow = new SetupFlow({...noLogin, register: async ui => { await ui.ask('好きな色は何ですか？'); }});
  const startP = flow.start();
  const st = await waitPrompt(flow, 'text');
  assert.equal(st.prompt.message, '好きな色は何ですか？');
  assert.equal(st.phase, 'busy', 'no wording match: the phase stays where it was');
  flow.answer({promptId: st.prompt.id, value: '青'});
  await startP;
  assert.equal(flow.state().phase, 'done');
});

test('setup-flow: a failed login lands in error and start can retry it', async () => {
  let attempts = 0;
  const flow = new SetupFlow({
    needs: async () => ({login: true, device: false}),
    login: async () => { attempts++; if (attempts === 1) throw new Error('Edge が見つかりません'); },
    register: async () => { throw new Error('register must not run'); },
  });
  await flow.start();
  let st = flow.state();
  assert.equal(st.phase, 'error');
  assert.equal(st.error, 'Edge が見つかりません');
  await flow.start();
  st = flow.state();
  assert.equal(st.phase, 'done');
  assert.equal(attempts, 2);
});

test('setup-flow: state() hands out copies, not the live object', async () => {
  const flow = new SetupFlow({needs: async () => ({login: false, device: false}), login: async () => {}, register: async () => {}});
  const st = flow.state();
  st.steps.login = 'now'; st.lines.push('x'); st.phase = 'error';
  const again = flow.state();
  assert.equal(again.phase, 'idle');
  assert.equal(again.steps.login, 'later');
  assert.deepEqual(again.lines, []);
});

test('setup-flow onboard: an outside ui reaches register; without one, register gets the clack shape', async () => {
  const {onboard} = require('../src/tui/onboard');
  const mine = {info() {}, note() {}, ask: async () => '', confirm: async () => true, pick: async () => 0, busy: async (_l, fn) => fn(), close() {}};
  let got = null;
  await onboard({needLogin: false, needDevice: true, login: async () => {}, register: async ui => { got = ui; }, ui: mine});
  assert.equal(got, mine, 'the passed ui is used as-is');
  got = null;
  await onboard({needLogin: false, needDevice: true, login: async () => {}, register: async ui => { got = ui; }});
  assert.ok(got && got !== mine, 'a default ui is built');
  for (const k of ['info', 'note', 'ask', 'confirm', 'pick', 'busy']) assert.equal(typeof got[k], 'function', 'clack ui has ' + k);
});
