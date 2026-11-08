'use strict';
const {messageFromEvent}=require('./chat-model');
const {t}=require('../i18n');

const BUSY=new Set(['running','pending','queued','in_progress','started','waiting_for_approval']);
const FAILED=new Set(['failed','error','errored','cancelled','canceled','stopped','interrupted']);

// Join one segment's messages into the reply text (see the note in check()).
// Fragments join as a new paragraph, the way Muse's own page shows them (two
// messages): a single space would glue a heading or a list onto the line
// before it when Muse splits at a paragraph break. A fragment that ends or a
// continuation that begins with whitespace, and a continuation that opens
// with closing punctuation, join as they are.
function joinFragment(a,b) {
  if(!a)return b;
  if(!b)return a;
  if(/\s$/.test(a)||/^\s/.test(b))return a+b;
  if(/^[,.!?;:%\)\]\}、。！？：；）」』】]/.test(b))return a+b;
  if(/[\(\[\{（「『【]$/.test(a))return a+b;
  return a+'\n\n'+b;
}
function combineMessages(list) {
  const kept=[];
  for(const m of list){
    if(kept.some(k=>k.content===m.content))continue; // the same text again under another id
    if(list.some(o=>o!==m&&o.content.length>m.content.length&&o.content.startsWith(m.content)))continue; // a snapshot a fuller copy extends
    kept.push(m);
  }
  let text='';
  for(const m of kept)text=joinFragment(text,m.content);
  return {text,ids:kept.map(m=>m.id)};
}

// Only a completed turn with a canonical, ready transcript may reach the executor.
// Delta notifications trigger the read; polling is a recovery path for a lost subscription.
function waitForReply({client,sessionId,baseline=new Set(),signal,timeoutMs=600000,pollMs=5000,settleMs=500,reconnectGraceMs=300000,silentMs=30000,stallMs=600000,localBusy=()=>false,segmentIds=null}) {
  let ended=false,checking=false,again=false,accepted=false,expectedReply=null,lost=null,lostSince=null,silentSince=null;
  // No-progress watchdog: the silent-finish check below only covers a chat that
  // ENDS without a reply. A chat whose status sticks at busy, whose history read
  // keeps failing, or whose final message never becomes ready has no exit either
  // and used to sit on the overall timeout (3 h in agent.js) with the window
  // refusing every send. Any sign of life — a session event, a changed history
  // or status, a tool of this turn still running locally — restarts the clock;
  // stallMs of nothing at all ends the wait with the timeout verdict instead.
  let lastProgressAt=Date.now(),lastSig='';
  const progress=sig=>{if(sig&&sig!==lastSig){lastSig=sig;lastProgressAt=Date.now();}};
  const stalled=()=>Date.now()-lastProgressAt>=stallMs;
  const stallError=()=>Object.assign(new Error(t('Muse の応答がタイムアウトしました。')),{stalled:true});
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
  // Wave 15 (W2-04): a wait that ends on the stall watchdog or the overall
  // timeout leaves Muse still working on that chat — busy, and spending —
  // on a turn this window has already given up on, so those two endings also
  // cancel the turn on Muse's side. The other endings must NOT cancel: a
  // FAILED status and a silent completion mean the chat already ended, and
  // auth_required / a lost connection mean a cancel could not be delivered
  // (or would only be noise) — they keep using finish() directly. The cancel
  // is fire-and-forget and best-effort: its failure never masks the verdict.
  const cancelMuseSide=()=>{try{const p=client.cancel?.(sessionId);if(p&&typeof p.catch==='function')p.catch(()=>{});}catch{}};
  const finishWithCancel=error=>{if(ended)return;cancelMuseSide();finish(error);};
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
        // Watchdog bookkeeping (see the note at the top): a changed status or
        // history tail is progress; a local tool still running is progress too
        // (Muse is waiting on us). Nothing changed for stallMs: end the wait.
        const tail=h.status==='fulfilled'?(h.value.chat_events||[]):[];
        progress(status+'|'+tail.length+'|'+(tail.length?(tail[tail.length-1].message_id||tail[tail.length-1].seq||''):''));
        if(localBusy())lastProgressAt=Date.now();
        if(stalled()){finishWithCancel(stallError());return;}
        if(BUSY.has(status)){silentSince=null;return;}
        // An empty status is not a verdict either way: fall through and let
        // the history speak, instead of ignoring a completed reply until the
        // overall timeout (fifth audit f2-4).
      }
      if(h.status!=='fulfilled'){pollFailures=Math.min(pollFailures+1,10);if(stalled()){finishWithCancel(stallError());return;}return;}
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
      // Muse finished WITHOUT answering: the chat is done and nothing at all follows our
      // newest message. 2026-11-05: an automatic bg-completion note got one memory search
      // from Muse, status went 'completed' and no reply ever came — the wait sat on its 3 h
      // timeout and the window stayed busy, refusing every send. A short grace covers the
      // moment right after sending, when the chat can still read 'completed' from before.
      const newer=parsed.filter(m=>m&&!baseline.has(m.id)).sort((a,b)=>a.seq-b.seq||a.time-b.time);
      const lastUser=newer.map(m=>m.role).lastIndexOf('user');
      const answered=lastUser>=0&&newer.slice(lastUser+1).some(m=>m.role==='assistant'&&m.content);
      if(status&&!BUSY.has(status)&&!messages.length&&lastUser>=0&&!answered){
        if(localBusy()){silentSince=null;return;} // a tool of this turn still runs here: Muse is waiting on us
        silentSince??=Date.now();
        if(Date.now()-silentSince>=silentMs)finish(null,{text:'',messageIds:[],silent:true});
        return;
      }
      silentSince=null;
      // The reply is what Muse said in the turn's LAST segment — after its
      // last local tool call. The caller passes the message ids it saw stream
      // in that segment (segmentIds); text before a tool call is narration for
      // that call, not part of the answer. With no live segment to go by (a
      // poll-only recovery), only the newest message counts, as before the
      // join: every candidate would pull earlier narration into the reply.
      let replyMessages=messages.slice(-1);
      if(typeof segmentIds==='function'){
        const seg=segmentIds();
        if(seg&&seg.size){const f=messages.filter(m=>seg.has(m.id));if(f.length)replyMessages=f;}
      }
      const latest=replyMessages[replyMessages.length-1];
      if(!latest?.ready||!replyMessages.every(m=>m.ready))return;
      // One logical reply can arrive as several messages (2026-11-08: the first
      // half as message.assistant, the rest as delta.presentation under another
      // id), so the segment's messages are joined, not just the last one read.
      // Tool calls no longer ride in this text — they run on the device link
      // while the turn streams — so joining cannot re-run anything. Identical
      // copies under different ids, and a shorter snapshot a fuller copy of the
      // same text extends, are dropped instead of repeating the text.
      const combined=combineMessages(replyMessages);
      const signature=JSON.stringify([combined.ids,combined.text]);
      if(signature!==last){last=signature;stableAt=Date.now();}
      if(doneIds.has(latest.id)||Date.now()-stableAt>=settleMs){
        finish(null,{text:combined.text,messageIds:combined.ids});
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
    lastProgressAt=Date.now(); // any event for this chat is a sign of life for the watchdog
    // Muse is visibly doing something for this chat: not a silent finish (yet).
    if(String(e.event||'').startsWith('delta.')||(e.event==='agent.status'&&['working','responding'].includes(p.activity_code)))silentSince=null;
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
  const timeout=arm(setTimeout(()=>finishWithCancel(new Error(t('Muse の応答がタイムアウトしました。'))),timeoutMs));
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
module.exports={waitForReply,combineMessages};
