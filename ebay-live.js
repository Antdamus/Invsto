(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = value => value == null ? 'Missing data' : new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value);
  let api, data={connection:null,attempts:[],unmatched:[]}, loadedSession, lastRead=0, lastReconcile=0, loading, busy=false, sessionError=false;
  const session = () => api?.state.currentSession?.id;
  const linked = () => !!data.connection && loadedSession===session();
  const current = () => api?.state.currentLot?.id ? data.attempts.find(a=>a.lot_id===api.state.currentLot.id) : null;
  const fresh = () => linked() && !sessionError && Date.now()-lastRead<12000 && data.connection.capture_ready && Date.parse(data.connection.source_seen_at)>Date.now()-30000;
  const verified = a => a && Date.parse(a.verified_at)>Date.now()-120000;
  const ready = a => a?.payment_state==='paid' && !a.closed_at && !a.resolved_at && (fresh() || verified(a));
  const message = (text,error=false) => {const el=$('ebay-live-message');if(el){el.textContent=text;el.classList.toggle('is-error',error);}};
  async function rpc(name,args) {const {data,error}=await window.supabase.rpc(name,args);if(error)throw Error(error.message);return data;}
  async function refresh() {
    if(!api || !session()) {loadedSession=null;data={connection:null,attempts:[],unmatched:[]};render();return;}
    if(loading) {await loading;if(loadedSession!==session())return refresh();return;}
    const id=session();
    loading=(async()=>{
      try {
        const result=await rpc('get_ebay_live_dashboard',{_session_id:id});
        if(id!==session())return;
        data=result;loadedSession=id;lastRead=Date.now();sessionError=false;
        if(data.connection && Date.now()-lastReconcile>15000) {
          lastReconcile=Date.now();
          await rpc('reconcile_ebay_live_orders',{_event_id:data.connection.event_id});
          const updated=await rpc('get_ebay_live_dashboard',{_session_id:id});
          if(id===session()) data=updated;
        }
        render();api.updateGate();
      } catch(error) {sessionError=true;message('Live queue unavailable: '+error.message,true);api.updateGate();}
    })();
    try{await loading;}finally{loading=null;}
  }
  function totals(rows,field) {const known=rows.filter(a=>a[field]!=null);return {sum:known.reduce((v,a)=>v+Number(a[field]),0),missing:rows.length-known.length};}
  function render() {
    if(!api)return;
    const c=linked()?data.connection:null;
    $('ebay-live-setup').hidden=!!c;
    $('ebay-live-connected').hidden=!c;
    $('ebay-live-session-hint').textContent=session()?'Link this show to its eBay event.':'Start or select a show session below, then link its eBay event.';
    $('ebay-link').disabled=!session() || busy;
    if(!c)return;
    const health=$('ebay-live-health');
    health.textContent=fresh()?'Capture connected · checking about every 2 seconds':data.unmatched.length?'Needs review · unmatched notifications':'Capture paused or disconnected · new scans require payment verification';
    health.classList.toggle('is-error',!fresh());
    $('ebay-live-event').textContent='eBay event '+c.event_id;
    const rows=data.attempts;
    const done=rows.filter(a=>a.payment_state==='paid'&&a.closed_at&&!a.resolved_at);
    const min=totals(done,'above_minimum'),profit=totals(done,'estimated_profit');
    $('ebay-live-totals').innerHTML=`<div><span>Paid + bag closed</span><strong>${done.length} / ${money(done.reduce((v,a)=>v+Number(a.amount),0))}</strong></div><div><span>Above minimum</span><strong>${money(min.sum)}</strong><small>${min.missing} bags missing minimum prices</small></div><div><span>Estimated profit</span><strong>${money(profit.sum)}</strong><small>${profit.missing} bags missing costs or expense estimates</small></div>`;
    const sellers=new Map();for(const a of done){const key=a.seller_name||'Unassigned';if(!sellers.has(key))sellers.set(key,[]);sellers.get(key).push(a);}
    $('ebay-live-seller-totals').innerHTML=[...sellers].map(([name,entries])=>{const t=totals(entries,'above_minimum');return `<p><b>${escape(name)}</b>: ${entries.length} bags · ${money(entries.reduce((n,a)=>n+Number(a.amount),0))} sold · ${money(t.sum)} above minimum${t.missing?` (${t.missing} incomplete)`:''}</p>`;}).join('')||'<p>No closed, paid bags yet.</p>';
    const counts={ready:rows.filter(a=>a.payment_state==='paid'&&!a.closed_at&&!a.resolved_at).length,waiting:rows.filter(a=>a.payment_state==='waiting'&&!a.resolved_at).length,attention:rows.filter(a=>['failed','review','cancelled'].includes(a.payment_state)&&!a.resolved_at).length,closed:rows.filter(a=>a.closed_at||a.resolved_at).length};
    for(const opt of $('ebay-live-filter').options){const label={ready:'Paid / ready',waiting:'Waiting for payment',attention:'Failed / needs review',closed:'Closed / resolved',all:'All auctions'}[opt.value];opt.textContent=label+(counts[opt.value]!=null?` (${counts[opt.value]})`:'');}
    const filter=$('ebay-live-filter').value;
    const visible=rows.filter(a=> filter==='all' || (filter==='ready'&&a.payment_state==='paid'&&!a.closed_at&&!a.resolved_at) || (filter==='waiting'&&a.payment_state==='waiting'&&!a.resolved_at) || (filter==='attention'&&['failed','review','cancelled'].includes(a.payment_state)&&!a.resolved_at) || (filter==='closed'&&(a.closed_at||a.resolved_at)));
    const html=visible.map(a=>{
      const mine=a.claimed_by===api.state.user.id,held=a.claimed_by&&!mine;
      const needsBagCheck=['failed','review','cancelled'].includes(a.payment_state)&&a.lot_id&&!a.resolved_at;
      const state=a.resolved_at?'Resolved':needsBagCheck?'STOP · check this bag':a.closed_at&&a.payment_state==='paid'?'Paid · bag closed':({waiting:'Waiting for payment',paid:'Payment confirmed',failed:'Payment failed',cancelled:'Cancelled',review:'Payment needs review'}[a.payment_state]);
      const time=a.stream_offset_seconds==null?'':` · approx. stream ${Math.floor(a.stream_offset_seconds/60)}:${String(a.stream_offset_seconds%60).padStart(2,'0')}`;
      return `<article class="ebay-auction ${needsBagCheck?'needs-review':''}" data-attempt="${escape(a.id)}"><div class="ebay-auction-head"><strong>${escape(a.listing_title)}</strong><b>${money(a.amount)}</b></div><p>${escape(a.buyer)} · ${escape(a.seller_name||'Unassigned seller')}</p><span class="ebay-state">${escape(state)}</span><small>${escape(a.win_time_label||'Time not captured')}${escape(time)} · Listing ${escape(a.listing_id)}</small>${a.review_note?`<p>${escape(a.review_note)}</p>`:''}${a.lot_id?`<p>${Number(a.units||0)} inventory units · Minimum ${money(a.minimum_total)}${held?' · Claimed by another scanner':''}</p>`:''}<div class="button-row">${!a.resolved_at&&!a.closed_at&&a.payment_state==='paid'?`<button type="button" data-action="scan" ${!ready(a)||held?'disabled':''}>${mine?'Continue scanning':'Scan sold item'}</button>`:''}${a.closed_at&&a.payment_state==='paid'&&!a.resolved_at?'<button type="button" data-action="print">Print bag label</button>':''}${!a.resolved_at?'<button type="button" class="secondary-btn" data-action="review">Payment / bag review</button>':''}</div></article>`;
    }).join('')||'<p>No auctions in this view.</p>';
    // Do not replace controls under a finger every two seconds.
    if($('ebay-live-queue').innerHTML!==html)$('ebay-live-queue').innerHTML=html;
    $('ebay-live-unmatched').hidden=!data.unmatched.length;
    $('ebay-live-unmatched-count').textContent=`${data.unmatched.length} notifications need review`;
    const unknownHtml=data.unmatched.map((o,i)=>`<article class="ebay-auction"><strong>${escape(o.listing_title||'Unrecognized notification')}</strong><p>${escape(o.evidence||o.kind)}</p><button type="button" data-observation="${i}">Review notification</button></article>`).join('');
    if($('ebay-live-unmatched-list').innerHTML!==unknownHtml)$('ebay-live-unmatched-list').innerHTML=unknownHtml;
    const active=current();$('ebay-live-current').hidden=!active;
    $('ebay-live-current').textContent=active?`${active.payment_state==='paid'?'Scanning':'STOP — payment needs review'}: ${active.listing_title} · ${active.buyer} · ${money(active.amount)}`:'';
  }
  function applyGate() {
    if(!api)return;
    const connected=linked();
    document.body.classList.toggle('ebay-live-linked',connected);
    if($('auction-number'))$('auction-number').readOnly=connected;
    if($('generate-live-label'))$('generate-live-label').textContent=connected?'Close paid bag':'Confirm Auction + Print Label';
    const banner=$('ebay-scan-payment-banner');
    if(banner){const a=current();banner.hidden=!connected||!a;banner.textContent=a ? (ready(a)?`Paid: ${a.listing_title} · ${a.buyer} · ${money(a.amount)}`:`STOP: ${a.listing_title} — ${a.payment_state==='paid'?'capture is stale; verify payment':'payment '+a.payment_state}. Review this auction above before continuing.`) : '';banner.classList.toggle('is-error',!!a&&!ready(a));}
    if(connected || sessionError) {
      const a=current();const can=ready(a)&&a.claimed_by===api.state.user.id&&!busy;
      if(!can)for(const id of ['item-scan','scan-item','manual-live-item-category','manual-live-item-quantity','manual-live-item-description','add-manual-live-item','generate-live-label'])$(id)?.setAttribute('disabled','');
      for(const id of ['bag-owner-select','label-bag-owner-select'])$(id)?.setAttribute('disabled','');
      if(connected&&api.state.currentLot&&!a)message('Choose a paid auction above before scanning.',true);
    }
  }
  async function prepare() {
    await refresh();
    if(sessionError) return true;
    if(!linked())return false;
    if(api.state.currentLot && !current())api.clearBag();
    api.updateGate();return true;
  }
  async function closeCurrent() {
    if(!linked())return false;
    await action(async()=>{
      const a=current();if(!a)throw Error('Choose a paid auction first.');
      await rpc('close_ebay_live_bag',{_attempt_id:a.id});
      api.clearBag();$('ebay-live-filter').value='closed';message('Bag closed. You can print its label below or select the next paid auction.');
      await refresh();$('ebay-live-panel').scrollIntoView({block:'start',behavior:'smooth'});
    });return true;
  }
  async function action(fn) {if(busy)return;busy=true;api.updateGate();try{await fn();}catch(e){message(e.message,true);}finally{busy=false;render();api.updateGate();}}
  function showReview(a) {
    const dialog=$('ebay-live-review');dialog.dataset.attempt=a?.id||'';dialog.dataset.observation='';
    $('ebay-review-title').textContent=a?`${a.listing_title} · ${a.buyer}`:'Review notification';
    $('ebay-review-note').value='';$('ebay-review-physical').checked=false;
    $('ebay-review-action').innerHTML='<option value="verify_paid">I verified this payment on eBay</option><option value="cancel_release">Resolve locally and release bag contents</option>'+(api.state.employee.role==='admin'?'<option value="release_claim">Release scanner claim</option>':'');
    $('ebay-review-match-label').hidden=true;$('ebay-review-check-label').hidden=false;
    $('ebay-review-error').textContent='';dialog.showModal();
  }
  async function init(bridge) {
    api=bridge;
    const section=document.createElement('section');section.className='live-panel ebay-live-panel';section.id='ebay-live-panel';
    section.innerHTML=`<div class="panel-head"><div><span class="eyebrow">eBay Live</span><h2>Paid auction queue</h2></div><button type="button" id="ebay-live-refresh" class="secondary-btn">Refresh queue</button></div><p id="ebay-live-message" role="status"></p><details id="ebay-capture-help"><summary>Set up the capture computer</summary><ol><li><a href="downloads/Invsto-Live-Capture.zip" download>Download Invsto Live Capture</a> on the dedicated computer and extract the ZIP.</li><li>In Edge open Extensions → Manage extensions, turn on Developer mode, choose Load unpacked, and select the extracted folder containing manifest.json. Chrome works the same way.</li><li>Open <a href="live-sales.html?capture=1" target="_blank" rel="noopener">this capture receiver</a> in the same browser, sign in, and select this show. Keep it open.</li><li>Open the eBay Stream Manager event. Click Start Invsto capture. Keep that window visible and the computer awake; capture uses its Activity and Sold tabs.</li><li>On your phone, open Live Sales and select the same show. Wait for Capture connected, then scan a paid auction.</li></ol><p>The helper reads visible titles, buyers, prices, payment badges and timestamps. It never places bids, starts auctions, cancels eBay orders or stores your passwords. Unknown notifications pause scanning until reviewed.</p></details><div id="ebay-live-setup"><p id="ebay-live-session-hint"></p><label>eBay Stream Manager event URL<input id="ebay-live-url" type="url" placeholder="https://www.ebay.com/ebaylive/host/events/..." /></label><button id="ebay-link" type="button">Link selected show</button></div><div id="ebay-live-connected" hidden><small id="ebay-live-event"></small><p id="ebay-live-health" role="status"></p><p id="ebay-live-current" class="ebay-current" hidden></p><div id="ebay-live-totals" class="ebay-live-totals"></div><p class="ebay-help">Totals count paid, closed bags only. Above minimum is not net profit. Estimated profit subtracts recorded item cost and the expense estimates below. Missing values are excluded, not treated as zero.</p><details><summary>Seller totals</summary><div id="ebay-live-seller-totals"></div></details><details id="ebay-live-settings"><summary>Active seller and expense estimates</summary><p>The selected seller is assigned to newly captured auctions. Start capture before the show for accurate attribution.</p><label>Seller on air<select id="ebay-live-seller"></select></label><div id="ebay-expenses"><label>Estimated eBay fee (%)<input id="ebay-fee-percent" type="number" min="0" max="100" step="0.01"></label><label>Fixed fee per auction ($)<input id="ebay-fee-fixed" type="number" min="0" step="0.01"></label><label>Shipping cost per auction ($)<input id="ebay-shipping" type="number" min="0" step="0.01"></label><p>These are estimates per auction, not final eBay payouts. Enter 0 explicitly where appropriate.</p></div><button type="button" id="ebay-save-settings">Save settings</button></details><details id="ebay-live-unmatched" hidden><summary id="ebay-live-unmatched-count"></summary><div id="ebay-live-unmatched-list"></div></details><label>Show auctions<select id="ebay-live-filter"><option value="ready">Paid / ready</option><option value="attention">Failed / needs review</option><option value="waiting">Waiting for payment</option><option value="closed">Closed / resolved</option><option value="all">All auctions</option></select></label><div id="ebay-live-queue"></div></div><dialog id="ebay-live-review"><h2 id="ebay-review-title"></h2><p>Confirm payment in eBay. Resolving here does not cancel an eBay order. If items were scanned, physically remove them from the bag before releasing inventory.</p><label>Action<select id="ebay-review-action"></select></label><label id="ebay-review-match-label" hidden>Affected auction<select id="ebay-review-match"></select></label><label>Evidence / reason<textarea id="ebay-review-note" rows="3" minlength="10" placeholder="What did you verify on eBay or check in the bag?"></textarea></label><label id="ebay-review-check-label"><input id="ebay-review-physical" type="checkbox"> I checked the physical bag and removed any items being released.</label><p id="ebay-review-error" role="alert"></p><div class="button-row"><button type="button" id="ebay-review-save">Save review</button><button type="button" id="ebay-review-cancel" class="secondary-btn">Back</button></div></dialog>`;
    document.querySelector('.live-summary-strip').after(section);
    const scanBanner=document.createElement('p');scanBanner.id='ebay-scan-payment-banner';scanBanner.className='ebay-current';scanBanner.hidden=true;scanBanner.setAttribute('role','status');$('scan-stage').prepend(scanBanner);
    $('ebay-live-refresh').onclick=()=>refresh();$('ebay-live-filter').onchange=render;
    $('ebay-link').onclick=()=>action(async()=>{
      const url=new URL($('ebay-live-url').value.trim());
      const id=url.hostname==='www.ebay.com'&&url.pathname.match(/^\/ebaylive\/(?:host\/)?events\/([\w-]{6,100})\/?$/)?.[1];
      if(!id)throw Error('Paste the eBay Stream Manager event URL.');
      await rpc('link_ebay_live_event',{_session_id:session(),_event_id:id});await refresh();await prepare();message('Show linked. Start capture on the dedicated computer.');
    });
    $('ebay-live-settings').ontoggle=()=>{if(!$('ebay-live-settings').open||!linked())return;const c=data.connection;$('ebay-live-seller').innerHTML=api.state.employees.map(e=>`<option value="${escape(e.id)}">${escape(e.display_name)}</option>`).join('');$('ebay-live-seller').value=c.active_seller_id;$('ebay-expenses').hidden=api.state.employee.role!=='admin';for(const [id,key] of [['ebay-fee-percent','fee_percent'],['ebay-fee-fixed','fee_fixed'],['ebay-shipping','shipping_per_sale']])$(id).value=c[key]??'';};
    $('ebay-save-settings').onclick=()=>action(async()=>{const val=id=>api.state.employee.role!=='admin'||$(id).value.trim()===''?null:Number($(id).value);await rpc('configure_ebay_live_event',{_event_id:data.connection.event_id,_seller_id:$('ebay-live-seller').value,_fee_percent:val('ebay-fee-percent'),_fee_fixed:val('ebay-fee-fixed'),_shipping:val('ebay-shipping')});await refresh();message('Seller and expense estimates saved.');});
    $('ebay-live-queue').onclick=e=>{const button=e.target.closest('[data-action]');if(!button)return;const a=data.attempts.find(a=>a.id===button.closest('[data-attempt]').dataset.attempt);if(!a)return;
      if(button.dataset.action==='review'){showReview(a);return;}
      action(async()=>{if(button.dataset.action==='scan'){const lot=await rpc('claim_ebay_live_bag',{_attempt_id:a.id});await api.openBag(Array.isArray(lot)?lot[0]:lot);await refresh();message('Payment confirmed. Scan the item, review the bag, then close it.');$('scan-stage').scrollIntoView({block:'start',behavior:'smooth'});}else if(button.dataset.action==='print'){await api.printBag(a.lot_id);} });
    };
    $('ebay-live-unmatched-list').onclick=e=>{const b=e.target.closest('[data-observation]');if(!b)return;const o=data.unmatched[Number(b.dataset.observation)];showReview();$('ebay-live-review').dataset.observation=o.source_key;$('ebay-review-title').textContent=o.evidence||o.listing_title;$('ebay-review-action').innerHTML='<option value="notification">Record notification review</option>';$('ebay-review-match-label').hidden=false;$('ebay-review-check-label').hidden=true;$('ebay-review-match').innerHTML='<option value="">No auction affected (explain below)</option>'+data.attempts.filter(a=>!a.resolved_at).map(a=>`<option value="${escape(a.id)}">${escape(a.listing_title)} · ${escape(a.buyer)} · ${money(a.amount)}</option>`).join('');};
    $('ebay-review-cancel').onclick=()=>$('ebay-live-review').close();
    $('ebay-review-save').onclick=async()=>{
      const button=$('ebay-review-save');button.disabled=true;
      try {const note=$('ebay-review-note').value.trim();if(note.length<10)throw Error('Describe your verification (at least 10 characters).');const d=$('ebay-live-review');
        if(d.dataset.observation)await rpc('resolve_ebay_live_observation',{_event_id:data.connection.event_id,_key:d.dataset.observation,_attempt_id:$('ebay-review-match').value||null,_note:note});
        else {const act=$('ebay-review-action').value;if(act==='cancel_release'&&!$('ebay-review-physical').checked)throw Error('Check the physical bag before releasing inventory.');await rpc('resolve_ebay_live_attempt',{_attempt_id:d.dataset.attempt,_action:act,_note:note});if(act==='cancel_release'&&current()?.id===d.dataset.attempt)api.clearBag();}
        d.close();await refresh();message('Review saved. Reruns appear as separate auction attempts.');
      }catch(e){$('ebay-review-error').textContent=e.message;}finally{button.disabled=false;}
    };
    window.addEventListener('message',async e=>{
      if(new URL(location.href).searchParams.get('capture')!=='1'||e.source!==window||e.origin!==location.origin||e.data?.type!=='INVSTO_LIVE_BATCH')return;
      const {id,payload}=e.data;try{
        if(!linked()||data.connection.event_id!==payload?.event_id)throw Error('Select and link the matching show in the Invsto receiver.');
        await rpc('ingest_ebay_live_events',{_event_id:payload.event_id,_events:payload.events,_health:payload.health});
        window.postMessage({type:'INVSTO_LIVE_ACK',id,ok:true},location.origin);await refresh();
      }catch(error){window.postMessage({type:'INVSTO_LIVE_ACK',id,ok:false,error:error.message},location.origin);message(error.message,true);}
    });
    setInterval(()=>refresh(),2000);
  }
  window.ebayLive={init,prepare,refresh,linked,applyGate,closeCurrent,current,reviewCurrent:()=>{const a=current();if(a)showReview(a);else message('Choose an eBay auction to review.',true);}};
})();
