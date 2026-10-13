/* Shared, explicit read receipts and calendar-day conversation review. */
(function(root){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const statuses=new Map(),versions=new Map(),pending=new Set(),busy=new Set();
 const dateLabel=v=>v?new Date(v).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';
 let context,onChange,onOpen,panel,day,state='all',offset=0,total=0,requestVersion=0,lastPayload=null,error='',loading=false,refreshTimer;
 const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 async function rpc(name,args){const result=await context.client.rpc(name,args);if(result.error)throw result.error;return result.data;}
 function accept(row){if(row?.conversation_id)statuses.set(row.conversation_id,row);}
 function status(id){return statuses.get(id);}
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
  catch(e){error=e.message||'Could not load team read status.';renderPanel();}
  finally{ids.forEach(id=>pending.delete(id));if(ids.some(id=>versions.get(id)!==markers.get(id)))onChange();}
 }
 async function mark(conversation,readState,messageId=null){
  if(!context||!conversation?.id||busy.has(conversation.id))return;
  busy.add(conversation.id);onChange();
  try{
   const row=await rpc('set_ebay_team_read_state',{_conversation_id:conversation.id,_read_state:readState,_message_id:messageId||null,_latest_message_id:conversation.latest_message_id||null});
   // Invalidate pending reads so an older response cannot undo this action.
   versions.delete(conversation.id);accept(row);error='';
   if(panel.open)await loadDay();
  }catch(e){
   error=e.message||'Could not save read status. Please retry.';
  }finally{
   busy.delete(conversation.id);onChange();renderPanel();
   document.querySelectorAll('[data-read-error]').forEach(el=>{if(el.dataset.readError===conversation.id)el.textContent=error;});
  }
 }
 function renderPanel(){
  if(!panel)return;
  const host=panel.querySelector('[data-read-results]');
  if(error){host.innerHTML=`<p class="classification-notice is-error" role="status">${esc(error)}</p><button type="button" class="secondary-btn" data-read-refresh>Retry</button>`;return;}
  if(loading){host.innerHTML='<p role="status">Loading daily counts…</p>';return;}
  if(!lastPayload)return;
  const counts=lastPayload.counts||{};
  host.innerHTML=`<div class="triage-read-counts" aria-label="Daily read counts">${['all','unread','read'].map(key=>`<button type="button" data-read-filter="${key}" aria-pressed="${state===key}">${key==='all'?'All conversations':key==='read'?'Read':'Unread'} <b>${Number(counts[key]||0)}</b></button>`).join('')}</div>
   <div class="triage-read-day-list">${(lastPayload.rows||[]).map(row=>`<div class="triage-read-day-row"><button type="button" data-read-open="${esc(row.id)}"><strong>${esc(row.other_party_username||row.conversation_title||'eBay notification')}</strong><span>${esc(row.latest_message_preview||row.conversation_title||'Open conversation')}</span><small>${esc(dateLabel(row.activity_at))} ET · ${row.is_read?'Read':'Unread'}${row.read_at?` · ${esc(receipt(row))}`:''}</small></button>${control({...row,id:row.id})}</div>`).join('')||'<p>No conversations for this date and read filter.</p>'}</div>
   <div class="triage-read-pagination"><button type="button" class="secondary-btn" data-read-page="-1" ${offset===0?'disabled':''}>Previous page</button><span>${total?`${offset+1}–${Math.min(offset+30,total)} of ${total}`:'0 conversations'}</span><button type="button" class="secondary-btn" data-read-page="1" ${offset+30>=total?'disabled':''}>Next page</button></div>`;
 }
 async function loadDay(){
  if(!context)return;
  const version=++requestVersion;loading=true;error='';renderPanel();
  try{
   const data=await rpc('get_ebay_daily_read_activity',{_date:day,_state:state,_offset:offset,_limit:30});
   if(version!==requestVersion)return;
   lastPayload=data;total=Number(data.total||0);
   if(offset>0&&offset>=total){offset=Math.max(0,Math.floor((total-1)/30)*30);return loadDay();}
   for(const row of data.rows||[])accept({...status(row.id),conversation_id:row.id,is_read:row.is_read,read_by:row.read_by,read_at:row.read_at});
   onChange();
  }catch(e){if(version===requestVersion)error=e.message||'Could not load daily read counts.';}
  finally{if(version===requestVersion){loading=false;renderPanel();}}
 }
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
 function invalidate(){versions.clear();onChange();if(panel?.open)loadDay();}
 function scheduleRefresh(){root.clearTimeout(refreshTimer);refreshTimer=root.setTimeout(invalidate,250);}
 function init(options){
  context=options.context;onChange=options.onChange;onOpen=options.onOpen;
  panel=document.getElementById('triage-read-tracking');day=today();
  panel.querySelector('[data-read-date]').value=day;
  panel.addEventListener('toggle',()=>{if(panel.open)loadDay();});
  panel.addEventListener('change',e=>{if(e.target.matches('[data-read-date]')&&e.target.value){day=e.target.value;offset=0;loadDay();}});
  document.addEventListener('click',e=>{
   const button=e.target.closest('button');if(!button)return;
   if(button.hasAttribute('data-team-read')){e.preventDefault();e.stopPropagation();mark({id:button.dataset.readConversation,latest_message_id:button.dataset.readLatest},button.dataset.teamRead,button.dataset.readMessage);return;}
   if(button.hasAttribute('data-read-open')){onOpen(button.dataset.readOpen).catch(e=>{error=e.message;renderPanel();});return;}
   if(button.hasAttribute('data-read-history')){history(button.dataset.readHistory);return;}
   if(button.hasAttribute('data-history-page')){history(button.dataset.historyId,Number(button.dataset.historyPage));return;}
   if(button.hasAttribute('data-read-history-close')){document.getElementById('triage-read-history-root').replaceChildren();return;}
   if(!panel.contains(button))return;
   if(button.hasAttribute('data-read-day')){const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+Number(button.dataset.readDay));day=d.toISOString().slice(0,10);panel.querySelector('[data-read-date]').value=day;offset=0;loadDay();}
   if(button.hasAttribute('data-read-filter')){state=button.dataset.readFilter;offset=0;loadDay();}
   if(button.hasAttribute('data-read-page')){offset=Math.max(0,offset+Number(button.dataset.readPage)*30);loadDay();}
   if(button.hasAttribute('data-read-refresh'))invalidate();
  });
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.querySelector('.triage-read-history')){document.getElementById('triage-read-history-root').replaceChildren();e.preventDefault();}});
  const timer=root.setInterval(()=>{if(document.visibilityState!=='hidden')invalidate();},60000);
  root.addEventListener('beforeunload',()=>root.clearInterval(timer),{once:true});
 }
 root.EmailTriageReadTracking={init,observe,status,control,conversationSummary,mark,invalidate,scheduleRefresh};
})(window);
