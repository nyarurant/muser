'use strict';
const crypto=require('node:crypto');
const {t}=require('../i18n');

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
// Native authentication and device credentials are distinct from the website cookie.
// Wire schemas: https://github.com/chaitanyarahalkar/muse-desktop-bridge/blob/main/docs/protocol.md
class PcAuth {
  constructor({load,save,request,listSdk,issueSdk,expectedVm}) {
    this.load=typeof load==='function'?load:null;this.saved=load()||{};this.save=save;this.request=request;this.listSdk=listSdk;this.issueSdk=issueSdk;this.expectedVm=expectedVm;
    this.phase=this.saved.device?'authenticated':this.saved.sdkToken?'contact':'start';
    this.login=null;this.pending=null;this.message='';this.active=false;this.generation=0;
  }
  snapshot() {
    const label=(item,fallback)=>[item.display_name,item.name,item.username,item.masked_contact,item.masked_contact_point].find(v=>typeof v==='string'&&v.trim())?.slice(0,160)||fallback;
    return {phase:this.phase,hasSdkToken:!!this.saved.sdkToken,hasDevice:!!this.saved.device,
      accounts:this.phase==='account'?(this.pending?.accounts||[]).map((a,i)=>({label:label(a,t('アカウント {n}', {n: i+1}))})):[],
      methods:this.phase==='two_factor'?(this.pending?.two_factor_methods||[]).map((a,i)=>({label:label(a,({TOTP:t('認証アプリ'),SMS:'SMS',EMAIL:t('メール')})[String(a.method_type).toUpperCase()]||t('認証方法 {n}', {n: i+1}))})):[],
      ...(this.phase==='checkpoint'&&this.checkpointUrl?{checkpointUrl:this.checkpointUrl}:{}),message:this.message};
  }
  persist(update) {
    // Re-read the disk state for EVERY persist, not only device updates (audit #194):
    // a whole-snapshot save from a stale window (a nodeId or sdkIssuePending persist)
    // used to overwrite a newer device pair another window had saved meanwhile.
    let disk=null; try{disk=this.load?.()||null;}catch{}
    const fresh=isObj(disk)?disk:{};
    const next={...fresh,...this.saved,...update};
    // For the device pair the newest copy wins, whichever side holds it: a pair is
    // stamped when saved, so compare stamps instead of blindly layering the stale
    // in-memory copy over a fresher one from disk (or vice versa).
    const diskDev=isObj(fresh.device)?fresh.device:null, knownDev=isObj(this.saved?.device)?this.saved.device:null;
    const stamp=d=>Number(d?.access_token_saved_at)||0;
    const newestDev=diskDev&&knownDev?(stamp(diskDev)>stamp(knownDev)?diskDev:knownDev):diskDev||knownDev;
    if(isObj(update?.device)){
      // Merge into the previously saved device instead of replacing it wholesale:
      // a mint/refresh only carries the token pair, and other saved device fields
      // must survive it. The older layer goes first, the newest device next, and
      // this update (the caller's own fresh pair) last.
      const olderDev=newestDev===(diskDev||null)?knownDev:diskDev;
      next.device={...(olderDev||{}),...(newestDev||{}),...update.device};
    } else if(newestDev&&(update===undefined||!('device' in (update||{})))){
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
  async start(acceptTerms=false) {
    return this.action(async check=>{
      if(this.saved.device){
        try{await this.vm();check();this.phase='authenticated';this.message=t('PC 端末の認証は完了しています。');return;}
        catch(e){
          // A pair that provably belongs to another account or can no longer be
          // refreshed is dead weight (audit #193): every retry failed the same way
          // until the user deleted the file by hand. Drop just that pair and fall
          // through to a fresh login. A transient failure (network, 5xx) keeps it.
          if(!(e.deviceMismatch||e.deadDevice||e.status===401))throw e;
          this.persist({device:undefined});check();
        }
      }
      if(!this.saved.sdkToken){
        if(acceptTerms!==true)throw new Error(t('SDK トークンの利用規約を確認してください。'));
        if(this.saved.sdkIssuePending)throw new Error(t('前回のトークン発行結果を確認できません。SDK トークンのページで発行状況を確認してください。自動で再発行はしません。'));
        const list=await this.listSdk(this.signal());check();
        if(!isObj(list)||!Array.isArray(list.tokens)||!Number.isSafeInteger(list.maxActiveTokens))throw new Error(t('SDK トークンの発行状況を確認できません。'));
        if(list.tokens.length>=list.maxActiveTokens)throw new Error(t('SDK トークンの発行上限です。既存のトークンは変更していません。'));
        this.persist({sdkIssuePending:true});
        // Persist an issued token even if the user closes the dialog during this request.
        const issued=await this.issueSdk(this.signal());
        if(!isObj(issued)||typeof issued.token!=='string'||!issued.token.startsWith('mgst_'))throw new Error(t('SDK トークンの発行結果を確認できません。'));
        this.persist({sdkToken:issued.token,sdkTokenId:issued.sdkToken?.id,sdkIssuePending:false});check();
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
    this.code(code);
    return this.action(async check=>{
      if(!this.login?.authState||this.phase!=='code')throw new Error(t('先に認証コードを送信してください。'));
      const result=await this.auth('confirm_otp',{auth_state:this.login.authState,otp_code:code.trim(),supports_account_selection:true});check();
      await this.accept(result,check);
    });
  }
  code(value) {if(typeof value!=='string'||!value.trim()||value.length>128)throw new Error(t('認証コードを入力してください。'));}
  choice(list,index) {if(!Number.isSafeInteger(index)||index<0||index>=list?.length)throw new Error(t('表示された認証項目を選択してください。'));return list[index];}
  async select(index) {
    return this.action(async check=>{
      if(this.phase!=='account'||!this.pending?.selection_state)throw new Error(t('アカウント選択を最初から開始してください。'));
      const account=this.choice(this.pending.accounts,index);
      const result=await this.auth('select_account',{selection_state:this.pending.selection_state,account_ref:account.account_ref});check();await this.accept(result,check);
    });
  }
  async twoFactor(index,code) {
    if(code!==undefined)this.code(code);
    return this.action(async check=>{
      if(this.phase!=='two_factor'||!this.pending?.two_factor_state)throw new Error(t('追加認証を最初から開始してください。'));
      const method=this.choice(this.pending.two_factor_methods,index);
      if(code===undefined&&/^(?:TOTP|AUTHENTICATOR)$/i.test(method.method_type||method.method_id||'')){this.message=t('認証アプリに表示されたコードを入力してください。');return;}
      const result=await this.auth(code===undefined?'two_factor/send_code':'two_factor',{two_factor_state:this.pending.two_factor_state,method_id:method.method_id,...code!==undefined?{code:code.trim()}:{}});check();
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
    if(result.account_selection_required){if(!Array.isArray(result.accounts)||!result.accounts.length)throw new Error(t('アカウント候補を確認できません。'));this.phase='account';this.message=t('現在 Muse で使っているアカウントを選んでください。');return;}
    if(result.two_factor_required){if(!Array.isArray(result.two_factor_methods)||!result.two_factor_methods.length)throw new Error(t('追加認証の方法を確認できません。'));this.phase='two_factor';this.message=t('追加認証の方法を選び、コードを入力してください。');return;}
    if(typeof result.abra_access_token!=='string'||!result.abra_access_token||!result.abra_user_id)throw new Error(t('Muse 側で追加の認証が必要です。'));
    // Minting needs this PC's node id (audit #199): a flow that reached accept()
    // without start() (a restored sdkToken, say) used to send device_id:undefined
    // and fail opaquely. Register the id the same way start() does.
    if(!this.saved.nodeId)this.persist({nodeId:'homelink-'+crypto.randomBytes(3).toString('hex')});
    // The native session bearer stays in memory until minting finishes; only the device pair is stored.
    const minted=await this.request('device','/device_token/mint',{device_id:this.saved.nodeId,sdk_token:this.saved.sdkToken},result.abra_access_token,this.signal());
    check();
    const pair=isObj(minted)?(minted.payload||minted):null;
    if(!isObj(pair)||!pair.access_token||!pair.refresh_token)throw new Error(t('PC 端末の認証情報を取得できませんでした。'));
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
    if(expected!==undefined&&this.vmCache&&this.vmCache.expected===expected&&Date.now()-this.vmCache.at<60000)return this.vmCache.vm;
    if(expected!==undefined&&this.vmPromise&&this.vmPromiseExpected===expected)return this.vmPromise;
    const promise=this.lookupVm().then(vm=>{this.vmCache={at:Date.now(),vm,expected};return vm;})
      .finally(()=>{if(this.vmPromise===promise){this.vmPromise=null;this.vmPromiseExpected=undefined;}});
    this.vmPromise=promise;this.vmPromiseExpected=expected;return promise;
  }
  async lookupVm() {
    if(!this.saved.device)throw new Error(t('PC 端末の認証が必要です。'));
    const expected=await this.expectedVm();if(!expected)throw new Error(t('先に Muse アプリへログインしてください。'));
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
      if(this.refreshedAccess&&this.saved.device.access_token===this.refreshedAccess&&Date.now()-this.refreshedAt<60000)throw firstError;
      const storedRefresh=this.saved.device.refresh_token;
      if(typeof storedRefresh!=='string'||!storedRefresh.trim()||!storedRefresh.split(':').pop())throw Object.assign(new Error(t('保存済みの更新トークンの形式が正しくありません。PC 端末を再認証してください。保存済みの情報は変更していません。')),{deadDevice:true});
      const refresh=storedRefresh.split(':').pop();
      let response;
      try{response=await this.request('device','/device_token/refresh',{device_id:this.saved.nodeId,sdk_token:this.saved.sdkToken},'hatch_refresh:'+refresh,this.signal());}
      catch(refreshError){
        // muser: the refresh may have failed because another window refreshed first and used
        // up this window's refresh token, saving a fresh pair meanwhile. Re-load from disk and
        // retry fetch_vms once with the saved pair before giving up with the refresh error.
        let disk=null;try{disk=this.load?.()?.device||null;}catch{}
        if(disk?.access_token&&disk.access_token!==this.saved.device.access_token){
          this.saved={...this.saved,device:{...this.saved.device,...disk}};
          try{result=await this.request('device','/fetch_vms',undefined,this.saved.device.access_token,this.signal());}catch{}
        }
        if(!result){if(refreshError.status>=400&&refreshError.status<500)refreshError.deadDevice=true;throw refreshError;}
      }
      if(!result){
        const pair=isObj(response)?(response.payload||response):null;
        if(!isObj(pair)||!pair.access_token||!pair.refresh_token)throw Object.assign(new Error(t('PC 端末の認証を更新できません。保存済みの情報は変更していません。')),{deadDevice:true});
        this.persist({device:{access_token:pair.access_token,refresh_token:pair.refresh_token,access_token_saved_at:Math.floor(Date.now()/1000)}});
        this.refreshedAt=Date.now();this.refreshedAccess=pair.access_token;
        result=await this.request('device','/fetch_vms',undefined,this.saved.device.access_token,this.signal());
        if(!isObj(result))throw new Error(t('PC 端末の認証情報を取得できませんでした。'));
      }
    }
    const vm=result.vm_list?.find(v=>v.vm_id===expected);
    // muser: marked, so a window can fail over to another account (src/agent.js ensureConnected).
    if(!vm?.vm_auth_token)throw Object.assign(new Error(t('PC 端末の認証先が、現在の Muse アカウントと一致しません。')),{deviceMismatch:true});
    return vm;
  }
  cancel() {this.generation++;this.abortCtrl?.abort();this.login=null;this.pending=null;this.checkpointUrl=undefined;this.phase=this.saved.device?'authenticated':this.saved.sdkToken?'contact':'start';this.message='';return this.snapshot();}
}
module.exports={PcAuth};
