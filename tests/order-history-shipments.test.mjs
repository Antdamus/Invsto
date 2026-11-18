import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';

const source = readFileSync(new URL('../ebay-order-history.js', import.meta.url), 'utf8');
const line = (id, order = {}, extra = {}) => ({
  id, order_id: `order-${id}`, quantity: 1, fulfilled_quantity: 1,
  fulfilled_at: '2026-11-10T18:00:00Z', line_status: 'fulfilled', total_price: 20,
  order: {id: `order-${id}`, order_number: `11-22222-${String(10000 + Number(id)).padStart(5, '0')}`,
    buyer_username: 'sample.buyer', ...order}, ...extra,
});
function app(lines, events = {}) {
  const context = vm.createContext({console, URLSearchParams,
    window: {addEventListener() {}, location: {search: ''}},
    document: {addEventListener() {}, getElementById() {return null;}}});
  vm.runInContext(source, context);
  context.fixture = JSON.parse(JSON.stringify({lines, ...events}));
  vm.runInContext('Object.assign(state, fixture)', context);
  const run = code => vm.runInContext(code, context);
  return {run, groups: () => JSON.parse(run('JSON.stringify(buildHistoryGroups(state.lines))'))};
}
const ids = groups => groups.map(g => g.lines.map(l => l.id).sort().join(',')).sort();
const tracked = (id, tracking, order = {}) => line(id, {tracking_number: tracking, ...order});

test('73 purchases by one buyer stay separate without shipment evidence, regardless of bulk closeouts', () => {
  const lines = Array.from({length: 73}, (_, i) => line(String(i)));
  const event = {id: 'bulk-closeout', action: 'fulfilled_no_inventory', order_line_ids: lines.map(l => l.id)};
  const a = app(lines, {adminEvents: [event], relatedAdminEvents: [event, {...event, id: 'duplicate-closeout'}]});
  const before = a.run('JSON.stringify(state.lines)');
  const groups = a.groups();
  assert.equal(groups.length, 73);
  assert.equal(new Set(groups.flatMap(g => g.lines.map(l => l.id))).size, 73);
  assert.ok(groups.every(g => g.kind === 'order' && g.lines.length === 1 && g.events.length === 2));
  assert.equal(a.run('JSON.stringify(state.lines)'), before, 'grouping must not rewrite saved records');
});

test('shared tracking combines only the matching shipment, with stable keys and no cross-buyer merge', () => {
  const a = app([tracked('1', '9400 1118 9956 0000 0000 01'), tracked('2', '9400111899560000000001'),
    tracked('3', '1z-999-aa1-0100000001'), tracked('4', '9400111899560000000001', {buyer_username: 'another.buyer'})]);
  assert.deepEqual(ids(a.groups()), ['1,2', '3', '4']);
  const first = a.groups().find(g => g.lines.some(l => l.id === '1'));
  assert.equal(first.kind, 'shipment');
  assert.equal(a.run(`buildHistoryGroups([state.lines[0]])[0].id`), first.id);
  assert.equal(a.run('buildHistoryGroups([...state.lines, state.lines[0]]).flatMap(g=>g.lines).length'), 4);
});

test('bulk PDF metadata uses each order’s package row instead of the batch’s first tracking number', () => {
  const metadata = {labelCount: 2, pageCount: 2, trackingNumber: 'TRACK0001', trackingNumbers: ['TRACK0001','TRACK0002'],
    shipmentIds: ['ship-one','ship-two'], labelRows: [
      {orderNumbers: ['11-22222-10001','11-22222-10002','11-22222-10003'], trackingNumbers: ['TRACK0001','TRACK0002']},
      {orderNumbers: ['11-22222-10001','11-22222-10002'], trackingNumbers: ['TRACK0001'], shipmentIds: ['ship-one']},
      {orderNumbers: ['11-22222-10003'], trackingNumbers: ['TRACK0002'], shipmentIds: ['ship-two']},
    ]};
  const a = app(['1','2','3'].map(id => line(id, {label_file_path: 'bulk.pdf', label_metadata: metadata})));
  assert.deepEqual(ids(a.groups()), ['1,2','3']);
  assert.deepEqual(a.groups().map(g => g.shipment.trackingNumbers).sort(), [['TRACK0001'],['TRACK0002']]);
});

test('an order with multiple trackers never bridges two separate packages', () => {
  const a = app([tracked('1','TRACK0001'), tracked('2','TRACK0002'),
    line('3', {label_metadata: {trackingNumbers: ['TRACK0001','TRACK0002']}})]);
  assert.deepEqual(ids(a.groups()), ['1','2','3']);
  assert.equal(a.groups().find(g => g.lines[0].id === '3').kind, 'order');
  assert.match(a.groups().find(g => g.lines[0].id === '3').shipment.reason, /Multiple packages/);
});

test('a shared PDF alone is not a package; a single-label PDF or unique shipment ID can identify one', () => {
  for (const metadata of [{}, {pageCount: 1}, {pageCount: 3}, {labelCount: 2, trackingNumber: 'TRACK0001'}]) {
    assert.equal(app(['1','2'].map(id => line(id, {label_file_path: 'shared.pdf', label_metadata: metadata}))).groups().length, 2);
  }
  assert.deepEqual(ids(app(['1','2'].map(id => line(id, {label_file_path: 'one.pdf', label_metadata: {labelCount: 1}}))).groups()), ['1,2']);
  assert.deepEqual(ids(app(['1','2'].map(id => line(id, {ebay_shipment_id: 'single-shipment'}))).groups()), ['1,2']);
  assert.equal(app(['1','2'].map(id => line(id, {ebay_shipment_id: 'first', label_metadata: {shipmentIds: ['first','second']}}))).groups().length, 2);
});

test('legacy current label events recover identity, while replaced labels and receipts cannot merge orders', () => {
  const label = {action: 'attached', label_file_path: 'current.pdf', label_metadata: {trackingNumber: 'TRACK0001'}};
  const a = app([line('1'), line('2'), line('3')], {relatedLabelEvents: [
    {...label, id: 'label-1', order_line_ids: ['1','2']},
    {...label, id: 'receipt-only', action: 'evidence_added', order_line_ids: ['3']},
  ]});
  assert.deepEqual(ids(a.groups()), ['1,2','3']);
  const b = app([tracked('1','TRACK0002',{label_file_path: 'current.pdf'}), tracked('2','TRACK0001')],
    {labelEvents: [{...label, id:'old', label_file_path: 'replaced.pdf', order_line_ids: ['1','2']}]});
  assert.deepEqual(ids(b.groups()), ['1','2']);
});

test('additional labels leave the order unconfirmed until line-level shipment evidence identifies its package', () => {
  const lines = [tracked('1','TRACK0001'), tracked('2','TRACK0001')];
  const events = {relatedLabelEvents: [{id:'extra', action:'extra_label', order_line_ids:['1'],
    label_file_path:'extra.pdf', label_metadata:{trackingNumber:'TRACK0002'}}]};
  assert.deepEqual(ids(app(lines, events).groups()), ['1','2']);
  lines[0].raw_payload = {shipping_reconciliation:{shipments:[{trackingNumber:'TRACK0001', shippedAt:'2026-11-09T14:00:00Z'}]}};
  assert.deepEqual(ids(app(lines, events).groups()), ['1,2']);
});

test('line-specific shipment records split one order and prevent duplicate quantities or whole-order financial totals', () => {
  const a = app(['1','2','3'].map((id, i) => line(id, {id:'same-order', order_number:'11-22222-10001'}, {
    order_id:'same-order', raw_payload:{shipping_reconciliation:{shipments:[{trackingNumber:`TRACK000${i + 1}`, shippedAt:'2026-11-09T14:00:00Z'}]}},
  })));
  assert.deepEqual(ids(a.groups()), ['1','2','3']);
  assert.equal(a.groups().reduce((sum,g)=>sum+g.lines.reduce((n,l)=>n+l.quantity,0),0), 3);
  a.run(`state.historyFinancials.set('11-22222-10001', {line_ids:['1','2','3'],net_sales:60,earnings:40,sales_complete:true,earnings_complete:true})`);
  assert.equal(a.run(`getHistoryFinancialTotals(buildHistoryGroups(state.lines)[0].lines).partialOrders`), 1);
  assert.match(a.run('getHistoryGroupTimelineText(buildHistoryGroups(state.lines)[0])'), /^Shipped /);
});

test('missing, malformed and ambiguous evidence stays unconfirmed; canceled lines cannot join shipments', () => {
  const lines = [line('1', {tracking_number:'N/A'}), line('2', {tracking_number:'undefined'}),
    line('3', {tracking_number:'TRACK0001'}, {raw_payload:{shipping_reconciliation:{shipments:[{trackingNumber:'TRACK0001'}, {}]}}}),
    line('4', {tracking_number:'TRACK0001'}, {line_status:'cancelled'}), tracked('5','TRACK0001')];
  const a = app(lines);
  assert.equal(a.groups().length, 5);
  assert.equal(a.groups().filter(g=>g.kind==='shipment').length, 1);
  assert.match(a.run('renderHistoryShipmentSummary(buildHistoryGroups(state.lines).find(g=>g.lines[0].id==="4"))'), /Canceled order/);
  assert.doesNotMatch(a.run('getHistoryGroupStatus(buildHistoryGroups(state.lines).find(g=>g.lines[0].id==="1"))'), /Shipped|Shipment record/);
});

test('filters do not erase hidden-line evidence or alter shipment membership', () => {
  const lines = [tracked('1','TRACK0001'), tracked('2','TRACK0001',{id:'order-1',order_number:'11-22222-10001'})];
  lines[1].order_id = 'order-1';
  const a = app(lines, {relatedLabelEvents:[{id:'extra', action:'extra_label',order_line_ids:['2'],label_file_path:'extra.pdf',label_metadata:{trackingNumber:'TRACK0002'}}]});
  assert.equal(a.run('buildHistoryGroups([state.lines[0]])[0].kind'), 'order');
  assert.equal(a.run('buildHistoryGroups([state.lines[0]])[0].id'), a.groups()[0].id);
});

test('proof stays scoped to matching lines without duplicate cards from overlapping events', () => {
  const events = {relatedAdminEvents:[{id:'all',order_line_ids:['1','2'],action:'fulfilled_no_inventory'}],
    relatedOrderTaskEvents:[{id:'one',order_line_ids:['1'],task_id:'task-one'},{id:'two',order_line_ids:['2'],task_id:'task-two'}]};
  const groups = app([tracked('1','TRACK0001'), tracked('2','TRACK0002')],events).groups();
  for (const group of groups) assert.deepEqual(group.events.map(e=>e.id).sort(), ['all',group.lines[0].id === '1' ? 'one' : 'two'].sort());
});


test('an unmapped line cannot inherit the first tracker of an order whose other lines shipped separately', () => {
  const lines = ['1','2','3'].map(id => line(id, {id:'same-order', order_number:'11-22222-10001', tracking_number:'TRACK0001'}, {order_id:'same-order'}));
  for (const [i, entry] of lines.slice(0,2).entries()) entry.raw_payload = {shipping_reconciliation:{shipments:[{trackingNumber:`TRACK000${i+1}`}]}};
  const a = app(lines);
  assert.deepEqual(ids(a.groups()), ['1','2','3']);
  assert.equal(a.groups().find(g=>g.lines[0].id==='3').kind, 'order');
  assert.equal(a.run('buildHistoryGroups([state.lines[2]])[0].kind'), 'order');
});

const completionAt = '2026-11-10T18:00:00Z';
const completedLine = (id, order = {}, extra = {}) => line(id, order,
  {fulfilled_by: 'worker-one', fulfilled_by_email:'packer@example.test', ...extra});
const completionEvent = (id, ids, extra = {}) => ({id, action:'fulfilled_no_inventory',
  order_line_ids:ids, signed_by:'worker-one', signed_by_email:'packer@example.test', created_at:completionAt,
  payload:{source:'worker_physical_item_not_in_inventory_batch', completed_at:completionAt,
    evidence_photos:[{bucket:'proof',path:`packing/${id}.jpg`}]}, ...extra});

test('normal completion batches are primary, keep their own photos, and stay separate even with the same tracker', () => {
  const a = app(['1','2','3','4'].map(id=>completedLine(id,{tracking_number:'TRACK0001'})), {
    adminEvents:[completionEvent('packing-one',['1','2']),completionEvent('packing-two',['3','4'])],
  });
  assert.deepEqual(ids(a.groups()), ['1,2','3,4']);
  assert.ok(a.groups().every(g=>g.kind==='completion'));
  assert.equal(a.run('buildHistoryGroups(state.lines).reduce((sum,g)=>sum+getHistoryGroupEvidencePhotos(g).length,0)'), 2);
  assert.match(a.run('renderHistoryShipmentSummary(buildHistoryGroups(state.lines)[0])'), /Completed together/);
  assert.match(a.run('getHistoryGroupTimelineText(buildHistoryGroups(state.lines)[0])'), /^Completed /);
  assert.equal(a.run('getHistoryGroupStatus(buildHistoryGroups(state.lines)[0])'), 'Completed');
});

test('normal closures without any shipping label remain together; forced closeouts do not', () => {
  const a = app(['1','2','3','4'].map(id=>completedLine(id)), {relatedAdminEvents:[
    completionEvent('normal',['1','2']),
    completionEvent('forced',['3','4'],{payload:{closed_at:completionAt,updated_lines:2}}),
  ]});
  assert.deepEqual(ids(a.groups()), ['1,2','3','4']);
  assert.equal(a.groups().filter(g=>g.kind==='completion').length, 1);
  const normal = a.groups().find(g=>g.kind==='completion');
  assert.equal(a.run('buildHistoryGroups([state.lines[0]])[0].id'), normal.id);
});

test('a reopened and recompleted line uses only its current completion and packing photos', () => {
  const a = app([completedLine('1'),completedLine('2'),completedLine('3')], {adminEvents:[
    completionEvent('old',['1','2'],{created_at:'2026-11-01T18:00:00Z',payload:{
      source:'worker_physical_item_not_in_inventory_batch',completed_at:'2026-11-01T18:00:00Z',
      evidence_photos:[{bucket:'proof',path:'packing/old.jpg'}]}}),
    completionEvent('current',['1','3']),
    completionEvent('wrong-worker',['2'],{signed_by:'different-worker'}),
  ]});
  assert.deepEqual(ids(a.groups()), ['1,3','2']);
  assert.equal(a.run(`getHistoryGroupEvidencePhotos(buildHistoryGroups(state.lines).find(g=>g.kind==='completion')).map(p=>p.path).join(',')`),'packing/current.jpg');
  assert.equal(a.run(`getHistoryGroupEvidencePhotos(buildHistoryGroups(state.lines).find(g=>g.kind==='order')).length`),0);
});

test('one mixed checkout joins inventory and noninventory items by the saved request, not timestamps alone', () => {
  const transaction = (id, request='request-one') => ({id,action_type:'checkout',confirmed_at:completionAt,
    user_id:'worker-one',email:'packer@example.test',metadata:{pending_checkout_request_id:request}});
  const a = app([completedLine('1',{}, {stock_transaction_id:'tx-one'}),
    completedLine('2',{}, {stock_transaction_id:'tx-two'}), completedLine('3'),
    completedLine('4',{}, {stock_transaction_id:'tx-four'})], {
    historyCheckoutTransactions:[transaction('tx-one'),transaction('tx-two'),transaction('tx-four','request-two')],
    adminEvents:[completionEvent('mixed',['3'],{payload:{source:'mixed_pending_checkout',checkout_request_id:'request-one'}})],
  });
  assert.deepEqual(ids(a.groups()), ['1,2,3','4']);
  assert.ok(a.groups().every(g=>g.kind==='completion'));
});

test('forced closeouts and stale stock transactions cannot impersonate a normal checkout', () => {
  const transactions = ['1','2','3'].map(id=>({id:`tx-${id}`,action_type:'checkout',confirmed_at:completionAt,
    user_id:'worker-one',metadata:{pending_checkout_request_id:'request-one'}}));
  transactions[2].confirmed_at='2026-11-09T18:00:00Z';
  const a=app(['1','2','3'].map(id=>completedLine(id,{}, {stock_transaction_id:`tx-${id}`})), {
    historyCheckoutTransactions:transactions,
    adminEvents:[completionEvent('forced',['1','2'],{payload:{source:'admin_reconcile',closed_at:completionAt}})],
  });
  assert.deepEqual(ids(a.groups()),['1','2','3']);
  assert.ok(a.groups().every(g=>g.kind==='order'));
});

test('the same completion cannot combine different buyers, canceled lines or duplicate event copies', () => {
  const event=completionEvent('normal',['1','2','3']);
  const a=app([completedLine('1'),completedLine('2',{buyer_username:'another.buyer'}),
    completedLine('3',{}, {line_status:'cancelled'})], {adminEvents:[event],relatedAdminEvents:[event]});
  assert.deepEqual(ids(a.groups()),['1','2','3']);
  assert.equal(a.groups().filter(g=>g.kind==='completion').length,2);
});

test('checkout loading reads only referenced transactions, preserves partial reads, and fails safely',async()=>{
  const a=app([]);
  a.run(`var calls=[]; var supabase={from(table){calls.push({table});return {
    select(columns){calls.at(-1).columns=columns;return this;},
    in(column,ids){calls.at(-1).ids=ids;return this;},
    limit(){return Promise.resolve({data:[{id:'tx-one'}],error:null});}
  }}};`);
  assert.equal((await a.run('fetchHistoryCheckoutTransactions([])')).length,0);
  await a.run(`fetchHistoryCheckoutTransactions([{stock_transaction_id:'tx-one'},{stock_transaction_id:'tx-one'}])`);
  assert.equal(a.run('calls.length'),1);
  assert.equal(a.run('calls[0].ids.join(",")'),'tx-one');
  assert.equal(a.run('calls[0].table'),'stock_transactions');
  a.run(`console={...console,warn(){}};supabase.from=()=>{throw Error('unavailable');};`);
  assert.equal((await a.run(`fetchHistoryCheckoutTransactions([{stock_transaction_id:'tx-one'}])`)).length,0);
});
