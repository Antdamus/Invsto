// Whatnot Seller API v2. Read-only: never create labels, cancel orders or change stock.
export const BASE = 'https://api.whatnot.com/seller-api/rest/v2';
export const ID = /^[1-9][0-9]{0,18}$/;
export class WhatnotError extends Error {}
export function identifier(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw new WhatnotError('Whatnot returned an invalid identifier.');
  return value;
}
export function safeUrl(value) {
  if (!value) return null;
  try { const u = new URL(value); return u.protocol === 'https:' && ['whatnot.com','www.whatnot.com'].includes(u.hostname) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
export function money(value) {
  if (!value || typeof value.amount !== 'string' || !/^\d+(\.\d{1,6})?$/.test(value.amount) || !/^[A-Z]{3}$/.test(value.currency)) throw new WhatnotError('Whatnot returned an invalid amount.');
  return {amount:value.amount,currency:value.currency};
}
export function date(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new WhatnotError('Whatnot returned an invalid date.');
  return value;
}
export function mapOrder(order, items, shipments, show = null) {
  const id = identifier(order.id);
  if (!['pending','pending_fulfillment','completed','cancelled','failed'].includes(order.status)) throw new WhatnotError('Unknown Whatnot order status. Sync stopped for review.');
  if (!Array.isArray(items) || !items.length) throw new WhatnotError(`Order ${id} has no readable items. Retry the sync.`);
  const seen = new Set();
  const lines = items.map(item => {
    identifier(item.id);
    if (item.order_id !== id || seen.has(item.id) || !Number.isSafeInteger(item.quantity) || item.quantity < 1) throw new WhatnotError('Whatnot returned inconsistent order items.');
    seen.add(item.id);
    const shipment = item.shipment_id ? shipments.get(identifier(item.shipment_id)) : null;
    if (item.shipment_id && !shipment) throw new WhatnotError('A shipment could not be verified. The order was not imported.');
    // Replacement IDs are not package coverage. Only use the exact item.shipment_id.
    const current = shipment && !shipment.replacement_shipment_id && !String(shipment.status).startsWith('cancelled');
    const unit = money(item.unit_price);
    const due = current ? date(shipment.dropoff_due) : null;
    return {id:item.id,order_id:id,title:item.purchased_item?.title || 'Title not provided',sku:item.purchased_item?.sku || null,
      product_id:item.product_id || null,quantity:item.quantity,unit_price:unit.amount,currency:unit.currency,
      shipment_id:item.shipment_id || null,shipment_url:safeUrl(shipment?.url),shipment_status:shipment?.status || null,
      tracking_number:current ? shipment.tracking?.tracking_code || shipment.tracking?.last_mile_tracking_code || null : null,
      last_mile_tracking:current ? shipment.tracking?.last_mile_tracking_code || null : null,carrier:current ? shipment.tracking?.carrier || null : null,
      // API defines dropoff_due as the due calendar day at seller-local midnight, not a cutoff instant.
      ship_by_date:due?.slice(0,10) || null,dropoff_due:due,
      holds:shipment?.required_actions || [],replacement_shipment_id:shipment?.replacement_shipment_id || null};
  });
  const totals = Object.fromEntries(['subtotal','shipping','tax','total'].map(k => [k,money(order.amounts?.[k])]));
  if (new Set(Object.values(totals).map(v=>v.currency)).size !== 1 || lines.some(l=>l.currency!==totals.total.currency)) throw new WhatnotError('The order contains inconsistent currencies.');
  return {id,url:safeUrl(order.url),status:order.status,buyer_id:order.buyer?.id || null,
    username:order.buyer?.username || null,customer_name:order.buyer?.display_name || null,
    purchased_at:date(order.created_at),source_updated_at:date(order.updated_at),cancelled_at:date(order.cancelled_at),
    currency:totals.total.currency,subtotal:totals.subtotal.amount,shipping:totals.shipping.amount,tax:totals.tax.amount,total:totals.total.amount,
    show_id:order.show_id || null,show_title:show?.title || null,show_url:safeUrl(show?.url),lines};
}
export function client(token, {fetcher=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  if (typeof token !== 'string' || !/^wn_pat_tk_[A-Za-z0-9._-]{12,}$/.test(token)) throw new WhatnotError('Enter a valid Whatnot personal access token.');
  let lastCall = 0;
  async function read(path, query={}) {
    if (!/^\/(users\/me|orders(?:\/[1-9][0-9]*(?:\/items)?)?|shipments\/[1-9][0-9]*|shows\/[a-fA-F0-9-]+)$/.test(path)) throw new WhatnotError('Unsupported Whatnot request.');
    const url = new URL(BASE+path);url.search=new URLSearchParams(query).toString();
    for (let attempt=0;attempt<4;attempt++) {
      await sleep(Math.max(0,180-(Date.now()-lastCall)));lastCall=Date.now();
      let response;
      try { response = await fetcher(url,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},signal:AbortSignal.timeout(20000),redirect:'error'}); }
      catch { throw new WhatnotError('Whatnot could not be reached. Sync will retry without skipping orders.'); }
      if ((response.status===429 || response.status>=500) && attempt<3) {
        const retry=Math.min(15000,Math.max(1000,Number(response.headers.get('Retry-After')||0)*1000,2**attempt*1000));await sleep(retry);continue;
      }
      if (response.status===401) throw new WhatnotError('Whatnot authorization expired or was revoked. Reconnect the account.');
      if (response.status===403) throw new WhatnotError('Whatnot denied access. The token needs Read orders, Read shipments, Read customers and Read shows.');
      if (!response.ok) throw new WhatnotError(`Whatnot request failed (${response.status}). No orders were skipped.`);
      try { return await response.json(); } catch { throw new WhatnotError('Whatnot returned an unreadable response.'); }
    }
  }
  async function page(path,cursor=null,limit=50) {
    const p=await read(path,{limit:String(limit),reverse:'true',...(cursor?{cursor}:{})});
    if (!Array.isArray(p.data) || (p.next_cursor!=null && (typeof p.next_cursor!=='string' || p.next_cursor===cursor || p.next_cursor.length>2048))) throw new WhatnotError('Whatnot returned an invalid page cursor.');
    return p;
  }
  async function items(id) {
    const all=[],seen=new Set();let cursor=null;
    do {const p=await page(`/orders/${identifier(id)}/items`,cursor);all.push(...p.data);cursor=p.next_cursor;if(cursor&&seen.has(cursor))throw new WhatnotError('Whatnot repeated an item cursor.');seen.add(cursor);if(all.length>10000)throw new WhatnotError('Order item limit exceeded; review this order.');} while(cursor);
    return all;
  }
  return {read,page,items};
}
export async function seal(value,keyText) {
  const key=await crypto.subtle.importKey('raw',Uint8Array.from(atob(keyText),c=>c.charCodeAt(0)),'AES-GCM',false,['encrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12));const bytes=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(value)));
  const b64=b=>btoa(String.fromCharCode(...b));return `v1.${b64(iv)}.${b64(bytes)}`;
}
export async function unseal(value,keyText) {
  const [,iv,data]=value.split('.'),bytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
  const key=await crypto.subtle.importKey('raw',bytes(keyText),'AES-GCM',false,['decrypt']);
  return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(iv)},key,bytes(data)));
}
