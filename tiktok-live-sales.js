(function boot(){
 'use strict';
 if(!window.supabase?.auth?.getSession){document.addEventListener('supabase-ready',boot,{once:true});return;}
 const $=id=>document.getElementById(id),sb=window.supabase,params=new URL(location.href).searchParams;
 const eventId=params.get('capture_event'),isCapture=params.get('capture')==='1';
 const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=v=>Number(v||0).toLocaleString('en-US',{style:'currency',currency:'USD'});
 const time=v=>v?new Date(v).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}):'Time unavailable';
 const states={paid:'Confirmed paid',waiting:'Pending payment',failed:'Payment failed',review:'Needs review',cancelled:'Canceled'};
 let data=null,currentSession=null,loading=false,employees=[],connections=[],rendered='',authorized=false,stream=null,receipts=[];
 try{stream=JSON.parse(params.get('stream')||'null');}catch{}
 const rpc=async(name,args={})=>{const r=await sb.rpc(name,args);if(r.error)throw r.error;return r.data;};
 const sort=rows=>[...rows].sort((a,b)=>Date.parse(b.sold_at||b.created_at)-Date.parse(a.sold_at||a.created_at));
 function status(message,error=false){$('connection-detail').textContent=message;$('connection-dot').classList.toggle('live',!error&&!!data);}
 function openPhoto(url,title){$('photo-image').src=url;$('photo-caption').textContent=title;$('photo-dialog').showModal();}
 async function printBag(lotId,options={}){
  let sale=data?.attempts.find(a=>a.lot_id===lotId);
  if(!sale){const r=await sb.from('tiktok_live_attempts').select('*,lot:live_sale_lots(lot_code)').eq('lot_id',lotId).maybeSingle();if(r.error)throw r.error;sale=r.data;if(sale)sale.lot_code=sale.lot?.lot_code;}
  if(!sale?.lot_code)throw Error('Saved TikTok bag not found. Refresh and retry.');
  const identity=window.liveBagLabel.identity({lot_code:sale.lot_code},sale);
  return window.printStations.printLabel(window.liveBagLabel.build(identity),{...options,copies:1,title:identity.title,barcode:sale.lot_code,filename:`TikTok_${sale.sku}_Copies_1.dymo`,capturePlatform:'tiktok'});
 }
 window.liveBagPrintBridge.install({printBag},sort,id=>data?.connection.event_id===id&&Date.now()-Date.parse(data.server_time)<8000?data:null,{platform:'tiktok'});
 function updateStatus(){
  if(!data)return;const c=data.connection,observed=c.health?.observed_at,age=Date.now()-Date.parse(observed),fresh=Number.isFinite(age)&&age>=-30000&&age<20000,live=fresh&&c.health?.ready;
  $('connection-title').textContent=live?'TikTok capture connected':fresh?'Capture needs attention':'Waiting for the TikTok console';
  const message=fresh?(c.health?.message||'Reading TikTok sold auctions.'):'The TikTok console is not sending current observations.';
  const version=/^\d+\.\d+\.\d+$/.test(c.health?.version||'')?' · Capture v'+c.health.version:'';
  status(`${message} · ${data.attempts.length} saved auction records${observed?' · Last capture '+time(observed):''}${version}`,!live);
 }
 function render(force=false){
  if(!data)return;updateStatus();
  const rows=data.attempts||[],query=$('search').value.trim().toLowerCase(),filter=$('payment').value;
  const signature=JSON.stringify([rows,data.photos,receipts,query,filter]);if(!force&&signature===rendered)return;rendered=signature;
  const c=data.connection;$('show-header').hidden=false;$('show-title').textContent=c.title;$('show-time').textContent='TIKTOK LIVE · '+time(c.started_at||data.session.started_at);
  $('show-seller').textContent='Seller: '+(employees.find(e=>e.id===c.active_seller_id)?.display_name||'Recorded seller');$('console-link').hidden=false;$('console-link').href=c.source_url;
  const metric=(label,set,cls='')=>`<article class="metric ${cls}"><small>${label}</small><strong>${money(set.reduce((s,a)=>s+Number(a.amount),0))}</strong><span>${set.length} item${set.length===1?'':'s'}</span></article>`;
  $('totals').innerHTML=metric('Confirmed paid',rows.filter(a=>a.payment_state==='paid'))+metric('Pending payment',rows.filter(a=>a.payment_state==='waiting'))+metric('Failed / needs review',rows.filter(a=>['failed','review'].includes(a.payment_state)),'failed')+`<article class="metric"><small>Captured items</small><strong>${rows.length}</strong><span>${new Set(rows.map(a=>a.buyer.toLowerCase())).size} buyers · ${data.photos.length} photos</span></article>`;
  const groups=new Map();for(const a of rows){const key=a.buyer.toLowerCase();if(!groups.has(key))groups.set(key,[]);groups.get(key).push(a);}
  $('buyer-index').hidden=!groups.size;$('buyer-count').textContent=groups.size+' buyers';
  $('buyers').innerHTML=[...groups].sort(([a],[b])=>a.localeCompare(b)).map(([key,items])=>`<a class="buyer-link ${items.some(a=>['failed','review'].includes(a.payment_state))?'issue':''}" href="#buyer-${encodeURIComponent(key)}"><strong>@${escape(items[0].buyer)}</strong><small>${escape(items[0].buyer_name||'')} · ${items.length} items</small><span>${money(items.filter(a=>a.payment_state==='paid').reduce((s,a)=>s+Number(a.amount),0))} paid</span></a>`).join('');
  const byJob=new Map(receipts.map(j=>[j.attempt_id,j]));
  $('sales').innerHTML=[...groups].map(([key,items])=>{
   const visible=items.filter(a=>(!filter||a.payment_state===filter)&&(!query||[a.buyer,a.buyer_name,a.listing_title,a.sku].some(v=>String(v||'').toLowerCase().includes(query))));if(!visible.length)return '';
   return `<section class="buyer-section" id="buyer-${encodeURIComponent(key)}"><div class="section-head"><div><h2>@${escape(items[0].buyer)}</h2><p>${escape(items[0].buyer_name||'')} · ${items.length} captured items</p></div><a href="#buyer-index">↑ Buyer index</a></div><div class="sale-grid">${sort(visible).map(a=>{const j=byJob.get(a.id),label={queued:'Waiting for printer',claimed:'Sending to printer',submitted:'✓ Sent to printer',failed:'Print failed',uncertain:'Check printer',cancelled:'Print canceled'}[j?.status]||'Label not sent';return `<article class="sale ${escape(a.payment_state)}" id="sale-${a.id}"><div class="sale-top"><span class="bag-number">Bag #${escape(a.sku)}</span><span class="pill ${escape(a.payment_state)}">${states[a.payment_state]}</span></div><div class="sale-body"><h3>${escape(a.listing_title)}</h3><div class="sale-detail"><strong class="amount">${money(a.amount)}</strong><time>${escape(time(a.sold_at))}${a.time_estimated?' · approx.':''}</time></div><div data-photos="${a.id}"></div><div class="sale-actions"><button data-print="${a.id}" ${['queued','claimed'].includes(j?.status)?'disabled':''}>${j?'Reprint':'Print'} bag label</button><a href="bag-lookup.html?bag=${encodeURIComponent(a.lot_code)}">Bag details ↗</a><a href="#buyer-${encodeURIComponent(key)}">↑ Buyer</a></div><span class="receipt ${j?.status==='submitted'?'sent':['failed','uncertain'].includes(j?.status)?'problem':''}">${escape(label)}${j?.station_name?' · '+escape(j.station_name):''}</span></div></article>`;}).join('')}</div></section>`;
  }).join('')||'<p class="empty">No captured items match this view.</p>';
  for(const a of rows){const host=document.querySelector(`[data-photos="${a.id}"]`);if(host)window.liveBagPhotos.load(host,a.lot_id,openPhoto,{showEmpty:true});}
  for(const b of document.querySelectorAll('[data-print]'))b.onclick=async()=>{b.disabled=true;try{const sale=rows.find(a=>a.id===b.dataset.print);const result=await printBag(sale.lot_id);status(result.mode==='remote-queue'?`Bag #${sale.sku} queued at ${result.stationName}.`:'Label sent to local download helper.');await refresh();}catch(e){status(e.message,true);}finally{b.disabled=false;}};
 }
 async function refresh(){if(loading||!authorized||!currentSession)return;loading=true;try{data=await rpc('get_tiktok_live_dashboard',{_session_id:currentSession});try{receipts=await rpc('get_tiktok_live_bag_print_status',{_event_id:data.connection.event_id});}catch{receipts=[];}render();}catch(e){status(e.message,true);}finally{loading=false;}}
 async function loadShows(){const r=await sb.from('tiktok_live_connections').select('*').order('linked_at',{ascending:false}).limit(500);if(r.error)throw r.error;connections=r.data;$('shows').replaceChildren(new Option('Choose a show',''),...connections.map(c=>new Option(c.title+' · '+time(c.started_at||c.linked_at),c.session_id)));const linked=connections.find(c=>c.event_id===eventId);if(linked)currentSession=linked.session_id;else if(!eventId&&!currentSession)currentSession=connections[0]?.session_id||null;$('shows').value=currentSession||'';if(currentSession)await refresh();else if(eventId&&stream){$('setup').hidden=false;$('setup-title').textContent=stream.title||'TikTok Live';$('setup-description').textContent=stream.start_label||'Choose the seller for this show. Historical sales are saved; automatic printing starts with new sales.';}}
 window.addEventListener('message',async e=>{if(e.source!==window||e.origin!==location.origin||e.data?.type!=='TIKTOK_LIVE_BATCH')return;const {id,payload}=e.data;if(!/^[0-9a-f-]{36}$/i.test(id||''))return;try{if(!authorized)throw Error('Sign in to Invsto.');if(payload?.event_id!==eventId)throw Error('Wrong TikTok show.');if(!currentSession)throw Error('Choose the seller for this TikTok show.');await rpc('ingest_tiktok_live_events',{_event_id:eventId,_events:payload.events,_health:payload.health});window.postMessage({type:'TIKTOK_LIVE_ACK',id,ok:true},location.origin);await refresh();}catch(error){window.postMessage({type:'TIKTOK_LIVE_ACK',id,ok:false,error:error.message},location.origin);}});
 $('setup-form').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{if(!stream||!eventId)throw Error('Start capture from the TikTok console.');const s=await rpc('start_tiktok_live_capture',{_event_id:eventId,_primary_seller_employee_id:$('seller').value,_stream:stream});currentSession=s.id;$('setup').hidden=true;await loadShows();}catch(error){$('setup-status').textContent=error.message;}finally{b.disabled=false;}};
 $('shows').onchange=()=>{currentSession=$('shows').value;data=null;rendered='';void refresh();};if(isCapture)$('shows').disabled=true;
 $('search').oninput=()=>render();$('payment').onchange=()=>render();$('refresh').onclick=()=>refresh();$('printer').onclick=async()=>{try{const chosen=await window.printStations.chooseDestination({copies:1,configureOnly:true});const {data:auth}=await sb.auth.getSession();localStorage.setItem('invsto.live.bagPrinter.v1.'+auth.session.user.id,JSON.stringify({...chosen,copies:1}));status('Bag-label printer saved.');}catch(e){status(e.message,true);}};
 $('report').onclick=()=>window.print();$('photo-close').onclick=()=>$('photo-dialog').close();window.addEventListener('live-bag-photo-saved',()=>{rendered='';void refresh();});
 async function init(){try{const r=await sb.auth.getSession();if(!r.data?.session){$('signin').hidden=false;throw Error('Sign in to Invsto, then refresh this receiver.');}employees=await rpc('get_live_sale_seller_directory');if(!employees.length)throw Error('An active inventory staff account is required.');authorized=true;$('seller').replaceChildren(new Option('Choose seller',''),...employees.map(e=>new Option(e.display_name||e.email,e.id)));await loadShows();if(!data){$('connection-title').textContent='Ready for TikTok capture';status('Start capture in the TikTok LIVE console.');}if(isCapture)document.title='TikTok capture receiver · Invsto';}catch(e){status(e.message,true);}}
 void init();setInterval(refresh,5000);
})();
