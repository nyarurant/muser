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
  // Content can arrive as parts (audit c17 #20): an array of part OBJECTS ({type:'text',
  // text} / {text}) is joined like turn-usage.messageText does, instead of dropping the
  // whole message from history, the baseline set and reply detection. A bare array of
  // strings is not that shape and stays rejected (tests/chat-model.test.js pins it).
  if(Array.isArray(content)&&content.length&&content.every(x=>x&&typeof x==='object'&&typeof x.text==='string'))content=content.map(x=>x.text).join('');
  if(typeof content!=='string')return null;
  // An assistant message's trailing [usage] line is live-event bookkeeping, not
  // reply text: it must never reach the screen, the transcript or /resume.
  // (User messages are left alone: a user quoting such a line typed it.)
  if(role==='assistant')content=require('../turn-usage').strip(content);
  // A [usage]-only assistant event strips to '': it is bookkeeping, not a reply. Returning
  // it as a valid empty reply let history rebuild overwrite the real reply with ''
  // (audit c17 #21); agent-reply already treats empty content as no reply.
  if(role==='assistant'&&content==='')return null;
  const id=event.message_id||p.message_id||p.id;
  if(typeof id!=='string'||!id)return null;
  let attachments=[];
  if(role==='user')({text:content,files:attachments}=splitAttachments(content));
  return {id,role,content,seq:Number(event.seq??p.chat_event_seq??p.seq??0),time:event.occurred_at_ms??p.created_at_ms??0,sessionId:p.session_id??event.session_id??'',resources:event.resources||p.resources||[],reaction:typeof event.reaction_emoji==='string'?event.reaction_emoji:null,replyTo:typeof event.reply_to_message_id==='string'?event.reply_to_message_id:null,attachments};
}
// Uploaded attachments come back in the user's text as "[image:image/png workspace/...png]",
// each on its OWN line. A marker-shaped string the user typed inline (asking about the
// format, quoting a log) or inside `code` / a ``` fence is their text, not an upload:
// splitting it out deleted that part of the message from the transcript for good and
// invented a file that does not exist (audit c17 #19). Only a marker that starts a line
// outside code counts.
const ATTACHMENT_MARKER=/\[(image|file|video|audio):([\w.+-]+\/[\w.+-]+) ([^\]\n]+)\]/g;
function splitAttachments(content) {
  const files=[];
  const lines=String(content).split('\n');
  let fenced=false;
  const out=lines.map(line=>{
    if(/^\s*```/.test(line)){fenced=!fenced;return line;}
    if(fenced)return line;
    // A line that is only a marker: take the file and drop the whole line, so the text
    // around it keeps its shape (no blank line left where the upload sat).
    const sole=/^\[(image|file|video|audio):([\w.+-]+\/[\w.+-]+) ([^\]\n]+)\]\s*$/.exec(line);
    if(sole){files.push({kind:sole[1],mime:sole[2],path:sole[3].trim()});return null;}
    // Split the line into code spans (`…`) and plain runs; markers count only in plain runs
    // and only at the very start of the line (the run must be the line's first segment).
    const segs=line.split(/(`[^`]*`)/);
    return segs.map((seg,idx)=>{
      if(seg.startsWith('`')||idx!==0)return seg;
      return seg.replace(ATTACHMENT_MARKER,(m,kind,mime,p,off)=>{
        if(off!==0)return m;
        files.push({kind,mime,path:p.trim()});return '';
      });
    }).join('');
  });
  const text=out.filter(l=>l!==null).join('\n').trim();
  return {text,files};
}
module.exports={messageFromEvent,splitAttachments};
