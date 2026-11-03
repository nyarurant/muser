'use strict';
// Input history shared by muser windows. Runs in a child process with its own home folder, so the
// user's real ~/.muser/history.json is never touched.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const SCRIPT = `
const {EventEmitter} = require('node:events');
(async () => {
  const {Controller} = await import(${JSON.stringify('file:///' + path.join(__dirname, '..', 'src', 'ui', 'controller.mjs').replace(/\\/g, '/'))});
  const make = () => {
    const a = new EventEmitter();
    Object.assign(a, {mode: 'default', cwd: process.cwd(), session: {id: 'x', turns: 0}, ctx: {cwd: process.cwd(), readFiles: new Set(), todos: []}, client: {status: 'connected'}, allowAlways: new Set(), device: {connected: true}, send: async () => {}});
    return new Controller({agent: a, museName: 'm', version: 't', onExit() {}});
  };
  const w1 = make(), w2 = make(); // two windows, both started before either sent anything
  const send = (w, text) => { w.setText(text); w.key('', {return: true}); };
  send(w1, 'from window 1'); send(w2, 'from window 2'); send(w1, 'again from 1');
})();
`;

test("two muser windows keep each other's input history", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-hist-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const env = {...process.env, USERPROFILE: home, HOME: home, MUSER_LANG: 'ja'};
  delete env.MUSER_HISTORY_FILE; // the default place, inside the scratch home
  execFileSync(process.execPath, ['-e', SCRIPT], {env, encoding: 'utf8', timeout: 60000});
  const saved = JSON.parse(fs.readFileSync(path.join(home, '.muser', 'history.json'), 'utf8'));
  assert.deepEqual(saved, ['from window 1', 'from window 2', 'again from 1']);
});
