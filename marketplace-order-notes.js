(function(){
 'use strict';
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const clock=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
 const stamp=value=>clock.format(new Date(value));
 const $=id=>document.getElementById('mn-'+id);
 const pageSize=30;
 let market,db,dialog,active,summaryTimer,summaryVersion=0,historyVersion=0;

 function control(orders,line){
  if(!orders.length)return '';
  const targets=orders.map(o=>[String(o.id),String(o.order_number||o.id)]);
  const label=line?'Add line note':'Add order note';
  return '<div class="mn-control" data-mn-targets="'+esc(JSON.stringify(targets))+'" data-mn-line="'+esc(line?.id)+'" data-mn-title="'+esc(line?.title)+'">'+
   '<button type="button" class="mn-add" data-mn-open><span aria-hidden="true">✎</span> '+label+'</button><small class="mn-preview" hidden></small></div>';
 }

 function refresh(){
  if(!db)return;
  const version=++summaryVersion;clearTimeout(summaryTimer);
  summaryTimer=setTimeout(()=>summaries(version),140);
 }
 async function summaries(version){
  const controls=Array.from(document.querySelectorAll('[data-mn-targets]'),node=>({node,ids:JSON.parse(node.dataset.mnTargets).map(t=>t[0])}));
  const ids=[...new Set(controls.flatMap(c=>c.ids))],byOrder=new Map();
  try{
   for(let i=0;i<ids.length;i+=100){
    for(let start=0;;start+=500){
     if(version!==summaryVersion)return;
     const r=await db.from('marketplace_order_note_summaries').select('order_id,line_id,note_count,signer,created_at,preview')
      .eq('market',market).in('order_id',ids.slice(i,i+100)).order('order_id').order('line_id').range(start,start+499);
     if(r.error)throw r.error;
     for(const row of r.data){
      if(!byOrder.has(row.order_id))byOrder.set(row.order_id,[]);
      byOrder.get(row.order_id).push(row);
     }
     if(r.data.length<500)break;
    }
   }
   if(version!==summaryVersion)return;
   for(const {node,ids} of controls){
    const rows=ids.flatMap(id=>byOrder.get(id)||[]).filter(r=>!node.dataset.mnLine||r.line_id===node.dataset.mnLine);
    const count=rows.reduce((n,r)=>n+Number(r.note_count),0),preview=node.querySelector('.mn-preview');
    preview.hidden=!count;node.classList.toggle('has-notes',count>0);
    if(!count)continue;
    const last=rows.reduce((a,b)=>a.created_at>b.created_at?a:b);
    const order=ids.length>1?JSON.parse(node.dataset.mnTargets).find(t=>t[0]===last.order_id)?.[1]:null;
    const scope=(order?' · Order #'+order:'')+(last.line_id&&!node.dataset.mnLine?' · Item note':'');
    preview.textContent=count+(count===1?' note':' notes')+scope+' · Signed by '+last.signer+' · '+stamp(last.created_at)+' — '+last.preview;
   }
  }catch{
   if(version===summaryVersion)for(const {node} of controls){
    const preview=node.querySelector('.mn-preview');preview.hidden=false;preview.textContent='Open notes to check the latest activity.';
   }
  }
 }

 function bind(platform,client){
  if(dialog)return;
  market=platform;db=client;
  dialog=document.createElement('dialog');dialog.id='mn-dialog';dialog.setAttribute('aria-labelledby','mn-heading');
  dialog.innerHTML='<form id="mn-form"><header><div><small>INTERNAL STAFF NOTES</small><h2 id="mn-heading"></h2></div><button type="button" id="mn-close" aria-label="Close notes">×</button></header>'+
   '<label id="mn-chooser">Choose an order<select id="mn-order"></select></label><p id="mn-context"></p>'+
   '<label>New note<textarea id="mn-draft" rows="3" maxlength="4000" placeholder="What should the next person know?"></textarea></label>'+
   '<p class="mn-help">Your staff name and the time are saved automatically.</p><button id="mn-save" type="submit">Save signed note</button><p id="mn-status" role="status"></p></form>'+
   '<section><h3>Note history</h3><button type="button" id="mn-refresh">Refresh notes</button><div id="mn-feed" aria-live="polite"></div><button type="button" id="mn-more" hidden>Earlier notes</button></section>';
  document.body.append(dialog);
  document.addEventListener('click',event=>{
   const button=event.target.closest('[data-mn-open]');if(!button)return;
   const node=button.closest('[data-mn-targets]'),targets=JSON.parse(node.dataset.mnTargets);
   active={line:node.dataset.mnLine||null,title:node.dataset.mnTitle,targets,offset:0};
   $('heading').textContent=active.line?'Item notes':'Order notes';
   $('chooser').hidden=targets.length===1;
   $('order').innerHTML=(targets.length>1?'<option value="">Select an order…</option>':'')+targets.map(([id,num])=>'<option value="'+esc(id)+'">Order #'+esc(num)+'</option>').join('');
   $('draft').value='';$('status').textContent='';dialog.showModal();chooseOrder();
  });
  $('order').onchange=chooseOrder;
  $('draft').oninput=syncForm;
  $('refresh').onclick=()=>loadHistory(false);$('more').onclick=()=>loadHistory(true);
  $('close').onclick=()=>{if(!active?.saving)dialog.close();};
  dialog.addEventListener('cancel',event=>{if(active?.saving)event.preventDefault();});
  dialog.addEventListener('close',()=>{active=null;historyVersion++;});
  $('form').onsubmit=save;
 }
 function syncForm(){
  if(!active)return;
  $('draft').disabled=!active.order||active.saving;
  $('save').disabled=!active.order||active.saving||!$('draft').value.trim();
  $('order').disabled=Boolean(active.saving||$('draft').value.trim());
  $('close').disabled=Boolean(active.saving);
 }
 function chooseOrder(){
  active.order=$('order').value;active.request=null;$('status').textContent='';
  const number=active.targets.find(([id])=>id===active.order)?.[1];
  $('context').textContent=number?'Order #'+number+' · '+(active.line?active.title+' · Line '+active.line:'Whole order'):'Choose the order this note belongs to.';
  syncForm();loadHistory(false);
 }
 async function loadHistory(append){
  const ctx=active,version=++historyVersion;if(!ctx)return;
  const offset=append?ctx.offset:0;
  if(!append)$('feed').replaceChildren();
  $('more').hidden=true;$('refresh').disabled=!ctx.order;
  if(!ctx.order)return;
  if(!append)$('feed').textContent='Loading notes…';
  try{
   let query=db.from('marketplace_order_notes').select('id,line_id,item_title,body,signer,created_at').eq('market',market).eq('order_id',ctx.order);
   if(ctx.line)query=query.eq('line_id',ctx.line);
   const r=await query.order('created_at',{ascending:false}).order('id',{ascending:false}).range(offset,offset+pageSize);
   if(r.error)throw r.error;if(version!==historyVersion)return;
   if(!append)$('feed').replaceChildren();
   const rows=r.data.slice(0,pageSize);
   if(!offset&&!rows.length)$('feed').textContent='No staff notes yet.';
   for(const row of rows){
    const entry=document.createElement('article');
    entry.innerHTML='<strong>Signed by '+esc(row.signer)+'</strong><time datetime="'+esc(row.created_at)+'">'+esc(stamp(row.created_at))+'</time><small>'+
     (row.line_id?'Item · '+esc(row.item_title||row.line_id):'Whole order')+'</small><p>'+esc(row.body)+'</p>';
    $('feed').append(entry);
   }
   ctx.offset=offset+rows.length;$('more').hidden=r.data.length<=pageSize;
  }catch{
   if(version!==historyVersion)return;
   if(!append)$('feed').textContent='Could not load notes. Use Refresh notes to retry.';
   else{$('more').hidden=false;$('status').textContent='Could not load earlier notes. Try again.';}
  }
 }
 async function save(event){
  event.preventDefault();const ctx=active,body=$('draft').value.trim();if(!ctx?.order||ctx.saving||!body)return;
  if(ctx.request?.body!==body)ctx.request={body,id:crypto.randomUUID()};
  ctx.saving=true;syncForm();$('status').textContent='Saving…';
  try{
   const r=await db.rpc('add_marketplace_order_note',{_market:market,_order_id:ctx.order,_line_id:ctx.line,_note:body,_request_id:ctx.request.id});
   if(r.error)throw r.error;
   ctx.request=null;$('draft').value='';$('status').textContent='Signed note saved.';refresh();await loadHistory(false);
  }catch(e){$('status').textContent=e.message||'Could not save. Your draft is still here.';}
  finally{ctx.saving=false;syncForm();}
 }
 window.MarketplaceOrderNotes={control,bind,refresh};
})();
