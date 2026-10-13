/* Shared, explicit read receipts and calendar-day conversation review. */
(function(root){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const statuses=new Map(),versions=new Map(),pending=new Set(),busy=new Set();
 const dateLabel=v=>v?new Date(v).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';
 let context,onChange,onFilter,onRefresh,panel,view={},error='',refreshTimer;
 const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 async function rpc(name,args){const result=await context.client.rpc(name,args);if(result.error)throw result.error;return result.data;}
 function accept(row){if(row?.conversation_id)statuses.set(row.conversation_id,row);}
 function status(id){return statuses.get(id);}
 function acceptConversations(rows=[]){for(const row of rows)if(row.team_read)accept({...status(row.id),...row.team_read});}
 function receipt(row){return row?.read_at?`${row.is_read?'Read':'Previously read'} by ${row.read_by||'Staff member'} · ${dateLabel(row.read_at)} ET`:'';}
 function control(conversation,message=null){
  if(!context||!conversation?.id)return '';
  const summary=status(conversation.id),row=message?summary?.message_states?.find(r=>r.message_id===message.id):summary;
  const label=row?.is_read?'Mark unread':'Mark read',saving=busy.has(conversation.id);
  return `<span class="triage-read-control"><button type="button" class="secondary-btn" data-team-read="${row?.is_read?'unread':'read'}" data-read-conversation="${esc(conversation.id)}" data-read-message="${esc(message?.id||'')}" data-read-latest="${esc(conversation.latest_message_id||'')}" ${saving?'disabled':''}>${saving?'Saving…':label}</button>${receipt(row)?`<small>${esc(receipt(row))}</small>`:''}<small data-read-error="${esc(conversation.id)}" role="status"></small></span>`;
 }
 function conversationSummary(conversation){
  if(!context||!conversation)return '';
  return `<div class="triage-read-summary">${control(conversation)}<button type="button" class="secondary-btn" data-read-history="${esc(conversation.id)}">Read history</button><span data-read-error="${esc(conversation.id)}" role="status"></span></div>`;
 }
 async function observe(conversations=[]){
  if(!context)return;
  const changed=conversations.filter(c=>!pending.has(c.id)&&versions.get(c.id)!==`${c.latest_message_id||''}:${c.latest_message_created_at||''}:${c.message_count||''}`);
  if(!changed.length)return;
  const ids=changed.map(c=>c.id),markers=new Map(changed.map(c=>[c.id,`${c.latest_message_id||''}:${c.latest_message_created_at||''}:${c.message_count||''}`]));
  ids.forEach(id=>{pending.add(id);versions.set(id,markers.get(id));});
  try{const rows=await rpc('get_ebay_team_read_status',{_conversation_ids:ids});for(const row of rows||[])if(versions.get(row.conversation_id)===markers.get(row.conversation_id))accept(row);onChange();}
  catch(e){error=e.message||'Could not load team read status.';}
  finally{ids.forEach(id=>pending.delete(id));if(ids.some(id=>versions.get(id)!==markers.get(id)))onChange();}
 }
 async function mark(conversation,readState,messageId=null){
  if(!context||!conversation?.id||busy.has(conversation.id))return;
  busy.add(conversation.id);onChange();
  try{
   const row=await rpc('set_ebay_team_read_state',{_conversation_id:conversation.id,_read_state:readState,_message_id:messageId||null,_latest_message_id:conversation.latest_message_id||null});
   // Invalidate pending reads so an older response cannot undo this action.
   versions.delete(conversation.id);accept(row);error='';
   onRefresh();
  }catch(e){
   error=e.message||'Could not save read status. Please retry.';
  }finally{
   busy.delete(conversation.id);onChange();
   document.querySelectorAll('[data-read-error]').forEach(el=>{if(el.dataset.readError===conversation.id)el.textContent=error;});
  }
 }
 function renderFilters(next){
  view=next;if(!panel)return;
  const day=view.ebayConversationActivityDate||'',readState=view.ebayConversationTeamReadState||'all';
  const counts=view.ebayConversationReadCounts,loading=view.ebayConversationLoading;
  const input=panel.querySelector('[data-read-date]');if(input.value!==day)input.value=day;
  panel.querySelector('[data-read-all-dates]').setAttribute('aria-pressed',String(!day));
  panel.querySelector('[data-read-today]').setAttribute('aria-pressed',String(day===today()));
  panel.querySelectorAll('[data-read-filter]').forEach(button=>{
   button.setAttribute('aria-pressed',String(readState===button.dataset.readFilter));
   button.querySelector('b').textContent=loading||view.ebayConversationError||!counts?'—':Number(counts[button.dataset.readFilter]||0).toLocaleString();
  });
  panel.setAttribute('aria-busy',String(!!loading));
  const notice=panel.querySelector('[data-read-results]');
  notice.hidden=!view.ebayConversationError;
  notice.textContent=view.ebayConversationError?'Could not load messages and counts. Use Refresh to retry.':'';
 }
 function chooseDate(day){onFilter({ebayConversationActivityDate:day||null});}
 async function history(id,offset=0){
  const host=document.getElementById('triage-read-history-root');
  host.innerHTML='<div class="triage-read-history" role="dialog" aria-modal="true" aria-label="Read history"><div><button type="button" class="secondary-btn" data-read-history-close>Close read history</button><h3>Read history</h3><p data-history-body role="status">Loading…</p></div></div>';
  host.querySelector('button').focus();
  try{
   const rows=await rpc('get_ebay_read_history',{_conversation_id:id,_offset:offset});
   const body=host.querySelector('[data-history-body]');if(!body)return;
   body.innerHTML=(rows||[]).map(r=>`<span class="triage-read-history-row"><b>${esc(r.actor_name)}</b> marked ${r.is_read?'read':'unread'} · ${esc(dateLabel(r.created_at))} ET<small>${esc(r.subject||r.message_body_preview||'Message')}</small></span>`).join('')||'No recorded read actions yet.';
   if(offset>0)body.insertAdjacentHTML('beforeend',`<button type="button" class="secondary-btn" data-history-page="${Math.max(0,offset-50)}" data-history-id="${esc(id)}">Newer actions</button>`);
   if(rows?.length===50)body.insertAdjacentHTML('beforeend',`<button type="button" class="secondary-btn" data-history-page="${offset+50}" data-history-id="${esc(id)}">Older actions</button>`);
  }catch(e){const body=host.querySelector('[data-history-body]');if(body)body.textContent=e.message||'Could not load read history.';}
 }
 function invalidate(){versions.clear();onChange();onRefresh();}
 function scheduleRefresh(){root.clearTimeout(refreshTimer);refreshTimer=root.setTimeout(invalidate,250);}
 function init(options){
  context=options.context;onChange=options.onChange;onFilter=options.onFilter;onRefresh=options.onRefresh;
  panel=document.getElementById('triage-read-tracking');
  panel.addEventListener('change',e=>{if(e.target.matches('[data-read-date]'))chooseDate(e.target.value);});
  document.addEventListener('click',e=>{
   const button=e.target.closest('button');if(!button)return;
   if(button.hasAttribute('data-team-read')){e.preventDefault();e.stopPropagation();mark({id:button.dataset.readConversation,latest_message_id:button.dataset.readLatest},button.dataset.teamRead,button.dataset.readMessage);return;}
   if(button.hasAttribute('data-read-history')){history(button.dataset.readHistory);return;}
   if(button.hasAttribute('data-history-page')){history(button.dataset.historyId,Number(button.dataset.historyPage));return;}
   if(button.hasAttribute('data-read-history-close')){document.getElementById('triage-read-history-root').replaceChildren();return;}
   if(!panel.contains(button))return;
   if(button.hasAttribute('data-read-day')){const d=new Date((view.ebayConversationActivityDate||today())+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+Number(button.dataset.readDay));chooseDate(d.toISOString().slice(0,10));}
   if(button.hasAttribute('data-read-filter'))onFilter({ebayConversationTeamReadState:button.dataset.readFilter});
   if(button.hasAttribute('data-read-today'))chooseDate(today());
   if(button.hasAttribute('data-read-all-dates'))chooseDate(null);
  });
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.querySelector('.triage-read-history')){document.getElementById('triage-read-history-root').replaceChildren();e.preventDefault();}});
 }
 root.EmailTriageReadTracking={init,observe,status,control,conversationSummary,mark,invalidate,scheduleRefresh,renderFilters,acceptConversations};
})(window);
