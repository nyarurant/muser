'use strict';
// Muse gateway wire format observed in the supplied DevTools capture.
// Noise XX / X25519 / AES-GCM / SHA-256, with protobuf HTTP multiplexing.
const crypto = require('node:crypto');
const EMPTY = Buffer.alloc(0);
const cat = (...parts) => Buffer.concat(parts);
function hash(b) { return crypto.createHash('sha256').update(b).digest(); }
function hmac(k, b) { return crypto.createHmac('sha256', k).update(b).digest(); }
function hkdf(k, input) {
  const tmp = hmac(k, input), a = hmac(tmp, Buffer.from([1]));
  return [a, hmac(tmp, cat(a, Buffer.from([2])))];
}
class Cipher {
  constructor(key = null) { this.key = key; this.n = 0n; this.dead = false; }
  nonce() {
    if (this.dead || this.n >= (1n << 64n) - 1n) throw new Error('Noise cipher unavailable');
    const b = Buffer.alloc(12); b.writeBigUInt64BE(this.n++, 4); return b;
  }
  encrypt(ad, data) {
    if (!this.key) return data;
    try {
      const c = crypto.createCipheriv('aes-256-gcm', this.key, this.nonce()); c.setAAD(ad);
      return cat(c.update(data), c.final(), c.getAuthTag());
    } catch (e) { this.dead = true; throw e; }
  }
  decrypt(ad, data) {
    if (!this.key) return data;
    try {
      if (data.length < 16) throw new Error('Truncated Noise ciphertext');
      const c = crypto.createDecipheriv('aes-256-gcm', this.key, this.nonce()); c.setAAD(ad);
      c.setAuthTag(data.subarray(-16)); return cat(c.update(data.subarray(0, -16)), c.final());
    } catch (e) { this.dead = true; throw e; }
  }
}
const keypair = () => crypto.generateKeyPairSync('x25519');
const rawKey = key => key.export({type: 'spki', format: 'der'}).subarray(-32);
function dh(privateKey, raw) {
  const publicKey = crypto.createPublicKey({key: cat(Buffer.from('302a300506032b656e032100', 'hex'), raw), format: 'der', type: 'spki'});
  return crypto.diffieHellman({privateKey, publicKey});
}
class NoiseXX {
  constructor() {
    this.h = Buffer.alloc(32); this.h.write('Noise_XX_25519_AESGCM_SHA256');
    this.ck = Buffer.from(this.h); this.mixHash(EMPTY); this.cipher = new Cipher(); this.phase = 0;
  }
  mixHash(b) { this.h = hash(cat(this.h, b)); }
  mixKey(b) { const [ck, key] = hkdf(this.ck, b); this.ck.fill(0); this.ck = ck; this.cipher = new Cipher(key); b.fill(0); }
  encrypt(b) { const out = this.cipher.encrypt(this.h, b); this.mixHash(out); return out; }
  decrypt(b) { const out = this.cipher.decrypt(this.h, b); this.mixHash(b); return out; }
  message1() {
    if (this.phase !== 0) throw new Error('Invalid Noise phase');
    this.ephemeral = keypair(); const pub = rawKey(this.ephemeral.publicKey); this.mixHash(pub);
    this.phase = 1; return cat(pub, this.encrypt(bytes(1, crypto.randomBytes(32))));
  }
  message2(data) {
    if (this.phase !== 1 || data.length < 96 || data.length > 65535) throw new Error('Invalid Noise message 2');
    this.remoteEphemeral = data.subarray(0,32); this.mixHash(this.remoteEphemeral);
    this.mixKey(dh(this.ephemeral.privateKey, this.remoteEphemeral));
    this.remoteStatic = this.decrypt(data.subarray(32,80));
    this.mixKey(dh(this.ephemeral.privateKey, this.remoteStatic));
    const payload = this.decrypt(data.subarray(80)); this.phase = 2; return payload;
  }
  message3(payload = EMPTY) {
    if (this.phase !== 2) throw new Error('Invalid Noise phase');
    const pair = keypair(), s = this.encrypt(rawKey(pair.publicKey));
    this.mixKey(dh(pair.privateKey, this.remoteEphemeral));
    const out = cat(s, this.encrypt(payload)); const [tx, rx] = hkdf(this.ck, EMPTY);
    this.ck.fill(0); this.cipher.key?.fill(0); this.ephemeral = null; this.phase = 3;
    return {message: out, tx: new Cipher(tx), rx: new Cipher(rx)};
  }
}
function varint(v) {
  v = BigInt.asUintN(64, BigInt(v)); const out = [];
  do { const b = Number(v & 127n); v >>= 7n; out.push(b | (v ? 128 : 0)); } while (v);
  return Buffer.from(out);
}
const uint = (n,v) => cat(varint(n*8), varint(v));
const bytes = (n,v) => { v = Buffer.from(v); return cat(varint(n*8+2), varint(v.length), v); };
const str = (n,v) => bytes(n, Buffer.from(v));
function fields(input) {
  const b = Buffer.from(input), out = new Map(); let pos = 0;
  function readVarint() {
    let result = 0n;
    for (let shift=0n; shift<70n; shift+=7n) {
      if (pos>=b.length) throw new Error('Truncated protobuf');
      const v = b[pos++]; result |= BigInt(v&127)<<shift; if (!(v&128)) return result;
    }
    throw new Error('Invalid protobuf varint');
  }
  while (pos < b.length) {
    const tag = Number(readVarint()), n = tag>>>3, wire = tag&7; let value;
    if (!n) throw new Error('Invalid protobuf field');
    if (wire===0) value = readVarint();
    else if (wire===2) { const len = Number(readVarint()); if (len>b.length-pos) throw new Error('Truncated protobuf bytes'); value=b.subarray(pos,pos+len); pos+=len; }
    else if (wire===1 || wire===5) { const len=wire===1?8:4; if (len>b.length-pos) throw new Error('Truncated protobuf scalar'); value=b.subarray(pos,pos+len); pos+=len; }
    else throw new Error('Unsupported protobuf wire type');
    const arr=out.get(n)||[]; arr.push(value); out.set(n,arr);
  }
  return out;
}
const first = (f,n,fallback=null) => f.get(n)?.[0] ?? fallback;
const CHUNK_TTL_MS = 30000;
class Transport {
  constructor(tx,rx) { this.tx=tx; this.rx=rx; this.next=1n; this.chunks=new Map(); }
  // Partial reassembly entries are timestamped at creation and dropped once they
  // are older than CHUNK_TTL_MS, so an abandoned multi-chunk frame cannot squat
  // in the 16-entry table until (or unless) some unrelated frame arrives.
  sweepChunks(now = Date.now()) {
    for(const [key,v] of this.chunks) if(now-v.created>CHUNK_TTL_MS) { clearTimeout(v.expireTimer); this.chunks.delete(key); }
  }
  expireChunkLater(id, record) {
    record.expireTimer=setTimeout(()=>{
      // Lazy per-entry expiry: this fires even if decode() is never called again.
      if(this.chunks.get(id)===record&&Date.now()-record.created>CHUNK_TTL_MS) this.chunks.delete(id);
    },CHUNK_TTL_MS+1);
    record.expireTimer.unref?.();
  }
  encode(service, frame) {
    this.sweepChunks();
    const payload=cat(uint(1,service),bytes(2,frame)), count=Math.max(1,Math.ceil(payload.length/65489));
    if(count>256) throw new Error('Muse request too large');
    const id=crypto.randomBytes(8).readBigUInt64LE(), result=[];
    for(let i=0;i<count;i++) result.push(this.tx.encrypt(EMPTY,cat(uint(1,id),uint(2,i),uint(3,count),bytes(4,payload.subarray(i*65489,(i+1)*65489)))));
    return result;
  }
  request(verb,path,body,headers=[],service=0) {
    const id=this.next++;
    const h=headers.map(([k,v])=>bytes(3,cat(str(1,k),str(2,v))));
    const request=cat(str(1,verb),str(2,path),...h,bytes(4,body),uint(5,1));
    return {id,frames:this.encode(service,cat(uint(1,id),bytes(2,request)))};
  }
  reset(id) { return this.encode(0,cat(uint(1,id),bytes(5,cat(uint(1,1),str(2,'Cancelled'))))); }
  decode(data) {
    const f=fields(this.rx.decrypt(EMPTY,data)); const id=first(f,1,0n).toString(), index=Number(first(f,2,0n)), count=Number(first(f,3,1n)), payload=first(f,4,EMPTY);
    const now=Date.now(); this.sweepChunks(now);
    if(count<1||count>256||index<0||index>=count||payload.length>65489) throw new Error('Invalid Muse frame');
    let record=this.chunks.get(id);
    if(!record) { if(this.chunks.size>=16) throw new Error('Too many Muse frames'); record={created:now,count,parts:new Map(),size:0}; this.chunks.set(id,record); this.expireChunkLater(id,record); }
    if(record.count!==count||record.parts.has(index)) throw new Error('Duplicate or inconsistent Muse frame');
    record.parts.set(index,payload); record.size+=payload.length;
    if(record.size>16*1024*1024) throw new Error('Muse response too large');
    if(record.parts.size<count) return null;
    clearTimeout(record.expireTimer); this.chunks.delete(id);
    const envelope=fields(cat(...Array.from({length:count},(_,i)=>record.parts.get(i))));
    const frame=fields(first(envelope,1,EMPTY)), streamId=first(frame,1,0n);
    if(frame.has(3)) {
      const r=fields(first(frame,3)); return {id:streamId,type:'response',status:Number(first(r,1,0n)),headers:(r.get(2)||[]).map(h=>{const f=fields(h);return [first(f,1,EMPTY).toString(),first(f,2,EMPTY).toString()];}),body:first(r,3,EMPTY),end:first(r,4,0n)===1n};
    }
    if(frame.has(4)) { const r=fields(first(frame,4)); return {id:streamId,type:'body',body:first(r,1,EMPTY),end:first(r,2,0n)===1n}; }
    if(frame.has(5)) return {id:streamId,type:'reset'};
    throw new Error('Unexpected Muse response frame');
  }
  destroy() { this.tx.key?.fill(0); this.rx.key?.fill(0); this.tx.dead=true; this.rx.dead=true; for(const v of this.chunks.values()) clearTimeout(v.expireTimer); this.chunks.clear(); }
}
module.exports={NoiseXX,Cipher,Transport,fields,first,bytes,uint,str,cat};
