import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';

const source = await readFile(new URL('../team-tasks.js', import.meta.url), 'utf8');
const workflow = await readFile(new URL('../task-workflow.js', import.meta.url), 'utf8');
const chat = {id: 'chat', source: 'team', metadata: {conversation_id: 'conversation'}};
const order = {id: 'one', order_number: '01-12345-67890', buyer_name: 'Buyer Name',
  buyer_username: 'buyer_one', status: 'pending', sale_date: '2026-10-09T16:00:00Z',
  ebay_order_lines: [{line_status: 'pending', quantity: 1, fulfilled_quantity: 0}]};

function fixture({links = [], orders = [order], conversation = {id:'conversation',other_party_username:'buyer_one'}, fail = ''} = {}) {
  const reads = [];
  const context = vm.createContext({URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    console: {warn(){}}, window: {addEventListener(){}, location: {href:'https://example.test/team-tasks.html',search:''}},
    document: {addEventListener(){}, getElementById(){return null;}},
    supabase: {from(table) {
      const call = {table}; reads.push(call);
      const builder = {
        select(columns, options) {call.columns=columns;call.options=options;return this;},
        eq(field, value) {call.eq=[field,value];return this;},
        in(field, values) {call.in=[field,values];return this;},
        ilike(field,value) {call.ilike=[field,value];return this;},
        order(field,options) {call.sort=[field,options];return this;},
        limit(value) {call.limit=value;return this;},
        abortSignal(signal) {call.signal=signal;return this;},
        then(resolve, reject) {
          let data = table==='ebay_conversations' ? (conversation ? [conversation] : []) : table==='ebay_conversation_links' ? links : orders;
          if (table==='ebay_orders' && call.in) data=data.filter(row=>call.in[1].includes(row.id));
          return Promise.resolve({data, error:fail===table ? {message:'Access denied'} : null, count:data.length}).then(resolve,reject);
        },
      };
      return builder;
    }},
  });
  vm.runInContext(workflow, context);
  vm.runInContext(source, context);
  return {context,reads,async load(task=structuredClone(chat)) {await context.loadTaskConversationOrders(task);return task;}};
}

test('non-message tasks make no conversation or order requests', async () => {
  const f=fixture(); await f.load({id:'plain',source:'team',metadata:{}});assert.equal(f.reads.length,0);
});

test('message tasks load current order links even when creation metadata had no order', async () => {
  const f=fixture({links:[{ebay_order_id:'one',status:'confirmed'},{ebay_order_id:'one',status:'suggested'}]});
  const task=await f.load();
  assert.equal(task.conversationOrdersState,'ready');assert.equal(task.conversationOrders.length,1);
  assert.equal(task.conversationOrders[0].linkStatus,'confirmed');
  assert.equal(f.reads[1].eq[1],'conversation');assert.deepEqual(Array.from(f.reads[1].in[1]),['confirmed','suggested']);
  assert.equal(f.reads[2].ilike,undefined);
  assert.match(f.context.renderTaskConversationOrders(task, f.context.getEbayConversationTaskContext(task)),/Linked orders \(1\)/);
});

test('explicit conversation order choice takes precedence over automatic matches', async () => {
  const f=fixture({links:[{ebay_order_id:'two',status:'suggested'}, {ebay_order_id:'one',status:'confirmed',match_method:'operator_selected_order'}],
    orders:[order,{...order,id:'two'}]});
  assert.deepEqual(Array.from((await f.load()).conversationOrders,o=>o.id),['one']);
});

test('order-line links and return links resolve their original orders once', async () => {
  const f=fixture({links:[{line:{order_id:'one'},status:'confirmed'}, {return_case:[{order_id:'one'}],status:'confirmed'}]});
  assert.equal((await f.load()).conversationOrders.length,1);
});

test('an unlinked conversation shows recent customer orders as choices, never confirmed matches', async () => {
  const f=fixture({orders:[order,{...order,id:'two',order_number:'02-12345-67890'}]});
  const task=await f.load();
  assert.equal(task.conversationOrdersKind,'buyer'); assert.equal(task.conversationOrders[0].linkStatus,'buyer');
  assert.equal(f.reads[2].ilike[1],'buyer\\_one');assert.equal(f.reads[2].limit,12);
  const html=f.context.renderTaskConversationOrders(task,f.context.getEbayConversationTaskContext(task));
  assert.match(html,/Customer orders \(2\)/);assert.match(html,/No order is selected/);
  assert.match(html,/Buyer Name · @buyer_one/);assert.match(html,/orderId=01-12345-67890/);
});

test('suggested matches remain visibly unconfirmed', async () => {
  const f=fixture({links:[{ebay_order_id:'one',status:'suggested'}]});
  const task=await f.load();
  assert.match(f.context.renderTaskConversationOrders(task,{}),/Possible match — verify/);
});

test('direct task order IDs are supported without a conversation database ID', async () => {
  const f=fixture();
  const task=await f.load({source:'order',order_id:'one',metadata:{conversation_link:'email-triage.html'}});
  assert.equal(task.conversationOrders[0].id,'one');assert.deepEqual(f.reads.map(r=>r.table),['ebay_orders']);
});

test('permission/network failure displays retry, not a misleading missing-order message', async () => {
  const f=fixture({fail:'ebay_conversation_links'});const task=await f.load();
  assert.equal(task.conversationOrdersState,'error');assert.equal(f.reads.length,2);
  const html=f.context.renderTaskConversationOrders(task,{});
  assert.match(html,/Retry order links/);assert.doesNotMatch(html,/No order link is available/);
});

test('pending lines open Pending Orders; completed lines open unfiltered Order History', () => {
  const {context:c}=fixture();
  assert.equal(c.taskConversationOrderTarget(order).pending,true);
  const finished={...order,ebay_order_lines:[{line_status:'fulfilled'}]};
  assert.equal(c.taskConversationOrderTarget(finished).href,'ebay-order-history.html?historySearch=01-12345-67890&allDates=1');
  assert.equal(c.taskConversationOrderTarget({...order,ebay_order_lines:[{line_status:'pending',quantity:2,fulfilled_quantity:2}]}).pending,false);
  assert.equal(c.taskConversationOrderTarget({...finished,ebay_order_lines:[...finished.ebay_order_lines,...order.ebay_order_lines]}).pending,true);
});

test('message task actions do not link back to themselves as Open return', () => {
  const {context:c}=fixture();
  const task=c.normalizeTeamTask({...chat,status:'assigned',title:'Follow up'});
  assert.doesNotMatch(c.renderTaskActions(task),/Open return/);
});

test('untrusted order information is escaped in compact cards', () => {
  const {context:c}=fixture();
  const html=c.renderTaskConversationOrders({conversationOrdersState:'ready',conversationOrders:[{...order,buyer_name:'<img src=x onerror=alert(1)>'}]},{href:'email-triage.html'});
  assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);
});
