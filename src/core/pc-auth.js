'use strict';
const crypto=require('node:crypto');
const {t}=require('../i18n');

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isToken = v => typeof v === 'string' && !!v;
// Two device copies are the same pair when they carry the same tokens. Compared by content:
// the disk copy is a fresh object on every read, so an identity check (`!==`) always said
// "another window saved a different pair" and start() could never drop a dead pair — after
// the device was unlinked on muse.ai, muser re-asked the e-mail forever with "この PC は認証済み
// です。" (Discord report, 2026-11-06).
const samePair = (a, b) => isObj(a) && isObj(b) && a.access_token === b.access_token && a.refresh_token === b.refresh_token;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// OTP / 2FA codes are 6-digit numbers. A code in any other shape used to be
// sent to the server as-is, where the rejection burned one of the caller's
// few tries (audit wave 8 B: '12', 'abcdef', '12345678', fullwidth digits and
// the empty string all reached confirm_otp). Normalize what is merely a
// typing variant — fullwidth digits become halfwidth, spaces and hyphens
// (common when copying a code) are dropped — and return null for anything
// that is not exactly 6 digits, so callers can reject it locally, in words,
// without spending a server try.
const OTP_DIGITS = 6;
function normalizeOtpCode(value) {
  if (typeof value !== 'string') return null;
  const half = value.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/[\s\-]+/g, '');
  return new RegExp('^\\d{' + OTP_DIGITS + '}$').test(half) ? half : null;
}
// The local format rejection: marked `codeFormat` so pc-login can tell it
// apart from a server wrong-code answer (which does spend a try).
function otpFormatError() {
  return Object.assign(new Error(t('認証コードは6桁の数字で入力してください。')), {codeFormat: true});
}
// An expired code is dead, not wrong: the server says so in its message
// ('code expired' / 期限切れ). Callers point the user at resend for it
// instead of asking them to re-enter the same code (audit wave 8 B).
function isOtpExpiredError(e) {
  if (!e) return false;
  if (e.otpExpired || e.code === 'otp_expired') return true;
  const msg = typeof e.message === 'string' ? e.message : '';
  return /expir/i.test(msg) || msg.includes('期限切れ') || msg.includes('有効期限が切れ');
}
// Interval checks (the vm cache, the refresh suppression) use a monotonic clock
// (c29 #6): with Date.now() a clock rollback made the age negative-or-small and
// stretched a 60 s window by the whole rollback, serving an expired VM/token far
// too long. A negative age (a timestamp that cannot be from this clock) is stale.
const monoNow = () => performance.now();
const fresh = (at, ms) => { if (typeof at !== 'number') return false; const age = monoNow() - at; return age >= 0 && age < ms; };
// Native authentication and device credentials are distinct from the website cookie.
// Wire schemas: https://github.com/chaitanyarahalkar/muse-desktop-bridge/blob/main/docs/protocol.md
// An sdkIssuePending flag is a crash guard, not a life sentence (audit-cli
// wave 9, W1-26): it is stamped when set (sdkIssuePendingAt), and a flag that
// is older than this AND already has its token saved next to it is a leftover
// of a finished issue whose clearing save never landed — start() clears it
// and proceeds instead of wedging every later login on it.
const SDK_ISSUE_PENDING_STALE_MS = 10 * 60 * 1000;
// The stamp may be epoch milliseconds, epoch seconds (the device pair's
// access_token_saved_at convention) or an ISO string; a flag written before
// stamps existed has none of them and reports null.
function pendingStampMs(saved) {
  const raw = saved?.sdkIssuePendingAt ?? (typeof saved?.sdkIssuePending === 'number' ? saved.sdkIssuePending : undefined) ?? saved?.sdkPendingAt;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw < 1e12 ? raw * 1000 : raw;
  if (typeof raw === 'string' && raw) { const p = Date.parse(raw); if (!Number.isNaN(p)) return p; }
  return null;
}
class PcAuth {
  constructor({load,save,request,listSdk,issueSdk,expectedVm,deviceFile}) {
    this.load=typeof load==='function'?load:null;this.saved=load()||{};this.save=save;this.request=request;this.listSdk=listSdk;this.issueSdk=issueSdk;this.expectedVm=expectedVm;this.deviceFile=typeof deviceFile==='string'&&deviceFile?deviceFile:null;
    this.phase=this.saved.device?'authenticated':this.saved.sdkToken?'contact':'start';
    this.login=null;this.pending=null;this.message='';this.active=false;this.generation=0;
  }
  snapshot() {
    // A malformed element (accounts: [null], say) must degrade to the fallback
    // label, not a bare TypeError that wedges the login on the same response
    // (c29 #7, the unvalidated-element residue of audit #188).
    const label=(item,fallback)=>isObj(item)?([item.display_name,item.name,item.username,item.masked_contact,item.masked_contact_point].find(v=>typeof v==='string'&&v.trim())?.slice(0,160)||fallback):fallback;
    return {phase:this.phase,hasSdkToken:!!this.saved.sdkToken,hasDevice:!!this.saved.device,
      accounts:this.phase==='account'?(this.pending?.accounts||[]).map((a,i)=>({label:label(a,t('アカウント {n}', {n: i+1}))})):[],
      methods:this.phase==='two_factor'?(this.pending?.two_factor_methods||[]).map((a,i)=>({label:label(a,({TOTP:t('認証アプリ'),SMS:'SMS',EMAIL:t('メール')})[String(isObj(a)?a.method_type:'').toUpperCase()]||t('認証方法 {n}', {n: i+1}))})):[],
      ...(this.phase==='checkpoint'&&this.checkpointUrl?{checkpointUrl:this.checkpointUrl}:{}),message:this.message};
  }
  persist(update) {
    // Re-read the disk state for EVERY persist, not only device updates (audit #194):
    // a whole-snapshot save from a stale window (a nodeId or sdkIssuePending persist)
    // used to overwrite a newer device pair another window had saved meanwhile.
    // The layering is: this window's memory first, then the fresh disk state, then
    // the caller's update — the disk wins over stale memory for EVERY key, not only
    // the device pair (master-debug #13: a stale persist used to roll back another
    // window's newer sdkToken / sdkTokenId and clear its sdkIssuePending). A key the
    // disk does not hold still survives from memory (audit #195's failed-save case),
    // and the device pair is refined by the stamp comparison below.
    let disk=null; try{disk=this.load?.()||null;}catch{}
    const fresh=isObj(disk)?disk:{};
    const next={...this.saved,...fresh,...update};
    // For the device pair the newest copy wins, whichever side holds it: a pair is
    // stamped when saved, so compare stamps instead of blindly layering the stale
    // in-memory copy over a fresher one from disk (or vice versa).
    const diskDev=isObj(fresh.device)?fresh.device:null, knownDev=isObj(this.saved?.device)?this.saved.device:null;
    const stamp=d=>Number(d?.access_token_saved_at)||0;
    // Stamps are second-granularity (mint/refresh), so a tie is common when two
    // windows save within the same second: the disk copy wins a tie (c29 #4).
    // It is the last state actually persisted; this window's in-memory copy may
    // be the stale one it started with, and letting it win silently rolled a
    // newer pair back to the old tokens.
    const newestDev=diskDev&&knownDev?(stamp(diskDev)>=stamp(knownDev)?diskDev:knownDev):diskDev||knownDev;
    if(isObj(update?.device)){
      // Merge into the previously saved device instead of replacing it wholesale:
      // a mint/refresh only carries the token pair, and other saved device fields
      // must survive it. The older layer goes first, the newest device next, and
      // this update (the caller's own fresh pair) last.
      const olderDev=newestDev===(diskDev||null)?knownDev:diskDev;
      next.device={...(olderDev||{}),...(newestDev||{}),...update.device};
    } else if(newestDev&&(update===undefined||!('device' in (update||{})))){
      next.device=newestDev;
    } else if(update&&'device' in update&&update.device===undefined&&newestDev&&newestDev===diskDev&&!samePair(diskDev,knownDev)){
      // An explicit pair deletion (start() dropping a dead pair) must not erase
      // a DIFFERENT pair another window has since saved to disk (c29 #4): this
      // window proved only its own pair dead. The delete is honoured when the
      // disk still holds the pair this window knows (or this window's unsaved
      // pair is the newest), and the newer disk pair survives otherwise.
      next.device=newestDev;
    }
    // Keep the new state in memory even when the disk save fails (audit #195): an
    // issued SDK token whose persist threw used to be lost for good, leaving only
    // sdkIssuePending on disk and no way to ever re-issue. The error still
    // propagates, but this process keeps the credential and a retry can proceed.
    this.saved=next;
    this.save(next);
  }
  async action(fn) {
    if(this.active)throw new Error(t('PC の認証処理中です。しばらくお待ちください。'));
    this.active=true;const generation=this.generation;
    // Cancelling aborts the in-flight HTTP too (audit #200): the generation check
    // alone only ran between awaits, so a cancelled send/mint kept its requests
    // (and their side effects) running to completion.
    const ctrl=new AbortController();this.abortCtrl=ctrl;
    try {await fn(()=>{if(generation!==this.generation)throw new Error(t('PC の認証を閉じました。'));});return this.snapshot();}
    finally {this.active=false;if(this.abortCtrl===ctrl)this.abortCtrl=null;if(generation!==this.generation)this.cancel();}
  }
  signal() {return this.abortCtrl?.signal;}
  // True when the pending flag may be dropped: it is older than the stale
  // window, or it carries no stamp at all (written before stamps existed) —
  // in that case a token saved beside it is the only evidence available, and
  // it proves the issue finished, because no issue runs in this process yet.
  pendingStale() {
    if(!this.saved.sdkIssuePending)return false;
    const at=pendingStampMs(this.saved);
    if(at!==null)return Date.now()-at>SDK_ISSUE_PENDING_STALE_MS;
    return !!this.saved.sdkToken;
  }
  // The blocked-pending error: name the manual way out (audit-cli wave 9).
  // Without it the old text was a dead end — it sent the user to the token
  // page, but every retry hit this same check and nothing ever cleared it.
  pendingError() {
    return new Error(t('前回のトークン発行結果を確認できません。手動で回復するには、保存ファイル {file} を削除してから、もう一度実行してください。発行済みかどうか分からない場合は、先に SDK トークンのページで発行状況を確認してください。自動で再発行はしません。',{file:this.deviceFile||'device.enc'}));
  }
  async start(acceptTerms=false) {
    return this.action(async check=>{
      // A stale pending flag beside an already-saved SDK token is cleared,
      // not obeyed (wave 9): the token is the finished issue's result, so
      // there is nothing left to confirm and the flow proceeds with it.
      if(this.saved.sdkIssuePending&&this.saved.sdkToken&&this.pendingStale()){this.persist({sdkIssuePending:false,sdkIssuePendingAt:undefined});check();}
      if(this.saved.device){
        try{await this.vm();check();this.phase='authenticated';this.message=t('PC 端末の認証は完了しています。');return;}
        catch(e){
          // A pair that provably belongs to another account or can no longer be
          // refreshed is dead weight (audit #193): every retry failed the same way
          // until the user deleted the file by hand. Drop just that pair and fall
          // through to a fresh login. A transient failure (network, 5xx) keeps it.
          if(!(e.deviceMismatch||e.deadDevice||e.status===401))throw e;
          this.persist({device:undefined});check();
          // The drop may have been refused by persist (c29 #4): another window
          // had already saved a different, newer pair, which is now this
          // window's pair too. That pair is a live registration, not the dead
          // one — this PC is authenticated, so do not fall through to a fresh
          // login (send() would only refuse it as already registered).
          if(this.saved.device){this.phase='authenticated';this.message=t('PC 端末の認証は完了しています。');return;}
          // The pair is gone: phase must stop claiming 'authenticated' right
          // here (c29 #8). It used to stay at the constructor's value when a
          // later step threw (terms not accepted, say), so snapshot consumers
          // skipped the registration step for a PC no longer registered.
          this.phase=this.saved.sdkToken?'contact':'start';
        }
      }
      if(!this.saved.sdkToken){
        if(acceptTerms!==true)throw new Error(t('SDK トークンの利用規約を確認してください。'));
        if(this.saved.sdkIssuePending)throw this.pendingError();
        const list=await this.listSdk(this.signal());check();
        if(!isObj(list)||!Array.isArray(list.tokens)||!Number.isSafeInteger(list.maxActiveTokens))throw new Error(t('SDK トークンの発行状況を確認できません。'));
        if(list.tokens.length>=list.maxActiveTokens)throw new Error(t('SDK トークンの発行上限です。既存のトークンは変更していません。'));
        this.persist({sdkIssuePending:true,sdkIssuePendingAt:Date.now()});
        // Persist an issued token even if the user closes the dialog during this request.
        const issued=await this.issueSdk(this.signal());
        if(!isObj(issued)||typeof issued.token!=='string'||!issued.token.startsWith('mgst_'))throw new Error(t('SDK トークンの発行結果を確認できません。'));
        this.persist({sdkToken:issued.token,sdkTokenId:issued.sdkToken?.id,sdkIssuePending:false,sdkIssuePendingAt:undefined});check();
      }
      if(!this.saved.nodeId)this.persist({nodeId:'homelink-'+crypto.randomBytes(3).toString('hex')});
      this.phase='contact';this.message=t('Muse で使っているメールアドレスまたは電話番号を入力してください。');
    });
  }
  async auth(action,fields={}) {
    if(!this.login?.token)throw new Error(t('認証を最初から開始してください。'));
    return this.request('auth','/hatch/auth/'+action,{device_id:this.login.deviceId,waterfall_id:this.login.waterfall,...fields},this.login.token,this.signal());
  }
  async send(contact) {
    if(typeof contact!=='string'||!contact.trim()||contact.length>320)throw new Error(t('メールアドレスまたは国番号付きの電話番号を入力してください。'));
    return this.action(async check=>{
      if(!this.saved.sdkToken)throw new Error(t('先に SDK トークンを準備してください。'));
      if(this.saved.device)throw new Error(t('この PC は認証済みです。'));
      const target=contact.trim();
      if(!this.login||this.login.contact!==target){
        const deviceId=crypto.randomUUID(),waterfall=crypto.randomUUID();
        const start=await this.request('auth','/hatch/auth/start',{device_id:deviceId,waterfall_id:waterfall},undefined,this.signal());check();
        if(!isObj(start)||typeof start.access_token!=='string'||!start.access_token)throw new Error(t('Muse の認証を開始できませんでした。'));
        this.login={deviceId,waterfall,token:start.access_token,contact:target};
        // A login_options failure must not leave this half-started login behind
        // (audit #196): the next send() reused the same token, skipped
        // login_options and kept failing until a restart or a contact change.
        try{await this.auth('login_options');check();}
        catch(e){this.login=null;throw e;}
      }
      const result=await this.auth('send_otp',{contact_point:target,...this.login.authState?{auth_state:this.login.authState}:{}});check();
      if(!isObj(result)||typeof result.auth_state!=='string'||!result.auth_state)throw new Error(t('Muse 側で追加のログイン手順が必要です。'));
      this.login.authState=result.auth_state;this.phase='code';this.pending=null;this.message=t('認証コードを送信しました。届いたコードを入力してください。');
    });
  }
  async confirm(code) {
    const normalized=this.code(code);
    return this.action(async check=>{
      if(!this.login?.authState||this.phase!=='code')throw new Error(t('先に認証コードを送信してください。'));
      const result=await this.auth('confirm_otp',{auth_state:this.login.authState,otp_code:normalized,supports_account_selection:true});check();
      await this.accept(result,check);
    });
  }
  // Validates AND normalizes: returns the 6-digit code to send, or throws the
  // marked format error before any request is made (audit wave 8 B).
  code(value) {const normalized=normalizeOtpCode(value);if(normalized===null)throw otpFormatError();return normalized;}
  choice(list,index) {if(!Number.isSafeInteger(index)||index<0||index>=list?.length)throw new Error(t('表示された認証項目を選択してください。'));return list[index];}
  async select(index) {
    return this.action(async check=>{
      if(this.phase!=='account'||!this.pending?.selection_state)throw new Error(t('アカウント選択を最初から開始してください。'));
      const account=this.choice(this.pending.accounts,index);
      if(!isObj(account)||!isToken(account.account_ref))throw new Error(t('アカウント候補を確認できません。'));
      const result=await this.auth('select_account',{selection_state:this.pending.selection_state,account_ref:account.account_ref});check();await this.accept(result,check);
    });
  }
  async twoFactor(index,code) {
    if(code!==undefined)code=this.code(code);
    return this.action(async check=>{
      if(this.phase!=='two_factor'||!this.pending?.two_factor_state)throw new Error(t('追加認証を最初から開始してください。'));
      const method=this.choice(this.pending.two_factor_methods,index);
      if(!isObj(method)||!isToken(method.method_id))throw new Error(t('追加認証の方法を確認できません。'));
      if(code===undefined&&/^(?:TOTP|AUTHENTICATOR)$/i.test(method.method_type||method.method_id||'')){this.message=t('認証アプリに表示されたコードを入力してください。');return;}
      const result=await this.auth(code===undefined?'two_factor/send_code':'two_factor',{two_factor_state:this.pending.two_factor_state,method_id:method.method_id,...code!==undefined?{code}:{}});check();
      if(code===undefined)this.message=t('追加認証コードを送信しました。');else await this.accept(result,check);
    });
  }
  async accept(result,check) {
    if(!isObj(result))throw new Error(t('Muse 側で追加の認証が必要です。'));
    this.pending=result;
    if(result.checkpoint_required||result.requires_birthday||result.requires_name||result.requires_consent){
      this.phase='checkpoint';this.message=t('Muse 側で追加の確認が必要です。公式ページで確認を完了してください。');
      this.checkpointUrl=undefined;
      try{const u=new URL(result.checkpoint_url||result.checkpointUrl);if(u.protocol==='https:'&&(u.hostname==='muse.ai'||u.hostname.endsWith('.muse.ai')||u.hostname==='auth.meta.com'))this.checkpointUrl=u.href;}catch{}
      return;
    }
    if(result.account_selection_required){if(!Array.isArray(result.accounts)||!result.accounts.length||!result.accounts.every(isObj))throw new Error(t('アカウント候補を確認できません。'));this.phase='account';this.message=t('現在 Muse で使っているアカウントを選んでください。');return;}
    if(result.two_factor_required){if(!Array.isArray(result.two_factor_methods)||!result.two_factor_methods.length||!result.two_factor_methods.every(isObj))throw new Error(t('追加認証の方法を確認できません。'));this.phase='two_factor';this.message=t('追加認証の方法を選び、コードを入力してください。');return;}
    if(typeof result.abra_access_token!=='string'||!result.abra_access_token||!result.abra_user_id)throw new Error(t('Muse 側で追加の認証が必要です。'));
    // Minting needs this PC's node id (audit #199): a flow that reached accept()
    // without start() (a restored sdkToken, say) used to send device_id:undefined
    // and fail opaquely. Register the id the same way start() does.
    if(!this.saved.nodeId)this.persist({nodeId:'homelink-'+crypto.randomBytes(3).toString('hex')});
    // The native session bearer stays in memory until minting finishes; only the device pair is stored.
    const minted=await this.request('device','/device_token/mint',{device_id:this.saved.nodeId,sdk_token:this.saved.sdkToken},result.abra_access_token,this.signal());
    check();
    const pair=isObj(minted)?(minted.payload||minted):null;
    // Token TYPES are checked, not just truthiness (c29 #7): a numeric token
    // used to be persisted as-is and then failed every later request forever;
    // rejecting it here lets a re-mint recover instead.
    if(!isObj(pair)||!isToken(pair.access_token)||!isToken(pair.refresh_token))throw new Error(t('PC 端末の認証情報を取得できませんでした。'));
    this.persist({device:{access_token:pair.access_token,refresh_token:pair.refresh_token,access_token_saved_at:Math.floor(Date.now()/1000)}});
    this.login=null;this.pending=null;this.phase='authenticated';
    // The pair is saved: authentication HAS succeeded (audit #190). A vm() failure
    // here must not turn into a code re-entry prompt that hides that fact.
    try{await this.vm();}catch{}
    check();
    this.phase='authenticated';this.message=t('PC 端末の認証が完了しました。');
  }
  // Startup asks for the VM credentials early, in parallel with the gateway, and the device
  // link asks again a moment later: a result is reused for a minute (two requests each time).
  async vm() {
    // The cache is keyed by the expected VM: a plain 60 s cache returned the previous
    // account's VM after the Muse login changed, without lookupVm's expected check ever
    // running. Asking expectedVm() on a cache hit is a local session read, not a request.
    let expected; try{expected=await this.expectedVm();}catch{expected=undefined;}
    // When expectedVm() itself failed, the key collapses to undefined and an
    // undefined-keyed cache hit used to serve ANOTHER account's VM unchecked
    // (audit #197). With no expected VM there is nothing safe to match against:
    // skip the cache and let lookupVm() ask (and fail) properly.
    // The key also carries the device pair's identity (c29 #5): after a
    // re-pairing for the SAME account, the old pair's cached VM used to be
    // served for another minute.
    const pairToken=this.saved.device?.access_token;
    if(expected!==undefined&&this.vmCache&&this.vmCache.expected===expected&&this.vmCache.pairToken===pairToken&&fresh(this.vmCache.at,60000))return this.vmCache.vm;
    if(expected!==undefined&&this.vmPromise&&this.vmPromiseExpected===expected&&this.vmPromisePair===pairToken)return this.vmPromise;
    // lookupVm is told the expected VM this call keyed on (c29 #5): it used to
    // re-read expectedVm() on its own, so an account switch between the two
    // reads fetched the NEW account's VM and cached it under the OLD key.
    const promise=this.lookupVm(expected).then(vm=>{if(vm?.vm_id===expected)this.vmCache={at:monoNow(),vm,expected,pairToken};return vm;})
      .finally(()=>{if(this.vmPromise===promise){this.vmPromise=null;this.vmPromiseExpected=undefined;this.vmPromisePair=undefined;}});
    this.vmPromise=promise;this.vmPromiseExpected=expected;this.vmPromisePair=pairToken;return promise;
  }
  // Deep H16: refresh tokens are single-use, so when two windows/instances refresh at once
  // only one wins; the loser's refresh fails with a 4xx even though the pairing is healthy.
  // Before believing any refresh failure, re-read the disk pair several times with a short
  // backoff (the winner needs a moment to persist) and adopt it when its access token differs
  // from ours. Returns the adopted disk device, or null when the disk still holds our pair.
  // (config.withLock is synchronous and cannot be held across the awaited refresh request,
  // so re-read/adopt is the coordination mechanism available here.)
  async adoptDiskPair(attempts = 5) {
    const delays = [0, 25, 50, 100, 200];
    for (let i = 0; i < attempts; i++) {
      if (delays[i]) await sleep(delays[i]);
      let disk = null; try { disk = this.load?.()?.device || null; } catch {}
      if (disk?.access_token && disk.access_token !== this.saved.device?.access_token) {
        this.saved = {...this.saved, device: {...this.saved.device, ...disk}};
        return disk;
      }
    }
    return null;
  }
  async lookupVm(expectedHint) {
    if(!this.saved.device)throw new Error(t('PC 端末の認証が必要です。'));
    const expected=expectedHint!==undefined?expectedHint:await this.expectedVm();if(!expected)throw new Error(t('先に Muse アプリへログインしてください。'));
    let result,expired=false,firstError=null;
    try{result=await this.request('device','/fetch_vms',undefined,this.saved.device.access_token,this.signal());}
    catch(e){
      if(e.status!==401)throw e;
      expired=true;firstError=e;
      // muser: another muser window may have refreshed the pair already (each window kept the one it
      // started with, and refreshed with a refresh token that may have been used up). Take the saved
      // pair first and only refresh when it is the same expired one.
      let disk=null;try{disk=this.load?.()?.device||null;}catch{}
      if(disk?.access_token&&disk.access_token!==this.saved.device.access_token){
        this.saved={...this.saved,device:{...this.saved.device,...disk}};
        try{result=await this.request('device','/fetch_vms',undefined,this.saved.device.access_token,this.signal());}catch(e2){if(e2.status!==401)throw e2;}
      }
    }
    // Only a real 401 means expiry (audit #198): an empty/malformed 200 body is a
    // shape failure, and refreshing for it burns the single-use refresh token.
    if(!expired&&!isObj(result))throw new Error(t('PC 端末の認証情報を取得できませんでした。'));
    if(!result&&expired){
      // A pair this process refreshed a moment ago is not refreshed again when the
      // follow-up fetch keeps failing: each retry burned the next single-use token.
      if(this.refreshedAccess&&this.saved.device.access_token===this.refreshedAccess&&fresh(this.refreshedAt,60000))throw firstError;
      const storedRefresh=this.saved.device.refresh_token;
      if(typeof storedRefresh!=='string'||!storedRefresh.trim()||!storedRefresh.split(':').pop())throw Object.assign(new Error(t('保存済みの更新トークンの形式が正しくありません。PC 端末を再認証してください。保存済みの情報は変更していません。')),{deadDevice:true});
      const refresh=storedRefresh.split(':').pop();
      let response;
      try{response=await this.request('device','/device_token/refresh',{device_id:this.saved.nodeId,sdk_token:this.saved.sdkToken},'hatch_refresh:'+refresh,this.signal());}
      catch(refreshError){
        // muser: the refresh may have failed because another window refreshed first and used
        // up this window's refresh token, saving a fresh pair meanwhile (deep H16). Re-read
        // the disk pair repeatedly with backoff and retry fetch_vms with the adopted pair
        // before giving up with the refresh error.
        const adopted=await this.adoptDiskPair();
        if(adopted){
          try{result=await this.request('device','/fetch_vms',undefined,this.saved.device.access_token,this.signal());}catch{}
          // The disk shows a different, newer pair: this failure is the race, not a dead
          // device. Never mark deadDevice here — start() would persist-clear the winner's
          // freshly saved pair.
          if(!result){delete refreshError.deadDevice;throw refreshError;}
        }
        // 408/429 are retryable, not death (c29 #3): the refresh token was not
        // consumed, so marking the pair dead made start() erase a healthy
        // pairing over a rate limit. Other 4xx keep the phase-1 behaviour.
        if(!result){const rs=refreshError.status;if(rs>=400&&rs<500&&rs!==408&&rs!==429)refreshError.deadDevice=true;throw refreshError;}
      }
      if(!result){
        const pair=isObj(response)?(response.payload||response):null;
        if(!isObj(pair)||!isToken(pair.access_token)||!isToken(pair.refresh_token))throw Object.assign(new Error(t('PC 端末の認証を更新できません。保存済みの情報は変更していません。')),{deadDevice:true});
        this.persist({device:{access_token:pair.access_token,refresh_token:pair.refresh_token,access_token_saved_at:Math.floor(Date.now()/1000)}});
        this.refreshedAt=monoNow();this.refreshedAccess=pair.access_token;
        result=await this.request('device','/fetch_vms',undefined,this.saved.device.access_token,this.signal());
        if(!isObj(result))throw new Error(t('PC 端末の認証情報を取得できませんでした。'));
      }
    }
    // Deep H15: a malformed vm_list (missing / not an array / empty) or a VM that exists but
    // is not provisioned yet (no auth token) is a shape/transient problem, NOT proof that this
    // pairing belongs to another account. Throw a retryable error and keep the pair;
    // deviceMismatch is reserved for a proper non-empty list that does not contain the
    // expected VM at all. (Guarding on Array.isArray also keeps .find off non-arrays.)
    if(!Array.isArray(result.vm_list)||!result.vm_list.length)throw Object.assign(new Error(t('PC 端末の認証情報を取得できませんでした。')),{retryable:true});
    const vm=result.vm_list.find(v=>v?.vm_id===expected);
    // muser: marked, so a window can fail over to another account (src/agent.js ensureConnected).
    if(!vm)throw Object.assign(new Error(t('PC 端末の認証先が、現在の Muse アカウントと一致しません。')),{deviceMismatch:true});
    if(!vm.vm_auth_token)throw Object.assign(new Error(t('PC 端末の認証情報を取得できませんでした。')),{retryable:true});
    return vm;
  }
  cancel() {this.generation++;this.abortCtrl?.abort();this.login=null;this.pending=null;this.checkpointUrl=undefined;this.phase=this.saved.device?'authenticated':this.saved.sdkToken?'contact':'start';this.message='';return this.snapshot();}
}
module.exports={PcAuth,normalizeOtpCode,isOtpExpiredError,OTP_DIGITS,SDK_ISSUE_PENDING_STALE_MS};
