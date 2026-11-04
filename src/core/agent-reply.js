'use strict';
const {messageFromEvent}=require('./chat-model');
const {t}=require('../i18n');

const BUSY=new Set(['running','pending','queued','in_progress','started','waiting_for_approval']);
const FAILED=new Set(['failed','error','errored','cancelled','canceled','stopped','interrupted']);

// Only a completed turn with a canonical, ready transcript may reach the executor.
// Delta notifications trigger the read; polling is a recovery path for a lost subscription.
function waitForReply({client,sessionId,baseline=new Set(),signal,timeoutMs=600000,pollMs=5000,settleMs=500,reconnectGraceMs=300000}) {
  let ended=false,checking=false,again=false,accepted=false,expectedReply=null,lost=null,lostSince=null;
  // An abandoned wait must not hold the process open: every long timer here is
  // unref'd, so only real work (an active socket, a running turn) keeps the
  // process alive, never a wait nobody is listening to any more.
  const arm=timer=>{timer?.unref?.();return timer;};
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
      // Settled separately, not Promise.all: bundling them made one side's
      // failure erase the other side's verdict — a session whose history read
      // kept failing never surfaced its FAILED status (the wait polled on to a
      // misleading timeout), and a failed detail read hid a finished reply.
      const [h,d]=await Promise.allSettled([
        client.history(sessionId),client.request('GET','/api/session/list/'+encodeURIComponent(sessionId)),
      ]);
      if(ended)return;
      let status='';
      if(d.status==='fulfilled'){
        pollFailures=0;
        const detail=d.value;
        status=String((detail?.session||detail)?.status||'').toLowerCase();
        // museStatus tells the caller the verdict came from Muse itself (agent.js retries a
        // parallel agent whose chat Muse ended with an error before it did anything).
        if(FAILED.has(status)){finish(Object.assign(new Error(t('Muse の作業が終了しました ({status})。PC 操作は続行しません。', {status})),{museStatus:status}));return;}
        if(BUSY.has(status))return;
        // An empty status is not a verdict either way: fall through and let
        // the history speak, instead of ignoring a completed reply until the
        // overall timeout (fifth audit f2-4).
      }
      if(h.status!=='fulfilled'){pollFailures=Math.min(pollFailures+1,10);return;}
      const history=h.value;
      const byId=new Map();
      // The chat is finished and holds exactly one message sent since the baseline (this
      // turn's own): every new reply in it answers that message, whatever its replyTo says.
      // 2026-11-04: of 51 finished parallel-agent replies, 45 had no replyTo (adopted only if
      // the done event reached this wait — a lost event left the poll unable to adopt them)
      // and two pointed at an id that was neither in the chat nor the send's ack; both agents
      // were done in Muse while muser waited for them until it was stopped.
      const parsed=(history.chat_events||[]).map(parseCached);
      const sole=status&&!BUSY.has(status)&&parsed.filter(m=>m?.role==='user'&&!baseline.has(m.id)).length===1;
      for(const [i,event] of (history.chat_events||[]).entries()){
        const message=parsed[i];
        if(message?.role!=='assistant'||!message.content||baseline.has(message.id))continue;
        if(sole){byId.set(message.id,{...message,ready:event.display_text_ready!==false&&event.payload?.display_text_ready!==false});continue;}
        // With an accepted reply id, a message counts only when it answers
        // that message, or its completion was signalled on this wait's own
        // event stream (doneIds). A replyTo-less message from another turn
        // sharing the session is otherwise indistinguishable from this turn's
        // reply, and the executor would run an unrelated text as its orders.
        if(expectedReply&&message.replyTo!==expectedReply&&!doneIds.has(message.id))continue;
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
        clearTimeout(retry);retry=arm(setTimeout(()=>void check(),settleMs));
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
  // The grace clock is anchored at the first drop of an outage episode and
  // only a real 'connected' resets it. 'connecting' used to clear the timer,
  // so a gateway flapping between disconnected and connecting (each attempt
  // failing inside the grace period) restarted the clock forever and the
  // lost-connection verdict never fired.
  const armLost=()=>{
    if(lost||lostSince==null)return;
    const remain=Math.max(0,reconnectGraceMs-(Date.now()-lostSince));
    lost=arm(setTimeout(()=>finish(new Error(t('Muse との接続が戻らないため、PC 操作を停止しました。'))),remain));
  };
  const onStatus=({status})=>{
    if(status==='connected'){clearTimeout(lost);lost=null;lostSince=null;void check();}
    else if(status==='auth_required')finish(new Error(t('Muse のログインが切れたため、PC 操作を停止しました。')));
    else if(status==='connecting'){armLost(); /* an attempt inside an episode keeps the episode's deadline */}
    else {if(lostSince==null)lostSince=Date.now();armLost();}
  };
  const onAbort=()=>cancel();
  const timeout=arm(setTimeout(()=>finish(new Error(t('Muse の応答がタイムアウトしました。'))),timeoutMs));
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
