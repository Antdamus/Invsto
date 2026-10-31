import {mapOrder, ORDER_PATH, sha256} from './tiktok.ts';

const check = (result: any) => { if (result.error) throw Error('Could not save TikTok sync progress. Retry shortly.'); return result.data; };

export function orderPage(data: any, previousCursor?: string | null) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('TikTok returned an invalid order page.');
  const cursor = data.next_page_token;
  if (cursor != null && typeof cursor !== 'string') throw Error('TikTok returned an invalid page cursor.');
  if (cursor && cursor === previousCursor) throw Error('TikTok repeated its page cursor. Retry shortly.');
  // A successful zero-result response can omit orders. Only an explicit zero
  // with no next page proves it is safe to finish this window.
  const emptyResult = data.orders == null && data.total_count === 0 && !cursor;
  if (!Array.isArray(data.orders) && !emptyResult) throw Error('TikTok returned an invalid order page. No sync progress was advanced.');
  if (data.total_count != null && (!Number.isSafeInteger(data.total_count) || data.total_count < 0)) throw Error('TikTok returned an invalid order count.');
  const orders: any[] = emptyResult ? [] : data.orders;
  if (orders.length && data.total_count === 0) throw Error('TikTok returned an inconsistent order count.');
  if (!orders.length && cursor) throw Error('TikTok returned an empty page with more results. No sync progress was advanced.');
  return {orders, nextCursor:cursor || null, omittedEmptyOrders:emptyResult};
}

// Shared with regression tests: only fully validated and imported pages may
// move the saved checkpoint. Errors leave the original window/cursor intact.
export async function syncOrderPage(db: any, c: any, workerToken: string, api: any, accessToken: string, now = Date.now()) {
  const query: Record<string,string> = {shop_cipher:c.shop_cipher,page_size:'50',sort_field:'update_time',sort_order:'ASC'};
  if (c.page_token) query.page_token = c.page_token;
  const page = orderPage(await api.read(ORDER_PATH, accessToken, query, {update_time_ge:Math.floor(Date.parse(c.window_from)/1000),update_time_lt:Math.floor(Date.parse(c.window_to)/1000)}), c.page_token);
  const existing = page.orders.length ? check(await db.from('tiktok_orders').select('order_number,buyer_username,api_buyer_id').in('order_number',page.orders.map(o => o.id))) : [];
  const buyerIds = page.orders.map(o => o.user_id).filter(Boolean);
  const knownBuyers = buyerIds.length ? check(await db.from('tiktok_orders').select('buyer_username,api_buyer_id').in('api_buyer_id',buyerIds)) : [];
  const names = new Map<string,string>(knownBuyers.map((o: any) => [o.api_buyer_id,o.buyer_username]));
  for (const order of page.orders) { const old = existing.find((o: any) => o.order_number === order.id); if (old) names.set(order.user_id,old.buyer_username); }
  const batches = page.orders.map(order => mapOrder(order,names.get(order.user_id)));
  for (const rows of batches) {
    const hash = await sha256(JSON.stringify({shop:c.shop_id,rows}));
    check(await db.rpc('import_tiktok_api_order',{_token:workerToken,_rows:rows,_hash:hash}));
  }
  const more = Boolean(page.nextCursor);
  const changes = more ? {page_token:page.nextCursor,next_sync_at:new Date(now).toISOString()} : {page_token:null,window_from:null,window_to:null,cursor_at:c.window_to,last_synced_at:new Date(now).toISOString(),next_sync_at:new Date(now+300000).toISOString()};
  const updated = check(await db.from('tiktok_api_connection').update({...changes,last_error:null,dispatch_token:null,lease_until:null,claimed:false}).eq('singleton',true).eq('dispatch_token',workerToken).select('singleton'));
  if (updated.length !== 1) throw Error('TikTok sync lease expired. The page will be retried.');
  return {ok:true,orders_read:batches.length,more,empty_result:page.omittedEmptyOrders};
}

export function syncInProgress(c: any, now = Date.now()) {
  return Boolean(c.enabled && (c.lease_until && Date.parse(c.lease_until)>now || c.page_token && !c.last_error));
}
