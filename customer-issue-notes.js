/* Internal notes expand in the case card; drafts survive list refreshes. */
(function(root){
 'use strict';
 const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const date=v=>new Date(v).toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
 const checked=r=>{if(r.error)throw r.error;return r.data;};
 const states=new Map();let db,people=[],workspace;
 const phone=()=>!!root.matchMedia?.('(max-width:900px)').matches;
 const author=n=>people.find(p=>p.user_id===n.signed_by)?.display_name||n.signed_by_email||'Staff';
 function state(id){if(!states.has(id))states.set(id,{notes:[],count:0,expanded:undefined,editing:false,draft:'',request:null,busy:false,loading:false,error:'',status:'',revision:0});return states.get(id);}
 const expanded=s=>s.expanded??phone();
 function preview(n){return n?`<div class="issue-note-preview"><p>${escape(n.notes)}</p><small>${escape(author(n))} · ${escape(date(n.created_at))}</small></div>`:'';}
 function content(id,variant='card'){
  const s=state(id),open=expanded(s),key=`case-notes-${variant}-${id}`,hasNotes=s.count>0;
  return `<div class="issue-inline-notes ${open?'is-expanded':''}" data-note-case="${escape(id)}" data-note-variant="${variant}">
   <div class="issue-notes-heading">${hasNotes?`<button type="button" class="issue-notes-button" data-note-toggle aria-expanded="${open}" aria-controls="${escape(key)}"><span aria-hidden="true">${open?'▾':'▸'}</span> Notes (${s.count})</button>`:variant==='detail'?'<h3>Internal notes</h3>':'<span></span>'}${!s.editing?`<button type="button" class="issue-notes-button" data-note-add ${s.loading?'disabled':''}>+ Add note</button>`:''}</div>
   ${!open&&hasNotes?`<button type="button" class="issue-note-preview-button" data-note-toggle aria-expanded="false" aria-controls="${escape(key)}" aria-label="Expand case notes">${preview(s.notes[0])}</button>`:''}
   <div id="${escape(key)}" ${open?'':'hidden'}>${s.notes.map(n=>`<article class="issue-note-entry"><header><strong>${escape(author(n))}</strong><time>${escape(date(n.created_at))}</time></header><p>${escape(n.notes)}</p></article>`).join('')}
   ${s.count>s.notes.length?`<button type="button" class="issue-notes-button" data-note-more ${s.loading||s.editing?'disabled':''}>${s.loading?'Loading…':`Show older notes (${s.count-s.notes.length})`}</button>`:''}</div>
   ${s.error?`<p class="issue-notes-unavailable" role="alert">${escape(s.error)}</p>${!s.editing?'<button type="button" class="issue-notes-button" data-note-retry>Retry loading notes</button>':''}`:''}
   ${s.editing?`<form class="issue-inline-note-form" data-note-form><label for="${escape(key)}-draft">Add an internal note</label><textarea id="${escape(key)}-draft" maxlength="10000" rows="3" required placeholder="What did you check or do?" ${s.busy?'disabled':''}>${escape(s.draft)}</textarea><small>Visible to your team · not sent to the buyer or eBay.</small><div class="issue-notes-save"><button type="submit" class="primary-btn" ${s.busy||s.loading?'disabled':''}>${s.busy?'Saving…':'Save note'}</button><button type="button" class="secondary-btn" data-note-cancel ${s.busy?'disabled':''}>Cancel</button></div></form>`:''}
   <span class="issue-note-status" role="status">${escape(s.status)}</span></div>`;
 }
 function card(c){return `<div class="issue-card-notes">${content(c.id)}</div>`;}
 function section(c){return content(c.id,'detail');}
 function panels(id){return Array.from(workspace?.querySelectorAll('[data-note-case]')||[]).filter(el=>el.dataset.noteCase===id);}
 function repaint(id){for(const el of panels(id))el.outerHTML=content(id,el.dataset.noteVariant);}
 function merge(s,row,append=false){
  // Notes are append-only. Keep an expanded history when its head is unchanged;
  // reset the page if another employee added notes, so offsets cannot skip any.
  const sameHead=row.notes[0]?.id===s.notes[0]?.id;
  const notes=append?[...s.notes,...row.notes]:sameHead&&s.notes.length>row.notes.length?s.notes:row.notes;
  s.notes=[...new Map(notes.map(n=>[n.id,n])).values()];s.count=row.note_count;s.error='';
 }
 async function load(ids){
  if(!ids.length)return;const revisions=new Map(ids.map(id=>[id,state(id).revision]));
  try{
   const rows=checked(await db.rpc('customer_issue_notes',{_case_ids:ids,_limit:phone()?3:1,_offset:0}));
   for(const row of rows||[]){const s=state(row.case_id);if(s.revision===revisions.get(row.case_id)&&!s.editing)merge(s,row);}
  }catch{for(const id of ids){const s=state(id);if(s.revision===revisions.get(id)&&!s.editing)s.error='Notes unavailable. Please retry.';}}
 }
 async function read(id,more=false){
  const s=state(id);if(s.loading||s.busy)return;s.loading=true;s.error='';const revision=++s.revision;repaint(id);
  try{
   const rows=checked(await db.rpc('customer_issue_notes',{_case_ids:[id],_limit:10,_offset:more?s.notes.length:0}));
   if(revision!==s.revision)return;if(!rows?.[0])throw Error('This case is no longer available.');merge(s,rows[0],more);
  }catch(error){if(revision===s.revision)s.error=error.message||'Could not load notes. Please retry.';}
  finally{if(revision===s.revision){s.loading=false;repaint(id);}}
 }
 async function save(id){
  const s=state(id),body=s.draft.trim();if(s.busy||s.loading)return;
  if(!body){s.status='Write a note before saving.';repaint(id);return;}
  if(!s.request||s.request.note!==body)s.request={id:crypto.randomUUID(),note:body};
  s.busy=true;s.error='';s.status='Saving…';s.revision++;repaint(id);
  try{
   const note=checked(await db.rpc('add_customer_issue_note',{_request_id:s.request.id,_case_id:id,_note:body}));
   const expected=s.count+(s.notes.some(n=>n.id===note.id)?0:1);s.count=note.note_count??expected;s.notes=[note,...(s.count>expected?[]:s.notes.filter(n=>n.id!==note.id))];
   s.request=null;s.draft='';s.editing=false;s.expanded=true;s.status='Note saved.';
  }catch(error){s.error=error.message||'Could not confirm the save. Your note is kept here; retry safely.';s.status='';}
  finally{s.busy=false;repaint(id);}
 }
 function init(options){
  db=options.db;people=options.people||[];workspace=document.getElementById('issues-workspace');
  workspace.addEventListener('click',e=>{
   const b=e.target.closest('button'),panel=b?.closest('[data-note-case]');if(!panel)return;
   const id=panel.dataset.noteCase,variant=panel.dataset.noteVariant,s=state(id);if(s.busy)return;
   if(b.hasAttribute('data-note-toggle')){s.expanded=!expanded(s);repaint(id);if(s.expanded&&s.count>s.notes.length&&!s.loading)read(id);}
   else if(b.hasAttribute('data-note-add')){s.editing=true;s.status='';repaint(id);panels(id).find(p=>p.dataset.noteVariant===variant)?.querySelector('textarea')?.focus({preventScroll:true});}
   else if(b.hasAttribute('data-note-cancel')){s.editing=false;s.draft='';s.request=null;s.error='';s.status='';repaint(id);}
   else if(b.hasAttribute('data-note-more'))read(id,true);
   else if(b.hasAttribute('data-note-retry'))read(id);
  });
  workspace.addEventListener('input',e=>{const panel=e.target.closest('[data-note-case]');if(panel&&e.target.matches('textarea'))state(panel.dataset.noteCase).draft=e.target.value;});
  workspace.addEventListener('submit',e=>{if(!e.target.matches('[data-note-form]'))return;e.preventDefault();const id=e.target.closest('[data-note-case]').dataset.noteCase;state(id).draft=e.target.querySelector('textarea').value;save(id);});
 }
 root.OGCaseNotes={init,load,card,section,get isEditing(){return [...states.values()].some(s=>s.editing||s.busy);},testing:{preview,state,expanded,read,save}};
})(globalThis);
