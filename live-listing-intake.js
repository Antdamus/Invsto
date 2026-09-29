(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let connection=null,item=null,itemEvent=null,busy=false,loading=false,requestId=null;
  const rpc=async(name,args)=>{const r=await window.supabase.rpc(name,args);if(r.error)throw Error(r.error.message);return r.data;};
  const status=(text,error=false)=>{const el=$('live-intake-status');el.textContent=text;el.classList.toggle('is-error',error);};
  const photos=i=>[...new Set([...(Array.isArray(i?.photos)?i.photos:[]),i?.photo_url].filter(p=>typeof p==='string'&&p.trim()))];
  async function photoUrl(path){
    if(/^https:\/\//i.test(path))return path;
    if(/^\w+:/.test(path))throw Error('Unsupported stock photo address');
    const r=await window.supabase.storage.from('photos').createSignedUrl(path.replace(/^photos\//,''),1800);
    if(r.error||!r.data?.signedUrl)throw Error('A stock photo could not be opened');return r.data.signedUrl;
  }
  async function photoData(path){
    const response=await fetch(await photoUrl(path));if(!response.ok)throw Error('A stock photo could not be downloaded');
    const blob=await response.blob();if(blob.size>30*1024*1024)throw Error('A stock photo is too large');
    const bitmap=await createImageBitmap(blob);
    try{const scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);return canvas.toDataURL('image/jpeg',.88).split(',')[1];}finally{bitmap.close();}
  }
  function clearItem(){item=null;itemEvent=null;requestId=null;$('live-intake-preview').hidden=true;$('live-intake-send').disabled=true;}
  function code(value){const text=value.trim();try{const u=new URL(text);return u.searchParams.get('barcode')||u.searchParams.get('item_id')||text;}catch{return text;}}
  async function lookup(){
    if(busy||!connection)return;busy=true;const event=connection.event_id;clearItem();status('Finding the stock item…');
    try{
      const found=await rpc('lookup_live_listing_item',{_barcode:code($('live-intake-barcode').value)});
      if(connection?.event_id!==event)return;
      item=found;itemEvent=event;requestId=crypto.randomUUID();
      $('live-intake-title').textContent=item.title;$('live-intake-stock').textContent=`${item.barcode} · ${item.available} available · One unit per auction`;
      $('live-intake-description').textContent=item.description||'No saved description';
      $('live-intake-preview').hidden=false;$('live-intake-existing').hidden=!item.existing_listing_id;$('live-intake-existing-check').checked=false;
      $('live-intake-existing-id').textContent=item.existing_listing_id||'';
      const paths=photos(item);$('live-intake-photo').hidden=!paths.length;
      if(paths.length)$('live-intake-photo').src=await photoUrl(paths[0]);
      if(connection?.event_id!==event)return;
      const complete=item.available>0&&item.title&&item.description&&paths.length>0&&paths.length<=25;
      $('live-intake-send').disabled=!complete;
      status(complete?`${paths.length} stock photo${paths.length===1?'':'s'} will be included. Choose the starting bid below.`:'This item needs available stock, a title, a description, and 1–25 photos. Update it on Stock first.',!complete);
    }catch(e){status(e.message,true);}finally{busy=false;}
  }
  async function send(){
    if(busy||!item||itemEvent!==connection?.event_id)return;busy=true;$('live-intake-send').disabled=true;
    try{
      const bid=Number($('live-intake-bid').value);if(!Number.isFinite(bid)||bid<=0)throw Error('Enter a starting bid. The break-even price stays internal.');
      const job=await rpc('queue_live_listing',{_id:requestId,_event_id:itemEvent,_barcode:item.barcode,_starting_bid:bid,_duration:Number($('live-intake-duration').value),_existing_listing_checked:$('live-intake-existing-check').checked});
      status(job.status==='queued'?'Sent. On the show computer, click Prepare next item in the updated helper.':`This item is already in this show’s preparation list (${job.status}).`);
      clearItem();$('live-intake-barcode').value='';await refresh();
    }catch(e){status(e.message,true);$('live-intake-send').disabled=false;}finally{busy=false;}
  }
  async function refresh(){
    if(!connection||loading||!$('live-intake-jobs'))return;loading=true;const event=connection.event_id;
    try{const rows=await rpc('get_live_listing_requests',{_event_id:event});if(connection?.event_id!==event)return;
      const labels={queued:'Waiting for show computer',preparing:'Preparing on eBay',ready:'Ready — review and click Create listing on eBay',created:'Created in the show',failed:'Preparation needs attention',cancelled:'Cancelled'};
      const html=(rows||[]).map(j=>`<article><strong>${esc(j.title)}</strong><span>${esc(j.barcode)} · $${Number(j.starting_bid).toFixed(2)} start · ${j.duration_seconds}s</span><b>${labels[j.status]||esc(j.status)}</b>${j.note?`<small>${esc(j.note)}</small>`:''}${j.listing_id?`<a href="https://www.ebay.com/itm/${encodeURIComponent(j.listing_id)}" target="_blank" rel="noopener">eBay listing ${esc(j.listing_id)}</a>`:''}${j.status==='failed'?`<button type="button" data-intake-retry="${esc(j.id)}">Retry preparation</button>`:''}</article>`).join('')||'<p>No items sent for this show yet.</p>';
      if($('live-intake-jobs').innerHTML!==html)$('live-intake-jobs').innerHTML=html;
    }catch(e){$('live-intake-jobs').textContent='Preparation status unavailable: '+e.message;}finally{loading=false;}
  }
  let workerToken;
  function token(){if(!workerToken){const key='invsto-live-listing-worker';workerToken=localStorage.getItem(key)||crypto.randomUUID();localStorage.setItem(key,workerToken);}return workerToken;}
  async function receiver(event){
    if(new URL(location.href).searchParams.get('capture')!=='1'||event.source!==window||event.origin!==location.origin||event.data?.type!=='INVSTO_LISTING_REQUEST')return;
    const {id,command}=event.data;let job;
    try{
      if(!/^[\w-]{6,100}$/.test(command?.event_id||''))throw Error('Invalid show');
      if(command.action==='next'){
        job=await rpc('claim_live_listing',{_event_id:command.event_id,_worker_token:token()});
        if(!job?.id){window.postMessage({type:'INVSTO_LISTING_RESPONSE',id,ok:true,job:null},location.origin);return;}
        if(job.event_id!==command.event_id)throw Error('Show changed');
        const source=job.snapshot,paths=photos(source);if(!paths.length||paths.length>25)throw Error('This item needs 1–25 stock photos');
        const images=[];if(job.status!=='ready')for(const path of paths)images.push(await photoData(path));
        const sku=String(source.barcode||'');const suffix=` [${sku.slice(-30)}]`;
        const title=String(source.title).slice(0,73-suffix.length)+suffix;
        // Only public listing content crosses to eBay. No costs or minimum prices.
        const fields=Object.entries(source.ebay_aspects||{}).map(([name,value])=>`${name}: ${Array.isArray(value)?value.join(', '):value}`).join('\n');
        window.postMessage({type:'INVSTO_LISTING_RESPONSE',id,ok:true,job:{id:job.id,event_id:job.event_id,status:job.status,title,description:String(source.description)+'\n\nInventory reference: '+sku,barcode:sku,images,starting_bid:job.starting_bid,duration_seconds:job.duration_seconds,category:source.ebay_category_id||'',condition:source.watch_details?.condition||source.ebay_condition||'',specifics:fields}},location.origin);
      }else if(['ready','failed','created'].includes(command.action)){
        await rpc('report_live_listing',{_id:command.job_id,_worker_token:token(),_status:command.action,_note:String(command.note||'').slice(0,500),_listing_id:command.listing_id||null});
        window.postMessage({type:'INVSTO_LISTING_RESPONSE',id,ok:true},location.origin);
      }else throw Error('Unsupported listing action');
      await refresh();
    }catch(e){
      if(job?.id&&job.status==='preparing')await rpc('report_live_listing',{_id:job.id,_worker_token:token(),_status:'failed',_note:e.message}).catch(()=>{});
      window.postMessage({type:'INVSTO_LISTING_RESPONSE',id,ok:false,error:e.message},location.origin);
    }
  }
  function init(){
    if($('live-intake'))return;
    const el=document.createElement('details');el.id='live-intake';el.className='live-intake';el.hidden=true;
    el.innerHTML=`<summary>Scan stock → add an auction</summary><p>Send one stock item to this show’s computer. Review its eBay template, then click Create listing there. Starting the auction stays separate.</p><div class="button-row"><input id="live-intake-barcode" aria-label="Inventory barcode for new auction" placeholder="Scan or enter item barcode" autocomplete="off"><button type="button" id="live-intake-find">Find item</button><button type="button" data-scan-target="live-intake-barcode" data-scan-action="live-intake-find">Use camera</button></div><p id="live-intake-status" role="status"></p><section id="live-intake-preview" hidden><img id="live-intake-photo" alt="Stock item"><strong id="live-intake-title"></strong><p id="live-intake-stock"></p><details><summary>Saved description</summary><p id="live-intake-description"></p></details><div class="live-intake-prices"><label>Starting bid ($)<input id="live-intake-bid" type="number" min="0.01" max="999999.99" step="0.01" placeholder="Enter amount"></label><label>Duration<select id="live-intake-duration"><option value="15">15 seconds</option><option value="30" selected>30 seconds</option><option value="45">45 seconds</option><option value="60">60 seconds</option><option value="90">90 seconds</option><option value="120">120 seconds</option></select></label></div><p>Break-even stays internal. Preparing this auction does not remove stock or change another listing.</p><label id="live-intake-existing" hidden><input type="checkbox" id="live-intake-existing-check">I checked the available quantity on existing eBay listing <span id="live-intake-existing-id"></span> before offering this unit again.</label><button type="button" id="live-intake-send" disabled>Send to show computer</button></section><div id="live-intake-jobs"></div><p class="ebay-help">Requires <a href="downloads/Invsto-Live-Capture.zip?v=1.1.0" download>Live Capture 1.1.0</a> and the signed-in capture receiver on the show computer.</p>`;
    $('ebay-queue-area').before(el);
    $('live-intake-find').onclick=lookup;$('live-intake-send').onclick=send;
    $('live-intake-barcode').addEventListener('input',()=>{if(!busy)clearItem();});
    $('live-intake-barcode').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();e.stopPropagation();lookup();}});
    $('live-intake-jobs').onclick=async e=>{const button=e.target.closest('[data-intake-retry]');if(!button)return;button.disabled=true;try{await rpc('retry_live_listing',{_id:button.dataset.intakeRetry});await refresh();}catch(error){status(error.message,true);button.disabled=false;}};
    el.addEventListener('toggle',()=>{if(el.open)refresh();});
    window.addEventListener('message',receiver);setInterval(()=>{if(el.open)refresh();},3000);
  }
  function sync(c){if(!$('live-intake'))return;const changed=connection?.event_id!==c?.event_id;connection=c;
    $('live-intake').hidden=!c||!!c.broadcast_ended_at||!!c.review_completed_at;
    if(changed){clearItem();$('live-intake-jobs').innerHTML='';status('');if(c&&$('live-intake').open)refresh();}
  }
  window.liveListingIntake={init,sync};
})();
