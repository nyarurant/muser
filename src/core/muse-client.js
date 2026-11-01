'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');
const WebSocket = require('ws');
const {NoiseXX,Transport,fields,first} = require('./noise');
const {t} = require('../i18n');

function allowedGateway(value) {
  const u = new URL(value);
  if (!['wss:','https:'].includes(u.protocol) || u.username || u.password || u.port ||
      !(u.hostname === 'hatch.metaaivm.com' || /^[a-z0-9-]+\.metaaivm\.com$/.test(u.hostname))) {
    throw new Error(t('Muse の接続先を確認できません。'));
  }
  return u;
}
function captureCredentials(file) {
  if (fs.statSync(file).size > 150*1024*1024) throw new Error(t('通信記録が大きすぎます。'));
  const entries = JSON.parse(fs.readFileSync(file,'utf8')).log?.entries;
  if (!Array.isArray(entries)) throw new Error(t('HAR 形式の通信記録を選んでください。'));
  const candidate = entries.findLast(e=>{
    try { const u=new URL(e.request.url); return u.protocol==='wss:' && u.pathname==='/v1/noise' && e.response?.status===101 && u.searchParams.has('auth_token'); } catch {return false;}
  });
  if (!candidate) throw new Error(t('接続に成功した Muse の通信が記録されていません。'));
  const u=allowedGateway(candidate.request.url), q=u.searchParams;
  let session=null;
  const s=entries.findLast(e=>{try{return new URL(e.request.url).hostname==='muse.ai' && new URL(e.request.url).pathname==='/api/session' && e.response.status===200;}catch{return false;}});
  if(s) try { session=JSON.parse(s.response.content.text); } catch {}
  const credentials={gateway:'https://'+u.hostname,vmId:q.get('vm_id'),appId:q.get('app_id'),token:q.get('auth_token'),notaryToken:q.get('notary_token'),vmName:session?.vm_name,endpoint:session?.endpoint_url,importedAt:new Date().toISOString()};
  if(!credentials.vmId||!credentials.appId||!credentials.token) throw new Error(t('Muse の接続情報が不足しています。'));
  return credentials;
}
function unwrap(value) {
  if(value?.ok===false || value?.status==='err' || value?.error) {
    // Gateway error text can contain request data; expose only a short code.
    const code=value?.error?.code||value?.code;
    throw new Error(t('Muse が操作を受け付けませんでした{code}。', {code: typeof code==='string'?' ('+code.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80)+')':''}));
  }
  if(value?.ok===true && 'result' in value) return value.result;
  if(value?.type==='res' && value.status==='ok') return value.payload;
  return value;
}
// Same rule as unwrap(): surface only a short error code from an HTTP error body.
function errorDetail(body) {
  let v;try{v=JSON.parse(body.toString('utf8'));}catch{return '';}
  const code=v?.error?.code||v?.code||(typeof v?.error==='string'?v.error:'');
  return typeof code==='string'&&code?' ('+code.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80)+')':'';
}
class MuseClient extends EventEmitter {
  // requireLogin: only connect with credentials obtained from the muse.ai login, and not at all
  // while the website session is logged out.
  constructor({credentials,fetchJson,checkPin,requireLogin=false,locale}) {
    super(); this.credentials=credentials; this.fetchJson=fetchJson; this.checkPin=checkPin; this.requireLogin=requireLogin;
    // Like the web client, ask the VM for text in the user's language (settings, connectors, permissions).
    this.locale=typeof locale==='string'&&/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale)?locale:'';
    this.pending=new Map(); this.ws=null; this.transport=null; this.connecting=null; this.status='disconnected'; this.badFrames=0;
  }
  state(status,message) { this.status=status; this.emit('status',{status,message}); }
  // One credential refresh attempt with a named outcome, so the login
  // watcher can tell the user which stage is not completing instead of
  // failing silently: 'waiting' (no signed-in website session yet),
  // 'session' (signed in but no usable VM session), 'token' (the hatch
  // token request did not yield a token), 'ready' (fresh credentials
  // stored), 'error' (no website session available to probe with).
  async probeLogin() {
    if(!this.fetchJson) return 'error';
    let session;
    // A network failure says nothing about the login; only an HTTP refusal means "not signed in".
    // muser: a server error (5xx) or rate limit (429) says nothing about the login either; taken as
    // 'waiting' it marked the login lapsed and stopped reconnecting on a passing muse.ai hiccup.
    try { session=await this.fetchJson('/api/session?vm_state=true'); } catch(e) { return e?.network||e?.status>=500||e?.status===429?'error':'waiting'; }
    if(!session?.endpoint_url||!session?.vm_id) return 'session';
    try { allowedGateway(session.endpoint_url); } catch { return 'session'; }
    let result;
    try { result=await this.fetchJson('/api/hatch/token',{vmAddress:session.endpoint_url,vmName:session.vm_name,force_refresh:true}); } catch { return 'token'; }
    if(!result?.token) return 'token';
    this.credentials={gateway:'https://hatch.metaaivm.com',vmId:session.vm_id,vmName:session.vm_name,endpoint:session.endpoint_url,appId:this.credentials?.appId||'hatch-web',token:result.token,notaryToken:result.notary_token,source:'login'};
    this.emit('credentials',this.credentials);
    return 'ready';
  }
  async refreshCredentials() {
    // Best effort: on a network failure the last login-derived credentials are kept.
    try { return await this.probeLogin(); } catch { return 'error'; }
  }
  async connect() {
    if(this.status==='connected') return;
    if(this.connecting) return this.connecting;
    this.connecting=this.open().finally(()=>{this.connecting=null;}); return this.connecting;
  }
  async open() {
    this.disconnect(false); this.state('connecting',t('Muse に接続しています…'));
    const stage=await this.refreshCredentials();
    if(this.requireLogin&&(stage==='waiting'||this.credentials?.source!=='login')) {
      this.state('auth_required',t('Muse にログインしてください。'));throw new Error(t('Muse にログインしてください。'));
    }
    const c=this.credentials;
    if(!c?.token) { this.state('auth_required',t('ログインまたは通信記録の読み込みが必要です。')); throw new Error(t('Muse にログインしてください。')); }
    const target=allowedGateway(c.gateway); target.protocol='wss:';target.pathname='/v1/noise';target.search='';
    for(const [k,v] of Object.entries({vm_id:c.vmId,auth_token:c.token,notary_token:c.notaryToken,app_id:c.appId,request_id:crypto.randomUUID()})) if(v) target.searchParams.set(k,v);
    const ws=new WebSocket(target,{origin:'https://muse.ai',handshakeTimeout:15000,maxPayload:1024*1024}); this.ws=ws;
    const noise=new NoiseXX(); let established=false;
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>fail(new Error(t('Muse への接続がタイムアウトしました。'))),20000);
      const fail=(e,status='error')=>{clearTimeout(timeout);if(this.ws===ws){this.disconnect(false);this.state(status,e.message);}reject(e);};
      ws.on('open',()=>{try{ws.send(noise.message1());}catch{fail(new Error(t('暗号化接続を開始できませんでした。')));}});
      ws.on('unexpected-response',(_,res)=>{const auth=res.statusCode===401||res.statusCode===403;fail(new Error(auth?t('Muse の認証が切れています。ログインし直してください。'):t('Muse に接続できませんでした (HTTP {status})。', {status: res.statusCode})),auth?'auth_required':'error');});
      ws.on('error',()=>{if(!established)fail(new Error(t('Muse の通信に失敗しました。接続情報を更新してください。')));});
      ws.on('message',data=>{
        if(this.ws!==ws) return;
        try {
          if(!established) {
            const payload=noise.message2(data);
            let f;try{f=fields(payload);}catch{}
            // Confidential VMs need owner recovery credentials and attestation.
            // Never silently fall back to the standard-VM handshake.
            if(f && [1n,2n].includes(first(f,2)) && first(f,3)?.length===32) throw new Error(t('この機密 VM は所有者キーによる認証が必要です。現在は標準 VM に対応しています。'));
            const fingerprint=crypto.createHash('sha256').update(noise.remoteStatic).digest('hex');
            this.checkPin?.(c.vmId,fingerprint);
            const keys=noise.message3();this.transport=new Transport(keys.tx,keys.rx);ws.send(keys.message);
            established=true;clearTimeout(timeout);this.startPing(ws);this.state('connected',t('接続済み'));resolve();
          }else this.onFrame(this.transport.decode(data));
        }catch(e){if(!established)fail(e);else{this.disconnect(false);this.state('error',t('Muse の暗号化通信が中断されました。再接続してください。'));}}
      });
      ws.on('close',()=>{
        if(this.ws!==ws)return;
        if(!established)fail(new Error(t('Muse との接続が閉じられました。')));
        else {this.disconnect(false);this.state('disconnected',t('接続が切れました。再接続しています…'));}
      });
    });
  }
  request(verb,path,params={},options={}) {
    if(this.status!=='connected'||!this.transport) return Promise.reject(new Error(t('Muse に接続してください。')));
    if(this.pending.size>=64) return Promise.reject(new Error(t('処理中の操作が多すぎます。')));
    let body=Buffer.alloc(0);
    if(verb==='GET') {const q=new URLSearchParams();for(const[k,v]of Object.entries(params))if(Array.isArray(v))for(const x of v)q.append(k,String(x));else if(v!==undefined&&v!==null)q.set(k,String(v));if(q.size)path+='?'+q;}
    else body=Buffer.isBuffer(options.body)?options.body:Buffer.from(JSON.stringify(params));
    const r=this.transport.request(verb,path,body,[['x-app-id',this.credentials.appId],['Content-Type',options.contentType||'application/json'],['Accept-Encoding','identity'],...(this.locale?[['Accept-Language',this.locale]]:[])],options.service||0);
    return new Promise((resolve,reject)=>{
      const pending={resolve,reject,path,subscriptionScope:options.subscriptionScope,status:0,chunks:[],size:0,text:'',decoder:new TextDecoder(),onEvent:options.onEvent,stream:!!options.stream,raw:!!options.raw,contentType:'',settled:false};
      pending.timer=setTimeout(()=>{this.cancelRequest(r.id);reject(new Error(t('Muse の応答がタイムアウトしました。送信済みの可能性があるため、自動再送はしません。')));},options.timeout||30000);
      this.pending.set(r.id.toString(),pending);
      try { for(const frame of r.frames)this.ws.send(frame); } catch {this.cancelRequest(r.id);reject(new Error(t('送信中に通信が切れました。')));}
    });
  }
  cancelRequest(id,completeSubscription=false) {
    const p=this.pending.get(String(id));if(p){
      clearTimeout(p.timer);this.pending.delete(String(id));
      // A view change can cancel a subscription before its initial ack. Its IPC
      // caller must still receive a reply; otherwise Electron reports "reply was
      // never sent". Request timeouts retain their own rejection path.
      if(completeSubscription&&!p.settled&&p.path==='/chat/subscribe'){
        p.settled=true;p.resolve({subscribed:false,cancelled:true});
      }
    }
    if(this.transport&&this.ws?.readyState===WebSocket.OPEN)for(const f of this.transport.reset(BigInt(id)))this.ws.send(f);
  }
  // One bad NDJSON record (unparseable JSON, or a payload unwrap() rejects) must not
  // kill a long-lived subscription: skip and count it instead. This only wraps the
  // per-record parse/unwrap; transport decode (Noise decrypt) failures happen in the
  // ws message handler before onFrame() and stay fatal, as do frame-level errors below.
  noteBadFrame(error) {
    this.badFrames=(this.badFrames||0)+1;
    if(this.badFrames===1||this.badFrames%25===0) console.error('muse-client: skipped a malformed stream record ('+this.badFrames+' total): '+(error?.message||error));
    try{this.emit('warning',{type:'bad-frame',count:this.badFrames,error:error?.message||String(error)});}catch{}
  }
  recordLine(p,line) {
    let value;
    try{value=JSON.parse(line);}catch(e){this.noteBadFrame(e);return;}
    try{this.record(p,value);}catch(e){this.noteBadFrame(e);}
  }
  record(p,value) {
    if(value?.type==='event'||(typeof value?.event==='string'&&value.payload)) {
      if(!p.settled){p.settled=true;clearTimeout(p.timer);p.resolve({});}
      p.onEvent?.(value); this.emit('event',value);return;
    }
    const result=unwrap(value);
    if(!p.settled){p.settled=true;clearTimeout(p.timer);p.resolve(result);}
  }
  onFrame(f) {
    if(!f)return;const key=f.id.toString(),p=this.pending.get(key);if(!p)return;
    try {
      if(f.type==='reset')throw new Error(t('Muse がこの操作の通信を終了しました。'));
      if(f.type==='response') {
        p.status=f.status;
        const type=f.headers.find(([k])=>k.toLowerCase()==='content-type')?.[1]||'';
        p.contentType=type;p.ndjson=!p.raw&&(p.stream||type.includes('ndjson'));
        if(f.headers.some(([k,v])=>k.toLowerCase()==='content-encoding'&&!['identity',''].includes(v)))throw new Error(t('Muse が未対応の圧縮形式を返しました。'));
      }
      if(f.body?.length) {
        p.size+=f.body.length;
        if(p.size>16*1024*1024)throw new Error(t('Muse の応答が大きすぎます。'));
        if(p.ndjson&&p.status>=200&&p.status<300) {
          p.text+=p.decoder.decode(f.body,{stream:true});
          const lines=p.text.split('\n');p.text=lines.pop();for(const line of lines)if(line.trim())this.recordLine(p,line);
          // A streaming subscription can live indefinitely; bound each record.
          if(p.text.length>2*1024*1024)throw new Error(t('Muse の通知が大きすぎます。'));p.size=0;
        }else p.chunks.push(f.body);
      }
      if(f.end) {
        if(p.ndjson&&p.status>=200&&p.status<300){p.text+=p.decoder.decode();if(p.text.trim())this.recordLine(p,p.text);if(!p.settled){p.settled=true;p.resolve({});}}
        else {
          if(p.status<200||p.status>=300)throw new Error(t('Muse API がエラーを返しました (HTTP {status})。{detail}', {status: p.status, detail: errorDetail(Buffer.concat(p.chunks))}));
          const data=Buffer.concat(p.chunks);
          if(p.raw){p.settled=true;p.resolve({contentType:p.contentType,data});}
          else{const text=data.toString('utf8');const value=text?unwrap(JSON.parse(text)):{};p.settled=true;p.resolve(value);}
        }
        clearTimeout(p.timer);this.pending.delete(key);
        // muser: say which stream ended, so a closed /chat/subscribe can be opened again.
        if(p.stream)this.emit('stream-end',{path:p.path,scope:p.subscriptionScope});
      }
    }catch(e){clearTimeout(p.timer);this.pending.delete(key);p.reject(e);if(p.settled)this.emit('stream-error',{path:p.path,scope:p.subscriptionScope,message:e.message});}
  }
  // muser: the gateway socket had no keepalive, so a half-open socket (sleep, network change)
  // looked connected forever. Missing pongs now count as a drop.
  startPing(ws) {
    clearInterval(this.pingTimer);let lastPong=Date.now();ws.on('pong',()=>{lastPong=Date.now();});
    this.pingTimer=setInterval(()=>{
      if(this.ws!==ws){clearInterval(this.pingTimer);return;}
      if(Date.now()-lastPong>45000){this.disconnect(false);this.state('disconnected',t('接続が切れました。再接続しています…'));return;}
      try{ws.ping();}catch{}
    },20000);this.pingTimer.unref?.();
  }
  disconnect(announce=true) {
    clearInterval(this.pingTimer);const ws=this.ws;this.ws=null;if(ws){ws.on('error',()=>{});if(ws.readyState===WebSocket.CONNECTING)ws.terminate();else ws.close();}
    this.transport?.destroy();this.transport=null;
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error(t('Muse の接続が終了しました。')));}this.pending.clear();
    this.status='disconnected';if(announce)this.state('disconnected',t('未接続'));
  }
  sessions() {return this.request('GET','/api/session/list',{limit:100});}
  history(sessionId='',before) {return this.request('GET','/chat/history',{limit:50,session_id:sessionId,...before!==undefined?{before_seq:before}:{}});}
  subscribe(sessionId='') {
    for(const [id,p]of this.pending)if(p.path==='/chat/subscribe'&&!p.subscriptionScope)this.cancelRequest(id,true);
    return this.request('POST','/chat/subscribe',{...(sessionId?{session_id:sessionId}:{}),capabilities:['chat_cancel','delta_stream']},{stream:true});
  }
  subscribeAgent(sessionId,scope) {
    if(typeof scope!=='string'||!scope)throw new Error(t('PC 作業の購読 ID が必要です。'));
    this.closeAgentSubscription(scope);
    return this.request('POST','/chat/subscribe',{session_id:sessionId,capabilities:['chat_cancel','delta_stream']},{stream:true,subscriptionScope:scope});
  }
  closeAgentSubscription(scope) {
    if(typeof scope!=='string'||!scope)return;
    for(const [id,p]of this.pending)if(p.path==='/chat/subscribe'&&p.subscriptionScope===scope)this.cancelRequest(id,true);
  }
  // With attachments the web client sends `items` (text + image/file parts); a reply adds `in_reply_to`.
  send(text,sessionId,nodeId,{replyTo,attachments}={}) {
    const content=attachments?.length?{items:[...text?[{type:'text',text}]:[],...attachments]}:{message:text};
    return this.request('POST','/chat/stream',{...content,node_id:nodeId,...sessionId?{session_id:sessionId}:{},...replyTo?{in_reply_to:replyTo}:{},capabilities:['chat_cancel','delta_stream']},{stream:true,timeout:120000});
  }
  cancel(sessionId) {return this.request('POST','/chat/cancel',{...(sessionId?{session_id:sessionId}:{})});}
}
module.exports={MuseClient,captureCredentials,allowedGateway,unwrap};
