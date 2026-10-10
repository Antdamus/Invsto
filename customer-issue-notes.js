/* Internal case notes, shared by the scrolling cards and case detail. */
(function(root){
 'use strict';
 const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const date=v=>new Date(v).toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
 const checked=r=>{if(r.error)throw r.error;return r.data;};
 let db,people=[],dialog,onChange,onClose,active=null,entries=[],count=0,busy=false,reading=false,request=null,epoch=0;
 const summaries=new Map();
 const author=n=>people.find(p=>p.user_id===n.signed_by)?.display_name||n.signed_by_email||'Staff';
 function preview(n){return n?`<div class="issue-note-preview"><p>${escape(n.notes)}</p><small>${escape(author(n))} · ${escape(date(n.created_at))}</small></div>`:'';}
 function card(c){
  const data=summaries.get(c.id);
  return `<div class="issue-card-notes">${data?.error?'<small class="issue-notes-unavailable">Notes unavailable · open to retry</small>':preview(data?.notes?.[0])}<button type="button" class="issue-notes-button" data-case-notes="${escape(c.id)}" aria-label="${data?.note_count?'View notes':'Add a note'} for ${escape(c.buyer_username||c.order_number||'this case')}">${data?.note_count?`Notes (${data.note_count})`:'+ Add note'}</button></div>`;
 }
 function section(c){return `<div class="issue-notes-heading"><h3>Internal notes</h3><button type="button" class="secondary-btn" data-case-notes="${escape(c.id)}">${summaries.get(c.id)?.note_count?'View / add notes':'+ Add note'}</button></div>${summaries.get(c.id)?.error?'<p class="issue-subtitle">Notes could not be loaded. Open Notes to retry.</p>':preview(summaries.get(c.id)?.notes?.[0])||'<p class="issue-subtitle">Keep a record of what you checked or did.</p>'}`;}
 async function load(ids){
  if(!ids.length)return;
  const stamp=epoch;
  try{const data=checked(await db.rpc('customer_issue_notes',{_case_ids:ids,_limit:1,_offset:0}));if(stamp!==epoch)return;for(const row of data||[])summaries.set(row.case_id,row);}
  catch{if(stamp===epoch)ids.forEach(id=>summaries.set(id,{...summaries.get(id),error:true}));}
 }
 function history(){
  dialog.querySelector('[data-note-history]').innerHTML=entries.length?entries.map(n=>`<article class="issue-note-entry"><header><strong>${escape(author(n))}</strong><time>${escape(date(n.created_at))}</time></header><p>${escape(n.notes)}</p></article>`).join(''):'<p class="issue-subtitle">No internal notes yet.</p>';
  const more=dialog.querySelector('[data-note-more]');more.hidden=entries.length>=count;more.disabled=false;
  dialog.querySelector('[data-note-count]').textContent=`${count} note${count===1?'':'s'} · Latest first`;
 }
 async function readHistory(more=false){
  if(busy||reading)return;reading=true;
  const stamp=epoch,id=active.id,target=dialog.querySelector('[data-note-history-error]');target.textContent='';
  dialog.querySelector('[type="submit"]').disabled=true;
  dialog.querySelector('[data-note-more]').disabled=true;
  try{
   const result=checked(await db.rpc('customer_issue_notes',{_case_ids:[id],_limit:10,_offset:more?entries.length:0})),row=result?.[0];
   if(stamp!==epoch)return;if(!row)throw Error('This case is no longer available.');
   const merged=more?[...entries,...row.notes]:row.notes;entries=[...new Map(merged.map(n=>[n.id,n])).values()];count=row.note_count;
   if(!more)summaries.set(id,{...row,notes:row.notes.slice(0,1)});
   history();onChange?.(id);
  }catch(error){if(stamp===epoch){target.textContent=error.message||'Could not load notes. Please retry.';dialog.querySelector('[data-note-more]').hidden=true;dialog.querySelector('[data-note-retry]').hidden=false;}}
  finally{if(stamp===epoch){reading=false;dialog.querySelector('[type="submit"]').disabled=false;}}
 }
 function close(){if(busy)return;epoch++;dialog.close();onClose?.();}
 async function save(event){
  event.preventDefault();if(busy||reading)return;
  const input=dialog.querySelector('textarea'),body=input.value.trim(),status=dialog.querySelector('[data-note-status]');
  if(!body){status.textContent='Write a note before saving.';input.focus();return;}
  if(!request||request.note!==body)request={id:crypto.randomUUID(),note:body};
  busy=true;dialog.querySelectorAll('button,textarea').forEach(el=>el.disabled=true);status.textContent='Saving…';
  try{
   const note=checked(await db.rpc('add_customer_issue_note',{_request_id:request.id,_case_id:active.id,_note:body}));
   count=note.note_count??(count+(entries.some(n=>n.id===note.id)?0:1));
   entries=[note,...entries.filter(n=>n.id!==note.id)];summaries.set(active.id,{case_id:active.id,note_count:count,notes:[note]});
   request=null;input.value='';history();onChange?.(active.id);status.textContent='Note saved. Visible to your team.';
  }catch(error){status.textContent=error.message||'Could not confirm the save. Your note is kept here; retry safely.';}
  finally{busy=false;dialog.querySelectorAll('button,textarea').forEach(el=>el.disabled=false);}
 }
 async function open(c,afterClose){
  if(busy)return;active=c;onClose=afterClose;entries=[];count=0;request=null;reading=false;epoch++;
  dialog.innerHTML=`<header class="issue-notes-dialog-heading"><div><h2 id="issue-notes-title">Case notes</h2><p>${escape(c.buyer_username||'Buyer')} · ${escape(c.order_number||'Order not linked')}</p><small>Case ${escape(c.ebay_return_id||'internal')}</small></div><button type="button" class="secondary-btn" data-note-close>Close</button></header><p class="issue-notes-private">Internal team notes · not sent to the buyer or eBay.</p><form><label for="issue-new-note">Add a note</label><textarea id="issue-new-note" maxlength="10000" rows="3" required placeholder="What did you check or do? What should the team know?"></textarea><div class="issue-notes-save"><span role="status" data-note-status></span><button type="submit" class="primary-btn">Save note</button></div></form><h3 data-note-count>Notes · Latest first</h3><p role="alert" class="issue-form-error" data-note-history-error></p><button type="button" class="secondary-btn" data-note-retry hidden>Retry loading notes</button><div data-note-history><p class="issue-subtitle">Loading notes…</p></div><button type="button" class="secondary-btn" data-note-more hidden>Show older notes</button>`;
  dialog.querySelector('form').onsubmit=save;dialog.querySelector('[data-note-close]').onclick=close;
  dialog.querySelector('[data-note-more]').onclick=()=>readHistory(true);
  dialog.querySelector('[data-note-retry]').onclick=e=>{e.currentTarget.hidden=true;readHistory();};
  dialog.showModal();dialog.querySelector('[data-note-close]').focus();
  await readHistory();
 }
 function init(options){db=options.db;people=options.people||[];onChange=options.onChange;dialog=document.getElementById('issue-notes-dialog');dialog.addEventListener('cancel',e=>{e.preventDefault();close();});}
 root.OGCaseNotes={init,load,card,section,open,get isOpen(){return !!dialog?.open;},testing:{preview}};
})(globalThis);
