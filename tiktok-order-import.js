/* TikTok CSV adapter. Identifiers remain strings; source times remain source text. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TikTokOrderImport = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';
  const MAX_BYTES = 10 * 1024 * 1024, MAX_ROWS = 10000;
  const clean = value => String(value ?? '').trim();
  function csv(text) {
    if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_BYTES) throw Error('Choose a TikTok CSV smaller than 10 MB.');
    text = text.replace(/^\uFEFF/, '');
    const rows = []; let row = [], cell = '', quoted = false, ended = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; ended = true; } } else cell += c; }
      else if (c === '"') { if (cell || ended) throw Error('Malformed CSV quote. Export a fresh CSV from TikTok.'); quoted = true; }
      else if (c === ',' || c === '\n' || c === '\r') {
        row.push(cell); cell = ''; ended = false;
        if (c !== ',') { if (row.some(v => v.trim())) rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
      } else { if (ended) throw Error('Malformed CSV field. Export a fresh CSV from TikTok.'); cell += c; }
      if (rows.length > MAX_ROWS + 1) throw Error('Import at most 10,000 item rows at a time.');
    }
    if (quoted) throw Error('Incomplete CSV. Download the report again.');
    row.push(cell); if (row.some(v => v.trim())) rows.push(row);
    return rows;
  }
  function parse(text) {
    const grid = csv(text), headers = (grid.shift() || []).map(clean);
    const required = ['Order ID', 'Order Status', 'Order Substatus', 'SKU ID', 'Seller SKU', 'Product Name', 'Quantity', 'Buyer Username', 'Package ID'];
    if (!required.every(k => headers.includes(k))) throw Error('This is not a TikTok orders CSV. In TikTok: Orders → To ship → Export → CSV.');
    if (new Set(headers).size !== headers.length) throw Error('The report has duplicate columns. Export a fresh TikTok report.');
    const read = (row, key) => clean(row[headers.indexOf(key)]);
    const rows = [], identities = new Map(), orders = new Map(); let duplicateRows = 0;
    const amount = (row, key) => { const v = read(row,key); if (!v) return null; if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(\.\d{1,2})?$/.test(v)) throw Error(`Invalid ${key}. Keep the original TikTok CSV format.`); return v.replaceAll(',',''); };
    grid.forEach((row, index) => {
      if (row.length !== headers.length) throw Error(`Row ${index + 2} has missing or extra columns. No orders were imported.`);
      const id = read(row,'Order ID'), sku = read(row,'SKU ID'), quantity = read(row,'Quantity');
      if (!/^\d{10,24}$/.test(id) || !/^\d{10,24}$/.test(sku)) throw Error(`Row ${index + 2}: invalid order or SKU ID. Do not open and resave IDs as numbers in Excel.`);
      if (!/^[1-9]\d{0,4}$/.test(quantity)) throw Error(`Row ${index + 2}: quantity must be a whole number above zero.`);
      const status = read(row,'Order Status'), substatus = read(row,'Order Substatus');
      if (!['To ship','Shipped','Completed','Canceled','Cancelled','Pending','Unpaid'].includes(status)) throw Error(`Unsupported TikTok status: ${status || '(blank)'}. No orders were imported.`);
      if (status === 'To ship' && !['Awaiting shipment','Awaiting collection','Partially shipped'].includes(substatus)) throw Error(`Unsupported To ship status: ${substatus || '(blank)'}.`);
      const entry = {order_number:id, sku_id:sku, product_id:read(row,'Product ID'), seller_sku:read(row,'Seller SKU'), title:read(row,'Product Name'), variation:read(row,'Variation'), quantity:Number(quantity), buyer_username:read(row,'Buyer Username'), buyer_nickname:read(row,'Buyer Nickname'), marketplace_status:status, marketplace_substatus:substatus, package_id:read(row,'Package ID'), tracking_number:read(row,'Tracking ID'), created_time:read(row,'Created Time'), paid_time:read(row,'Paid Time'), shipped_time:read(row,'Shipped Time'), seller_note:read(row,'Seller Note'), buyer_message:read(row,'Buyer Message'), shipping_method:read(row,'Delivery Option Type'), cancel_return:read(row,'Cancelation/Return Type'), order_amount:amount(row,'Order Amount'), line_amount:amount(row,'SKU Subtotal After Discount')};
      if (!entry.title || !entry.buyer_username) throw Error(`Row ${index + 2}: product name and buyer username are required.`);
      const key = `${id}:${sku}`, serialized = JSON.stringify(entry);
      if (identities.has(key)) { if (identities.get(key) !== serialized) throw Error(`Conflicting rows for order ${id}. Export a fresh report.`); duplicateRows++; return; }
      const orderFields = JSON.stringify([entry.buyer_username,status,substatus,entry.order_amount]);
      if (orders.has(id) && orders.get(id) !== orderFields) throw Error(`Conflicting order details for ${id}.`);
      orders.set(id,orderFields); identities.set(key,serialized); rows.push(entry);
    });
    if (!rows.length) throw Error('No order rows found in this CSV.');
    return {rows, orderCount:orders.size, buyerCount:new Set(rows.map(r=>r.buyer_username.toLowerCase())).size, duplicateRows,
      awaitingShipment:new Set(rows.filter(r=>r.marketplace_substatus==='Awaiting shipment').map(r=>r.order_number)).size,
      awaitingCollection:new Set(rows.filter(r=>r.marketplace_substatus==='Awaiting collection').map(r=>r.order_number)).size,
      historyCount:new Set(rows.filter(r=>r.marketplace_status!=='To ship').map(r=>r.order_number)).size};
  }
  function orderUrl(id, receipt=false, sku='') {
    if (!/^\d{10,24}$/.test(String(id))) throw Error('Invalid TikTok order ID.');
    if(sku&&!/^\d{10,24}$/.test(String(sku)))throw Error('Invalid TikTok SKU ID.');
    return `https://seller-us.tiktok.com/order/detail?order_no=${id}&shop_region=US${receipt ? '&ogReceipt=1' : ''}${sku?'&ogSku='+sku:''}`;
  }
  return {parse, csv, orderUrl, MAX_BYTES};
});
