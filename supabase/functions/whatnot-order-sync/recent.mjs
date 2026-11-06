// A separate cursor keeps new sales current while a large history import runs.
// Recent pages are newest first, as documented by Whatnot's List orders API.
export async function syncRecentOrders(db, connection, token, api, importOrder, now = Date.now()) {
  const last = Date.parse(connection.recent_synced_at || '');
  if (!connection.recent_page_cursor && Number.isFinite(last) && now - last < 300000) return {more:false,read:0};
  const continuing = Boolean(connection.recent_page_cursor);
  const start = continuing ? Date.parse(connection.recent_sync_started_at) : now;
  const from = continuing ? Date.parse(connection.recent_sync_from) : Date.parse(connection.recent_synced_at || connection.connected_at) - 300000;
  if (!Number.isFinite(start) || !Number.isFinite(from)) throw Error('Whatnot recent-order checkpoint is invalid.');
  const page = await api.page('/orders', connection.recent_page_cursor || null, 30);
  if (!Array.isArray(page.data) || (!page.data.length && page.next_cursor)) throw Error('Whatnot returned an incomplete recent order page.');
  let reachedBoundary = false, read = 0;
  for (const order of page.data) {
    const created = Date.parse(order.created_at);
    if (!Number.isFinite(created)) throw Error('Whatnot returned an order without a valid purchase time.');
    if (created < from) { reachedBoundary = true; continue; }
    await importOrder(order); read++;
  }
  const more = Boolean(page.next_cursor && !reachedBoundary);
  const changes = more
    ? {recent_page_cursor:page.next_cursor,recent_sync_started_at:new Date(start).toISOString(),recent_sync_from:new Date(from).toISOString()}
    : {recent_page_cursor:null,recent_sync_started_at:null,recent_sync_from:null,recent_synced_at:new Date(start).toISOString()};
  const updated = await db.from('whatnot_api_connection').update(changes).eq('singleton',true).eq('dispatch_token',token).select('singleton');
  if (updated.error || updated.data?.length !== 1) throw Error('Could not save the Whatnot recent-order checkpoint.');
  return {more,read};
}
