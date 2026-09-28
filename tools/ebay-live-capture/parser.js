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
  function parse(doc, cache = {}, now = new Date()) {
    const observed_at = now.toISOString();
    const events = [];
    let supported=true;
    const elapsedText = text(doc.querySelector('#metric-elapsed-time-value'));
    const elapsedParts = elapsedText.split(':').map(Number);
    const elapsed = /^\d+:\d{2}:\d{2}$/.test(elapsedText) ? elapsedParts[0]*3600+elapsedParts[1]*60+elapsedParts[2] : null;
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
      if (distinct.length && ((buyer && amount !== null) || distinct.some(k=>k==='failed'||k==='cancelled'))) {
        const kind = distinct.length === 1 ? distinct[0] : 'unknown';
        events.push({key:key(['listing',listing_id,buyer,amount,kind]),source:'listing',kind,listing_id,title,ordinal,buyer,amount,currency:'USD',observed_at,evidence:statuses.join(' / ')});
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
    return {events, cache, supported, panelPresent: !!panel, elapsed};
  }
  root.InvstoLiveParser = {parse,status,money,key};
})(typeof globalThis !== 'undefined' ? globalThis : window);
