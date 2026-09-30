(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = value => value == null ? 'Not entered' : Number(value).toLocaleString('en-US',{style:'currency',currency:'USD'});
  const date = value => value ? new Date(value).toLocaleString() : 'Not recorded';
  const elapsed = value => value == null ? 'Not recorded' : `${Math.floor(Number(value)/60)}:${String(Number(value)%60).padStart(2,'0')}`;
  const one = value => Array.isArray(value) ? value[0] : value;
  const active = row => ['reserved','packed'].includes(row.status) && Number(row.quantity)>0;
  let sb, current = null, generation = 0, printing = false, orderConnections = null;

  function status(text, error = false) { $('bag-status').textContent=text; $('bag-status').classList.toggle('is-error',error); }
  function clear() { orderConnections?.dispose(); orderConnections=null; current=null; $('bag-result').hidden=true; $('bag-result').replaceChildren(); $('bag-photo-dialog').close(); $('bag-photo').removeAttribute('src'); }
  function controls(enabled) { for(const id of ['bag-code','bag-find','bag-camera']) $(id).disabled=!enabled; }
  async function checked(query) { const {data,error}=await query; if(error)throw error; return data; }
  async function authorize() {
    const {data,error}=await sb.auth.getSession();
    if(error)throw error;
    if(!data?.session)throw new Error('Sign in to Invsto to view bag details.');
    const employee=await checked(sb.from('employees').select('id,active').eq('user_id',data.session.user.id).maybeSingle());
    if(!employee || employee.active===false)throw new Error('An active staff account is required to view bags.');
    $('bag-sign-in').hidden=true; controls(true);
  }
  function itemCard(row) {
    const item=one(row.item)||{}, location=one(row.source_location)||{};
    const title=row.manual ? row.item_category : item.title || 'Inventory item';
    const description=row.manual ? row.item_description : item.description;
    return `<article class="bag-item"><button type="button" class="bag-thumb" data-photo="${escape(row.id)}" aria-label="View photo of ${escape(title)}" disabled>No photo</button><div><strong>${escape(title)}</strong>${description?`<p>${escape(description)}</p>`:''}<p>Qty ${Number(row.quantity)} · ${row.manual?'Manual item':escape(item.barcode||'No barcode')}</p><small>Minimum per unit: ${escape(money(row.live_unit_minimum))}</small><small>${escape(row.status)}${location.location_name?` · ${escape(location.location_name)}`:''}</small><small>Live minute ${escape(elapsed(row.show_elapsed_seconds))} · ${escape(date(row.scanned_at||row.created_at))}</small></div></article>`;
  }
  async function photoUrl(row) {
    const item=one(row.item)||{};
    const path=row.manual ? row.photo_path : (Array.isArray(item.photos)?item.photos.find(Boolean):'')||item.photo_url;
    if(!path)return '';
    if(/^https?:\/\//i.test(path))return path;
    const {data,error}=await sb.storage.from('photos').createSignedUrl(String(path).replace(/^photos\//,''),3600);
    return error?'':data?.signedUrl||'';
  }
  function render(record) {
    const {lot,auction,rows,sellers}=record, session=one(lot.session)||{};
    const identity=window.liveBagLabel.identity(lot,auction);
    const contents=rows.filter(active),removed=rows.filter(row=>!active(row));
    const units=contents.reduce((n,row)=>n+Number(row.quantity),0);
    const missing=contents.filter(row=>row.live_unit_minimum==null||!Number.isFinite(Number(row.live_unit_minimum))).length;
    const minimum=contents.length&&!missing?contents.reduce((n,row)=>n+Math.round(Number(row.live_unit_minimum)*100)*Number(row.quantity),0):null;
    const qualifies=auction?.payment_state==='paid'&&!auction.resolved_at&&!['cancelled','released'].includes(lot.status);
    const margin=qualifies&&minimum!=null?Math.round(Number(auction.amount)*100)-minimum:null;
    const closed=lot.closed_at||auction?.closed_at;
    const seller=sellers.find(s=>s.id===(auction?.seller_id||lot.owner_employee_id));
    const sellerName=seller?.display_name||seller?.email||lot.owner_snapshot?.display_name||lot.owner_snapshot?.email||'Unassigned';
    const payment=auction?({paid:'Payment confirmed',waiting:'Waiting for payment',failed:'Payment failed',cancelled:'Cancelled',review:'Payment needs review'}[auction.payment_state]||'Payment unknown'):'No linked eBay payment';
    const bagState=['cancelled','released','packed'].includes(lot.status)?lot.status:closed?'Closed':'Open · being filled';
    $('bag-result').innerHTML=`<section class="bag-card"><p class="bag-eyebrow">${auction?'eBay auction':'Auction bag'}</p><h2>${identity.auctionNumber?`#${escape(identity.auctionNumber)}`:'Auction number not captured'}</h2><p>${escape(identity.title)}</p><p class="bag-winner">Winner: <strong>${escape(auction?.buyer||'Not recorded')}</strong></p><div class="bag-tags"><span>${escape(bagState)}</span><span>${escape(payment)}</span>${auction?.resolved_at?'<span>Resolved · excluded from running result</span>':''}</div><dl><div><dt>Bag ID</dt><dd>${escape(lot.lot_code)}</dd></div><div><dt>Sold by</dt><dd>${escape(sellerName)}</dd></div><div><dt>Sale price</dt><dd>${escape(money(auction?.amount))}</dd></div><div><dt>Total break-even</dt><dd>${minimum==null?'Not complete':money(minimum/100)}</dd></div><div><dt>Above / below break-even</dt><dd class="${margin==null?'':margin<0?'negative':'positive'}">${margin==null?'Not available':`${margin<0?'-':'+'}${money(Math.abs(margin)/100)}`}</dd></div><div><dt>Contents</dt><dd>${units} unit${units===1?'':'s'} · ${contents.length} entr${contents.length===1?'y':'ies'}</dd></div></dl><p>${missing?`${missing} item entr${missing===1?'y is':'ies are'} missing a minimum price. `:''}${!contents.length?'No items saved in this bag. ':''}${!closed?'Open-bag results are provisional. ':''}Result compares the sale price with saved minimums; fees are not deducted separately.</p><details><summary>Show and timing</summary><dl><div><dt>Show</dt><dd>${escape(session.title||session.session_code||'Not recorded')}</dd></div><div><dt>Session</dt><dd>${escape(session.session_code||'Not recorded')} · ${escape(session.status||'')}</dd></div><div><dt>Show started</dt><dd>${escape(date(session.started_at))}</dd></div><div><dt>Auction time</dt><dd>${escape(auction?.win_time_label||'Not captured')}</dd></div><div><dt>Stream minute</dt><dd>${escape(elapsed(auction?.stream_offset_seconds))}${auction?.stream_offset_seconds!=null&&auction.time_estimated?' (estimated)':''}</dd></div><div><dt>Bag created</dt><dd>${escape(date(lot.created_at))}</dd></div><div><dt>Bag closed</dt><dd>${escape(date(closed))}</dd></div><div><dt>eBay listing</dt><dd>${escape(auction?.listing_id||'Not linked')}</dd></div></dl>${lot.notes?`<p>${escape(lot.notes)}</p>`:''}${auction?.review_note?`<p>Payment review: ${escape(auction.review_note)}</p>`:''}</details><div class="bag-actions"><button id="bag-print" type="button" ${['cancelled','released'].includes(lot.status)?'disabled':''}>Print bag label</button></div><small>DYMO 30299 · choose the computer and matching label roll. The label shows the auction number and a shortened winner name. Both QR codes identify this bag.</small></section><section class="bag-card"><h3>Bag contents</h3>${contents.length?contents.map(itemCard).join(''):'<p>No items saved yet.</p>'}</section>${removed.length?`<details class="bag-card"><summary>Removed / released items (${removed.length})</summary><p>These entries are outside the current bag contents and totals.</p>${removed.map(itemCard).join('')}</details>`:''}`;
    $('bag-result').hidden=false;
    const connections=document.createElement('section');
    connections.className='bag-card';
    $('bag-result').children[0].after(connections);
    orderConnections=window.bagOrderLinks.mount({container:connections,client:sb,lot});
    orderConnections.load();
    $('bag-print').onclick=print;
    for(const row of rows) {
      const button=$('bag-result').querySelector(`[data-photo="${CSS.escape(row.id)}"]`);
      photoUrl(row).then(url=>{
        if(!url||current!==record||!button?.isConnected)return;
        const title=row.manual?row.item_category:one(row.item)?.title||'Item photo';
        const img=new Image();img.alt=title;img.src=url;button.replaceChildren(img);button.disabled=false;
        button.onclick=()=>{$('bag-photo').src=url;$('bag-photo').alt=title;$('bag-photo-title').textContent=title;$('bag-photo-dialog').showModal();};
      }).catch(()=>{});
    }
  }
  async function lookup() {
    const token=++generation;
    clear();
    const term=$('bag-code').value.trim().toUpperCase();
    try {
      await authorize();
      if(token!==generation)return null;
      if(!term){status('Scan a bag QR or enter its LIVE bag ID.');return null;}
      if(!/^LIVE-[A-Z0-9]{1,40}$/.test(term))throw new Error('Use the unique LIVE bag ID. On an older label, scan the other QR beside that ID; an auction number alone can match more than one show.');
      status('Loading bag details…');
      const lot=await checked(sb.from('live_sale_lots').select('*,session:live_sale_sessions(id,title,session_code,status,started_at)').eq('lot_code',term).maybeSingle());
      if(!lot)throw new Error('No accessible bag matched that ID. Check the label and try again.');
      const results=await Promise.all([
        checked(sb.from('live_sale_lot_items').select('*,item:item_id(title,description,barcode,photos,photo_url),source_location:source_location_id(location_name)').eq('lot_id',lot.id).order('scanned_at')),
        checked(sb.from('live_sale_manual_lot_items').select('*').eq('lot_id',lot.id).order('created_at')),
        checked(sb.from('ebay_live_attempts').select('*').eq('lot_id',lot.id).maybeSingle()),
        checked(sb.rpc('get_live_sale_seller_directory')),
      ]);
      if(token!==generation)return null;
      current={lot,rows:[...(results[0]||[]),...(results[1]||[]).map(row=>({...row,manual:true}))],auction:results[2],sellers:results[3]||[]};
      $('bag-code').value=lot.lot_code;
      history.replaceState(null,'',window.liveBagLabel.url(lot.lot_code));
      render(current);
      status(`Saved bag details · Updated ${new Date().toLocaleTimeString()}`);
      return current;
    } catch(error) {
      if(token!==generation)return null;
      clear(); status(error.message||'Could not load bag details. Try again.',true);
      if(/sign in|staff account/i.test(error.message||'')){$('bag-sign-in').hidden=false;controls(false);}
      return null;
    }
  }
  async function print() {
    if(printing||!current)return;
    printing=true;$('bag-print').disabled=true;
    try {
      // Re-read payment/identity before printing a label from an older open page.
      const record=await lookup();
      if(!record)return;
      $('bag-print').disabled=true;
      if(['cancelled','released'].includes(record.lot.status))throw new Error('This bag was cancelled or released. Review it in Live Sales before printing.');
      const identity=window.liveBagLabel.identity(record.lot,record.auction);
      const result=await window.printStations.printLabel(window.liveBagLabel.build(identity),{filename:`Invsto_Bag_${record.lot.lot_code}_Copies_1.dymo`,copies:1,title:identity.title,barcode:record.lot.lot_code});
      status(result.mode==='remote-queue'?`Label queued for ${result.stationName}. Check Print stations for delivery status.`:'Label downloaded for the local helper.');
    } catch(error) { status(error.message||'Could not print the label.',true); }
    finally { printing=false;if($('bag-print'))$('bag-print').disabled=['cancelled','released'].includes(current?.lot.status); }
  }
  document.addEventListener('DOMContentLoaded',async()=>{
    sb=window.supabase?.auth?window.supabase:await new Promise(resolve=>document.addEventListener('supabase-ready',()=>resolve(window.supabase),{once:true}));
    $('bag-code').value=new URLSearchParams(location.search).get('bag')||'';
    $('bag-search').onsubmit=event=>{event.preventDefault();if(!printing)lookup();};
    $('bag-refresh').onclick=()=>{if(!printing)lookup();};
    $('bag-photo-close').onclick=()=>$('bag-photo-dialog').close();
    sb.auth.onAuthStateChange?.((_event,session)=>{if(!session){++generation;clear();controls(false);$('bag-sign-in').hidden=false;status('Sign in to Invsto to view bag details.',true);}});
    await lookup();
  });
})();
