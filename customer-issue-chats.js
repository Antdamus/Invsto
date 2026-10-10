/* Read-only, batched buyer-chat shortcuts. The messaging workspace owns replies/read state. */
(function(root){
 'use strict';
 const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const records=new Map();let db,cases=[],sequence=0,failed=false,timer,channel;
 const icon='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-8 8H4l-2 2v-10a9 9 0 0 1 18 0Z"/><path d="M7 9h8M7 13h5"/></svg>';
 function href(c,row){
  const p=new URLSearchParams({ebayBuyer:c.buyer_username||'',from:'issues',caseId:c.id});
  if(row?.conversation_id)p.set('ebayConversationDbId',row.conversation_id);
  else if(row?.order_line_id)p.set('orderLineId',row.order_line_id);
  return 'email-triage.html?'+p;
 }
 function html(c,row,{unavailable=false}={}){
  if(!c.buyer_username&&!row?.conversation_id&&!row?.order_line_id)return '';
  const found=Number(row?.conversation_count)>0,unread=Number(row?.unread_count)>0,buyer=row?.match_scope==='buyer';
  const label=found?(buyer?'Buyer chat':'Order chat'):'Find buyer chat';
  const when=row?.latest_buyer_message_at&&!Number.isNaN(Date.parse(row.latest_buyer_message_at))?new Date(row.latest_buyer_message_at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';
  const meta=unavailable?'Chat updates unavailable · open to check':!row?'Checking saved chats…':found?(buyer?'Same buyer · check the item':row.match_scope==='item'?'Linked to this item':'Linked to this order'):'No saved chat found yet';
  return `<a class="issue-chat-link ${unread?'has-unread':''} ${found?'has-chat':'is-empty'}" href="${escape(href(c,row))}" target="_blank" rel="noopener" aria-label="${escape(label+' for '+(c.buyer_username||'this case')+(unread?', unread buyer message':''))}">${icon}<span class="issue-chat-copy"><span class="issue-chat-title"><strong>${label}${Number(row?.conversation_count)>1?' · '+Number(row.conversation_count):''}</strong>${unread?'<b class="issue-chat-unread">Unread</b>':''}<span aria-hidden="true">↗</span></span><small>${escape(meta)}${when?' · '+escape(when):''}</small>${found&&row.latest_buyer_preview?`<span class="issue-chat-preview">${escape(row.latest_buyer_preview)}</span>`:''}</span></a>`;
 }
 function slot(c){return `<div class="issue-chat-slot" data-case-chat="${escape(c.id)}" data-chat-buyer="${escape(c.buyer_username||'')}">${html(c,records.get(c.id),{unavailable:failed})}</div>`;}
 function paint(){
  document.querySelectorAll('[data-case-chat]').forEach(el=>{
   const content=html({id:el.dataset.caseChat,buyer_username:el.dataset.chatBuyer},records.get(el.dataset.caseChat),{unavailable:failed});
   if(el.innerHTML!==content)el.innerHTML=content;
  });
 }
 async function load(current=cases){
  cases=current;const ids=[...new Set([...cases.map(c=>c.id),...Array.from(document.querySelectorAll('[data-case-chat]'),el=>el.dataset.caseChat)])].slice(0,60),request=++sequence;
  if(!db||!ids.length)return;
  try{const {data,error}=await db.rpc('customer_issue_chat_markers',{_case_ids:ids});if(error)throw error;
   if(request!==sequence)return;failed=false;ids.forEach(id=>records.delete(id));(data||[]).forEach(row=>records.set(row.case_id,row));paint();
  }catch{if(request===sequence){failed=true;paint();}}
 }
 function schedule(){if(document.hidden)return;clearTimeout(timer);timer=setTimeout(()=>load(),700);}
 function init(client){
  db=client;
  if(db.channel){channel=db.channel('customer-issue-chats');for(const table of ['ebay_conversations','ebay_conversation_messages','ebay_conversation_links','ebay_conversation_user_read_states'])channel.on('postgres_changes',{event:'*',schema:'public',table},schedule);channel.subscribe();}
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)load();});
  root.addEventListener('pagehide',()=>{clearTimeout(timer);if(channel)db.removeChannel(channel);});
 }
 root.OGIssueChats={init,load,slot,testing:{href,html}};
})(globalThis);
