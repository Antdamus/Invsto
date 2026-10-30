(function(root){
  'use strict';
  const h=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const valid=v=>Number.isFinite(Date.parse(v));
  const parts=value=>Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).map(p=>[p.type,p.value]));
  const dateKey=p=>`${p.year}-${p.month}-${p.day}`;
  function schedule(start,seller){
    if(!valid(start))return {label:seller||'Host not recorded',day:'Date not recorded',estimated:!seller};
    const p=parts(start),hour=Number(p.hour)+Number(p.minute)/60;
    let day=dateKey(p),slot=hour>=9&&hour<13?'morning':hour>=13&&hour<17?'afternoon':hour>=17.5||hour<6?'evening / overnight':'show';
    if(hour<6)day=new Date(Date.parse(`${day}T12:00:00Z`)-86400000).toISOString().slice(0,10);
    const host=seller||(slot==='morning'||slot==='afternoon'?'Sydney':slot==='evening / overnight'?'Otello':'Host unconfirmed');
    return {label:`${host} · ${slot}`,day,estimated:!seller};
  }
  function eventFromReceipt(url){try{const u=new URL(url);return /(^|\.)ebay\.com$/.test(u.hostname)?u.pathname.match(/\/ebaylive\/events\/([^/]+)/)?.[1]||null:null;}catch{return null;}}
  function titleNumber(title){const m=String(title||'').match(/^\s*#\s*(\d+)\b/);return m?Number(m[1]):null;}
  function resolve(row,evidence){
    const shows=new Map(evidence.shows.map(s=>[s.event_id,s]));
    const exact=evidence.attempts.filter(a=>a.order_line_id===row.id&&!a.merged_into);
    const ids=[...new Set(exact.map(a=>a.event_id).filter(Boolean))],receipt=eventFromReceipt(row.videoUrl);
    if(receipt&&!ids.includes(receipt))ids.push(receipt);
    if(ids.length===1){const a=exact.find(a=>a.event_id===ids[0]),show=shows.get(ids[0])||{event_id:ids[0],title:'Recorded live show',started_at:a?.sold_at||row.sortDate};return {show,confirmed:true,reason:receipt?'Saved video receipt':'Captured sale linked to this order line',number:titleNumber(row.title)??a?.ordinal,sequenceNumber:a?.ordinal};}
    if(ids.length>1)return {reason:'Conflicting show evidence; review required',conflict:true};
    // Membership is only accepted with a sold listing AND a purchase inside the show window.
    // Listings can be reused in multiple events; ambiguous membership never silently picks one.
    const sale=Date.parse(row.sortDate),matches=evidence.listings.filter(l=>l.item_number===row.item&&/^sold\b/i.test(l.listing_status||'')).map(l=>({l,show:shows.get(l.event_id)})).filter(({show})=>{
      if(!show||!valid(show.started_at)||!Number.isFinite(sale))return false;
      const start=Date.parse(show.started_at),s=schedule(show.started_at),duration=/Sydney/.test(s.label)?4*3600000:16*3600000;
      const finish=valid(show.ended_at)?Math.min(Date.parse(show.ended_at),start+duration):start+duration;
      return sale>=start-15*60000&&sale<=finish;
    });
    const unique=[...new Map(matches.map(m=>[m.show.event_id,m])).values()];
    if(unique.length===1)return {show:unique[0].show,confirmed:true,reason:'Sold listing matched to eBay event and purchase time',number:titleNumber(row.title)??unique[0].l.ordinal,sequenceNumber:unique[0].l.ordinal};
    if(unique.length>1)return {reason:'Listing appears in more than one possible show',conflict:true};
    return {reason:/as\s+seen\s+on\s+(?:the\s+)?screen|\blive\s+(?:auction|show)\b/i.test(row.title)?'Live item title; show not recovered':'No live-show evidence',likelyLive:/as\s+seen\s+on\s+(?:the\s+)?screen|\blive\s+(?:auction|show)\b/i.test(row.title)};
  }
  function attach(model,evidence){
    evidence={shows:[],attempts:[],listings:[],history:[],...evidence};
    const groups=new Map(),excluded=[],unassigned=[];
    for(const row of model.rows){
      const recovered=evidence.history.find(o=>o.order_number===row.orderNumber&&String(o.buyer_username).toLowerCase()===model.username.toLowerCase());
      if(recovered&&valid(recovered.purchased_at)){row.sortDate=recovered.purchased_at;row.date=root.OGMissingReport.date(recovered.purchased_at);row.historyVerifiedAt=recovered.captured_at;const purchase=row.timeline.find(e=>e.label==='Purchased');if(purchase){purchase.at=Date.parse(recovered.purchased_at);purchase.text=row.date;}}
      const match=resolve(row,evidence);
      if(!match.show){(match.likelyLive||match.conflict?unassigned:excluded).push({...row,mapReason:match.reason});continue;}
      const show=match.show,s=schedule(show.started_at,show.seller_name),key=`show-${show.event_id}`;
      row.showMap={...match,key,label:s.label,day:s.day,hostEstimated:s.estimated};
      if(!row.videoUrl&&/^[A-Za-z0-9_-]{1,128}$/.test(show.event_id)&&/^\d{9,15}$/.test(row.item||''))row.videoUrl=`https://www.ebay.com/ebaylive/events/${encodeURIComponent(show.event_id)}/stream?${new URLSearchParams({playback:'true',selectedItemId:row.item,itemIds:row.item})}`;
      if(!groups.has(key))groups.set(key,{key,show,...s,rows:[]});groups.get(key).rows.push(row);
    }
    const mapped=[...groups.values()].sort((a,b)=>String(a.show.started_at).localeCompare(String(b.show.started_at)));
    for(const g of mapped){g.rows.sort((a,b)=>(a.showMap.number??Infinity)-(b.showMap.number??Infinity)||a.sortDate.localeCompare(b.sortDate));g.quantity=g.rows.reduce((sum,r)=>sum+r.price.quantity,0);}
    model.orderMap={groups:mapped,unassigned,excluded,coverage:evidence.coverage,warning:evidence.warning};
    model.rows=mapped.flatMap(g=>g.rows);model.title='Live show order map';model.count=model.rows.length;model.orderCount=new Set(model.rows.map(r=>r.orderId)).size;
    model.pending=model.count;model.closed=0;model.overdue=model.rows.filter(r=>r.deadline.level==='overdue').length;model.today=model.rows.filter(r=>r.deadline.level==='today').length;
    model.labeled=model.rows.filter(r=>r.shippingLabel.attached).length;model.unlabeled=model.count-model.labeled;model.itemValue=root.OGBuyerReport.totalsFor(model.rows);
    model.unknownPrices=model.rows.filter(r=>r.price.total==null).length;return model;
  }
  async function pages(make){let rows=[];for(let offset=0;;offset+=500){const r=await make().range(offset,offset+499);if(r.error)throw r.error;rows.push(...r.data);if(r.data.length<500)return rows;}}
  async function load(client,model,progress){
    let coverage,warning='';
    try{for(let n=0;n<100;n++){
      progress(`Recovering eBay history${coverage?` · ${coverage.orders} orders checked`:''}…`);
      const r=await client.functions.invoke('ebay-order-map-history',{body:coverage?.runId?{runId:coverage.runId}:{}});
      if(r.error||r.data?.error)throw Error(r.data?.error||r.error.message);
      coverage=r.data;if(coverage.complete)break;
    }if(!coverage?.complete)throw Error('History capture is still incomplete. Refresh to continue.');}
    catch(e){warning=`History refresh incomplete: ${e.message}. Saved evidence is shown below.`;}
    progress('Matching pending items to recorded shows…');
    const shows=await pages(()=>client.from('ebay_show_catalog').select('*').order('event_id'));
    const connections=await pages(()=>client.from('ebay_live_connections').select('event_id,session_id,stream_start_at').order('event_id'));
    const attempts=[];for(let start=0;start<model.rows.length;start+=100){const r=await client.from('ebay_live_attempts').select('event_id,order_line_id,ordinal,sold_at,merged_into').in('order_line_id',model.rows.slice(start,start+100).map(r=>r.id));if(r.error)throw r.error;attempts.push(...r.data);}
    const listings=[];const items=[...new Set(model.rows.map(r=>r.item).filter(Boolean))];for(let start=0;start<items.length;start+=100){listings.push(...await pages(()=>client.from('ebay_show_listing_evidence').select('*').in('item_number',items.slice(start,start+100)).order('event_id').order('item_number')));}
    const history=await pages(()=>client.from('ebay_order_map_history').select('*').ilike('buyer_username',model.username.replace(/[\\%_]/g,'\\$&')).order('order_number'));
    const sessionIds=[...new Set(connections.map(c=>c.session_id).filter(Boolean))];const sessions=[];
    for(let start=0;start<sessionIds.length;start+=100){const r=await client.from('live_sale_sessions').select('id,title,seller_snapshot').in('id',sessionIds.slice(start,start+100));if(r.error)throw r.error;sessions.push(...r.data);}
    for(const c of connections){const session=sessions.find(s=>s.id===c.session_id),saved=shows.find(s=>s.event_id===c.event_id),seller=session?.seller_snapshot?.primary;const sellerName=typeof seller==='string'?seller:seller?.name||seller?.full_name||seller?.display_name;
      if(saved)saved.seller_name=sellerName;else if(c.stream_start_at)shows.push({event_id:c.event_id,title:session?.title||'Captured live show',started_at:c.stream_start_at,seller_name:sellerName});}
    return {shows,attempts,listings,history,coverage,warning};
  }
  function renderIndex(model){const m=model.orderMap,shared=root.OGMissingReport;
    return `<section id="item-index" class="order-map"><div class="section-title"><span>02 / YOUR SHOW ROUTE</span><h2>One buyer. Every show.</h2><p>${m.groups.length} matched shows · ${model.count} pending item lines · ${m.groups.reduce((s,g)=>s+g.quantity,0)} units. Select an item to inspect its evidence.</p></div><p class="scope-note">Only pending purchases with live-show evidence appear on this map. Host names marked “schedule estimate” follow your usual show schedule; Sydney’s sessions normally last about three hours. Overnight shows belong to the preceding evening. Show membership and host identification are separate.</p>${m.warning?`<p class="verification">${h(m.warning)}</p>`:''}${m.coverage?.complete?`<p class="map-coverage">eBay history checked: ${h(shared.date(m.coverage.since))} through ${h(shared.date(m.coverage.until))} · ${m.coverage.orders} orders captured across all buyers.</p>`:''}
      <nav class="show-directory" aria-label="Show directory">${m.groups.map(g=>`<a href="#${h(g.key)}"><span>${h(g.day)}</span><strong>${h(g.label)}</strong><small>${g.rows.length} item lines · ${g.quantity} units</small></a>`).join('')}</nav>
      ${m.groups.map((g,i)=>`<section class="show-stop" id="${h(g.key)}"><header><span class="stop-number">${String(i+1).padStart(2,'0')}</span><div><div class="eyebrow">${h(g.day)} · ${g.estimated?'HOST: SCHEDULE ESTIMATE':'RECORDED HOST'}</div><h3>${h(g.label)}</h3><p>${h(g.show.title)}</p><small>Show started ${h(shared.date(g.show.started_at))} · ${g.rows.length} item lines / ${g.quantity} units</small></div><a href="https://www.ebay.com/ebaylive/events/${encodeURIComponent(g.show.event_id)}" target="_blank" rel="noopener">Show ↗</a></header><nav class="map-items">${g.rows.map(r=>`<a href="#purchase-${h(r.id)}" class="${r.deadline.level}"><span class="map-number">${r.showMap.number==null?'No #':`#${r.showMap.number}`}</span><span><strong>${h(r.title)}</strong><small>Order ${h(r.orderNumber)} · Qty ${r.price.quantity} · Purchased ${h(r.date)}</small><small>${h(r.shippingLabel.label)}</small></span><span class="map-amount"><strong>${h(shared.money(r.price.total,r.price.currency))}</strong><small>${h(root.OGCustomerReport.urgency(r))}</small><small>Ship by ${h(r.deadline.dueEastern||'Not recorded')}</small></span></a>`).join('')}</nav><a class="map-back" href="#item-index">↑ Show directory</a></section>`).join('')}
      ${!model.count?'<p class="empty-report">No pending items can currently be matched to a live show for this buyer.</p>':''}
      ${m.unassigned.length?`<aside class="map-unassigned"><h3>Live items needing a show match · ${m.unassigned.length}</h3><p>These are outside the route until their show is verified.</p>${m.unassigned.map(r=>`<p><a href="${h(r.orderUrl)}" target="_blank" rel="noopener">Order ${h(r.orderNumber)} · ${h(r.title)}</a><small>${h(r.mapReason)}</small></p>`).join('')}</aside>`:''}
      <p class="scope-note">${m.excluded.length} other pending item lines have no live-show evidence and are excluded. <a href="ebay-buyer-report.html?buyer=${encodeURIComponent(model.username)}&scope=pending">See all pending purchases ↗</a></p></section>`;
  }
  const api={schedule,eventFromReceipt,titleNumber,resolve,attach,load,renderIndex};root.OGOrderMap=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
