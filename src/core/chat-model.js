'use strict';
// Shared by the local renderer and tests; never execute markup from Muse.
// i18n may be absent in the non-Node contexts this file was once shared with; then the
// Japanese text is used as-is (placeholders still filled).
let t=(s,vars)=>{let out=String(s);if(vars)out=out.replace(/\{(\w+)\}/g,(m,k)=>(Object.prototype.hasOwnProperty.call(vars,k)?String(vars[k]):m));return out;};
try{t=require('../i18n').t;}catch{}
function messageFromEvent(event) {
  const p=event.payload||event;
  const name=event.event_name||event.event||'';
  const role=event.role||p.role||(name==='message.user'?'user':name==='message.assistant'?'assistant':null);
  const visibility=event.visibility||p.visibility;
  if(visibility && visibility!=='public') return null;
  if(!['user','assistant'].includes(role)) return null;
  let content=event.display_text??p.display_text??p.content??p.text;
  if(typeof content!=='string')return null;
  const id=event.message_id||p.message_id||p.id;
  if(typeof id!=='string'||!id)return null;
  let attachments=[];
  if(role==='user')({text:content,files:attachments}=splitAttachments(content));
  return {id,role,content,seq:Number(event.seq??p.chat_event_seq??p.seq??0),time:event.occurred_at_ms??p.created_at_ms??0,sessionId:p.session_id??event.session_id??'',resources:event.resources||p.resources||[],reaction:typeof event.reaction_emoji==='string'?event.reaction_emoji:null,replyTo:typeof event.reply_to_message_id==='string'?event.reply_to_message_id:null,attachments};
}
// Uploaded attachments come back in the user's text as "[image:image/png workspace/...png]".
const ATTACHMENT_MARKER=/\n?\[(image|file|video|audio):([\w.+-]+\/[\w.+-]+) ([^\]\n]+)\]/g;
function splitAttachments(content) {
  const files=[];
  const text=content.replace(ATTACHMENT_MARKER,(_,kind,mime,path)=>{files.push({kind,mime,path:path.trim()});return '';}).trim();
  return {text,files};
}
function mergeMessages(existing,events) {
  const map=new Map(existing.map(m=>[m.id,m]));
  for(const event of events) {const m=messageFromEvent(event);if(m)map.set(m.id,{...map.get(m.id),...m});}
  return [...map.values()].sort((a,b)=>(Number(a.seq)||0)-(Number(b.seq)||0)||(Number(a.time)||0)-(Number(b.time)||0));
}
function applyDelta(existing,event) {
  const p=event.payload||{},name=event.event;
  if(!name?.startsWith('delta.')||typeof p.message_id!=='string')return existing;
  const prior=existing.find(m=>m.id===p.message_id);
  if(prior?.lastDeltaSeq&&Number(p.seq)<=prior.lastDeltaSeq)return existing;
  let content=prior?.content||'';
  if(name==='delta.text_append'&&typeof p.text==='string')content+=p.text;
  else if(name==='delta.presentation'&&typeof p.display_text==='string')content=p.display_text;
  else if(name==='delta.message_done'){
    const t=p.transcript;const text=t?.display_text??t?.content??t?.text;if(typeof text==='string')content=text;
  }else if(name!=='delta.message_start')return existing;
  const message={...prior,id:p.message_id,role:'assistant',content,seq:prior?.seq??Number(p.message_seq??p.seq??0),time:prior?.time??Date.now(),sessionId:p.session_id||'',lastDeltaSeq:Number(p.seq)||0};
  return [...existing.filter(m=>m.id!==message.id),message].sort((a,b)=>(Number(a.seq)||0)-(Number(b.seq)||0)||(Number(a.time)||0)-(Number(b.time)||0));
}
// Presentation only. The backend always parses the original assistant transcript.
function localMessageView(message) {
  let content=message.content||'';
  if(message.role==='user') {
    if(content.startsWith('[Local agent task — sent by the Muse App on the user\'s PC, not typed by the user]')) {
      const at=content.indexOf('\nTask from the user:\n');
      if(at>=0)content=content.slice(at+'\nTask from the user:\n'.length);
    }else if(content.startsWith('[Local tool results — sent by the Muse App, not typed by the user]')) {
      return {content:content.slice(content.indexOf(']')+1).trim(),toolResults:true};
    }
  }else if(message.role==='assistant') {
    content=content.replace(/```local-tool[^\S\r\n]*\r?\n([\s\S]*?)```/g,(block,json)=>{
      try {
        const call=JSON.parse(json);
        if(call.tool==='done')return typeof call.summary==='string'?call.summary:'';
        const labels={run:t('コマンド実行'),read:t('ファイル読み取り'),list:t('フォルダー確認'),write:t('ファイル書き込み'),edit:t('ファイル編集')};
        if(!labels[call.tool])return block;
        const target=String(call.command||call.path||t('作業フォルダー')).replace(/[\r\n`]/g,' ').slice(0,160);
        return t('PC操作: {label} — `{target}`', {label: labels[call.tool], target});
      }catch{return block;}
    });
  }
  return {content,toolResults:false};
}
// The view a send should follow. A new side chat may get its server ID back, but
// the main chat stays '' even though Muse returns its real session ID: main chat
// events and pending state are keyed by ''.
function sessionAfterSend(sentId,result) {
  return sentId&&result?.session_id?result.session_id:sentId;
}
if(typeof module!=='undefined')module.exports={messageFromEvent,mergeMessages,applyDelta,splitAttachments,localMessageView,sessionAfterSend};
