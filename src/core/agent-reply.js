'use strict';
const {messageFromEvent}=require('./chat-model');
const {t}=require('../i18n');

const BUSY=new Set(['running','pending','queued','in_progress','started','waiting_for_approval']);
const FAILED=new Set(['failed','error','errored','cancelled','canceled','stopped','interrupted']);

// Only a completed turn with a canonical, ready transcript may reach the executor.
// Delta notifications trigger the read; polling is a recovery path for a lost subscription.
function waitForReply({client,sessionId,baseline=new Set(),signal,timeoutMs=600000,pollMs=5000,settleMs=500,reconnectGraceMs=300000}) {
  let ended=false,checking=false,again=false,accepted=false,expectedReply=null,lost=null;
  let doneIds=new Set(),last='',stableAt=0,retry=null,resolveReply,rejectReply;
  // Parsed history messages, cached by id across check() calls: polling re-reads
  // the same history every time, and messageFromEvent (incl. attachment splitting)
  // need not run again for an event whose text has not changed.
  const parsedCache=new Map();
  const parseCached=event=>{
    const p=event.payload||{};
    const id=event.message_id||p.message_id||p.id;
    const raw=event.display_text??p.display_text??p.content??p.text;
    if(typeof id==='string'&&id){
      const hit=parsedCache.get(id);
      if(hit&&hit.raw===raw)return hit.message;
      const message=messageFromEvent(event);
      parsedCache.set(id,{raw,message});
      return message;
    }
    return messageFromEvent(event);
  };
  let pollFailures=0,pollTimer=null;
  const promise=new Promise((resolve,reject)=>{resolveReply=resolve;rejectReply=reject;});
  // Sending can fail before the caller starts awaiting this promise.
  promise.catch(()=>{});
  const cleanup=()=>{
    clearTimeout(timeout);clearTimeout(retry);clearTimeout(lost);clearTimeout(pollTimer);
    client.off('event',onEvent);client.off('status',onStatus);signal?.removeEventListener('abort',onAbort);
  };
  const finish=(error,value)=>{if(ended)return;ended=true;cleanup();error?rejectReply(error):resolveReply(value);};
  const cancel=()=>finish(Object.assign(new Error(t('PC の操作を停止しました。')),{name:'AbortError'}));
  const check=async()=>{
    if(ended||!accepted)return;
    if(checking){again=true;return;}
    checking=true;
    try {
      const [history,detail]=await Promise.all([
        client.history(sessionId),client.request('GET','/api/session/list/'+encodeURIComponent(sessionId)),
      ]);
      pollFailures=0;
      if(ended)return;
      const status=String((detail?.session||detail)?.status||'').toLowerCase();
      if(FAILED.has(status)){finish(new Error(t('Muse の作業が終了しました ({status})。PC 操作は続行しません。', {status})));return;}
      if(!status||BUSY.has(status))return;
      const byId=new Map();
      for(const event of history.chat_events||[]){
        const message=parseCached(event);
        if(message?.role!=='assistant'||!message.content||baseline.has(message.id)||(expectedReply&&message.replyTo&&message.replyTo!==expectedReply))continue;
        byId.set(message.id,{...message,ready:event.display_text_ready!==false&&event.payload?.display_text_ready!==false});
      }
      const messages=[...byId.values()].sort((a,b)=>a.seq-b.seq||a.time-b.time);
      const latest=messages[messages.length-1];
      if(!latest?.ready)return;
      // A turn can publish several assistant messages, including identical copies
      // under different IDs. Only its final reply is a tool request, as in the
      // original protocol. Executing their concatenation can repeat side effects.
      const signature=JSON.stringify([latest.id,latest.content]);
      if(signature!==last){last=signature;stableAt=Date.now();}
      if(doneIds.has(latest.id)||Date.now()-stableAt>=settleMs){
        finish(null,{text:latest.content,messageIds:messages.map(m=>m.id)});
      }else{
        clearTimeout(retry);retry=setTimeout(()=>void check(),settleMs);
      }
    }catch{ pollFailures=Math.min(pollFailures+1,10); /* A fresh thread or a reconnect may not be readable yet. Never re-send. */ }
    finally{
      checking=false;
      if(again&&!ended){again=false;queueMicrotask(()=>void check());}
    }
  };
  const onEvent=e=>{
    const p=e.payload||{};
    // muser: side-chat events all carry parent_agent_id, so only the session decides.
    if((p.session_id||e.session_id)!==sessionId)return;
    if(e.event==='delta.message_done'&&p.status==='completed'&&!baseline.has(p.message_id)){
      doneIds.add(p.message_id);void check();
    }else if(e.event==='task.status'&&!BUSY.has(String(p.status||'').toLowerCase()))void check();
    else if(e.event==='sessions.updated'&&doneIds.size)void check();
  };
  // muser: Muse keeps working server-side while the gateway is down and the agent reconnects it,
  // so a drop only ends the wait if the connection stays down past the grace period.
  const onStatus=({status})=>{
    if(status==='connected'){clearTimeout(lost);lost=null;void check();}
    // A genuine reconnect attempt resets the grace clock: without this, a drop that
    // recovered into 'connecting' and then failed again was still timed from the
    // first drop, so the sticky timer could fire during the second outage.
    else if(status==='connecting'){clearTimeout(lost);lost=null;}
    else if(status==='auth_required')finish(new Error(t('Muse のログインが切れたため、PC 操作を停止しました。')));
    else lost??=setTimeout(()=>finish(new Error(t('Muse との接続が戻らないため、PC 操作を停止しました。'))),reconnectGraceMs);
  };
  const onAbort=()=>cancel();
  const timeout=setTimeout(()=>finish(new Error(t('Muse の応答がタイムアウトしました。'))),timeoutMs);
  // Self-scheduling poll with backoff: the interval starts at the caller's pollMs
  // and doubles per consecutive failed check, capped at 30s (or pollMs*8 when that
  // is larger, so callers that asked for a slower cadence still back off);
  // a successful check resets it.
  const maxPollMs=Math.max(30000,pollMs*8);
  const schedulePoll=()=>{
    if(ended)return;
    const delay=pollFailures?Math.min(pollMs*(2**pollFailures),maxPollMs):pollMs;
    pollTimer=setTimeout(()=>{pollTimer=null;void check().then(schedulePoll,schedulePoll);},delay);
    pollTimer.unref?.();
  };
  schedulePoll();
  client.on('event',onEvent);client.on('status',onStatus);signal?.addEventListener('abort',onAbort,{once:true});
  if(signal?.aborted)cancel();
  return {
    promise,cancel,
    accept(replyId){expectedReply=replyId||null;accepted=true;void check();},
    refresh:()=>void check(),
  };
}
module.exports={waitForReply};
