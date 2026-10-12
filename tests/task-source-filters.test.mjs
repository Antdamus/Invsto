import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';

const source = await readFile(new URL('../team-tasks.js', import.meta.url), 'utf8');
function workspace() {
  const app = vm.createContext({document: {addEventListener() {}}, window: {addEventListener() {}}});
  vm.runInContext(source + '\nthis.taskState = state;', app);
  return app;
}
const issue = (app, id, kind, lane) => app.normalizeReturnTask({id, ebay_return_cases: {issue_kind: kind, source_lane: lane}});
const ids = tasks => Array.from(tasks, task => task.id);

test('case tasks use the actual case kind and show matching card labels', () => {
  const app = workspace();
  for (const [kind, lane, label] of [['return', 'return', 'Return'], ['request', 'inquiry', 'Buyer request'], ['dispute', 'payment_dispute', 'Payment dispute'], ['dispute', 'case', 'eBay case']]) {
    const task = issue(app, lane, kind, lane);
    assert.equal(app.getTaskSourceFilterValue(task), kind);
    assert.equal(app.getTaskSourceLabel(task), label);
  }
  assert.equal(app.getTaskSourceFilterValue(issue(app, 'legacy', null, 'inquiry')), 'request');
  assert.equal(app.getTaskSourceFilterValue(issue(app, 'legacy-case', null, 'case')), 'dispute');
  assert.equal(app.getTaskSourceFilterValue(app.normalizeReturnTask({ebay_return_cases: [{issue_kind: 'dispute', source_lane: 'payment_dispute'}]})), 'dispute');
});

test('a task created from a message stays in Messages after being linked to an order or return', () => {
  const app = workspace();
  for (const source of ['team', 'order', 'return']) {
    const task = {source, metadata: {source: 'ebay_conversation_message', task_tag: 'refunds'}};
    assert.equal(app.getTaskSourceFilterValue(task), 'ebay_triage');
    assert.equal(app.getTaskSourceLabel(task), 'Message · Refund');
  }
  assert.equal(app.getTaskSourceFilterValue({source: 'order', metadata: {conversation_id: 'context-only'}}), 'order', 'linked chat alone is not message origin');
});

test('source buttons count and filter distinct categories, with Orders including pending and history work', () => {
  const app = workspace();
  const rows = [
    issue(app, 'return', 'return', 'return'), issue(app, 'dispute', 'dispute', 'payment_dispute'), issue(app, 'request', 'request', 'inquiry'),
    {id: 'message', source: 'order', metadata: {source: 'ebay_conversation_message'}},
    {id: 'order', source: 'order'}, {id: 'history', source: 'order', metadata: {source: 'order_history'}}, {id: 'general', source: 'team'},
  ];
  const counts = app.getTaskSourceCounts(rows);
  assert.equal(counts.all, 7); assert.equal(counts.orders, 2);
  for (const key of ['return', 'dispute', 'request', 'ebay_triage', 'independent']) assert.equal(counts[key], 1);
  app.taskState.taskSourceFilter = 'orders'; assert.deepEqual(ids(app.getTasksForSourceFilter(rows)), ['order', 'history']);
  app.taskState.taskSourceFilter = 'dispute'; assert.deepEqual(ids(app.getTasksForSourceFilter(rows)), ['dispute']);
  app.taskState.taskSourceFilter = 'ebay_triage'; assert.deepEqual(ids(app.getTasksForSourceFilter(rows)), ['message']);
  app.taskState.taskSourceFilter = 'all'; assert.equal(app.getTasksForSourceFilter(rows).length, 7);
});
