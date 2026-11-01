'use strict';

const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');
const WebSocket = require('ws');
const {
  NoiseXX,
  Transport,
  fields,
  first,
  uint,
  bytes,
  str,
  cat,
} = require('./noise');

const NOISE_URL_PREFIX = 'wss://hatch.metaaivm.com/v1/noise?vm_id=';
const CONTROL_PATH = '/link-control';
const CHAT_PATH = '/chat/stream';
const APP_ID = 'musegadget';
const MAX_INBOUND_MESSAGE = 4 * 1024 * 1024;
const MAX_OUTBOUND_MESSAGE = 256 * 1024;
const MAX_CONCURRENT_INVOKES = 6;
const MAX_CHAT_MESSAGE = 16 * 1024 * 1024 - 65536;
const MAX_PENDING_REQUESTS = 64;
const MAX_COMPLETED_INVOKES = 128;
const CONNECT_TIMEOUT_MS = 25_000;
const REQUEST_TIMEOUT_MS = 60_000;
const PING_INTERVAL_MS = 20_000;
const OPEN = 1;

function safeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asBinary(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value);
}

function encodeControlMessage(message) {
  let raw;
  try {
    raw = Buffer.from(JSON.stringify(message));
  } catch {
    throw safeError('outbound_invalid');
  }
  if (raw.length > MAX_OUTBOUND_MESSAGE) throw safeError('outbound_too_large');
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32LE(raw.length, 0);
  return Buffer.concat([prefix, raw]);
}

class ControlMessageDecoder {
  constructor(maxMessageBytes = MAX_INBOUND_MESSAGE) {
    this.maxMessageBytes = maxMessageBytes;
    this.buffer = Buffer.alloc(0);
  }

  feed(chunk) {
    const data = asBinary(chunk);
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
    const messages = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > this.maxMessageBytes) throw safeError('inbound_too_large');
      if (this.buffer.length < length + 4) break;
      const raw = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      if (length === 0) continue;
      let message;
      try {
        message = JSON.parse(raw.toString('utf8'));
      } catch {
        continue;
      }
      if (isRecord(message)) messages.push(message);
    }
    if (this.buffer.length > this.maxMessageBytes + 4) {
      throw safeError('inbound_too_large');
    }
    return messages;
  }
}

function responseError(value) {
  if(typeof value==='string')return value.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,2000)||'command_failed';
  if (value && typeof value === 'object' && typeof value.code === 'string' &&
      /^[A-Za-z0-9_-]{1,80}$/.test(value.code)) {
    return value.code;
  }
  if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)) {
    return value;
  }
  return 'command_failed';
}

function statusMessage(code) {
  switch (code) {
    case 'connecting': return 'connecting';
    case 'connected': return 'connected';
    case 'connection_timeout': return 'connection timed out';
    case 'connection_closed': return 'connection closed';
    case 'connection_failed': return 'connection failed';
    case 'registration_failed': return 'registration failed';
    case 'device_unpaired': return 'device unpaired';
    case 'protocol_error': return 'protocol error';
    case 'socket_error': return 'connection failed';
    default: return 'disconnected';
  }
}

class NativeDevice extends EventEmitter {
  constructor({
    execute,
    commands,
    displayName,
    WebSocket: WebSocketImpl,
    socketFactory,
    noiseFactory,
    transportFactory,
    invokes,
  } = {}) {
    super();
    if (typeof execute !== 'function') throw new TypeError('execute is required');
    this._execute = execute;
    this._commands = commands === undefined ? {} : commands;
    this._displayName = typeof displayName === 'string' ? displayName : '';
    this._WebSocket = WebSocketImpl || WebSocket;
    this._socketFactory = socketFactory;
    this._noiseFactory = noiseFactory || (() => new NoiseXX());
    this._transportFactory = transportFactory || ((tx, rx) => new Transport(tx, rx));

    this._ws = null;
    this._noise = null;
    this._transport = null;
    this._phase = 'idle';
    this._connected = false;
    this._nodeId = null;
    this._vmId = null;
    this._vmToken = null;
    this._controlStreamId = null;
    this._registerId = null;
    this._controlDecoder = null;
    this._pending = new Map();
    // muser: shared across reconnects (invokes), so an invoke Muse re-sends to the new
    // connection is answered from the record instead of running a second time.
    this._inflightInvokes = invokes?.inflight || new Map();
    this._completedInvokes = invokes?.completed || new Map();
    this._invokeBusy = false;
    this._streamFallback = 1n;
    this._sendQueue = Promise.resolve();
    this._connectPromise = null;
    this._connectWait = null;
    this._connectTimer = null;
    this._registerWait = null;
    this._pingTimer = null;
  }

  get connected() {
    // muser: a socket being torn down is not connected even before its close event arrives.
    return this._connected &&
      !(this._ws && this._ws.readyState !== undefined && this._ws.readyState !== OPEN);
  }

  get nodeId() {
    return this._nodeId;
  }

  _emitStatus(connected, message) {
    this._connected = Boolean(connected);
    this.emit('status', {connected: this._connected, message});
  }

  _clearConnectTimer() {
    if (this._connectTimer !== null) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }
  }

  _isCurrent(ws) {
    return this._ws === ws;
  }

  _makeSocket(url, options) {
    if (this._socketFactory) return this._socketFactory(url, options);
    return new this._WebSocket(url, options);
  }

  connect({vm, nodeId} = {}) {
    if (!vm || typeof vm.vm_id !== 'string' || !vm.vm_id ||
        typeof vm.vm_auth_token !== 'string' || !vm.vm_auth_token) {
      return Promise.reject(safeError('credentials_required'));
    }
    if (typeof nodeId !== 'string' || !nodeId) {
      return Promise.reject(safeError('node_id_required'));
    }
    if (this._connectPromise) return this._connectPromise;
    if (this.connected && this._nodeId === nodeId) return Promise.resolve();
    if (this._ws || this._transport) this.disconnect();

    this._nodeId = nodeId;
    this._vmId = vm.vm_id;
    this._vmToken = vm.vm_auth_token;
    this._phase = 'opening';
    this._emitStatus(false, statusMessage('connecting'));

    let resolveConnect;
    let rejectConnect;
    this._connectPromise = new Promise((resolve, reject) => {
      resolveConnect = resolve;
      rejectConnect = reject;
    });
    this._connectWait = {resolve: resolveConnect, reject: rejectConnect};
    const completion = this._connectPromise;
    this._connectTimer = setTimeout(
      () => this._failConnection('connection_timeout'),
      CONNECT_TIMEOUT_MS,
    );
    this._connectTimer.unref?.();

    const url = NOISE_URL_PREFIX + encodeURIComponent(vm.vm_id);
    const options = {
      headers: {Authorization: 'Bearer ' + vm.vm_auth_token},
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      maxPayload: MAX_INBOUND_MESSAGE,
    };
    try {
      const ws = this._makeSocket(url, options);
      this._ws = ws;
      this._wireSocket(ws);
    } catch {
      this._failConnection('connection_failed');
    }
    return completion.finally(() => {
      if (this._connectPromise === completion) this._connectPromise = null;
    });
  }

  _wireSocket(ws) {
    if (!ws || typeof ws.on !== 'function') throw safeError('connection_failed');
    ws.on('open', () => this._onOpen(ws));
    ws.on('message', (data, isBinary) => this._onMessage(ws, data, isBinary));
    ws.on('error', () => this._onSocketError(ws));
    ws.on('close', () => this._onSocketClose(ws));
  }

  _onOpen(ws) {
    if (!this._isCurrent(ws)) return;
    try {
      this._phase = 'handshake';
      this._noise = this._noiseFactory();
      this._sendRaw(ws, this._noise.message1());
      this._startPing(ws);
    } catch {
      this._failConnection('connection_failed');
    }
  }

  _startPing(ws) {
    if (this._pingTimer !== null) clearInterval(this._pingTimer);
    // muser: a socket that went half-open (PC sleep, network change) never closes by itself;
    // treat missing pongs as a drop so the agent reconnects.
    let lastPong = Date.now();
    ws.on?.('pong', () => { lastPong = Date.now(); });
    this._pingTimer = setInterval(() => {
      if (!this._isCurrent(ws)) return;
      if (ws.readyState !== undefined && ws.readyState !== OPEN) return;
      if (Date.now() - lastPong > PING_INTERVAL_MS * 2 + 5000) {
        this._failConnection('connection_timeout');
        return;
      }
      try {
        if (typeof ws.ping === 'function') ws.ping();
      } catch {
        this._failConnection('socket_error');
      }
    }, PING_INTERVAL_MS);
    this._pingTimer.unref?.();
  }

  _sendRaw(ws, frame) {
    if (!this._isCurrent(ws)) throw safeError('connection_closed');
    if (ws.readyState !== undefined && ws.readyState !== OPEN) {
      throw safeError('connection_closed');
    }
    ws.send(frame);
  }

  _onMessage(ws, data) {
    if (!this._isCurrent(ws)) return;
    try {
      if (this._phase === 'handshake') {
        if (typeof data === 'string') throw safeError('protocol_error');
        const payload = this._noise.message2(asBinary(data));
        let handshakeFields;
        try {
          handshakeFields = fields(payload);
        } catch {
          handshakeFields = null;
        }
        if (handshakeFields &&
            [1n, 2n].includes(first(handshakeFields, 2)) &&
            first(handshakeFields, 3)?.length === 32) {
          throw safeError('confidential_vm_unsupported');
        }
        const keys = this._noise.message3();
        this._transport = this._transportFactory(keys.tx, keys.rx);
        this._phase = 'control';
        this._openControl(ws).catch(() => this._failConnection('connection_failed'));
        this._sendRaw(ws, keys.message);
        return;
      }
      if (this._phase !== 'control' && this._phase !== 'connected') return;
      if (typeof data === 'string') throw safeError('protocol_error');
      if (asBinary(data).length > MAX_INBOUND_MESSAGE + 64 * 1024) {
        throw safeError('inbound_too_large');
      }
      const frame = this._transport.decode(asBinary(data));
      if (frame) this._handleFrame(frame);
    } catch (error) {
      const code = error && error.code === 'inbound_too_large'
        ? 'protocol_error'
        : 'connection_failed';
      this._failConnection(code);
    }
  }

  _onSocketError(ws) {
    if (this._isCurrent(ws)) this._failConnection('socket_error');
  }

  _onSocketClose(ws) {
    if (this._isCurrent(ws)) this._failConnection('connection_closed');
  }

  _nextStreamId() {
    if (this._transport && typeof this._transport.next === 'bigint') {
      const id = this._transport.next;
      this._transport.next += 1n;
      return id;
    }
    if (this._transport && typeof this._transport.next === 'number') {
      const id = this._transport.next;
      this._transport.next += 1;
      return id;
    }
    return this._streamFallback++;
  }

  _encodeControlStreamRequest(streamId) {
    const request = cat(
      str(1, 'POST'),
      str(2, CONTROL_PATH),
      uint(5, 0),
    );
    return this._transport.encode(
      0,
      cat(uint(1, streamId), bytes(2, request)),
    );
  }

  _encodeBodyChunk(streamId, body, endBody = false) {
    const chunk = cat(
      bytes(1, body),
      uint(2, endBody ? 1 : 0),
    );
    return this._transport.encode(
      0,
      cat(uint(1, streamId), bytes(4, chunk)),
    );
  }

  async _openControl(ws) {
    if (!this._isCurrent(ws)) throw safeError('connection_closed');
    this._controlDecoder = new ControlMessageDecoder();
    this._controlStreamId = this._nextStreamId();
    this._registerId = crypto.randomUUID();
    this._registerWait = {
      resolve: () => {},
      reject: () => {},
    };
    const streamFrames = this._encodeControlStreamRequest(this._controlStreamId);
    await this._sendFrames(streamFrames, ws);
    const register = {
      type: 'req',
      id: this._registerId,
      method: 'link.register',
      params: {
        node_id: this._nodeId,
        display_name: this._displayName,
        platform: 'windows',
        version: '0.5.0',
        device_family: 'homehub',
        model_id: 'windows',
        is_wakeup_supported: false,
        commands_v2: this._commands,
      },
    };
    await this._sendControlMessage(register, ws);
  }

  _sendFrames(frames, ws = this._ws) {
    const task = this._sendQueue.then(() => {
      if (!this._isCurrent(ws)) throw safeError('connection_closed');
      for (const frame of frames) this._sendRaw(ws, frame);
    });
    this._sendQueue = task.catch(() => {});
    return task;
  }

  _sendControlMessage(message, ws = this._ws) {
    const body = encodeControlMessage(message);
    if (this._controlStreamId === null) throw safeError('connection_closed');
    const frames = this._encodeBodyChunk(this._controlStreamId, body, false);
    return this._sendFrames(frames, ws);
  }

  _handleFrame(frame) {
    const id = String(frame.id);
    if (id === String(this._controlStreamId)) {
      if (frame.type === 'reset') {
        this._failConnection('protocol_error');
        return;
      }
      if (frame.type === 'response' && (frame.status < 200 || frame.status >= 300)) {
        this._failConnection('connection_failed');
        return;
      }
      if (frame.body?.length) {
        for (const message of this._controlDecoder.feed(frame.body)) {
          this._handleControlMessage(message);
        }
      }
      if (frame.end) this._failConnection('connection_closed');
      return;
    }
    const pending = this._pending.get(id);
    if (!pending) return;
    if (frame.type === 'reset') {
      this._settlePending(id, safeError('request_reset'));
      return;
    }
    if (frame.type === 'response') {
      pending.status = Number(frame.status) || 0;
      pending.headers = frame.headers || [];
    }
    if (frame.body?.length) {
      pending.size += frame.body.length;
      if (pending.size > MAX_INBOUND_MESSAGE) {
        this._settlePending(id, safeError('response_too_large'));
        return;
      }
      pending.body.push(Buffer.from(frame.body));
    }
    if (frame.end) this._settlePending(id);
  }

  _handleControlMessage(message) {
    if (message.id === this._registerId && message.method == null) {
      if (message.error || message.ok === false || message.status === 'err') {
        this._failConnection('registration_failed');
        return;
      }
      this._clearConnectTimer();
      this._phase = 'connected';
      const wait = this._connectWait;
      this._connectWait = null;
      this._registerWait = null;
      this._emitStatus(true, statusMessage('connected'));
      wait?.resolve();
      return;
    }
    if (message.event === 'link.unpaired' || message.event === 'node.unpaired') {
      this._failConnection('device_unpaired');
      return;
    }
    if (message.method === 'link.invoke' && this.connected) {
      this._dispatchInvoke(message);
    }
  }

  _dispatchInvoke(message) {
    const invokeId = message.id === undefined || message.id === null
      ? ''
      : String(message.id);
    if (!invokeId || invokeId.length > 256) return;
    if (this._completedInvokes.has(invokeId)) {
      const result = this._completedInvokes.get(invokeId);
      this._sendResult(invokeId, result).catch(() => {});
      return;
    }
    const prior = this._inflightInvokes.get(invokeId);
    if (prior) {
      prior.then((result) => this._sendResult(invokeId, result)).catch(() => {});
      return;
    }
    const command = typeof message.command === 'string' ? message.command : '';
    const params = isRecord(message.params) ? message.params : {};
    // muser: parallel agents call tools at the same time; allow a few concurrent invokes.
    // 'busy' is not remembered as the call's result: a re-send of the same id (Muse re-sends after
    // a reconnect) must run once a slot is free, not get 'busy' from the record forever.
    if (this._inflightInvokes.size >= MAX_CONCURRENT_INVOKES) {
      this._sendResult(invokeId, {ok: false, error: 'busy'}).catch(() => {});
      return;
    }
    const timeoutMs = Number.isFinite(message.timeout_ms) && message.timeout_ms > 0
      ? Math.min(600000, message.timeout_ms)
      : null;
    const executed = this._executeInvoke(invokeId, command, params, timeoutMs);
    // Watchdog: an execute() that never settles would otherwise leak this inflight
    // slot forever (counting against MAX_CONCURRENT_INVOKES) and leave the
    // duplicate-dedupe waiters above, which hold this same promise, unanswered.
    // Race it against a timeout result so the slot frees and every waiter is
    // answered once with that result, which is also what gets remembered for
    // later duplicates. Promise.race settles exactly once, so a late real
    // completion after the watchdog fires cannot double-answer or crash here.
    let watchdog = null;
    const task = Promise.race([
      executed,
      new Promise((resolve) => {
        watchdog = setTimeout(
          () => resolve({ok: false, error: 'invoke_timeout'}),
          (timeoutMs || 120000) + 30000,
        );
        watchdog.unref?.();
      }),
    ]);
    const clearWatchdog = () => {
      if (watchdog !== null) {
        clearTimeout(watchdog);
        watchdog = null;
      }
    };
    executed.then(clearWatchdog, clearWatchdog);
    this._inflightInvokes.set(invokeId, task);
    task.then((result) => {
      this._rememberCompleted(invokeId, result);
      return this._sendResult(invokeId, result);
    }).catch(() => {
      // _executeInvoke converts command failures to structured results. This
      // catch only prevents a transport failure from becoming unhandled.
    }).finally(() => {
      this._inflightInvokes.delete(invokeId);
    });
  }

  async _executeInvoke(id, command, params, timeoutMs) {
    this.emit('invoke', {phase: 'running', id, command, params});
    let result;
    try {
      const value = await this._execute(command, params, timeoutMs, id);
      if (value && value.ok === true) {
        result = {ok: true, payload: value.payload};
      } else {
        result = {ok: false, error: responseError(value?.error)};
      }
    } catch {
      result = {ok: false, error: 'command_failed'};
    }
    try {
      encodeControlMessage({method: 'link.result', id, ...result});
    } catch {
      result = {ok: false, error: 'result_too_large'};
    }
    this.emit('invoke', {phase: 'complete', id, command, params, result});
    return result;
  }

  _rememberCompleted(id, result) {
    this._completedInvokes.delete(id);
    this._completedInvokes.set(id, result);
    while (this._completedInvokes.size > MAX_COMPLETED_INVOKES) {
      this._completedInvokes.delete(this._completedInvokes.keys().next().value);
    }
  }

  async _sendResult(id, result) {
    const message = {method: 'link.result', id, ...result};
    try {
      await this._sendControlMessage(message);
    } catch (error) {
      if (error?.code !== 'outbound_too_large') return;
      try {
        await this._sendControlMessage({
          method: 'link.result',
          id,
          ok: false,
          error: 'result_too_large',
        });
      } catch {
        // The connection cleanup path will reject all outstanding work.
      }
    }
  }

  send(text, sessionId = '', extra = {}) {
    if (!this.connected || !this._transport || !this._ws) {
      return Promise.reject(safeError('not_connected'));
    }
    if (typeof text !== 'string') return Promise.reject(safeError('message_required'));
    if (!isRecord(extra)) extra = {};
    const attachments = Array.isArray(extra.attachments) ? extra.attachments : [];
    const content = attachments.length
      ? {items: [...(text ? [{type: 'text', text}] : []), ...attachments]}
      : {message: text};
    const bodyObject = {
      ...content,
      output_modality: 'text',
      device_id: this._nodeId,
    };
    if (sessionId) bodyObject.session_id = sessionId;
    if (extra.replyTo) bodyObject.in_reply_to = extra.replyTo;
    let body;
    try {
      body = Buffer.from(JSON.stringify(bodyObject));
    } catch {
      return Promise.reject(safeError('message_invalid'));
    }
    if (body.length > MAX_CHAT_MESSAGE) {
      return Promise.reject(safeError('message_too_large'));
    }
    return this._request(body, extra.timeoutMs);
  }

  _request(body, timeoutMs) {
    if (this._pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(safeError('busy'));
    }
    let request;
    try {
      request = this._transport.request(
        'POST',
        CHAT_PATH,
        body,
        [
          ['x-app-id', APP_ID],
          ['Content-Type', 'application/json'],
          ['Accept-Encoding', 'identity'],
        ],
        0,
      );
    } catch {
      return Promise.reject(safeError('connection_failed'));
    }
    const id = String(request.id);
    let resolveRequest;
    let rejectRequest;
    const promise = new Promise((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const requestedTimeout = Number.isFinite(Number(timeoutMs))
      ? Number(timeoutMs)
      : REQUEST_TIMEOUT_MS;
    const waitMs = Math.max(1, Math.min(REQUEST_TIMEOUT_MS, requestedTimeout));
    const pending = {
      resolve: resolveRequest,
      reject: rejectRequest,
      timer: null,
      status: 0,
      headers: [],
      body: [],
      size: 0,
    };
    pending.timer = setTimeout(() => {
      this._settlePending(id, safeError('request_timeout'));
    }, waitMs);
    pending.timer.unref?.();
    this._pending.set(id, pending);
    this._sendFrames(request.frames).catch(() => {
      this._settlePending(id, safeError('connection_closed'));
    });
    return promise;
  }

  _settlePending(id, error) {
    const pending = this._pending.get(String(id));
    if (!pending) return;
    this._pending.delete(String(id));
    clearTimeout(pending.timer);
    if (error) {
      pending.reject(error);
      return;
    }
    if (pending.status < 200 || pending.status >= 300) {
      pending.reject(safeError('request_failed'));
      return;
    }
    const raw = Buffer.concat(pending.body).toString('utf8');
    if (!raw) {
      pending.resolve({});
      return;
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      pending.reject(safeError('invalid_response'));
      return;
    }
    if (value && typeof value === 'object' &&
        (value.ok === false || value.error || value.status === 'err')) {
      pending.reject(safeError('request_failed'));
      return;
    }
    pending.resolve(value?.ok===true&&'result' in value?value.result:value?.type==='res'&&value.status==='ok'?value.payload:value);
  }

  disconnect() {
    const wait = this._connectWait;
    this._connectWait = null;
    this._cleanup('connection_closed', true);
    wait?.reject(safeError('connection_closed'));
  }

  _failConnection(code) {
    const wait = this._connectWait;
    this._connectWait = null;
    this._cleanup(code, true);
    wait?.reject(safeError(code));
  }

  _cleanup(code, announce) {
    const ws = this._ws;
    const wasActive = Boolean(ws || this._transport || this._phase !== 'idle' || this._connected);
    this._ws = null;
    this._phase = 'idle';
    this._connected = false;
    this._clearConnectTimer();
    if (this._pingTimer !== null) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    const pendingError = safeError(code === 'connection_closed' ? 'connection_closed' : 'connection_failed');
    for (const [id, pending] of this._pending) {
      this._pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(pendingError);
    }
    if (this._registerWait) {
      this._registerWait.reject(pendingError);
      this._registerWait = null;
    }
    try {
      this._transport?.destroy?.();
    } catch {
      // Key material cleanup is best effort.
    }
    this._transport = null;
    this._noise = null;
    this._controlStreamId = null;
    this._registerId = null;
    this._controlDecoder = null;
    this._vmToken = null;
    if (ws) {
      try {
        ws.on?.('error', () => {});
        if (ws.readyState === 0 && typeof ws.terminate === 'function') ws.terminate();
        else ws.close?.();
      } catch {
        // Closing an already-closed socket is harmless.
      }
    }
    if (announce && wasActive) this._emitStatus(false, statusMessage(code));
  }
}

module.exports = {
  NativeDevice,
  ControlMessageDecoder,
  encodeControlMessage,
  MAX_INBOUND_MESSAGE,
  MAX_OUTBOUND_MESSAGE,
  MAX_CHAT_MESSAGE,
};
