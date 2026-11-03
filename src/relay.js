'use strict';
// Several muser windows on one PC used to share one Muse device, and Muse sent a tool call to
// whichever window connected last. That was often an idle one, which refused the call ("muser is
// idle") while another window was in the middle of a turn. Each window now has a node id of its own
// (src/node-slots.js); this still covers windows sharing one (all slots taken, older muser
// versions). A call carries no chat id, so an idle window hands it over to the one window that
// would take it, through a local named pipe. Nothing leaves
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
// Line buffers are capped on both sides: a peer that never sends a newline (buggy or wedged
// window) used to grow the buffer without limit. The cap is generous — a single invoke result
// can legitimately be ~15 MB — but finite.
const MAX_LINE_BYTES = 64 * 1024 * 1024;
// A server socket that never completes its first line is destroyed after this long. The timer
// only runs while a line is incomplete: once a message is parsed, a long invoke may still take
// as long as its timeout allows.
const IDLE_TIMEOUT_MS = 60000;

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

// One JSON line out, one JSON line back.
function request(pipe, msg, timeoutMs, maxBytes = MAX_LINE_BYTES) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipe); let buf = '', done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => finish(new Error('relay timeout')), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify(msg) + '\n'));
    sock.on('data', d => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) { if (buf.length > maxBytes) finish(new Error('relay response too large')); return; }
      if (i > maxBytes) { finish(new Error('relay response too large')); return; }
      try { finish(null, JSON.parse(buf.slice(0, i))); } catch (e) { finish(e); }
    });
    sock.on('error', e => finish(e));
    sock.on('close', () => finish(new Error('relay closed')));
  });
}

class Relay {
  // takes(params): would this window run the call (it has the turn it belongs to)?
  // run(command, params, timeoutMs, id): run it here and return the device result.
  // idleTimeoutMs / maxLineBytes default to the module constants; tests may shrink them.
  // account(): this window's Muse account id (src/accounts.js). A call is only ever handed to a
  // window on the same account: another account's window would run it for a Muse whose chat
  // never asked for it. Windows that do not say (older muser) are not filtered.
  constructor({takes, run, account = () => null, dir = defaultDir(), idleTimeoutMs = IDLE_TIMEOUT_MS, maxLineBytes = MAX_LINE_BYTES}) {
    this.takes = takes; this.run = run; this.account = account; this.dir = dir;
    this.idleTimeoutMs = idleTimeoutMs; this.maxLineBytes = maxLineBytes;
    const name = 'muser-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
    this.pipe = '\\\\.\\pipe\\' + name;
    this.file = path.join(dir, name + '.json');
    this.server = null;
    this._sockets = new Set();
  }
  start() {
    this.server = net.createServer(sock => {
      this._sockets.add(sock);
      let buf = '';
      let idle = null;
      const armIdle = () => {
        if (idle) clearTimeout(idle);
        if (this.idleTimeoutMs > 0) { idle = setTimeout(() => sock.destroy(), this.idleTimeoutMs); idle.unref?.(); }
      };
      armIdle();
      sock.setEncoding('utf8');
      sock.on('error', () => {});
      sock.on('close', () => { if (idle) clearTimeout(idle); this._sockets.delete(sock); });
      sock.on('data', async d => {
        buf += d; const i = buf.indexOf('\n');
        if (i < 0) {
          if (buf.length > this.maxLineBytes) return sock.destroy();
          armIdle();
          return;
        }
        if (i > this.maxLineBytes) return sock.destroy();
        if (idle) clearTimeout(idle); // line complete: processing may legitimately take a while
        let msg; try { msg = JSON.parse(buf.slice(0, i)); } catch { return sock.destroy(); }
        buf = '';
        let reply;
        try {
          const mine = this.account(), other = msg.account && mine && msg.account !== mine;
          if (msg.type === 'takes') reply = {takes: !other && !!this.takes(msg.params)};
          else if (msg.type === 'invoke') reply = {result: other ? {ok: false, error: 'This call came from another Muse account than this muser window is on.'} : await this.run(msg.command, msg.params, msg.timeoutMs, msg.id)};
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
    for (const sock of this._sockets) { try { sock.destroy(); } catch {} }
    this._sockets.clear();
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
    const account = this.account() || undefined;
    const ask = p => request(p.pipe, {type: 'takes', params, account}, ASK_MS, this.maxLineBytes).then(r => r.takes ? p : null, e => { if (e.code === 'ENOENT') { try { fs.unlinkSync(p.file); } catch {} } return null; });
    const answers = await Promise.all(this.peers().map(ask));
    const takers = answers.filter(Boolean);
    if (takers.length !== 1) return {takers: takers.length};
    try {
      const r = await request(takers[0].pipe, {type: 'invoke', command, params, timeoutMs, id, account}, (timeoutMs || 600000) + INVOKE_MARGIN_MS, this.maxLineBytes);
      return {result: r.result};
    } catch (e) { return {takers: 1, error: e.message}; }
  }
}

module.exports = {Relay, INVOKE_MARGIN_MS, MAX_LINE_BYTES, IDLE_TIMEOUT_MS, defaultDir, alive};
