'use strict';
// Several muser windows on one PC share one Muse device, and Muse sends a tool call to whichever
// window connected last. That was often an idle one, which refused the call ("muser is idle")
// while another window was in the middle of a turn. A call carries no chat id, so an idle window
// hands it over to the one window that would take it, through a local named pipe. Nothing leaves
// the PC: each window lists its pipe in %LOCALAPPDATA%\muser\instances\muser-<pid>-<id>.json.
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const defaultDir = () => process.env.MUSER_RELAY_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'muser', 'instances');
// A window busy with a big edit or a slow tool may answer late; 2 s counted such a window as gone.
const ASK_MS = 4000;
// How long the handing window waits for the answer, past Muse's timeout: as long as the window
// running it may still take an approval (src/agent.js deadline: timeout + 30 s), and a little
// more. It gave up 5 s past the timeout, and told Muse "muser is idle" about a call another
// window was still showing for approval and could still run.
const INVOKE_MARGIN_MS = 35000;

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

// One JSON line out, one JSON line back.
function request(pipe, msg, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipe); let buf = '', done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => finish(new Error('relay timeout')), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify(msg) + '\n'));
    sock.on('data', d => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { try { finish(null, JSON.parse(buf.slice(0, i))); } catch (e) { finish(e); } } });
    sock.on('error', e => finish(e));
    sock.on('close', () => finish(new Error('relay closed')));
  });
}

class Relay {
  // takes(params): would this window run the call (it has the turn it belongs to)?
  // run(command, params, timeoutMs, id): run it here and return the device result.
  constructor({takes, run, dir = defaultDir()}) {
    this.takes = takes; this.run = run; this.dir = dir;
    const name = 'muser-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
    this.pipe = '\\\\.\\pipe\\' + name;
    this.file = path.join(dir, name + '.json');
    this.server = null;
  }
  start() {
    this.server = net.createServer(sock => {
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('error', () => {});
      sock.on('data', async d => {
        buf += d; const i = buf.indexOf('\n'); if (i < 0) return;
        let msg; try { msg = JSON.parse(buf.slice(0, i)); } catch { return sock.destroy(); }
        buf = '';
        let reply;
        try {
          if (msg.type === 'takes') reply = {takes: !!this.takes(msg.params)};
          else if (msg.type === 'invoke') reply = {result: await this.run(msg.command, msg.params, msg.timeoutMs, msg.id)};
          else reply = {error: 'unknown'};
        } catch (e) { reply = {result: {ok: false, error: e.message}}; }
        sock.end(JSON.stringify(reply) + '\n');
      });
    });
    this.server.on('error', () => {});
    this.server.listen(this.pipe);
    this.server.unref();
    // Through a temp file, so another window never reads half an entry.
    try { fs.mkdirSync(this.dir, {recursive: true}); fs.writeFileSync(this.file + '.tmp', JSON.stringify({pid: process.pid, pipe: this.pipe})); fs.renameSync(this.file + '.tmp', this.file); } catch {}
    return this;
  }
  stop() {
    try { this.server?.close(); } catch {}
    try { fs.unlinkSync(this.file); } catch {}
  }
  // The other muser windows on this PC; entries of windows that are gone are removed.
  peers() {
    let names = []; try { names = fs.readdirSync(this.dir); } catch { return []; }
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue; // a .tmp being written
      const f = path.join(this.dir, n);
      let e; try { e = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
      if (!e?.pipe || e.pipe === this.pipe) continue;
      if (!alive(e.pid)) { try { fs.unlinkSync(f); } catch {} continue; }
      out.push({...e, file: f});
    }
    return out;
  }
  // {result} when exactly one other window takes the call; else {takers: n} (0, or 2+ = ambiguous);
  // {takers: 1, error} when the one that took it did not answer.
  async forward(command, params, timeoutMs, id) {
    // An entry whose pipe is gone (its pid now belongs to another program) is removed.
    const ask = p => request(p.pipe, {type: 'takes', params}, ASK_MS).then(r => r.takes ? p : null, e => { if (e.code === 'ENOENT') { try { fs.unlinkSync(p.file); } catch {} } return null; });
    const answers = await Promise.all(this.peers().map(ask));
    const takers = answers.filter(Boolean);
    if (takers.length !== 1) return {takers: takers.length};
    try {
      const r = await request(takers[0].pipe, {type: 'invoke', command, params, timeoutMs, id}, (timeoutMs || 600000) + INVOKE_MARGIN_MS);
      return {result: r.result};
    } catch (e) { return {takers: 1, error: e.message}; }
  }
}

module.exports = {Relay, INVOKE_MARGIN_MS};
