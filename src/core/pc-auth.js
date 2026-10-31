'use strict';
const crypto=require('node:crypto');

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
      accounts:this.phase==='account'?(this.pending?.accounts||[]).map((a,i)=>({label:label(a,'アカウント '+(i+1))})):[],
      methods:this.phase==='two_factor'?(this.pending?.two_factor_methods||[]).map((a,i)=>({label:label(a,({TOTP:'認証アプリ',SMS:'SMS',EMAIL:'メール'})[String(a.method_type).toUpperCase()]||'認証方法 '+(i+1))})):[],
      ...(this.phase==='checkpoint'&&this.checkpointUrl?{checkpointUrl:this.checkpointUrl}:{}),message:this.message};
  }
  persist(update) {
    const next={...this.saved,...update};
    if(update?.device&&typeof update.device==='object'&&!Array.isArray(update.device)){
      // Merge into the previously saved device instead of replacing it wholesale:
      // a mint/refresh only carries the token pair, and other saved device fields
      // must survive it. Re-read the current saved device when possible (another
      // writer may have updated it since construction); the in-memory copy is the
      // fallback and the next-newest layer.
      let onDisk=null;
      try{onDisk=this.load?.()?.device||null;}catch{}
      const base=onDisk&&typeof onDisk==='object'?onDisk:{};
      const known=this.saved?.device&&typeof this.saved.device==='object'?this.saved.device:{};
      next.device={...base,...known,...update.device};
    }
    this.save(next);this.saved=next;
  }
  async action(fn) {
    if(this.active)throw new Error('PC の認証処理中です。しばらくお待ちください。');
    this.active=true;const generation=this.generation;
    try {await fn(()=>{if(generation!==this.generation)throw new Error('PC の認証を閉じました。');});return this.snapshot();}
    finally {this.active=false;if(generation!==this.generation)this.cancel();}
  }
  async start(acceptTerms=false) {
    return this.action(async check=>{
      if(this.saved.device){await this.vm();check();this.phase='authenticated';this.message='PC 端末の認証は完了しています。';return;}
      if(!this.saved.sdkToken){
        if(acceptTerms!==true)throw new Error('SDK トークンの利用規約を確認してください。');
        if(this.saved.sdkIssuePending)throw new Error('前回のトークン発行結果を確認できません。SDK トークンのページで発行状況を確認してください。自動で再発行はしません。');
        const list=await this.listSdk();check();
        if(!Array.isArray(list.tokens)||!Number.isSafeInteger(list.maxActiveTokens))throw new Error('SDK トークンの発行状況を確認できません。');
        if(list.tokens.length>=list.maxActiveTokens)throw new Error('SDK トークンの発行上限です。既存のトークンは変更していません。');
        this.persist({sdkIssuePending:true});
        // Persist an issued token even if the user closes the dialog during this request.
        const issued=await this.issueSdk();
        if(typeof issued.token!=='string'||!issued.token.startsWith('mgst_'))throw new Error('SDK トークンの発行結果を確認できません。');
        this.persist({sdkToken:issued.token,sdkTokenId:issued.sdkToken?.id,sdkIssuePending:false});check();
      }
      if(!this.saved.nodeId)this.persist({nodeId:'homelink-'+crypto.randomBytes(3).toString('hex')});
      this.phase='contact';this.message='Muse で使っているメールアドレスまたは電話番号を入力してください。';
    });
  }
  async auth(action,fields={}) {
    if(!this.login?.token)throw new Error('認証を最初から開始してください。');
    return this.request('auth','/hatch/auth/'+action,{device_id:this.login.deviceId,waterfall_id:this.login.waterfall,...fields},this.login.token);
  }
  async send(contact) {
    if(typeof contact!=='string'||!contact.trim()||contact.length>320)throw new Error('メールアドレスまたは国番号付きの電話番号を入力してください。');
    return this.action(async check=>{
      if(!this.saved.sdkToken)throw new Error('先に SDK トークンを準備してください。');
      if(this.saved.device)throw new Error('この PC は認証済みです。');
      const target=contact.trim();
      if(!this.login||this.login.contact!==target){
        const deviceId=crypto.randomUUID(),waterfall=crypto.randomUUID();
        const start=await this.request('auth','/hatch/auth/start',{device_id:deviceId,waterfall_id:waterfall});check();
        if(typeof start.access_token!=='string'||!start.access_token)throw new Error('Muse の認証を開始できませんでした。');
        this.login={deviceId,waterfall,token:start.access_token,contact:target};
        await this.auth('login_options');check();
      }
      const result=await this.auth('send_otp',{contact_point:target,...this.login.authState?{auth_state:this.login.authState}:{}});check();
      if(typeof result.auth_state!=='string'||!result.auth_state)throw new Error('Muse 側で追加のログイン手順が必要です。');
      this.login.authState=result.auth_state;this.phase='code';this.pending=null;this.message='認証コードを送信しました。届いたコードを入力してください。';
    });
  }
  async confirm(code) {
    this.code(code);
    return this.action(async check=>{
      if(!this.login?.authState||this.phase!=='code')throw new Error('先に認証コードを送信してください。');
      const result=await this.auth('confirm_otp',{auth_state:this.login.authState,otp_code:code.trim(),supports_account_selection:true});check();
      await this.accept(result,check);
    });
  }
  code(value) {if(typeof value!=='string'||!value.trim()||value.length>128)throw new Error('認証コードを入力してください。');}
  choice(list,index) {if(!Number.isSafeInteger(index)||index<0||index>=list?.length)throw new Error('表示された認証項目を選択してください。');return list[index];}
  async select(index) {
    return this.action(async check=>{
      if(this.phase!=='account'||!this.pending?.selection_state)throw new Error('アカウント選択を最初から開始してください。');
      const account=this.choice(this.pending.accounts,index);
      const result=await this.auth('select_account',{selection_state:this.pending.selection_state,account_ref:account.account_ref});check();await this.accept(result,check);
    });
  }
  async twoFactor(index,code) {
    if(code!==undefined)this.code(code);
    return this.action(async check=>{
      if(this.phase!=='two_factor'||!this.pending?.two_factor_state)throw new Error('追加認証を最初から開始してください。');
      const method=this.choice(this.pending.two_factor_methods,index);
      if(code===undefined&&/^(?:TOTP|AUTHENTICATOR)$/i.test(method.method_type||method.method_id||'')){this.message='認証アプリに表示されたコードを入力してください。';return;}
      const result=await this.auth(code===undefined?'two_factor/send_code':'two_factor',{two_factor_state:this.pending.two_factor_state,method_id:method.method_id,...code!==undefined?{code:code.trim()}:{}});check();
      if(code===undefined)this.message='追加認証コードを送信しました。';else await this.accept(result,check);
    });
  }
  async accept(result,check) {
    this.pending=result;
    if(result.checkpoint_required||result.requires_birthday||result.requires_name||result.requires_consent){
      this.phase='checkpoint';this.message='Muse 側で追加の確認が必要です。公式ページで確認を完了してください。';
      this.checkpointUrl=undefined;
      try{const u=new URL(result.checkpoint_url||result.checkpointUrl);if(u.protocol==='https:'&&(u.hostname==='muse.ai'||u.hostname.endsWith('.muse.ai')||u.hostname==='auth.meta.com'))this.checkpointUrl=u.href;}catch{}
      return;
    }
    if(result.account_selection_required){if(!Array.isArray(result.accounts)||!result.accounts.length)throw new Error('アカウント候補を確認できません。');this.phase='account';this.message='現在 Muse で使っているアカウントを選んでください。';return;}
    if(result.two_factor_required){if(!Array.isArray(result.two_factor_methods)||!result.two_factor_methods.length)throw new Error('追加認証の方法を確認できません。');this.phase='two_factor';this.message='追加認証の方法を選び、コードを入力してください。';return;}
    if(typeof result.abra_access_token!=='string'||!result.abra_access_token||!result.abra_user_id)throw new Error('Muse 側で追加の認証が必要です。');
    // The native session bearer stays in memory until minting finishes; only the device pair is stored.
    const minted=await this.request('device','/device_token/mint',{device_id:this.saved.nodeId,sdk_token:this.saved.sdkToken},result.abra_access_token);
    const pair=minted.payload||minted;
    if(!pair.access_token||!pair.refresh_token)throw new Error('PC 端末の認証情報を取得できませんでした。');
    this.persist({device:{access_token:pair.access_token,refresh_token:pair.refresh_token,access_token_saved_at:Math.floor(Date.now()/1000)}});
    this.login=null;this.pending=null;this.phase='authenticated';await this.vm();check();
    this.phase='authenticated';this.message='PC 端末の認証が完了しました。';
  }
  // Startup asks for the VM credentials early, in parallel with the gateway, and the device
  // link asks again a moment later: a result is reused for a minute (two requests each time).
  vm() {
    if(this.vmCache&&Date.now()-this.vmCache.at<60000)return Promise.resolve(this.vmCache.vm);
    if(this.vmPromise)return this.vmPromise;
    this.vmPromise=this.lookupVm().then(vm=>{this.vmCache={at:Date.now(),vm};return vm;}).finally(()=>{this.vmPromise=null;});return this.vmPromise;
  }
  async lookupVm() {
    if(!this.saved.device)throw new Error('PC 端末の認証が必要です。');
    const expected=await this.expectedVm();if(!expected)throw new Error('先に Muse アプリへログインしてください。');
    let result;
    try{result=await this.request('device','/fetch_vms',undefined,this.saved.device.access_token);}
    catch(e){
      if(e.status!==401)throw e;
      const storedRefresh=this.saved.device.refresh_token;
      if(typeof storedRefresh!=='string'||!storedRefresh.trim()||!storedRefresh.split(':').pop())throw new Error('保存済みの更新トークンの形式が正しくありません。PC 端末を再認証してください。保存済みの情報は変更していません。');
      const refresh=storedRefresh.split(':').pop();
      const response=await this.request('device','/device_token/refresh',{device_id:this.saved.nodeId,sdk_token:this.saved.sdkToken},'hatch_refresh:'+refresh);
      const pair=response.payload||response;
      if(!pair.access_token||!pair.refresh_token)throw new Error('PC 端末の認証を更新できません。保存済みの情報は変更していません。');
      this.persist({device:{access_token:pair.access_token,refresh_token:pair.refresh_token,access_token_saved_at:Math.floor(Date.now()/1000)}});
      result=await this.request('device','/fetch_vms',undefined,this.saved.device.access_token);
    }
    const vm=result.vm_list?.find(v=>v.vm_id===expected);
    if(!vm?.vm_auth_token)throw new Error('PC 端末の認証先が、現在の Muse アカウントと一致しません。');
    return vm;
  }
  cancel() {this.generation++;this.login=null;this.pending=null;this.checkpointUrl=undefined;this.phase=this.saved.device?'authenticated':this.saved.sdkToken?'contact':'start';this.message='';return this.snapshot();}
}
module.exports={PcAuth};
