/* Parse only visible Stream Manager evidence. Never infer payment from an auction win. */
(function (root) {
  'use strict';
  const text = node => (node?.textContent || '').replace(/\s+/g, ' ').trim();
  const part = (node, name) => node?.querySelector(`[class*="_${name}_"]`);
  const money = value => {
    const match = String(value).match(/^(?:US\s*)?\$([\d,]+\.\d{2})$/);
    return match ? Number(match[1].replace(/,/g, '')) : null;
  };
  // A reversible key keeps collisions out of deduplication. Server caps its length.
  const key = values => values.map(v => encodeURIComponent(String(v ?? ''))).join('|');
  const status = value => {
    const v = value.toLowerCase().trim();
    if (v === 'won the auction') return 'won';
    if (/^(paid|payment successful|payment received|payment completed)$/.test(v)) return 'paid';
    if (/^(payment failed|payment failure|payment declined|failed to pay)$/.test(v)) return 'failed';
    if (/^(cancelled|canceled|order cancelled|order canceled)$/.test(v)) return 'cancelled';
    return 'unknown';
  };
  // eBay's terminal control, not a frozen/zero clock or a chat message.
  const hasEnded = doc => [...doc.querySelectorAll('button[disabled]')].some(button => text(button)==='Event ended' && !button.closest('#activity-panel,[role="log"],[role="region"]'));
  function parse(doc, cache = {}, now = new Date()) {
    const observed_at = now.toISOString();
    const events = [];
    let supported=true;
    const elapsedText = text(doc.querySelector('#metric-elapsed-time-value'));
    const elapsedParts = elapsedText.split(':').map(Number);
    const broadcastEnded=hasEnded(doc);
    const elapsed = !broadcastEnded && /^\d+:\d{2}:\d{2}$/.test(elapsedText) ? elapsedParts[0]*3600+elapsedParts[1]*60+elapsedParts[2] : null;
    for (const tile of doc.querySelectorAll('[data-testid="listing-tile"]')) {
      const listing_id = tile.querySelector('[data-testid^="checkbox-"]')?.dataset.testid?.match(/^checkbox-(\d{8,20})$/)?.[1];
      const title = text(tile.querySelector('[data-testid="inline-edit-title"]'));
      const ordinal = tile.querySelector('[data-testid="ordinal-id"]')?.value || '';
      if (!listing_id || !title) {supported=false;continue;}
      cache[listing_id] = {listing_id, title, ordinal};
      const buyer = part(tile, 'soldLabel')?.getAttribute('title')?.trim() || '';
      const amount = money(text(part(tile, 'price')));
      const statuses = [text(part(tile, 'statusPill')), text(part(tile, 'statusText'))].filter(Boolean);
      const kinds = statuses.map(status).filter(k => k !== 'unknown');
      const distinct = [...new Set(kinds)];
      if (amount !== null || distinct.some(k=>k==='failed'||k==='cancelled')) {
        const kind = distinct.length === 1 ? distinct[0] : 'unknown';
        events.push({key:key(['listing',listing_id,buyer,amount,kind]),source:'listing',kind,payment_snapshot:true,listing_id,title,ordinal,buyer,amount,currency:'USD',observed_at,evidence:statuses.join(' / ')});
      }
    }
    const panel = doc.querySelector('#activity-panel');
    for (const row of panel?.querySelectorAll('[class*="_rowContent_"]') || []) {
      const line = part(row, 'messageLine');
      const buyer = text(part(row, 'username'));
      const time_label = text(part(row, 'timestamp'));
      const title = text(part(row, 'listingTitle'));
      const actionNode = [...(line?.children || [])].find(n => /_action/.test(n.className));
      const action = text(actionNode);
      const amount = money(text(part(row, 'itemSummary')?.firstElementChild));
      const kind = status(action);
      const matches = Object.values(cache).filter(t => t.title === title);
      const listing = matches.length === 1 ? matches[0] : {};
      const event = {key:key(['activity',buyer,title,amount,time_label,action]),source:'activity',kind,...listing,title,buyer,amount,currency:'USD',time_label,observed_at,evidence:text(row).slice(0,1000)};
      // The clock is minute precision: provide an estimate, never an exact replay timestamp.
      const clock = time_label.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (elapsed !== null && clock) {
        const at = new Date(now); at.setHours(Number(clock[1])%12 + (/PM/i.test(clock[3]) ? 12 : 0),Number(clock[2]),0,0);
        if (at > now) at.setDate(at.getDate()-1);
        const offset = Math.floor(elapsed-(now-at)/1000);
        if (offset >= 0) event.stream_offset_seconds = offset;
      }
      if (text(row)) events.push(event);
    }
    const counts=new Map();
    for(const e of events.filter(e=>e.source==='activity'))counts.set(e.key,(counts.get(e.key)||0)+1);
    for(const [k,count] of counts)if(count>1)events.push({key:'ambiguous|'+k,kind:'unknown',source:'activity',observed_at,evidence:'Identical auction notifications cannot be distinguished. Verify each auction attempt on eBay.'});
    return {events, cache, supported, panelPresent: !!panel, elapsed, broadcastEnded};
  }
  function streamMetadata(doc) {
    const start=doc.querySelector('input#startDate'), zone=doc.querySelector('input#timezone'), title=doc.querySelector('input#title');
    if (!start || !zone || !title) return null;
    if ([start,zone,title].some(input=>input.defaultValue && input.defaultValue!==input.value)) throw Error('Save or discard your Event information edits before starting capture');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start.value) || !zone.value.trim()) return null;
    return {source:'ebay_event_information',start_local:start.value,timezone_label:zone.value.trim(),title:title.value.trim().slice(0,200),activity_timezone:Intl.DateTimeFormat().resolvedOptions().timeZone};
  }
  // The named list can be the tall inner virtualizer, not the element that
  // actually scrolls. Find the overflow viewport before falling back to it.
  function scrollContainer(node,boundary) {
    let named=null,overflow=null;
    for(let el=node;el&&el!==el.ownerDocument.body&&el!==el.ownerDocument.documentElement;el=el.parentElement){
      if(el.clientHeight>0){
        const style=el.ownerDocument.defaultView?.getComputedStyle(el);
        if(/^(auto|scroll|overlay)$/.test(style?.overflowY||'')){
          if(el.scrollHeight>el.clientHeight+3)return el;
          overflow ||= el;
        }
        if(String(el.className).includes('_list_'))named ||= el;
      }
      if(el===boundary)break;
    }
    return overflow||named;
  }
  function historyContainers(doc) {
    const activityPanel=doc.querySelector('#activity-panel');
    const activity=scrollContainer(activityPanel?.querySelector('[class*="_rowContent_"]')?.parentElement||activityPanel?.querySelector('[class*="_list_"]')||activityPanel,activityPanel);
    const listings=scrollContainer(doc.querySelector('[data-testid="listing-tile"]')?.parentElement);
    return {activity,listings};
  }
  // Record only capture layout/scroll metadata, never page HTML, messages,
  // input values, cookies or credentials. This also works when UI support is unavailable.
  function captureDiagnostics(doc) {
    const containers=historyContainers(doc);
    const describe=(start,selected)=>{
      const nodes=[];
      for(let el=start;el&&el!==doc.body&&el!==doc.documentElement&&nodes.length<8;el=el.parentElement){
        const style=doc.defaultView?.getComputedStyle(el);
        nodes.push({tag:el.tagName.toLowerCase(),classes:String(el.className||'').slice(0,160),selected:el===selected,
          top:Math.round(el.scrollTop),height:el.scrollHeight,viewport:el.clientHeight,overflow:style?.overflowY||''});
      }
      return nodes;
    };
    const panel=doc.querySelector('#activity-panel');
    const tiles=[...doc.querySelectorAll('[data-testid="listing-tile"]')];
    const controls=[...doc.querySelectorAll('button,[role="button"]')].filter(el=>el.getClientRects().length)
      .map(el=>({label:text(el),disabled:el.disabled===true||el.getAttribute('aria-disabled')==='true'}))
      .filter(el=>/^(?:[0-9]{1,3}|Next(?: page)?|Previous(?: page)?|Load more|Show more)$/i.test(el.label)).slice(0,12);
    return {protocol:1,visibility:doc.visibilityState,
      tile_ids:tiles.map(tile=>tile.querySelector('[data-testid^="checkbox-"]')?.dataset.testid?.match(/^checkbox-(\d{8,20})$/)?.[1]).filter(Boolean).slice(0,80),
      activity_rows:panel?.querySelectorAll('[class*="_rowContent_"]').length||0,
      search_active:[...doc.querySelectorAll('input[type="search"],input[placeholder*="search" i]')].some(el=>!!el.value.trim()),
      listings:describe(tiles[0]?.parentElement,containers.listings),
      activity:describe(panel?.querySelector('[class*="_rowContent_"]')?.parentElement||panel,containers.activity),controls};
  }
  // A pass means every viewport was read after it settled, not just that a list
  // was scrolled to its bottom. Counts describe listings, not auction attempts.
  function createHistoryTracker(runId) {
    const sold=new Set(),wins=new Set(),evidence=new Map(),states={};let expected=null,lastNew=0,lastPhase='reading',ended=false;
    const reset=()=>{for(const state of Object.values(states)){state.passes=0;state.target=0;state.signature=null;state.changed=0;state.moved=false;}};
    function advance(name,node,signature,now) {
      if(!node || node.clientHeight<=0)return false;
      let state=states[name];
      if(!state || state.node!==node){
        state=states[name]={node,height:node.scrollHeight,maxHeight:node.scrollHeight,viewport:node.clientHeight,passes:0,target:0,signature:null,changed:now,moved:false};
      }else if(state.height!==node.scrollHeight || state.viewport!==node.clientHeight){
        // eBay remeasures virtual rows when buyer/payment details load. Keep
        // moving forward instead of returning to the first cards on every resize.
        // A new largest extent or viewport requires fresh complete passes;
        // ordinary estimate fluctuations must not invalidate every later pass.
        if(node.scrollHeight>state.maxHeight+3 || state.viewport!==node.clientHeight)state.passes=0;
        state.height=node.scrollHeight;state.maxHeight=Math.max(state.maxHeight,node.scrollHeight);state.viewport=node.clientHeight;
        state.target=Math.min(state.target,Math.max(0,node.scrollHeight-node.clientHeight));
        state.signature=null;state.changed=now;
      }
      if(!state.moved || Math.abs(node.scrollTop-state.target)>3){node.scrollTop=state.target;state.moved=true;state.signature=null;state.changed=now;return true;}
      if(state.signature!==signature){state.signature=signature;state.changed=now;return true;}
      if(now-state.changed<1200)return true;
      const bottom=Math.max(0,node.scrollHeight-node.clientHeight);
      if(state.target>=bottom-3){state.passes=Math.min(2,state.passes+1);state.target=0;}
      else state.target=Math.min(bottom,state.target+node.clientHeight*0.65);
      node.scrollTop=state.target;state.signature=null;state.changed=now;
      return true;
    }
    function observe(doc,parsed,{canRead,reason='waiting',now=Date.now()}={}) {
      const soldTab=[...doc.querySelectorAll('[role="tab"]')].find(el=>/^Sold(?:\s|\(|$)/i.test(text(el)));
      const count=text(soldTab).match(/^Sold\s*\(([\d,]+)\)$/i);
      const total=count?Number(count[1].replace(/,/g,'')):null;
      if(parsed.broadcastEnded&&!ended){ended=true;sold.clear();wins.clear();reset();lastNew=now;}
      let added=expected!==total;
      if(added){expected=total;sold.clear();reset();lastNew=now;}
      const tileIds=[...doc.querySelectorAll('[data-testid="listing-tile"]')].map(tile=>tile.querySelector('[data-testid^="checkbox-"]')?.dataset.testid?.match(/^checkbox-(\d{8,20})$/)?.[1]).filter(Boolean);
      const soldSelected=soldTab?.getAttribute('aria-selected')==='true';
      if(soldSelected)for(const id of tileIds)if(!sold.has(id)){sold.add(id);added=true;}
      for(const event of parsed.events)if(event.kind==='won'&&!wins.has(event.key)){wins.add(event.key);added=true;}
      for(const event of parsed.events){const signature=JSON.stringify([event.listing_id,event.kind,event.buyer,event.amount]);if(evidence.get(event.key)!==signature){evidence.set(event.key,signature);added=true;}}
      if(added){lastNew=now;if(lastPhase==='read'||lastPhase==='needs_review')reset();}
      let layout=true;
      if(ended&&canRead){
        const {activity,listings:list}=historyContainers(doc);
        const activitySignature=JSON.stringify(parsed.events.filter(e=>e.source==='activity').map(e=>[e.key,e.listing_id]));
        layout=advance('activity',activity,activitySignature,now);
        const listingSignature=JSON.stringify(parsed.events.filter(e=>e.source==='listing').map(e=>[e.key,e.listing_id]))+tileIds.join('|');
        if(list&&list!==doc.body)layout=advance('listings',list,listingSignature,now)&&layout;
        else if(soldSelected&&expected!==null&&tileIds.length===expected){
          // All Sold listings fit without a scrolling container.
          const panel=soldTab.closest('[role="tablist"]')?.parentElement;
          layout=advance('listings',panel,listingSignature,now)&&layout;
        }else layout=false;
      }
      const activityPasses=states.activity?.passes||0,listingPasses=states.listings?.passes||0;
      let phase=!ended?'live':!canRead?(lastPhase==='read'&&!added?'read':'paused'):!layout?'needs_review':activityPasses<2||listingPasses<2||now-lastNew<5000?'reading':expected===null||sold.size!==expected?'needs_review':'read';
      lastPhase=phase;
      return {protocol:1,run_id:runId,phase,sold_expected:expected,sold_seen:sold.size,observed_wins:wins.size,live_sales:money(text(doc.querySelector('#metric-live-sales-value'))),activity_passes:activityPasses,listing_passes:listingPasses,reason:!canRead?reason:!layout?'layout':phase==='needs_review'?'counts':null};
    }
    return {observe};
  }
  root.InvstoLiveParser = {parse,status,money,key,hasEnded,streamMetadata,createHistoryTracker,historyContainers,captureDiagnostics};
})(typeof globalThis !== 'undefined' ? globalThis : window);
