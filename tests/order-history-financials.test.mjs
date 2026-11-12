import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../ebay-order-history.js', import.meta.url), 'utf8');
function app() {
  const context = vm.createContext({console: {warn() {}}, URL, URLSearchParams, setTimeout: () => 0, clearTimeout,
    window: {addEventListener() {}, location: {search: ''}}, document: {addEventListener() {}}});
  vm.runInContext(source, context);
  return code => vm.runInContext(code, context);
}

test('history reconciles cancellations, refunds and expenses once per order, including zero and negative earnings', () => {
  const run = app();
  run(`var fixtures = [
    ['paid', 100, 0, 0, 100, 82], ['cancel', 100, 100, 0, 0, 0],
    ['refund', 100, 0, 100, 0, -3], ['partial', 100, 0, 25, 75, 65], ['zero', 100, 0, 0, 100, 0]
  ];
  state.lines = fixtures.map(([id]) => ({id, order: {order_number: id}, total_price: 117, net_payout: 110}));
  state.historyFinancials = new Map(fixtures.map(([id, original, cancelled, refunded, net_sales, earnings]) =>
    [id, {line_ids: [id], original, cancelled, refunded, net_sales, earnings, sales_complete: true, earnings_complete: true}]));
  var totals = getHistoryFinancialTotals([...state.lines, state.lines[0]]);`);
  assert.equal(run('totals.orders'), 5);
  assert.equal(run('totals.sales'), 275);
  assert.equal(run('totals.earnings'), 144);
  assert.equal(run('totals.earningsKnown'), 5);
  assert.equal(run(`getHistoryFinancialTotals([state.lines[1]]).earnings`), 0);
  assert.equal(run(`getHistoryFinancialTotals([state.lines[2]]).earnings`), -3);
});

test('missing reconciliation never falls back to gross, original payout or a repeated multi-line order amount', () => {
  const run = app();
  run(`state.lines = ['a','b'].map(id => ({id, order: {order_number: 'multi'}, total_price: 500, net_payout: 400}));
    state.historyFinancials.set('multi', {line_ids:['a','b'],original:100,cancelled:0,refunded:0,net_sales:100,earnings:80,sales_complete:true,earnings_complete:true});`);
  assert.equal(run('getHistoryFinancialTotals(state.lines).earnings'), 80);
  assert.equal(run('getHistoryFinancialTotals([state.lines[0]]).partialOrders'), 1);
  assert.equal(run(`historyFinancialValue(getHistoryFinancialTotals([state.lines[0]]), 'earnings')`), 'Needs verification');
  run(`state.historyFinancials.get('multi').earnings_complete = false;`);
  assert.equal(run('getHistoryFinancialTotals(state.lines).earnings'), 0);
  run(`state.historyFinancials.get('multi').earnings = -12;`);
  assert.equal(run('getHistoryFinancialTotals(state.lines).earnings'), -12);
  run(`state.historyFinancials.clear()`);
  assert.equal(run('getHistoryFinancialTotals(state.lines).salesKnown'), 0);
  assert.equal(run(`historyFinancialValue(getHistoryFinancialTotals(state.lines), 'earnings')`), 'Needs verification');
});

test('finance load is admin-only, de-duplicates orders, refreshes data and fails closed', async () => {
  const run = app();
  run(`isReturnsWorkbenchPage = () => false; var calls = [];
    var supabase = {rpc: async (name, args) => {calls.push(args); return {data: [{order_number:'one', earnings:0}]};}};
    state.employee = {role:'employee'}; var lines = [{id:'a',order:{order_number:'one'}},{id:'b',order:{order_number:'one'}}];`);
  await run('fetchHistoryFinancials(lines)'); assert.equal(run('calls.length'), 0);
  run(`state.employee.role = 'admin'`);
  const result = await run('fetchHistoryFinancials(lines)');
  assert.equal(result.records.get('one').earnings, 0);
  assert.equal(run('calls[0]._orders.length'), 1);
  run(`supabase.rpc = async () => ({error: {message:'unavailable'}})`);
  const failed = await run('fetchHistoryFinancials(lines)');
  assert.equal(failed.status, 'error'); assert.equal(failed.records.size, 0);
});

test('large history reads are bounded and keep verified batches when another request fails', async () => {
  const run = app();
  run(`isReturnsWorkbenchPage = () => false; state.employee = {role:'admin'};
    var calls = [], active = 0, peak = 0;
    var supabase = {rpc: async (name, args) => {
      calls.push(args._orders.length); peak = Math.max(peak, ++active);
      await Promise.resolve(); active--;
      if (args._orders.includes('order-30')) throw new Error('Unavailable');
      return {data: args._orders.map(order_number => ({order_number, earnings:0}))};
    }};
    var lines = Array.from({length:101}, (_,i) => ({id:String(i),order:{order_number:'order-'+i}}));`);
  const result = await run('fetchHistoryFinancials(lines)');
  assert.equal(result.status, 'partial'); assert.equal(result.records.size, 76);
  assert.equal(run('calls.length'), 5); assert.ok(run('Math.max(...calls)') <= 25); assert.ok(run('peak') <= 3);
});
