/* Customer Issues: a case workspace over the shared order, evidence and task system. */
(function(root){
 'use strict';
 const $=id=>document.getElementById(id),escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const finish=new Set(['resolved','cancelled','closed','approved_by_admin']);
 const nice=v=>v==='received_no_restock'?'Received · not added to inventory':String(v||'Not reported').replace(/_/g,' ').toLowerCase().replace(/^./,x=>x.toUpperCase());
 const date=v=>v&&!Number.isNaN(Date.parse(v))?new Date(v).toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}):'Not provided';
 const kind=c=>['request','return','dispute'].includes(c.issue_kind)?c.issue_kind:'request';
 const closed=c=>/(^|_)(CLOSED|CANCELLED|CANCELED|RESOLVED|SELLER_WON|SELLER_LOST|DISPUTE_REVERSED)($|_)/i.test(c.ebay_status||'');
 const safeUrl=value=>{try{const u=new URL(value,location.href);return ['https:','http:'].includes(u.protocol)?u.href:'';}catch{return '';}};
 function escalatedData(c){
  if(c.source_lane!=='case')return null;
  for(const d of [c.raw_payload?.ebayDetail,c.provider_case])if(d?.caseId&&String(d.caseId)===String(c.ebay_return_id))return d;
  return null;
 }
 function escalatedBadge(c){
  if(c.source_lane!=='case'||closed(c))return null;
  const status=String(c.ebay_status||'').toUpperCase(),d=escalatedData(c);
  if(status==='REFUND_AGREED_BUT_FAILED')return {kind:'action',label:'Refund failed · review required'};
  if(status==='ACTION_NEEDED')return {kind:'action',label:'eBay case · response required'};
  if(status==='ON_HOLD'||d?.caseContentOnHold===true)return {kind:'partial',label:'eBay case · on hold'};
  if(status==='WAITING_DELIVERY')return {kind:'case_waiting',label:'eBay case · awaiting delivery'};
  const noSteps=Array.isArray(d?.nextSteps)&&d.nextSteps.length===0;
  const noDue=!c.ebay_due_at&&(!d?.sellerResponseDue||Object.keys(d.sellerResponseDue).length===0);
  // OPEN alone does not establish who acts next. Require eBay's explicit
  // empty nextSteps before saying the seller has no response to make.
  if((status==='OPEN'&&noSteps||status==='WAITING_CS'&&(!d?.nextSteps||noSteps))&&noDue&&!c.ebay_action)return {kind:'reviewing',label:'eBay reviewing · no response needed'};
  if(status==='OPEN'||status==='WAITING_CS')return {kind:'case_open',label:'eBay case opened'};
  return {kind:'case_open',label:'eBay case · check status'};
 }
 const cardKind=c=>c.source_lane==='case'?'eBay case':kind(c)==='request'?'Customer request':kind(c)==='return'?'Physical return':'Dispute';
 let ctx,db,ready=false,view='attention',scope='all',sort='newest',returnStage='all',search='',offset=0,total=0,rows=[],counts={},people=[],selected=null,detail=null,version=0,listVersion=0,timer,poll,saving=false,syncing=false;
 const PAGE=30;
 const BULK_LIMIT=60;
 let selecting=false,bulkSelection=new Map(),bulkReview=[],bulkReviewVersion=0;
 let listReturnPosition=null,bulkReturnPosition=null;
 const listContext=()=>JSON.stringify([view,scope,sort,search,view==='return'?returnStage:'all']);
 function captureListPosition(id){
  const cards=Array.from($('issues-list').querySelectorAll('[data-case]'));
  const card=cards.find(el=>el.dataset.case===id)||cards.find(el=>el.getBoundingClientRect().bottom>80);
  const index=Math.max(0,rows.findIndex(c=>c.id===card?.dataset.case));
  const visibleTop=Math.max(root.matchMedia('(max-width:900px)').matches?76:16,($('issues-bulk-toolbar')?.getBoundingClientRect().bottom||0)+8);
  return {context:listContext(),index,ids:[...rows.slice(index),...rows.slice(0,index).reverse()].map(c=>c.id),top:Math.max(visibleTop,card?.getBoundingClientRect().top??visibleTop),x:root.scrollX,y:root.scrollY};
 }
 function restoreListPosition(position){
  if(!position||position.context!==listContext())return;
  const cards=Array.from($('issues-list').querySelectorAll('[data-case]'));
  const card=position.ids.map(id=>cards.find(el=>el.dataset.case===id)).find(Boolean)||cards[Math.min(position.index,cards.length-1)];
  // Keep the next surviving card where the closed case was, even when the
  // preceding rows disappeared or the last page became empty.
  root.scrollTo({left:position.x,top:card?root.scrollY+card.getBoundingClientRect().top-position.top:position.y,behavior:'instant'});
  card?.focus({preventScroll:true});
 }
 async function continueAfterClose(ids,position){
  const removed=new Set(ids);rows=rows.filter(c=>!removed.has(c.id));
  ids.forEach(id=>bulkSelection.delete(id));
  closeCase();
  await refresh({detail:false});
  restoreListPosition(position);
 }
 function closeBlock(c,items=[]){
  if(!c)return 'Case could not be loaded. Refresh and try again.';
  if(['closed','cancelled'].includes(c.status)&&!Number(c.open_tasks))return 'Already saved in History';
  if(c.ebay_return_id&&!closed(c))return 'Still open on eBay';
  if(items.some(i=>Number(i.received_quantity)>Number(i.restocked_quantity)&&!['received_no_restock','damaged','refund_only'].includes(i.disposition)))return 'Returned items still need inspection';
  return '';
 }
 // One guarded transaction per case: a stale or ineligible case cannot stop the
 // others, and an uncertain network result is never automatically retried.
 async function runCloseBatch(entries,close,onResult=()=>{}){
  const results=[],seen=new Set();
  for(const entry of entries){
   if(entry.blocked||seen.has(entry.c.id))continue;
   seen.add(entry.c.id);let result;
   try{const data=await close(entry);result={id:entry.c.id,ok:true,data};}
   catch(error){result={id:entry.c.id,ok:false,error:error.message||'Could not confirm closure. Refresh before retrying.'};}
   results.push(result);onResult(result,results.length);
  }
  return results;
 }
 const sortLabels={newest:'Newest cases',oldest:'Oldest cases',order_newest:'Newest orders',order_oldest:'Oldest orders',due_soonest:'eBay deadline: soonest',due_latest:'eBay deadline: latest',value_highest:'Value: high to low',value_lowest:'Value: low to high'};
 const money=c=>{if(c.item_value==null||!Number.isFinite(Number(c.item_value)))return 'Not available';try{return new Intl.NumberFormat(undefined,{style:'currency',currency:c.item_currency||'USD'}).format(Number(c.item_value));}catch{return `${c.item_currency||''} ${Number(c.item_value).toFixed(2)}`;}};
 function lineFacts(lines){
  const currencies=new Set(lines.map(l=>l.raw_payload?.line?.total?.currency||l.raw_payload?.line?.lineItemCost?.currency||'USD'));
  const order=lines[0]?.order||lines[0]?.ebay_orders;
  return {order_placed_at:(Array.isArray(order)?order[0]:order)?.sale_date,item_currency:currencies.size===1?[...currencies][0]:null,linked_line_count:lines.length,
   item_value:lines.length&&currencies.size===1&&lines.every(l=>Number(l.sold_for)>0)?lines.reduce((sum,l)=>sum+Number(l.sold_for)*Number(l.quantity),0):null};
 }
 function cardFacts(c){return `<div class="issue-card-facts"><div><small>${c.linked_line_count>1?'Linked items value':'Item value'}</small><strong>${escape(money(c))}</strong></div><div><small>Order placed</small><span>${escape(c.order_placed_at?new Date(c.order_placed_at).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}):'Not provided')}</span></div></div><div class="issue-card-opened">Case opened ${escape(date(c.opened_at))}</div>`;}
 function customerContact(c){
  const text=v=>typeof v==='string'?v.trim():'',name=text(c.customer_name),recipient=text(c.shipping_name),a=c.shipping_address||{};
  const cityState=[text(a.city),text(a.state)].filter(Boolean).join(', '),locality=[cityState,text(a.postal_code)].filter(Boolean).join(' ');
  const address=[text(a.line1),text(a.line2),locality,text(a.country)].filter(Boolean);
  const customer=`<div class="issue-customer-name"><small>Customer</small><strong>${escape(name||'Name not saved')}</strong></div>`;
  if(kind(c)!=='return')return customer;
  return customer+`<div class="issue-customer-address"><small>Original shipping address</small>${address.length?`${recipient&&recipient.toLowerCase()!==name.toLowerCase()?`<span class="issue-address-recipient">Recipient: ${escape(recipient)}</span>`:''}${address.map(line=>`<span>${escape(line)}</span>`).join('')}`:`<span class="issue-contact-missing">${c.order_id?'Address not saved with this order':'Link the original order to see the address'}</span>`}</div>`;
 }
 function conversationRows(data){return root.OGIssueEvidence.conversation(data).map(m=>({...m,when:m.sent_at}));}
 function renderConversation(){
  const target=$('issue-conversation');if(!target||!detail?.originalEvidence)return;
  const data=detail.originalEvidence,messages=conversationRows(data),limit=detail.conversationLimit||5;
  const system=messages.filter(m=>m.provider_actor==='SYSTEM'),visible=messages.filter(m=>m.provider_actor!=='SYSTEM');
  const truncated=(data.case_messages||[]).length>500||(data.buyer_messages||[]).length>500||(data.case_history||[]).length>500;
  target.innerHTML=`<div class="issue-conversation-heading"><h3>Conversation <span>${visible.length}${truncated?'+':''}</span></h3><small>Latest first</small></div><p class="issue-subtitle">Messages linked to this case or its original order/item.</p>`+
   (visible.length?visible.slice(0,limit).map(m=>`<article class="issue-chat-message ${m.entry_type==='event'?'is-event':m.direction==='outbound'?'is-outbound':''}"><header><b>${escape(m.entry_type==='event'?'Case update':m.sender_username||(m.direction==='outbound'?'Our reply':detail.c.buyer_username||'Buyer'))}</b><small>${escape(m.channel)} · ${escape(date(m.when))}</small></header><p>${escape(m.message_body||'Message has no saved text. Open Buyer chat to review attachments.')}</p></article>`).join(''):'<p class="issue-subtitle">No linked conversation has been saved yet. Use Buyer chat or Open eBay case to check for other messages.</p>')+
   (visible.length>limit?`<button type="button" class="secondary-btn" data-more-messages>Show older messages (${visible.length-limit} more)</button>`:'')+
   (system.length?`<details class="issue-system-history"><summary>eBay system activity (${system.length})</summary>${system.map(m=>`<div class="issue-chat-message is-event"><small>${escape(date(m.when))}</small><p>${escape(m.message_body)}</p></div>`).join('')}</details>`:'')+
   (truncated?'<p class="issue-subtitle">More history may be available in Buyer chat or the eBay case.</p>':'');
 }

 const checked=r=>{if(r.error)throw r.error;return r.data;};
 const person=id=>id===ctx?.user?.id?'You':people.find(p=>p.user_id===id)?.display_name||people.find(p=>p.user_id===id)?.email||'Needs an owner';
 const taskLink=t=>`team-tasks.html?taskId=${encodeURIComponent(t.id)}`;
 function feedback(message,error=false){$('issues-feedback').textContent=message;$('issues-feedback').classList.toggle('is-error',error);}
 const returnStages={
  requested:{label:'Return requested',tone:'action'},
  awaiting_shipment:{label:'Awaiting buyer shipment',tone:'waiting'},
  in_transit:{label:'In transit · eBay',tone:'transit'},
  delivered:{label:'Delivered · eBay',tone:'action'},
  received:{label:'Received in Invsto',tone:'received'},
  partially_received:{label:'Partially received · Invsto',tone:'action'},
  needs_review:{label:'Received · needs review',tone:'action'},
  unknown:{label:'Shipment not reported',tone:'unknown'}
 };
 function returnBadge(c){
  if(kind(c)!=='return')return '';
  const stage=returnStages[c.return_stage]||returnStages.unknown;
  const refund=({refunded:{label:'Refunded · eBay',tone:'received'},partial:{label:'Partially refunded · eBay',tone:'waiting'},pending:{label:'Refund pending · eBay',tone:'waiting'},failed:{label:'Refund failed · eBay',tone:'action'}})[c.return_refund];
  const issued=['refunded','partial'].includes(c.return_refund),stamp=issued&&typeof c.return_refunded_at==='string'&&!Number.isNaN(Date.parse(c.return_refunded_at))?new Date(c.return_refunded_at):null;
  const refundDate=issued?(stamp?`<time class="issue-refund-date" datetime="${escape(stamp.toISOString())}" title="${escape('Refund issued '+date(c.return_refunded_at))}">${escape(stamp.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}))}</time>`:'<span class="issue-refund-date">Date not provided</span>'):'';
  return `<span class="issue-tag issue-return-badge is-${stage.tone}">${escape(stage.label)}</span>`+(refund?`<span class="issue-tag issue-return-badge issue-refund-badge is-${refund.tone}"><span>${escape(refund.label)}</span>${refundDate}</span>`:'');
 }
 function nextText(c){
  if(['closed','cancelled'].includes(c.status)&&!c.open_tasks)return 'Closed · saved in History';
  if(!c.order_id)return 'Match the order';
  if(c.status==='needs_review'&&kind(c)==='return')return 'Inspect returned items';
  if(c.status==='needs_review')return 'Review the customer request';
  if(c.status==='partially_received'&&kind(c)==='return')return 'Check the remaining items';
  if(closed(c)&&c.open_tasks)return 'Finish internal follow-up';
  if(closed(c))return 'Review the case outcome';
  if(kind(c)==='return'&&c.return_refund==='failed')return 'Review the failed refund on eBay';
  if(c.source_lane==='case')return escalatedBadge(c)?.kind==='reviewing'?'Waiting for eBay’s decision':escalatedBadge(c)?.label==='eBay case opened'?'Review the eBay case':escalatedBadge(c)?.label||'Review the eBay case';
  if(c.source_lane==='payment_dispute'&&c.ebay_status==='ACTION_NEEDED')return 'Respond to the payment dispute';
  if(root.OGDisputeResponse?.badge(c)?.kind==='waiting')return 'Response submitted · awaiting outcome';
  if(root.OGDisputeResponse?.badge(c)?.kind==='protected')return 'Awaiting outcome';
  if(root.OGDisputeResponse?.badge(c)?.kind==='no_response')return 'No response needed · awaiting outcome';
  if(c.source_lane==='payment_dispute'&&c.ebay_status==='OPEN')return 'Monitor payment-dispute updates';
  if(kind(c)==='return'&&c.return_stage==='delivered')return 'Confirm receipt and inspect the returned items';
  if(kind(c)==='return'&&c.return_stage==='received')return 'Receipt saved · review the remaining case work';
  if(kind(c)==='return'&&c.return_stage==='awaiting_shipment')return 'Waiting for the buyer to ship';
  if(kind(c)==='return'&&c.return_stage==='in_transit')return 'Watch for the returned package';
  if(kind(c)==='return'&&c.return_refund==='refunded')return 'Refund saved · review the remaining case work';
  if(kind(c)==='return'&&c.return_refund==='pending')return 'Waiting for refund confirmation';
  if(kind(c)==='return'&&/READY_FOR_SHIPPING|ITEM_READY_TO_SHIP/.test(c.ebay_status||''))return 'Waiting for the buyer to ship';
  if(kind(c)==='return'&&/^(ITEM_SHIPPED|RETURN_SHIPPED)$/.test(c.ebay_status||''))return 'Watch for the returned package';
  if(/WAITING.*BUYER|BUYER_RESPONSE/i.test(c.ebay_status||''))return 'Waiting on the buyer';
  if(c.ebay_action&&!/^\d{4}-\d{2}-\d{2}T/i.test(c.ebay_action))return nice(c.ebay_action);
  return c.next_user?'Continue assigned work':'Choose the next person';
 }
 function providerBadge(c){return root.OGDisputeResponse?.badge(c)||escalatedBadge(c)||(closed(c)?{kind:'closed',label:'Closed on eBay'}:null);}
 function providerBadgeHtml(c){
  const badge=providerBadge(c),protection=root.OGDisputeResponse?.protection(c);
  return (badge?`<span class="issue-tag issue-response-badge is-${badge.kind}">${escape(badge.label)}</span>`:'')+
   (protection&&badge?.kind!=='protected'&&badge?.kind!=='action'?`<span class="issue-tag issue-response-badge is-${protection.kind}">${escape(protection.label)}</span>`:'');
 }
 function cardStatus(c){
  const badge=providerBadge(c),next=nextText(c);
  const state=providerBadgeHtml(c);
  const nextTag=badge&&(next===badge.label||next==='Respond to the payment dispute'||badge.kind==='reviewing'&&next==='Waiting for eBay’s decision')?'':`<span class="issue-tag">${escape(next)}</span>`;
  const deadline=['waiting','protected','no_response','reviewing'].includes(badge?.kind)||closed(c)?'':c.ebay_due_at?`<span class="issue-tag ${c.overdue?'is-overdue':''}">${c.overdue?'eBay deadline overdue':'eBay deadline'} ${escape(date(c.ebay_due_at))}</span>`:'<span class="issue-tag">eBay deadline not provided</span>';
  return returnBadge(c)+state+nextTag+deadline;
 }
 function cards(){
  $('issues-list').innerHTML=rows.length?rows.map(c=>`<div class="issue-card-row ${selecting?'is-selecting':''} ${bulkSelection.has(c.id)?'is-checked':''}">${selecting?`<label class="issue-select"><input type="checkbox" data-select-case="${escape(c.id)}" aria-label="Select ${escape(c.buyer_username||'buyer')}, case ${escape(c.ebay_return_id||c.id)}" ${bulkSelection.has(c.id)?'checked':''} ${closeBlock(c)?'disabled':''}/><span>${escape(closeBlock(c)||'Select case')}</span></label>`:''}<button type="button" class="issue-card" data-case="${escape(c.id)}" aria-current="${selected===c.id}">
   <div class="issue-card-top"><span class="issue-kind is-${kind(c)}">${cardKind(c)}</span><small>${escape(c.order_number||`Case ${c.ebay_return_id||'not linked'}`)}</small></div>
   <h2>${escape(c.buyer_username||'Buyer not identified')}</h2>${customerContact(c)}<p>${escape(c.item_title||c.return_reason||'Open this case to review the order and next step.')}</p>
   ${cardFacts(c)}
   <div class="issue-card-footer">${cardStatus(c)}</div>
   <div class="issue-card-top" style="margin:11px 0 0"><small>${['closed','cancelled'].includes(c.status)&&!c.open_tasks?'Saved record':c.watching_tasks===c.open_tasks&&c.watching_tasks?'Following eBay updates':escape(person(c.next_user))}${c.open_tasks>Number(c.watching_tasks||0)?` · ${c.open_tasks-Number(c.watching_tasks||0)} active task${c.open_tasks-Number(c.watching_tasks||0)===1?'':'s'}`:''}</small>${c.stale||c.sync_error?'<span class="issue-tag is-stale">Needs refresh</span>':''}</div></button>${root.OGCaseNotes?.card(c)||''}</div>`).join(''):
   `<div class="issues-empty"><h2>${search?'No matching cases':'You’re caught up here'}</h2><p>${search?'Try the customer name, buyer username, order number, case ID or return tracking.':'Choose another view or responsibility filter to see other work.'}</p></div>`;
  $('issues-count').textContent=`${total} ${view==='history'?'finished':'active'} case${total===1?'':'s'}`;
  $('issues-return-filter').hidden=view!=='return';
  $('issues-sort-caption').textContent=sortLabels[sort]+(sort.startsWith('value_')?' · grouped by currency':'');
  $('issues-page').textContent=total?`${offset+1}–${Math.min(offset+PAGE,total)} of ${total}`:'0 cases';
  $('issues-prev').disabled=offset===0;$('issues-next').disabled=offset+PAGE>=total;
  document.querySelectorAll('[data-issue-view]').forEach(b=>{b.setAttribute('aria-pressed',String(b.dataset.issueView===view));b.querySelector('b').textContent=counts[b.dataset.issueView]??'–';});
  bulkToolbar();
 }
 function bulkToolbar(){
  const bar=$('issues-bulk-toolbar');if(!bar)return;
  bar.hidden=ctx.employee.role!=='admin'||view==='history';
  bar.innerHTML=selecting?`<div class="issue-bulk-top"><strong aria-live="polite">${bulkSelection.size} selected</strong><button type="button" class="secondary-btn" data-bulk-done>Done selecting</button></div><div class="issue-bulk-actions"><button type="button" class="secondary-btn" data-bulk-page>Select eligible on this page</button><button type="button" class="secondary-btn" data-bulk-clear ${bulkSelection.size?'':'disabled'}>Clear</button><button type="button" class="primary-btn" data-bulk-review ${bulkSelection.size?'':'disabled'}>Mark selected closed (${bulkSelection.size})</button></div><p>Up to ${BULK_LIMIT} cases across pages. Only resolved cases can be closed.</p>`:'<button type="button" class="secondary-btn" data-bulk-start>Select cases</button>';
 }
 function clearBulk(){selecting=false;bulkSelection.clear();bulkToolbar();}
 function closeBulkDialog(){if(saving)return;bulkReviewVersion++;$('issues-bulk-dialog').close();restoreListPosition(bulkReturnPosition);bulkReturnPosition=null;}
 function bulkReviewRows(){
  return bulkReview.map((entry,index)=>`<li><strong>${escape(entry.c.buyer_username||'Buyer not identified')}</strong><span>${escape(entry.c.order_number||'Order not linked')} · Case ${escape(entry.c.ebay_return_id||'internal')}</span><p>${escape(entry.c.item_title||'')}</p><p id="bulk-case-result-${index}" class="${entry.blocked?'issue-form-error':'issue-subtitle'}">${escape(entry.blocked?'Stays open: '+entry.blocked:`Ready · ${entry.tasks.length} follow-up${entry.tasks.length===1?'':'s'} will also close`)}</p>${entry.tasks.length?`<details><summary>Review follow-ups (${entry.tasks.length})</summary>${entry.tasks.map(t=>`<p>${escape(t.title||'Follow-up')} · ${escape(person(t.assigned_to_user_id))} · ${escape(nice(t.status))}</p>`).join('')}</details>`:''}</li>`).join('');
 }
 async function reviewBulk(){
  if(ctx.employee.role!=='admin'||!bulkSelection.size||saving)return;
  clearTimeout(timer);const token=++bulkReviewVersion,cases=[...bulkSelection.values()];bulkReview=[];
  bulkReturnPosition=captureListPosition();
  const dialog=$('issues-bulk-dialog');
  dialog.innerHTML='<h2 id="issues-bulk-title">Review selected cases</h2><p role="status">Checking current case status and follow-ups…</p><button type="button" class="secondary-btn" data-bulk-cancel>Cancel</button>';
  dialog.showModal();
  // Bounded reads keep large selections from flooding the database.
  for(let start=0;start<cases.length;start+=4){
   const group=await Promise.all(cases.slice(start,start+4).map(async summary=>{
    try{
     const [c,tasks,items]=await Promise.all([
      db.from('ebay_return_cases').select('id,order_number,buyer_username,item_title,ebay_return_id,ebay_status,status,updated_at').eq('id',summary.id).single(),
      db.from('ebay_return_tasks').select('id,title,status,assigned_to_user_id,updated_at').eq('return_case_id',summary.id),
      db.from('ebay_return_items').select('received_quantity,restocked_quantity,disposition').eq('return_case_id',summary.id)
     ]).then(rs=>rs.map(checked));
     const active=tasks.filter(t=>!finish.has(t.status));
     return {c:{...c,open_tasks:active.length},tasks:active,blocked:closeBlock({...c,open_tasks:active.length},items)};
    }catch(error){return {c:summary,tasks:[],blocked:error.message||'Could not check this case. Refresh and retry.'};}
   }));
   if(token!==bulkReviewVersion)return;bulkReview.push(...group);
  }
  const eligible=bulkReview.filter(e=>!e.blocked),followups=eligible.reduce((n,e)=>n+e.tasks.length,0);
  dialog.innerHTML=`<form id="issues-bulk-form" class="issue-form"><h2 id="issues-bulk-title">Close ${eligible.length} case${eligible.length===1?'':'s'} & move to History</h2><p>${eligible.length} ready${bulkReview.length>eligible.length?` · ${bulkReview.length-eligible.length} will stay open`:''}. ${followups} remaining follow-up${followups===1?'':'s'} will also close. No new assignments.</p><ul class="issue-bulk-review-list">${bulkReviewRows()}</ul>${eligible.length?'<label class="issue-close-confirm"><input name="confirmed" type="checkbox" required /><span>These cases are resolved; no further follow-up is needed.</span></label><label>Closing note for all selected cases (optional)<textarea name="note" maxlength="10000" placeholder="Anything useful for the saved records"></textarea></label>':''}<p class="issue-subtitle">Photos, messages and activity stay in History. This does not issue refunds, close cases on eBay or change inventory.</p><p id="issue-bulk-progress" role="status" aria-live="polite"></p><div class="issue-bulk-footer">${eligible.length?`<button type="submit" class="primary-btn">Close ${eligible.length} case${eligible.length===1?'':'s'}</button>`:''}<button type="button" class="secondary-btn" data-bulk-cancel>Cancel</button></div></form>`;
  $('issues-bulk-form').onsubmit=async e=>{
   e.preventDefault();if(saving)return;
   const values=new FormData(e.currentTarget);if(values.get('confirmed')!=='on')return;
   saving=true;dialog.querySelectorAll('button,input,textarea').forEach(el=>el.disabled=true);
   const progress=$('issue-bulk-progress');progress.textContent=`Closing 0 of ${eligible.length}… Keep this page open.`;
   const completedIds=[];
   try{
    const results=await runCloseBatch(eligible,entry=>db.rpc('close_resolved_customer_issue',{
     _case_id:entry.c.id,_expected_updated_at:entry.c.updated_at,_expected_tasks:entry.tasks.map(t=>({id:t.id,updated_at:t.updated_at})),_confirmed:true,_note:values.get('note')||null
    }).then(checked),(result,count)=>{
     const index=bulkReview.findIndex(e=>e.c.id===result.id),target=$('bulk-case-result-'+index);
     target.textContent=result.ok?'Closed · saved in History':'Not confirmed: '+result.error;
     target.classList.toggle('issue-form-error',!result.ok);
     if(result.ok){bulkSelection.delete(result.id);completedIds.push(result.id);}
     progress.textContent=`Checked ${count} of ${eligible.length}… Keep this page open.`;
    });
    const completed=results.filter(r=>r.ok).length,failed=results.length-completed;
    $('issues-bulk-title').textContent='Bulk close results';
    $('issues-bulk-title').nextElementSibling.textContent='Review the result for each selected case below.';
    dialog.querySelectorAll('label').forEach(el=>el.remove());
    progress.textContent=`${completed} case${completed===1?'':'s'} saved in History.${failed?` ${failed} could not be confirmed; review the reasons above and refresh before retrying.`:''}${bulkReview.length>eligible.length?` ${bulkReview.length-eligible.length} skipped.`:''}`;
    dialog.querySelector('.issue-bulk-footer').innerHTML='<button type="button" class="primary-btn" data-bulk-cancel>Done</button><button type="button" class="secondary-btn" data-bulk-history>View History</button>';
    feedback(progress.textContent,!!failed);
   }finally{
    saving=false;
    if(!bulkSelection.size)selecting=false;
    await continueAfterClose(completedIds,bulkReturnPosition);
   }
  };
 }
 async function refresh(options={}){
  const request=++listVersion;$('issues-list').setAttribute('aria-busy','true');
  try{
   const result=checked(await db.rpc('list_customer_issues',{_view:view,_scope:scope,_search:search,_offset:offset,_limit:PAGE,_sort:sort,_return_stage:view==='return'?returnStage:'all'}));
   if(request!==listVersion)return;
   rows=result.rows||[];counts=result.counts||{};total=result.total||0;
   if(offset>0&&offset>=total){offset=Math.max(0,Math.floor((total-1)/PAGE)*PAGE);return refresh(options);}
   await root.OGCaseNotes?.load(rows.map(c=>c.id));if(request!==listVersion)return;
   cards();
   if($('issues-feedback').classList.contains('is-error'))feedback('');
   const selectedChanged=detail&&rows.some(c=>c.id===selected&&c.updated_at!==detail.c.updated_at);
   if(!root.OGCaseNotes?.isEditing&&(options.detail!==false||selectedChanged)&&selected&&!$('issue-action-form')&&!ctx.state.busy&&!$('issue-evidence-package')?.dataset.ready)await openCase(selected,{quiet:true});
  }catch(error){if(request===listVersion)feedback(error.message||'Could not load customer issues. Please retry.',true);}
  finally{if(request===listVersion)$('issues-list').setAttribute('aria-busy','false');}
 }
 async function health(){
  try{
   const result=checked(await db.rpc('customer_issue_sync_health'));const lanes=result.lanes||[];
   const problems=result.problems||[],broken=lanes.filter(l=>['needs_access','error'].includes(l.status));
   const stale=lanes.some(l=>!l.last_progress_at&&!l.last_success_at||Date.parse(l.last_progress_at||l.last_success_at)<Date.now()-20*60000);
   const summary=$('issues-health-summary');summary.classList.toggle('is-warning',!!problems.length||!!broken.length||stale);
   summary.textContent=problems.length?'eBay updates need attention · view recovery steps':broken.length?'An eBay update failed · automatic retries active'
    :result.queued||result.retrying?`Updating in the background · ${result.queued} queued${result.urgent?` · ${result.urgent} prioritized`:''}${result.retrying?` · ${result.retrying} retrying`:''}`
    :stale?'eBay data needs a refresh · details':'eBay connected · background updates active';
   const labels={worker:'Customer issues',return:'Returns',inquiry:'Customer requests',case:'Escalated cases',payment_dispute:'Payment disputes'};
   const access=problems.some(p=>p.reason==='access')||lanes.some(l=>l.status==='needs_access');
   let connect='';try{const url=new URL(root.SUPABASE_URL);if(/^https:$/.test(url.protocol)&&/^[a-z0-9]+\.supabase\.co$/.test(url.hostname))connect=`https://${url.hostname.split('.')[0]}.functions.supabase.co/ebay-oauth-callback`;}catch{}
   const guidance={access:'eBay authorization needs attention. Reconnect eBay and save the replacement refresh token before retrying.',failures:'Updates have failed repeatedly. Inspect the errors below, correct the reported problem, then retry.',stalled:'No recent sync progress. Retry sync; if it remains stalled, check the scheduled worker in Supabase.',backlog:'Some updates have waited over 30 minutes. Urgent cases are prioritized while the queue catches up.'};
   $('issues-health-detail').innerHTML=
    (problems.length?`<section class="issue-sync-recovery"><h3>Restore automatic updates</h3>${problems.map(p=>`<p><b>${escape(labels[p.monitor_key]||p.monitor_key)}</b>${escape(guidance[p.reason]||'Check the latest sync status.')}</p>`).join('')}
     ${ctx.employee.role==='admin'?`<div class="issue-sync-actions">${access&&connect?`<a class="secondary-btn" href="${escape(connect)}" target="_blank" rel="noopener">Reconnect eBay ↗</a>`:''}<button class="primary-btn" data-retry-sync ${syncing?'disabled':''}>Retry sync</button></div>`:'<p>Ask an administrator to restore the eBay connection.</p>'}<p class="issue-subtitle">The warning clears after successful recovery. Existing case information stays available.</p></section>`:'')+
    `<p><b>Background worker</b>Last completed: ${escape(date(result.worker?.last_finished_at))}<br>New changes and urgent response deadlines are checked before routine work. Older retries retain a share of each batch.</p>`+
    lanes.map(l=>`<p><b>${labels[l.lane]||escape(l.lane)}</b>${l.status==='needs_access'?'eBay authorization is needed for this feed.':escape(l.error||nice(l.status))}<br>Last progress: ${escape(date(l.last_progress_at||l.last_success_at))}</p>`).join('')+
    '<p>Each case keeps its last successful information while failed updates retry.</p>'+
    (result.failures?.length?`<section class="issue-sync-retries"><h3>Updates needing attention</h3>${result.failures.map(f=>`<article><b>${escape(labels[f.lane]||f.lane)} · ${escape(f.external_id)}</b>${f.failure_kind==='access'?'Check the eBay connection.':f.failure_kind==='review'?'Verify this case on eBay; it may need a manual correction.':'Temporary failure; an automatic retry is scheduled.'} Attempt ${escape(f.attempts)}. Next check: ${escape(date(f.next_attempt_at))}${f.case_id?` <button class="secondary-btn" data-case="${escape(f.case_id)}">Inspect case</button>`:''}<details><summary>Error details</summary>${escape(f.last_error||'No error details')}</details></article>`).join('')}</section>`:'');
  }catch(error){$('issues-health-summary').textContent='Connection status unavailable · refresh to retry';$('issues-health-summary').classList.add('is-warning');}
 }
 async function sync(caseId){
  if(syncing)return;syncing=true;$('issues-sync').disabled=true;document.querySelectorAll('[data-retry-sync]').forEach(b=>b.disabled=true);
  feedback('Queuing a background refresh…');
  try{const result=checked(await db.functions.invoke('ebay-return-sync',{body:{action:'refresh',...(caseId?{caseId}:{})}}));feedback(result.message||'Refresh queued. You can keep working.');await health();}
  catch(error){feedback(error.message||'Could not queue the refresh.',true);}
  finally{syncing=false;$('issues-sync').disabled=false;document.querySelectorAll('[data-retry-sync]').forEach(b=>b.disabled=false);}
 }
 function actions(task){
  const next=root.OGTaskWorkflow.next(task,people),mine=next.userId===ctx.user.id;
  if(next.kind==='monitoring')return '<span class="issue-subtitle">No seller response requested. A new request from eBay brings this back automatically.</span>';
  const participant=ctx.employee.role==='admin'||[task.assigned_to_user_id,task.created_by,task.assigned_by].includes(ctx.user.id);
  let buttons=participant&&!(mine&&next.kind==='approval'&&task.status!=='completed_by_employee')?`<button class="secondary-btn" data-task-action="update" data-task="${task.id}">Add update / hand back</button>`:'';
  if(mine&&next.kind==='work')buttons+=`<button class="primary-btn" data-task-action="complete" data-task="${task.id}">Complete my part</button>`;
  if(mine&&next.kind==='approval')buttons+=task.status==='completed_by_employee'
   ?`<button class="primary-btn" data-task-action="accept" data-task="${task.id}">Accept completed work</button><button class="secondary-btn" data-task-action="return" data-task="${task.id}">Request changes</button>`
   :`<button class="primary-btn" data-task-action="instructions" data-task="${task.id}">Update / give instructions</button><button class="secondary-btn" data-task-action="decide" data-task="${task.id}">Decision finishes this task</button>`;
  if(mine&&task.task_type==='return_review'&&detail.c.source_lane==='payment_dispute'&&detail.c.ebay_status==='OPEN'&&task.status!=='completed_by_employee')buttons=`<button class="primary-btn" data-follow-task="${task.id}">Reviewed · follow updates</button>`+buttons;
  return buttons;
 }
 function renderTasks(){
  const tasks=detail.tasks.filter(t=>!finish.has(t.status));
  if(!tasks.length&&['closed','cancelled'].includes(detail.c.status))return '<section class="issue-detail-section"><h3>Case closed</h3><p class="issue-subtitle">No further work is assigned. Photos, messages and the closing record remain available below.</p><div id="issue-form-slot"></div></section>';
  return `<section class="issue-detail-section"><h3>Who acts next</h3>${tasks.length?tasks.map(t=>`<div class="issue-task"><strong>${escape(root.OGTaskWorkflow.label(t,people,ctx.user.id))}</strong><p>${escape(t.question||t.title||'Review this case')}</p>
   <span class="issue-tag">${escape(nice(t.status))}</span>${t.due_at?` <span class="issue-tag">Internal follow-up: ${escape(date(t.due_at))}</span>`:''}
   <div class="issue-actions">${actions(t)}<a class="secondary-btn" href="${taskLink(t)}">Full task</a>${ctx.employee.role==='admin'?`<button class="secondary-btn" data-assign="${t.id}">Assign next step</button>`:''}</div></div>`).join(''):'<p class="issue-subtitle">No open internal task. Assign work or a decision if someone needs to act.</p>'}
   ${ctx.employee.role==='admin'||(kind(detail.c)==='return'&&!['closed','cancelled'].includes(detail.c.status))?'<button class="secondary-btn" data-assign="">Create a task</button>':''}<div id="issue-form-slot"></div></section>`;
 }
 function caseHref(c){
  const id=encodeURIComponent(String(c.ebay_return_id||'').trim());
  if(c.source_lane==='return'&&id)return `https://www.ebay.com/rtn/Return/ReturnsDetail?returnId=${id}`;
  if(c.source_lane==='inquiry'&&id)return `https://www.ebay.com/res/ItemNotReceived/ViewRequest?id=${id}`;
  if(c.source_lane==='payment_dispute'&&id)return `https://pmtdispute.ebay.com/dispute/${id}`;
  if(c.source_lane==='case'&&id&&escalatedData(c)?.caseType==='RETURN')return `https://www.ebay.com/ReturnCase/${id}`;
  const raw=c.raw_payload||{},url=safeUrl(raw.detailsUrl||raw.apiExtractedDetails?.detailsUrl||'');
  if(url){const u=new URL(url);if(/(^|\.)ebay\.com$/.test(u.hostname)&&!/(ViewItem|\/itm\/)/i.test(url))return url;}
  return c.order_number?`https://www.ebay.com/mesh/ord/details?orderid=${encodeURIComponent(c.order_number)}`:'';
 }
 function caseLinkLabel(c,url){
  if(c.source_lane==='payment_dispute'&&url.startsWith('https://pmtdispute.ebay.com/dispute/'))return 'Open eBay dispute';
  if(c.source_lane==='case'&&url.startsWith('https://www.ebay.com/ReturnCase/'))return 'Open eBay case';
  return c.source_lane==='case'||c.source_lane==='payment_dispute'?'Open eBay order / case':'Open eBay case';
 }
 function renderDetail(){
  if(!detail||detail.c.id!==selected)return;
  const {c,tasks,items,lines,events}=detail,summary=rows.find(r=>r.id===c.id)||{...c,...lineFacts(lines),open_tasks:tasks.filter(t=>!finish.has(t.status)).length};
  const primary={...(tasks.find(t=>!finish.has(t.status))||{id:'',metadata:c.raw_payload}),order_line_ids:lines.map(l=>l.id),ebay_return_cases:c};
  const provider=root.OGIssueEvidence.providerContext(c),overrides={};
  if(provider.buyerComment)overrides.buyerComment=provider.buyerComment;
  if(provider.requestAmount)overrides.requestAmount=provider.requestAmount;
  primary.ebay_return_cases={...c,raw_payload:{...c.raw_payload,...overrides}};
  const receipt=ctx.renderReceipt(primary),complaint=ctx.renderComplaint(primary,{compact:true});
  const url=caseHref(c),remaining=items.some(i=>i.received_quantity<i.expected_quantity)||!items.length;
  const reason=c.source_lane==='inquiry'?'Item not received':/^(CLOSED|OPEN|WAITING_.*)$/i.test(c.return_reason||'')?'No customer reason captured':nice(c.return_reason);
  $('issues-detail').innerHTML=`<div class="issue-detail-bar"><button type="button" class="secondary-btn issue-back" data-close-case>← Cases</button><span>${escape(c.ebay_return_id?`Case ${c.ebay_return_id}`:'Internal return')}</span>${c.ebay_return_id?'<button type="button" class="secondary-btn" data-sync-case>Refresh case</button>':''}</div>
   <div class="issue-detail-content"><span class="issue-kind is-${kind(c)}">${kind(c)==='dispute'?(c.source_lane==='payment_dispute'?'Payment dispute':'Escalated eBay case'):nice(kind(c))}</span><h2>${escape(c.buyer_username||'Buyer not identified')}</h2><p class="issue-subtitle">${escape(c.item_title||summary.item_title||lines[0]?.item_title||'Review the linked order items below')}</p>
   <section class="issue-original-order"><div><small>ORIGINAL ORDER</small><strong>${escape(c.order_number||'Not identified yet')}</strong><span>${c.order_id?`${lines.length} linked item${lines.length===1?'':'s'} · Saved in Invsto`:c.order_number?'Not found in saved orders yet':'Match the original order to see its evidence'}</span></div>${c.order_number?`<a class="secondary-btn" href="ebay-order-history.html?orderHistorySearch=${encodeURIComponent(c.order_number)}&historyAllDates=true">Open full order ↗</a>`:''}</section>
   ${kind(c)==='return'&&summary.return_stage?`<div class="issue-return-summary">${returnBadge(summary)}<small>eBay delivery is separate from receipt and inspection in Invsto.</small></div>`:''}
   <section id="issue-case-notes" class="issue-case-notes">${root.OGCaseNotes?.section(c)||''}</section>
   <div class="issue-next">${providerBadge(c)?`<div class="issue-provider-outcome">${providerBadgeHtml(c)}</div>`:''}<span>NEXT STEP</span><strong>${escape(nextText({...summary,raw_payload:c.raw_payload}))}</strong><p>${['closed','cancelled'].includes(c.status)&&!summary.open_tasks?'This record is saved in History. Its evidence and activity are preserved.':closed(c)?'eBay has closed its case. Keep it here while internal work remains, or finish and archive it when everything is handled.':providerBadge(c)?.kind==='reviewing'?'eBay is reviewing this escalated case. No response is currently requested. Keep it open until eBay decides the outcome; any internal work remains separate.':['protected','no_response'].includes(providerBadge(c)?.kind)?'No response is currently requested by eBay. This dispute is still awaiting an outcome; updates continue automatically. Any internal tasks remain separate.':'Keep the case open until the customer issue and your internal work are both handled.'}</p></div>
   ${ctx.employee.role==='admin'&&(closed(c)||!c.ebay_return_id)&&(!['closed','cancelled'].includes(c.status)||tasks.some(t=>!finish.has(t.status)))?'<section class="issue-closeout"><div><strong>All internal work finished?</strong><p>Save the case and its evidence in History. No new task is needed.</p></div><button type="button" class="primary-btn" data-finish-case>Finish &amp; archive</button></section>':''}<div id="issue-close-form-slot"></div>
   <div class="issue-facts"><div><small>Item value</small><b>${escape(money(summary))}</b></div><div><small>Order placed</small><b>${escape(summary.order_placed_at?new Date(summary.order_placed_at).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}):'Not provided')}</b></div><div><small>eBay status</small><b>${escape(root.OGDisputeResponse?.response(c)?.waiting?'Open · response submitted':nice(c.ebay_status))}</b></div><div><small>eBay deadline</small><b>${escape(closed(c)||['waiting','protected','no_response','reviewing'].includes(providerBadge(c)?.kind)?'No current response deadline':date(c.ebay_due_at))}</b></div></div>
   <p class="issue-review-meta">Opened ${escape(date(c.opened_at))}<br>Last eBay update ${escape(date(c.synced_at))} · Internal status: ${escape(nice(c.status))}</p>
   ${c.sync_error?`<p class="issue-tag is-stale">Update failed. The previous case information was kept. ${escape(c.sync_error)}</p>`:''}
   <div class="issue-actions">${c.issue_kind==='return'&&remaining&&lines.some(l=>l.line_status==='fulfilled')&&!['closed','cancelled'].includes(c.status)?'<button class="primary-btn" data-receive>Receive returned items</button>':''}
    ${url?`<a class="secondary-btn" href="${escape(url)}" target="_blank" rel="noopener">${caseLinkLabel(c,url)} ↗</a>`:''}
    ${lines[0]||c.buyer_username?`<a class="secondary-btn" href="email-triage.html?${lines[0]?'orderLineId='+encodeURIComponent(lines[0].id):'ebayBuyer='+encodeURIComponent(c.buyer_username)}&from=returns" target="_blank" rel="noopener">Buyer chat ↗</a>`:''}
    ${!lines.length&&ctx.employee.role==='admin'?'<button class="primary-btn" data-match-order>Match order items</button>':''}</div>
   ${root.OGDisputeResponse?.section(c)||''}
   <section class="issue-detail-section issue-complaint-summary"><h3>Complaint &amp; conversation</h3><p class="issue-complaint-reason"><small>Customer’s reason</small><strong>${escape(reason)}</strong></p>${complaint||'<p class="issue-subtitle">No additional complaint details saved.</p>'}<div id="issue-conversation" aria-live="polite"><p class="issue-subtitle">Loading related conversation…</p></div></section>
   ${renderTasks()}
   <details class="issue-detail-section" open><summary>Order items &amp; saved photos</summary>${receipt||'<p class="issue-subtitle">No item screenshot is saved yet.</p>'}${lines.map(l=>`<div class="issue-line"><strong>${escape(l.item_title)}</strong><p>${escape(l.item_number||'')} · Order qty ${l.quantity||0} · Fulfilled ${l.fulfilled_quantity||0}</p></div>`).join('')}
    ${items.map(i=>`<div class="issue-line"><strong>${escape(i.item_title)}</strong><p>Received ${i.received_quantity} of ${i.expected_quantity} · Restocked ${i.restocked_quantity||0} · ${escape(nice(i.disposition))}</p>${i.received_quantity>i.restocked_quantity&&!['closed','cancelled'].includes(c.status)?`<button class="secondary-btn" data-inspect="${i.id}">Inspect received item</button>`:''}</div>`).join('')}
    <div id="issue-original-evidence"><p class="issue-subtitle">Loading saved order evidence…</p></div><h3 style="margin-top:20px">Return evidence</h3><div id="issue-return-evidence" class="issues-evidence-grid"></div></details>
   <details class="issue-detail-section issue-evidence-package"><summary>Evidence package</summary><p class="issue-subtitle">Gather item photos, packing evidence, tracking, certificates and messages. Choose what belongs in the download.</p><button class="secondary-btn" data-prepare-evidence>Prepare evidence</button><div id="issue-evidence-package"></div></details>
   <details class="issue-detail-section"><summary>Money &amp; payment</summary><p>Case amount: <strong>${escape(provider.requestAmount||c.raw_payload?.apiExtractedDetails?.requestAmount||c.raw_payload?.requestAmount||c.raw_payload?.refundText||'Not provided by eBay')}</strong></p>${ctx.financeBadge?.(primary)||''}<p class="issue-subtitle">Payment information updates separately in the background. The case amount is not confirmation that a refund was issued. Check eBay before making a financial decision.</p></details>
   <details class="issue-detail-section"><summary>Activity &amp; internal updates</summary>${events.length?events.map(e=>`<div class="issue-update"><small>${escape(date(e.created_at))} · ${escape(e.signed_by_email||'eBay / system')}</small><p>${escape(e.notes||nice(e.action))}</p></div>`).join(''):'<p class="issue-subtitle">No recorded updates yet.</p>'}${detail.moreEvents?'<p class="issue-subtitle">Showing the latest 50 events from each source. Open Full task for its complete work history.</p>':''}</details>
   </div>`;
  ctx.bindReceipt($('issues-detail'));ctx.hydrateReceipts().catch(()=>{});
  loadEvidence(version);loadOriginalEvidence(version);
  root.OGDisputeResponse?.hydrate({c,db,target:$('issue-dispute-response')});
 }
 async function loadEvidence(stamp){
  const photos=[],seen=new Set();
  detail.events.forEach(e=>(e.evidence_photos||e.photo_attachments||[]).forEach(p=>{const bucket=p.bucket||p.storage_bucket||'ebay-return-evidence',path=p.path||p.storage_path;if(path&&!seen.has(bucket+path)){seen.add(bucket+path);photos.push({...p,bucket,path});}}));
  const target=$('issue-return-evidence');if(!photos.length){target.innerHTML='<p class="issue-subtitle">No return photos or videos received yet.</p>';return;}
  target.innerHTML=photos.map((p,i)=>`<button class="issue-media" type="button" data-media="${i}"><span>Loading ${/video|mp4|mov|webm/i.test(p.mime_type||p.path)?'video':'photo'}…</span></button>`).join('');
  detail.photos=photos;
  // Small batches avoid signing hundreds of evidence files in parallel.
  for(let at=0;at<photos.length;at+=4){await Promise.all(photos.slice(at,at+4).map(async(p,index)=>{
   const video=/video|\.(mp4|mov|webm|m4v)$/i.test(p.mime_type||p.path),url=await ctx.signEvidence(p,{thumbnail:!video});
   if(stamp!==version)return;const b=target.querySelector(`[data-media="${at+index}"]`);if(!b)return;
   b.setAttribute('aria-label',video?'Play video':'View full photo');
   b.innerHTML=url?`${video?'<span style="font-size:32px;padding:45px 20px">▶</span>':`<img loading="lazy" src="${escape(url)}" alt="Returned item evidence" />`}<span>${video?'Play video':'View full photo'}</span>`:'<span>Preview unavailable · tap to retry</span>';
  }));if(stamp!==version)return;}
 }
 async function loadOriginalEvidence(stamp){
  const target=$('issue-original-evidence');
  try{
   const data=checked(await db.rpc('customer_issue_evidence',{_case_id:detail.c.id}));if(stamp!==version||!target.isConnected)return;
   detail.originalEvidence=data;detail.originalLimits={};renderConversation();
   const receipts=ctx.evidenceReceipts?ctx.evidenceReceipts(detail.lines):[],shown=new Set(receipts.map(p=>`${p.bucket||p.storage_bucket}:${p.path||p.storage_path}`));
   detail.originalFiles=root.OGIssueEvidence.collect(data).filter(p=>p.group!=='returned'&&!shown.has(`${p.bucket}:${p.path}`));
   await renderOriginalEvidence(stamp);
  }catch(error){if(stamp===version&&target.isConnected){target.innerHTML=`<p class="issue-form-error">Saved order evidence could not load: ${escape(error.message)}. Refresh this case to retry.</p>`;if($('issue-conversation'))$('issue-conversation').innerHTML='<p class="issue-form-error">Conversation could not load. Refresh this case to retry.</p>';}}
 }
 async function renderOriginalEvidence(stamp){
  const target=$('issue-original-evidence'),data=detail.originalEvidence,files=detail.originalFiles;
  if(!detail.c.order_id){target.innerHTML='<p class="issue-subtitle">Connect the original order to review its saved item and packaging evidence.</p>';return;}
  const groups={item:'Live bag photos',completion:'Order completion photos',packaging:'Packaging photos & videos',certificate:'Certificate copies'};
  target.innerHTML=`<p class="issue-subtitle">Evidence from original order ${escape(detail.c.order_number)}. Completion and packaging photos may include other items shipped in the same package.</p>`+
   Object.entries(groups).map(([key,title])=>{const found=files.map((p,i)=>({...p,i})).filter(p=>p.group===key),limit=detail.originalLimits[key]||6;
    if(!found.length)return `<p class="issue-evidence-empty"><b>${title}</b> · None saved</p>`;
    return `<section class="issue-original-group"><h3>${title} <small>${found.length}</small></h3>${found.length?`<div class="issues-evidence-grid">${found.slice(0,limit).map(p=>`<button class="issue-media" type="button" data-original-media="${p.i}" aria-label="${escape(p.video?'Play packaging video':p.label)}"><span>Loading ${p.video?'video':'file'}…</span></button>`).join('')}</div>${found.length>limit?`<button class="secondary-btn" data-more-original="${key}">Show ${Math.min(6,found.length-limit)} more</button>`:''}`:'<p class="issue-subtitle">No saved files in this category.</p>'}</section>`;}).join('')+
   (data.certificates||[]).filter(c=>safeUrl(c.certificate_url)).map(c=>`<p><a class="secondary-btn" href="${escape(safeUrl(c.certificate_url))}" target="_blank" rel="noopener">Certificate ${escape(c.report_number||'link')} ↗</a></p>`).join('')+
   (data.packages||[]).map(p=>`<p class="issue-subtitle">Package: ${escape(nice(p.status))}${p.tracking_code?` · Tracking ${escape(p.tracking_code)}`:''}</p>`).join('');
  const buttons=Array.from(target.querySelectorAll('[data-original-media]'));
  for(let at=0;at<buttons.length;at+=4){await Promise.all(buttons.slice(at,at+4).map(async button=>{
   const p=files[Number(button.dataset.originalMedia)],pdf=/pdf/i.test(p.mime_type||p.path),url=await ctx.signEvidence(p,{thumbnail:!p.video&&!pdf}).catch(()=>null);
   if(stamp!==version||!button.isConnected)return;
   const label=`${escape(p.label)}${p.created_at?` · ${escape(date(p.created_at))}`:''}`;
   if(pdf&&url){const a=document.createElement('a');a.className='issue-media';a.href=url;a.target='_blank';a.rel='noopener';a.innerHTML=`<span class="issue-file-symbol">PDF ↗</span><span>${label}</span>`;button.replaceWith(a);}
   else button.innerHTML=url?`${p.video?'<span class="issue-file-symbol">▶ Play video</span>':`<img loading="lazy" src="${escape(url)}" alt="${escape(p.label)}" />`}<span>${label}</span>`:`<span>Preview unavailable · tap to retry</span><span>${label}</span>`;
  }));if(stamp!==version)return;}
 }
 async function originalMedia(index){
  const p=detail?.originalFiles?.[index];if(!p)return;
  try{const url=await ctx.signEvidence(p,{thumbnail:false});if(!url)throw Error('File unavailable');ctx.openEvidence(url,p.label,p.path,p.video?'video':'image');}
  catch{feedback('Could not open this saved file. Please retry.',true);}
 }
 async function openCase(id,{quiet=false}={}){
  const initialForm=$('issue-action-form');
  const scroll=quiet?$('issues-detail').scrollTop:0,conversationLimit=quiet?detail?.conversationLimit:undefined;
  const expanded=quiet?new Set(Array.from($('issues-detail').querySelectorAll('details[open]>summary'),el=>el.textContent)):null;
  if(saving)return;if(!quiet&&selected!==id)listReturnPosition=captureListPosition(id);selected=id;const stamp=++version;document.querySelector('.issues-columns').classList.add('is-selected');cards();
  if(!quiet)$('issues-detail').innerHTML='<div class="issues-empty">Loading the case and its evidence…</div>';
  try{
   const [c,tasks,items,caseEvents]=await Promise.all([
    db.from('ebay_return_cases').select('*').eq('id',id).single(),db.from('ebay_return_tasks').select('*').eq('return_case_id',id).order('created_at',{ascending:false}),
    db.from('ebay_return_items').select('*').eq('return_case_id',id),db.from('ebay_return_events').select('*').eq('return_case_id',id).order('created_at',{ascending:false}).limit(50)
   ]).then(rs=>rs.map(checked));
   if(stamp!==version)return;
   const ids=[...new Set([...tasks.flatMap(t=>t.order_line_ids||[]),...items.map(i=>i.order_line_id),...(c.raw_payload?.manualOrderMatch?.line_ids||c.raw_payload?.automaticOrderMatch?.line_ids||[])])].filter(Boolean);
   const [rawLines,taskEvents]=await Promise.all([ids.length?db.from('ebay_order_lines').select(ctx.lineSelect).in('id',ids):{data:[]},
    db.from('ebay_return_task_events').select('*').eq('return_case_id',id).order('created_at',{ascending:false}).limit(50)]).then(rs=>rs.map(checked));
   if(stamp!==version)return;
   const lines=rawLines.filter(l=>!l.order_id||l.order_id===c.order_id).map(ctx.normalizeLine);tasks.forEach(t=>t.ebay_return_cases=c);
   const [orderEvents]=await Promise.all([ctx.loadOrderEvents(ids),root.OGCaseNotes?.load([id])]);if(stamp!==version)return;
   ctx.state.returnTasks=tasks;ctx.state.returnTaskLines=new Map(lines.map(l=>[l.id,l]));ctx.state.returnTaskOrderEvents=orderEvents;ctx.state.returnCases=[{...c,ebay_return_items:items}];
   ctx.state.returnTaskEvents=taskEvents;ctx.state.returnAssignees=people;ctx.mergeLines(lines);
   if(tasks[0])await ctx.hydrateComplaint(tasks);
   if(stamp!==version)return;
   if(quiet&&(root.OGCaseNotes?.isEditing||($('issue-action-form')&&$('issue-action-form')!==initialForm)||ctx.state.busy))return;
   detail={c,tasks,items,lines,conversationLimit,events:[...caseEvents,...taskEvents].sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)),moreEvents:caseEvents.length===50||taskEvents.length===50};
   renderDetail();if(expanded)$('issues-detail').querySelectorAll('details').forEach(el=>el.open=expanded.has(el.querySelector('summary')?.textContent));$('issues-detail').scrollTop=scroll;
   const url=new URL(location.href);url.searchParams.delete('returnTaskId');url.searchParams.set('caseId',id);history.replaceState(null,'',url);
  }catch(error){if(stamp===version){$('issues-detail').innerHTML=`<div class="issues-empty"><button class="secondary-btn" data-close-case>← Cases</button><h2>Couldn’t load this case</h2><p>${escape(error.message)}</p><button class="primary-btn" data-retry-case>Retry</button></div>`;}}
 }
 function closeCase(){if(saving)return;version++;selected=null;detail=null;document.querySelector('.issues-columns').classList.remove('is-selected');$('issues-detail').innerHTML='<div class="issues-empty">Choose a case to see its order, evidence and next steps.</div>';const url=new URL(location.href);url.searchParams.delete('caseId');history.replaceState(null,'',url);cards();}
 function form(title,body,submit,slot='issue-form-slot'){
  $('issue-action-form')?.remove();
  $(slot).innerHTML=`<form id="issue-action-form" class="issue-form"><h3>${escape(title)}</h3>${body}<p class="issue-form-error" role="alert"></p><div class="issue-actions"><button class="primary-btn" type="submit">${escape(submit)}</button><button class="secondary-btn" type="button" data-cancel-form>Cancel</button></div></form>`;
  $('issue-action-form').scrollIntoView({block:'nearest'});$('issue-action-form').querySelector('textarea,input,select')?.focus();
 }
 function taskForm(id,action){
  const task=detail.tasks.find(t=>t.id===id);if(!task)return;
  const titles={instructions:'Update or give instructions',update:'Update or hand back',complete:'Complete my part',accept:'Accept completed work',return:'Request changes',decide:'Record your decision'};
  const assignee=task.assigned_by&&task.assigned_by!==ctx.user.id?task.assigned_by:task.created_by;
  const update=action==='update'||action==='instructions';
  form(titles[action],`${update?`<label>What happens next?<select name="mode"><option value="update">Add information · responsibility stays the same</option>${assignee&&assignee!==ctx.user.id?`<option value="work">Ask ${escape(person(assignee))} to do work</option><option value="decision">Ask ${escape(person(assignee))} for a decision</option>`:''}</select></label>`:'<p class="issue-subtitle">Only this task changes. The order and eBay case stay separate.</p>'}<label>Update / instructions<textarea name="note" required maxlength="10000" placeholder="What happened, and what should happen next?"></textarea></label>`,update?'Save update':'Confirm');
  $('issue-action-form').onsubmit=e=>submitForm(e,async f=>{
   if(update)checked(await db.rpc('respond_task_request',{_source:'return',_task_id:task.id,_note:f.get('note'),_mode:f.get('mode'),_expected_assignee:task.assigned_to_user_id||null,_expected_assigner:task.assigned_by||null,_expected_updated_at:task.updated_at,_photos:[]}));
   else if(action==='decide'&&task.task_type==='return_review'&&!task.assigned_to_user_id)checked(await db.rpc('finish_customer_issue_review',{_task_id:task.id,_expected_updated_at:task.updated_at,_note:f.get('note')}));
   else checked(await db.rpc('advance_task_workflow',{_source:'return',_task_id:task.id,_action:action,_note:f.get('note'),_expected_status:task.status,_expected_assignee:task.assigned_to_user_id||null,_expected_updated_at:task.updated_at,_photos:[]}));
  });
 }
 function assignForm(id){
  const task=detail.tasks.find(t=>t.id===id),request=crypto.randomUUID();
  form(task?'Assign the next step':'Create a task',`<label>Person responsible<select name="owner" required><option value="">Choose a person</option>${people.map(p=>`<option value="${p.user_id}" ${p.user_id===task?.assigned_to_user_id?'selected':''}>${escape(p.display_name||p.email)}</option>`).join('')}</select></label><label>They need to<select name="kind"><option value="work">Do work</option><option value="decision">Make a decision / give instructions</option></select></label><label>Instructions<textarea name="note" required maxlength="10000">${escape(task?.question||'')}</textarea></label><label>Internal follow-up (optional)<input type="datetime-local" name="followup" /></label>`,'Assign task');
  $('issue-action-form').onsubmit=e=>submitForm(e,async f=>checked(await db.rpc(!task&&kind(detail.c)==='return'?'request_customer_return_followup':'assign_customer_issue',{_case_id:selected,...(!task&&kind(detail.c)==='return'?{_request_id:request}:{_task_id:task?.id||null}),_owner:f.get('owner'),_kind:f.get('kind'),_note:f.get('note'),_follow_up:f.get('followup')?new Date(f.get('followup')).toISOString():null})));
 }
 async function submitForm(event,operation,onSaved){
  event.preventDefault();if(saving)return;const el=event.currentTarget;const f=new FormData(el);saving=true;el.querySelectorAll('button').forEach(b=>b.disabled=true);
  try{await operation(f);saving=false;if(onSaved){await onSaved();return;}feedback('Saved. The next step and activity are updated.');await openCase(selected,{quiet:true});await refresh({detail:false});}
  catch(error){el.querySelector('.issue-form-error').textContent=error.message||'Could not save. Your instructions are still here.';}
  finally{saving=false;el.querySelectorAll('button').forEach(b=>b.disabled=false);}
 }
 function closeResolvedForm(){
  const c=detail.c,tasks=detail.tasks.filter(t=>!finish.has(t.status));
  const snapshot=tasks.map(t=>({id:t.id,updated_at:t.updated_at}));
  form('Move to History',`<p class="issue-subtitle"><strong>${escape(c.buyer_username||c.order_number||'This case')}</strong> · ${escape(c.ebay_return_id?'Case '+c.ebay_return_id:'Internal return')}</p><p>Keep all photos, messages and activity in the saved record.</p>${tasks.length?`<p>${tasks.length} remaining follow-up${tasks.length===1?'':'s'} will also be closed. Nobody will receive a new assignment.</p><details class="issue-close-followups"><summary>Review follow-ups (${tasks.length})</summary>${tasks.map(t=>`<p><strong>${escape(t.title||'Follow-up')}</strong><br>${escape(person(t.assigned_to_user_id))} · ${escape(nice(t.status))}</p>`).join('')}</details>`:'<p>No task needs to be created or assigned.</p>'}<label class="issue-close-confirm"><input name="confirmed" type="checkbox" required /><span>Everything is resolved; no further follow-up is needed.</span></label><label>Closing note (optional)<textarea name="note" maxlength="10000" placeholder="Anything useful for the record"></textarea></label><p class="issue-subtitle">This saves the internal closing record. It does not issue a refund or change inventory.</p>`,'Mark closed & move to History','issue-close-form-slot');
  $('issue-action-form').onsubmit=e=>submitForm(e,async f=>checked(await db.rpc('close_resolved_customer_issue',{
   _case_id:c.id,_expected_updated_at:c.updated_at,_expected_tasks:snapshot,_confirmed:f.get('confirmed')==='on',_note:f.get('note')||null
  })),async()=>{
   feedback('Case saved in History. Continue with the remaining cases here.');
   await continueAfterClose([c.id],listReturnPosition);
  });
 }
 function inspectionForm(id){
  const item=detail.items.find(i=>i.id===id),key=crypto.randomUUID();
  form('Inspect received item',`<p class="issue-subtitle">${escape(item.item_title)} · ${item.received_quantity-item.restocked_quantity} units not restocked</p><label>Inspection outcome<select name="outcome"><option value="quarantine">Keep on hold</option><option value="received_no_restock">Inspected, good · received without restocking</option>${item.internal_item_id?'<option value="restock">Inspected and sellable · restock</option>':''}<option value="damaged">Damaged · do not restock</option><option value="wrong_item">Wrong item · needs review</option><option value="admin_review">Needs a decision</option></select></label><p class="issue-subtitle">Received without restocking saves the inspection and evidence. It does not create an inventory item or change stock.</p><label>Restock location code (only for restocking)<input name="location" placeholder="Scan the tray or location code" /></label><label>Inspection notes<textarea name="note" required></textarea></label>`,'Save inspection');
  const note=$('issue-action-form').querySelector('[name="note"]');
  note.closest('label').insertAdjacentHTML('afterend','<div class="inspection-evidence"><label>Inspection photos / videos<input id="inspection-files" type="file" accept="image/*,video/*" multiple /></label><button type="button" class="secondary-btn" id="inspection-camera">Take a photo</button><input id="inspection-camera-file" type="file" accept="image/*" capture="environment" hidden /><p id="inspection-file-summary" class="issue-subtitle">Add close-ups of any damage, the item and its packaging.</p></div>');
  const location=$('issue-action-form').querySelector('[name="location"]');location.id='inspection-location';location.setAttribute('data-camera-scan','');
  const outcome=$('issue-action-form').querySelector('[name="outcome"]');
  const showLocation=()=>{location.closest('label').hidden=outcome.value!=='restock';location.required=outcome.value==='restock';};outcome.onchange=showLocation;showLocation();
  let uploaded=null,uploadedFiles=[];
  $('inspection-camera').onclick=()=>$('inspection-camera-file').click();
  $('inspection-camera-file').onchange=()=>{const dt=new DataTransfer();[...$('inspection-files').files,...$('inspection-camera-file').files].forEach(f=>dt.items.add(f));$('inspection-files').files=dt.files;$('inspection-camera-file').value='';$('inspection-files').dispatchEvent(new Event('change'));};
  $('inspection-files').onchange=()=>{$('inspection-file-summary').textContent=[...$('inspection-files').files].map(f=>f.name).join(' · ')||'No new files selected.';};
  $('issue-action-form').onsubmit=e=>submitForm(e,async f=>{
   let locationId=null;if(f.get('outcome')==='restock'){
    const choices=checked(await db.from('locations').select('id').eq('location_code',String(f.get('location')).trim()).eq('active',true).limit(2));
    if(choices.length!==1)throw Error('Scan one exact active location code.');locationId=choices[0].id;
   }
   const files=[...$('inspection-files').files];
   if(files.length>30||files.some(f=>!ctx.isEvidenceFile(f)))throw Error('Choose up to 30 photos or videos.');
   if(!uploaded||files.length!==uploadedFiles.length||files.some((f,i)=>f!==uploadedFiles[i])){uploaded=await ctx.uploadEvidence(files,[detail.c.order_number]);uploadedFiles=files;}
   checked(await db.rpc('inspect_customer_return',{_request_id:key,_item_id:id,_disposition:f.get('outcome'),_location:locationId,_note:f.get('note'),_evidence:uploaded}));
  });
 }
 async function receive(){
  const ids=detail.lines.filter(l=>l.line_status==='fulfilled'&&(!detail.items.find(i=>i.order_line_id===l.id)||detail.items.some(i=>i.order_line_id===l.id&&i.received_quantity<i.expected_quantity))).map(l=>l.id);
  ctx.openIntake(ids);ctx.state.returnIntakeCaseId=selected;$('return-ebay-id').value=detail.c.ebay_return_id||'';$('return-tracking').value=detail.c.return_tracking_number||'';
  $('return-ebay-id').readOnly=true;
 }
 async function media(index){
  const p=detail?.photos?.[index];if(!p)return;
  const url=await ctx.signEvidence(p,{thumbnail:false});if(!url)return feedback('Could not open this evidence. Please retry.',true);
  ctx.openEvidence(url,p.label||'Return evidence',p.path,/video|\.(mp4|mov|webm|m4v)$/i.test(p.mime_type||p.path)?'video':'image');
 }
 async function init(context){
  ctx=context;db=ctx.supabase;ready=true;
  root.OGReturnReceiving?.init({db,ctx,openCase,feedback});
  try{people=checked(await db.from('employees').select('user_id,email,display_name,role,active').eq('active',true).order('display_name')).filter(p=>p.user_id);}catch{people=[ctx.employee];}
  root.OGCaseNotes?.init({db,people,userId:ctx.user.id});
  $('issues-workspace').addEventListener('click',e=>{
   const b=e.target.closest('button');if(!b||saving)return;
   if(b.dataset.issueView){clearBulk();view=b.dataset.issueView;offset=0;closeCase();refresh({detail:false});}
   else if(b.hasAttribute('data-bulk-start')&&ctx.employee.role==='admin'){selecting=true;closeCase();cards();}
   else if(b.hasAttribute('data-bulk-done')){clearBulk();cards();}
   else if(b.hasAttribute('data-bulk-clear')){bulkSelection.clear();cards();}
   else if(b.hasAttribute('data-bulk-page')){for(const c of rows){if(!closeBlock(c)&&bulkSelection.size<BULK_LIMIT)bulkSelection.set(c.id,c);}cards();}
   else if(b.hasAttribute('data-bulk-review'))reviewBulk();
   else if(b.hasAttribute('data-bulk-cancel'))closeBulkDialog();
   else if(b.hasAttribute('data-bulk-history')){closeBulkDialog();clearBulk();clearTimeout(timer);view='history';scope='all';search='';offset=0;$('issues-search').value='';$('issues-scope').value='all';closeCase();refresh({detail:false});}
   else if(b.dataset.case)openCase(b.dataset.case);
   else if(b.hasAttribute('data-close-case'))closeCase();
   else if(b.hasAttribute('data-retry-case'))openCase(selected);
   else if(b.hasAttribute('data-sync-case'))sync(selected);
   else if(b.hasAttribute('data-retry-sync')&&ctx.employee.role==='admin')sync();
   else if(b.hasAttribute('data-receive'))receive();
   else if(b.dataset.taskAction)taskForm(b.dataset.task,b.dataset.taskAction);
   else if(b.dataset.followTask){const t=detail.tasks.find(t=>t.id===b.dataset.followTask);form('Reviewed · follow updates','<label>Review note<textarea name="note" required placeholder="What did you check? What are we waiting for?"></textarea></label>','Move to Following');$('issue-action-form').onsubmit=e=>submitForm(e,async f=>checked(await db.rpc('follow_customer_issue',{_task_id:t.id,_expected_updated_at:t.updated_at,_note:f.get('note')})));}
   else if(b.hasAttribute('data-prepare-evidence'))root.OGIssueEvidence.open({db,caseId:selected,target:$('issue-evidence-package'),data:detail.originalEvidence,sign:ctx.signEvidence,receipts:ctx.evidenceReceipts?ctx.evidenceReceipts(detail.lines):[],returnEvents:detail.events});
   else if(b.hasAttribute('data-assign'))assignForm(b.dataset.assign);
   else if(b.dataset.inspect)inspectionForm(b.dataset.inspect);
   else if(b.hasAttribute('data-media'))media(Number(b.dataset.media));
   else if(b.hasAttribute('data-original-media'))originalMedia(Number(b.dataset.originalMedia));
   else if(b.hasAttribute('data-more-messages')){detail.conversationLimit=(detail.conversationLimit||5)+12;renderConversation();}
   else if(b.hasAttribute('data-more-original')){detail.originalLimits[b.dataset.moreOriginal]=(detail.originalLimits[b.dataset.moreOriginal]||6)+6;renderOriginalEvidence(version);}
   else if(b.hasAttribute('data-cancel-form'))$('issue-action-form')?.remove();
   else if(b.hasAttribute('data-match-order'))matchForm();
   else if(b.hasAttribute('data-finish-case'))closeResolvedForm();
  });
  $('issues-list').addEventListener('change',e=>{
   const input=e.target.closest('[data-select-case]');if(!input||saving||ctx.employee.role!=='admin')return;
   const c=rows.find(c=>c.id===input.dataset.selectCase);if(!c)return;
   if(!input.checked)bulkSelection.delete(c.id);
   else if(!closeBlock(c)&&bulkSelection.size<BULK_LIMIT)bulkSelection.set(c.id,c);
   else {input.checked=false;feedback(`Select up to ${BULK_LIMIT} resolved cases at a time.`,true);}
   input.closest('.issue-card-row').classList.toggle('is-checked',input.checked);bulkToolbar();
  });
  $('issues-bulk-dialog').addEventListener('cancel',e=>{e.preventDefault();closeBulkDialog();});
  $('issues-search').addEventListener('input',()=>{clearBulk();cards();clearTimeout(timer);timer=setTimeout(()=>{search=$('issues-search').value.trim();offset=0;refresh({detail:false});},280);});
  $('issues-sort').onchange=()=>{clearBulk();sort=$('issues-sort').value;offset=0;refresh({detail:false});};
  $('issues-scope').onchange=()=>{clearBulk();scope=$('issues-scope').value;offset=0;refresh({detail:false});};
  $('issues-return-stage').onchange=()=>{clearBulk();returnStage=$('issues-return-stage').value;offset=0;closeCase();refresh({detail:false});};
  $('issues-prev').onclick=()=>{offset=Math.max(0,offset-PAGE);refresh({detail:false});};$('issues-next').onclick=()=>{offset+=PAGE;refresh({detail:false});};
  $('issues-refresh').onclick=()=>{refresh();health();};$('issues-sync').onclick=()=>sync();
  await Promise.all([refresh({detail:false}),health()]);
  const params=new URLSearchParams(location.search);let id=params.get('caseId');
  if(!id&&params.get('returnTaskId'))try{id=checked(await db.from('ebay_return_tasks').select('return_case_id').eq('id',params.get('returnTaskId')).single()).return_case_id;}catch{}
  if(id)await openCase(id);
  if(params.get('syncHealth')==='1')document.querySelector('.issues-sync-health').open=true;
  poll=setInterval(()=>{if(!document.hidden&&!saving&&!root.OGCaseNotes?.isEditing){health();if(!$('issue-action-form')&&!ctx.state.busy&&!$('issues-bulk-dialog').open)refresh({detail:false});}},30000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!saving&&!root.OGCaseNotes?.isEditing&&!$('issues-bulk-dialog').open){health();refresh({detail:false});}});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.defaultPrevented&&selected&&!document.querySelector('.history-modal:not(.hidden), dialog[open]'))closeCase();});
 }
 function matchForm(){
  form('Find the exact order','<label>eBay order number<input name="order" required placeholder="00-00000-00000" pattern="[0-9]{2}-[0-9]{5}-[0-9]{5}" value="'+escape(detail.c.order_number||'')+'" /></label><div id="issue-match-results"></div>','Find order');
  $('issue-action-form').onsubmit=async e=>{
   e.preventDefault();const f=new FormData(e.currentTarget),target=$('issue-match-results');target.textContent='Finding the order…';
   try{
    const order=checked(await db.from('ebay_orders').select('id,order_number,buyer_username').eq('order_number',f.get('order')).single());
    const lines=checked(await db.from('ebay_order_lines').select('id,item_title,item_number,quantity').eq('order_id',order.id));
    target.innerHTML=`<p><strong>${escape(order.buyer_username)}</strong> · ${escape(order.order_number)}</p>${lines.map(l=>`<label><input type="checkbox" name="line" value="${l.id}" /> ${escape(l.item_title)} · ${escape(l.item_number)} · Qty ${l.quantity}</label>`).join('')}<label>Why these items match<textarea name="match_note" required></textarea></label>`;
    e.currentTarget.querySelector('[type="submit"]').textContent='Confirm matching items';
    e.currentTarget.onsubmit=ev=>submitForm(ev,async values=>checked(await db.rpc('link_customer_issue_order',{_case_id:selected,_order_id:order.id,_line_ids:values.getAll('line'),_note:values.get('match_note'),_expected_updated_at:detail.c.updated_at})));
   }catch(error){target.textContent=error.message||'No exact order found.';}
  };
 }
 root.OGCustomerIssues={init,refresh,openReceivedCase:id=>openCase(id),get ready(){return ready;},testing:{kind,escalatedBadge,cardKind,nextText,cardStatus,returnBadge,customerContact,closed,date,caseHref,caseLinkLabel,money,cardFacts,conversationRows,lineFacts,closeBlock,runCloseBatch}};
})(globalThis);
