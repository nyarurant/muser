'use strict';
// Shared by the local renderer and tests; never execute markup from Muse.
// Node-only module: callers are src/agent.js, src/transcript.js and
// src/core/agent-reply.js, so i18n is required directly where it is needed
// (this module itself no longer renders any localised text).
function messageFromEvent(event) {
  const p=event.payload||event;
  const name=event.event_name||event.event||'';
  const role=event.role||p.role||(name==='message.user'?'user':name==='message.assistant'?'assistant':null);
  const visibility=event.visibility||p.visibility;
  if(visibility && visibility!=='public') return null;
  if(!['user','assistant'].includes(role)) return null;
  let content=event.display_text??p.display_text??p.content??p.text;
  if(typeof content!=='string')return null;
  // An assistant message's trailing [usage] line is live-event bookkeeping, not
  // reply text: it must never reach the screen, the transcript or /resume.
  // (User messages are left alone: a user quoting such a line typed it.)
  if(role==='assistant')content=require('../turn-usage').strip(content);
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
module.exports={messageFromEvent,splitAttachments};
