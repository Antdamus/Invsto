import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';

const source = readFileSync(new URL('../pending-orders.js', import.meta.url), 'utf8');
function app(now = '2026-10-28T23:23:38Z') {
  let time = Date.parse(now);
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return time; }
  }
  const events = {}, timers = [], elements = new Map();
  const context = vm.createContext({console, Date: Clock, URL, URLSearchParams, setTimeout() {}, clearTimeout() {},
    window: {location: {search: ''}, addEventListener(name, fn) { events[name] = fn; },
      setInterval(fn, delay) { timers.push({fn, delay}); return timers.length; }},
    document: {hidden: false, addEventListener(name, fn) { events[name] = fn; }, querySelectorAll: () => [],
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, {value: '', textContent: '', disabled: false,
          classList: {toggle() {}}, setAttribute() {}});
        return elements.get(id);
      }},
  });
  vm.runInContext(source, context);
  return {context, events, timers, run: code => vm.runInContext(code, context), setTime: value => { time = Date.parse(value); }};
}
const plain = value => JSON.parse(JSON.stringify(value));

test('the reported 351-order cohort matches eBay: 136 overdue, 78 today, 137 tomorrow', () => {
  const {context} = app();
  const counts = {};
  for (const [day, count] of [[14, 1], [15, 1], [27, 11], [28, 123], [29, 78], [30, 137]]) {
    const level = context.getOrderUrgency(`2026-10-${day}T06:59:59Z`).level;
    counts[level] = (counts[level] || 0) + count;
  }
  assert.deepEqual(counts, {overdue: 136, today: 78, tomorrow: 137});
});

test('an exact deadline becomes overdue only after its final instant, including within today', () => {
  const {context, setTime} = app('2026-10-28T06:59:58.999Z');
  const deadline = '2026-10-28T06:59:59Z';
  assert.equal(context.getOrderUrgency(deadline).level, 'today');
  setTime(deadline);
  assert.equal(context.getOrderUrgency(deadline).level, 'today');
  setTime('2026-10-28T06:59:59.001Z');
  assert.equal(context.getOrderUrgency(deadline).level, 'overdue');
  setTime('2026-10-28T23:23:38Z');
  assert.equal(context.getOrderUrgency('2026-10-28T20:00:00Z').level, 'overdue');
});

test('future shipping days use Pacific time even after Eastern midnight', () => {
  const {context} = app('2026-10-29T05:00:00Z');
  assert.equal(context.getOrderUrgency('2026-10-29T06:59:59Z').level, 'today');
  assert.equal(context.getOrderUrgency('2026-10-30T06:59:59Z').level, 'tomorrow');
  assert.equal(context.getOrderUrgency('2026-10-31T06:59:59Z'), null);
});

test('calendar dates from CSV stay due for the whole eBay day, never the noon UTC placeholder', () => {
  const {context, setTime} = app('2026-10-29T05:00:00Z');
  const order = {ship_by_date: '2026-10-28T12:00:00.000Z', raw_payload: {date_precision: {ship_by_date: 'day'}}};
  assert.equal(context.getOrderUrgency(order.ship_by_date, order).level, 'today');
  assert.equal(context.getOrderUrgency('2026-10-28').level, 'today');
  order.raw_payload = {first_row: {'Ship By Date': 'Oct-28-26'}};
  assert.equal(context.getOrderUrgency(order.ship_by_date, order).level, 'today');
  setTime('2026-10-29T07:00:00Z');
  assert.equal(context.getOrderUrgency(order.ship_by_date, order).level, 'overdue');
  order.raw_payload.date_precision = {ship_by_date: 'timestamp'};
  setTime('2026-10-28T12:00:00.001Z');
  assert.equal(context.getOrderUrgency(order.ship_by_date, order).level, 'overdue');
});

test('Pacific days and exact deadlines survive both daylight-saving transitions', () => {
  const {context, setTime} = app();
  for (const [now, deadline, nextDay] of [
    ['2026-03-08T08:30:00Z', '2026-03-09T06:59:59Z', '2026-03-10T06:59:59Z'],
    ['2026-11-01T07:30:00Z', '2026-11-02T07:59:59Z', '2026-11-03T07:59:59Z'],
  ]) {
    setTime(now);
    assert.equal(context.getOrderUrgency(deadline).level, 'today');
    assert.equal(context.getOrderUrgency(nextDay).level, 'tomorrow');
    setTime(new Date(Date.parse(deadline) + 1).toISOString());
    assert.equal(context.getOrderUrgency(deadline).level, 'overdue');
  }
});

test('shipping dates display eBay Pacific time while purchase dates retain local time', () => {
  const previousTZ = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    const {context} = app();
    const order = {ship_by_date: '2026-10-28T06:59:59Z', sale_date: '2026-10-20T16:30:00Z'};
    assert.match(context.formatOrderDate(order, 'ship_by_date'), /Oct 27.*11:59 PM PDT/);
    assert.match(context.formatOrderDate(order, 'sale_date'), /Oct 20.*12:30 PM EDT/);
    for (const zone of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
      process.env.TZ = zone;
      assert.equal(context.getOrderUrgency(order.ship_by_date).level, 'overdue');
      assert.match(context.formatOrderDate(order, 'ship_by_date'), /Oct 27.*11:59 PM PDT/);
    }
  } finally {
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

test('missing or malformed deadlines do not invent a due status', () => {
  const {context} = app();
  for (const value of [null, undefined, '', 'bad-date']) assert.equal(context.getOrderUrgency(value), null);
});

test('due filters, buyer-group sorting, summaries and eBay handoff agree without splitting grouped orders', () => {
  const {run, context} = app();
  run(`state.orders = [
    ['late', 'buyer-a', '2026-10-28T06:59:59Z'],
    ['future-in-group', 'buyer-a', '2026-10-30T06:59:59Z'],
    ['today', 'buyer-b', '2026-10-29T06:59:59Z'],
    ['csv-today', 'buyer-c', '2026-10-28T12:00:00Z'],
  ].map(([id, buyer, due]) => normalizeLine({id, order_id:id, quantity:1, fulfilled_quantity:0, line_status:'pending',
    order:{id,order_number:id,buyer_username:buyer,ship_by_date:due,
      raw_payload:id==='csv-today'?{date_precision:{ship_by_date:'day'}}:{}}}));
    renderCancellationReviewIndicator = renderAdminOrderActions = renderLiveLotOrderMatches = renderOrders = () => {};
    state.orderDueFilter = 'overdue'; applyOrderFilters();`);
  assert.deepEqual(plain(run('state.filteredOrders.map(line=>line.id)')), ['late', 'future-in-group']);
  assert.equal(context.document.getElementById('summary-overdue-orders').textContent, '1 group');
  assert.equal(context.document.getElementById('summary-today-orders').textContent, '2 groups');
  const handoff = plain(run('buildEbayPendingPriorityPayload()'));
  assert.equal(handoff.priorities.find(g => g.buyerKey === 'buyer-a').priorityLabel, 'Overdue');
  assert.equal(handoff.priorities.find(g => g.buyerKey === 'buyer-c').priorityLabel, 'Due today');
  run(`state.orderSort='urgency_asc';`);
  assert.equal(run('sortBuyerGroups(groupLinesByBuyer(state.orders))[0].buyer'), 'buyer-a');
  run(`state.orderDueFilter='today'; applyOrderFilters();`);
  assert.deepEqual(plain(run('state.filteredOrders.map(line=>line.id)')), ['today', 'csv-today']);
});

test('an open queue refreshes only when a deadline category changes and catches up on focus', () => {
  const {run, setTime, timers, events, context} = app('2026-10-28T06:59:58Z');
  run(`state.user={id:'staff'}; state.orders=[{id:'line',line_status:'pending',quantity:1,fulfilled_quantity:0,
    order:{ship_by_date:'2026-10-28T06:59:59Z'}}];
    var deadlineRenders=0; applyOrderFilters=()=>{deadlineRenders++;orderDeadlineSignature=getOrderDeadlineSignature();};
    orderDeadlineSignature=getOrderDeadlineSignature(); startOrderDeadlineUpdates(); startOrderDeadlineUpdates();`);
  assert.equal(timers.length, 1);
  timers[0].fn();
  assert.equal(run('deadlineRenders'), 0);
  setTime('2026-10-28T07:00:00Z');
  context.document.hidden = true;
  timers[0].fn();
  assert.equal(run('deadlineRenders'), 0);
  context.document.hidden = false;
  events.focus();
  assert.equal(run('deadlineRenders'), 1);
  timers[0].fn();
  assert.equal(run('deadlineRenders'), 1);
});
