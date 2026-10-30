import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';

const pending = readFileSync(new URL('../pending-orders.js', import.meta.url), 'utf8');
const finances = readFileSync(new URL('../live-sales-report-finances.js', import.meta.url), 'utf8');
const usd = value => ({value: String(value), currency: 'USD'});
function app() {
  const elements = new Map();
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-28T23:23:38Z'])); } static now() { return Date.parse('2026-10-28T23:23:38Z'); } }
  const context = vm.createContext({console, Date: Clock, URL, URLSearchParams,
    window: {location: {search: ''}, addEventListener() {}},
    document: {addEventListener() {}, querySelectorAll: () => [], getElementById(id) {
      if (!elements.has(id)) elements.set(id, {textContent: '', value: '', classList: {remove() {}, toggle() {}}});
      return elements.get(id);
    }},
  });
  vm.runInContext(finances, context);
  vm.runInContext(pending, context);
  return {context, run: code => vm.runInContext(code, context), text: id => elements.get(id)?.textContent};
}
function lines() {
  const items = [10, 20, 30].map((amount, index) => ({lineItemId: `api-${index}`, legacyItemId: `item-${index}`,
    lineItemCost: usd(amount), total: usd(amount), deliveryCost: {shippingCost: usd(0)}, ebayCollectAndRemitTaxes: []}));
  const order = {id: 'order', order_number: '11-22222-33333', buyer_username: 'buyer', ship_by_date: '2026-10-28T06:59:59Z',
    total_price: 60, net_payout: 999, raw_payload: {order: {totalMarketplaceFee: usd(1.01), lineItems: items}}};
  return items.map((item, index) => ({id: `line-${index}`, order_id: order.id, order, item_number: item.legacyItemId,
    transaction_id: item.lineItemId, quantity: 1, total_price: Number(item.total.value), net_payout: 999,
    line_status: 'pending', raw_payload: {line: item}}));
}

test('actual fees allocate exact cents once across all original lines, including fulfilled siblings', () => {
  const {context} = app(), rows = lines();
  let total = context.getPendingOrderMoneySummary(rows);
  assert.equal(total.gross, 6000); assert.equal(total.fees, 101); assert.equal(total.afterFees, 5899);
  total = context.getPendingOrderMoneySummary(rows.slice(0, 2));
  assert.equal(total.gross, 3000); assert.equal(total.fees, 51); assert.equal(total.afterFees, 2949);
  rows[0].order.raw_payload.order.lineItems.reverse();
  assert.equal(context.getPendingOrderMoneySummary(rows.slice(0, 2)).fees, 51);
});

test('missing fees use one order estimate, replaced by actual fees on the next render', () => {
  const {context} = app(), rows = lines();
  delete rows[0].order.raw_payload.order.totalMarketplaceFee;
  let total = context.getPendingOrderMoneySummary(rows);
  assert.equal(total.gross, 6000); assert.equal(total.afterFees, 5640); assert.equal(total.missingFees, 0);
  assert.equal(total.fees, 360); assert.equal(total.estimatedFees, 360); assert.equal(total.estimatedFeeLines, 3);
  total = context.getPendingOrderMoneySummary(rows.slice(0, 2));
  assert.equal(total.afterFees, 2820); assert.equal(total.estimatedFees, 180);
  rows[0].order.raw_payload.order.totalMarketplaceFee = usd(1.01);
  total = context.getPendingOrderMoneySummary(rows);
  assert.equal(total.afterFees, 5899); assert.equal(total.estimatedFees, 0); assert.equal(total.estimatedFeeLines, 0);
});

test('ambiguous line identity cannot duplicate a fee from a multi-line order', () => {
  const {context} = app();
  const fresh = lines(); fresh[0].raw_payload = {}; fresh[0].transaction_id = 'unknown'; fresh[0].item_number = 'unknown';
  const total = context.getPendingOrderMoneySummary(fresh);
  assert.equal(total.missingFees, 1); assert.equal(total.afterFees, null);
});

test('zero actual fees are known, foreign currencies are not silently mixed into USD', () => {
  const {context} = app(), rows = lines();
  rows[0].order.raw_payload.order.totalMarketplaceFee = usd(0);
  assert.equal(context.getPendingOrderMoneySummary(rows).afterFees, 6000);
  assert.equal(context.getPendingOrderMoneySummary(rows).estimatedFeeLines, 0);
  rows[0].order.raw_payload.order.totalMarketplaceFee.currency = 'EUR';
  assert.equal(context.getPendingOrderMoneySummary(rows).estimatedFees, 360);
  assert.equal(context.getPendingOrderMoneySummary(rows).afterFees, 5640);
  rows[0].raw_payload.line.total.currency = 'EUR';
  const total = context.getPendingOrderMoneySummary(rows);
  assert.equal(total.gross, 5000); assert.equal(total.missingPrices, 1);
});

test('estimates include known shipping and tax in the fee basis while revenue excludes tax', () => {
  const {context} = app(), rows = lines().slice(0, 1);
  const item = rows[0].raw_payload.line;
  Object.assign(item, {lineItemCost: usd(53), total: usd(54), deliveryCost: {shippingCost: usd(1)},
    ebayCollectAndRemitTaxes: [{amount: usd(4.32), collectionMethod: 'NET'}]});
  rows[0].order.raw_payload.order = {lineItems: [item], totalFeeBasisAmount: usd(58.32)};
  const total = context.getPendingOrderMoneySummary(rows);
  assert.equal(total.gross, 5300); assert.equal(total.shipping, 100);
  assert.equal(total.estimatedFees, 351); assert.equal(total.afterFees, 5049);
});

test('imported orders share one fixed fee across their lines and reserve the share of closed or unloaded lines', () => {
  const {context} = app(), order = {id: 'csv-order', total_price: 60, buyer_username: 'buyer'};
  const rows = [10, 20, 30].map((amount, index) => ({id: `csv-${index}`, order_id: order.id, order,
    sold_for: amount, total_price: amount, quantity: 1, shipping_and_handling: 0}));
  let total = context.getPendingOrderMoneySummary(rows);
  assert.equal(total.fees, 360); assert.equal(total.estimatedFees, 360); assert.equal(total.afterFees, 5640);
  total = context.getPendingOrderMoneySummary(rows.slice(0, 2));
  assert.equal(total.fees, 180); assert.equal(total.afterFees, 2820);
  const amounts = context.getPendingOrderAmountMap(rows);
  total = context.getPendingOrderMoneySummary(rows.slice(0, 2), amounts);
  assert.equal(total.fees, 180);
  rows.reverse();
  assert.equal(context.getPendingOrderAmountMap(rows).get(rows[2]).fee, amounts.get(rows[2]).fee);
  // Separate eBay orders for the same buyer still each have a fixed charge.
  const other = {...rows[0], id: 'other', order_id: 'other', order: {...order, id: 'other', total_price: 30}};
  total = context.getPendingOrderMoneySummary([...rows, other]);
  assert.equal(total.estimatedFees, 555);
});

test('item sales exclude shipping/tax, use API line costs once and multiply imported unit prices by quantity', () => {
  const {context} = app();
  const total = context.getPendingOrderMoneySummary([
    {total_price: 50, sold_for: 4, quantity: 3, raw_payload: {source: 'ebay_fulfillment_api', line: {lineItemCost: usd(12.34)}}},
    {total_price: 99, sold_for: 0, quantity: 2},
    {total_price: null, sold_for: 2.25, quantity: 4}, {total_price: '', sold_for: null},
  ]);
  assert.equal(total.gross, 2134); assert.equal(total.missingPrices, 1); assert.equal(total.afterFees, null);
});

test('shipping is separate, shared shipping is allocated once after discounts, and incomplete shipping blocks net totals', () => {
  const {context} = app(), rows = lines();
  rows[0].order.raw_payload.order.lineItems.forEach(item => delete item.deliveryCost);
  rows[0].order.raw_payload.order.pricingSummary = {deliveryCost: usd(10), deliveryDiscount: usd(-9)};
  let total = context.getPendingOrderMoneySummary(rows);
  assert.equal(total.gross, 6000); assert.equal(total.shipping, 100); assert.equal(total.afterFees, 5999);
  total = context.getPendingOrderMoneySummary(rows.slice(0, 2));
  assert.equal(total.shipping, 50); assert.equal(total.afterFees, 2999);
  delete rows[0].order.raw_payload.order.pricingSummary;
  rows.forEach(row => row.shipping_and_handling = 0); // API import's missing shipping is not proof of free shipping.
  total = context.getPendingOrderMoneySummary(rows);
  assert.equal(total.missingShipping, 3); assert.equal(total.afterFees, null);
  total = context.getPendingOrderMoneySummary([{sold_for: 12.5, quantity: 3, shipping_and_handling: 5, total_price: 46}]);
  assert.equal(total.gross, 3750); assert.equal(total.shipping, 500);
});

test('summary dollars cover the same whole groups as the due counts, exclude closed lines, and ignore search filters', () => {
  const {context, run, text} = app();
  const rows = lines(); rows[2].line_status = 'fulfilled';
  const tomorrow = {...rows[0], id: 'tomorrow', order_id: 'tomorrow', total_price: 40, sold_for: 40, shipping_and_handling: 0, raw_payload: {},
    order: {id: 'tomorrow', order_number: '22-33333-44444', buyer_username: 'buyer', ship_by_date: '2026-10-30T06:59:59Z'}};
  context.rows = [...rows, tomorrow];
  run('state.orders=rows; state.filteredOrders=[]; renderSummaryStrip();');
  assert.equal(text('summary-pending-value'), '$70.00 item sales · before fees');
  assert.equal(text('summary-overdue-value'), '$70.00 item sales · before fees');
  assert.equal(text('summary-tomorrow-value'), '$70.00 item sales · before fees');
  assert.equal(text('summary-today-value'), '$0.00 item sales · before fees');
  assert.equal(text('summary-pending-shipping'), 'Shipping collected: $0.00');
  assert.equal(text('summary-pending-fees'), '$66.99 items + shipping after eBay fees · $2.50 of fees estimated');
  assert.equal(text('summary-overdue-fees'), text('summary-pending-fees'));
  assert.equal(text('summary-tomorrow-fees'), text('summary-pending-fees'));
  assert.equal(text('summary-today-fees'), 'No open item lines');
  run('renderPendingOrderSummaryLoading()');
  assert.equal(text('summary-pending-value'), 'Loading value…'); assert.equal(text('summary-pending-fees'), '');
  run('renderPendingOrderSummaryError()');
  assert.equal(text('summary-pending-value'), 'Value unavailable');
});
