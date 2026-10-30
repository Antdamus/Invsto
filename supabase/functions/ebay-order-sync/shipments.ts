// Read-only shipping evidence. Never infers shipment time from order modification
// or purchase time, and never changes local fulfillment or inventory.
export async function inspectShippingFulfillments(db: any, body: any, read: (path: string) => Promise<any>) {
  const ids = [...new Set((Array.isArray(body.orderIds) ? body.orderIds : []).map(String))];
  if (!ids.length || ids.length > 50 || ids.some(id => !/^\d{2}-\d{5}-\d{5}$/.test(id))) {
    throw new Error('Choose between 1 and 50 explicit eBay order numbers.');
  }
  const {data: orders, error} = await db.from('ebay_orders').select('id,order_number,status').in('order_number', ids);
  if (error) throw error;
  const known = new Map((orders || []).map((o: any) => [o.order_number, o]));
  const results: any[] = [];
  let cursor = 0;
  await Promise.all(Array.from({length: Math.min(5, ids.length)}, async () => {
    while (cursor < ids.length) {
      const orderNumber = ids[cursor++];
      if (!known.has(orderNumber)) { results.push({orderNumber, error: 'Order is not saved in Invsto.'}); continue; }
      try {
        const payload = await read(`/sell/fulfillment/v1/order/${encodeURIComponent(orderNumber)}/shipping_fulfillment`);
        const fulfillments = payload.fulfillments || [];
        // Fetch current order state only when shipping evidence exists.
        const order = fulfillments.length ? await read(`/sell/fulfillment/v1/order/${encodeURIComponent(orderNumber)}`) : null;
        results.push({orderNumber, orderFulfillmentStatus: order?.orderFulfillmentStatus || null,
          lineItems: (order?.lineItems || []).map((l: any) => ({lineItemId: l.lineItemId, legacyItemId: l.legacyItemId,
            legacyVariationId: l.legacyVariationId, quantity: l.quantity, lineItemFulfillmentStatus: l.lineItemFulfillmentStatus})),
          fulfillments});
      } catch (e) { results.push({orderNumber, error: e instanceof Error ? e.message : String(e)}); }
    }
  }));
  return {ok: results.every(r => !r.error), readOnly: true, checkedAt: new Date().toISOString(), results};
}
