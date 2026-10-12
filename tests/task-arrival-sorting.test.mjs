import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';

const source = await readFile(new URL('../team-tasks.js', import.meta.url), 'utf8');
function workspace() {
  const context = vm.createContext({document: {addEventListener() {}}, window: {addEventListener() {}}});
  vm.runInContext(source + '\nthis.taskState = state;', context);
  return context;
}
const task = (id, created, extra = {}) => ({id, source: 'team', created_at: created, assigned_to_user_id: 'worker', ...extra});
const ids = rows => Array.from(rows, row => row.id);

test('active and history default to arrival order across task sources, regardless of priority or later edits', () => {
  const app = workspace();
  const rows = [
    task('old-urgent', '2026-10-01T12:00:00Z', {priority: 'urgent', updated_at: '2026-10-12T23:00:00Z', resolved_at: '2026-10-12T23:00:00Z'}),
    task('order', '2026-10-12T12:00:00Z', {source: 'order', priority: 'normal'}),
    task('return', '2026-10-11T12:00:00Z', {source: 'return'}),
    task('unassigned', '2026-10-12T15:00:00Z', {assigned_to_user_id: null}),
  ];
  assert.deepEqual(ids(app.sortUnifiedTasks(rows)), ['unassigned', 'order', 'return', 'old-urgent']);
  assert.deepEqual(ids(app.sortHistoryTasks(rows)), ['unassigned', 'order', 'return', 'old-urgent']);
  assert.deepEqual(ids(rows), ['old-urgent', 'order', 'return', 'unassigned'], 'sorting does not mutate the source');
});

test('a new assignment moves an older task up; progress and other assignees do not change its arrival time', () => {
  const app = workspace();
  const rows = [task('new', '2026-10-12T12:00:00Z'), task('reassigned', '2026-09-01T12:00:00Z')];
  app.taskState.eventsByTask.set('team:reassigned', [
    {action: 'assigned', new_assigned_to_user_id: 'worker', created_at: '2026-10-12T13:00:00Z'},
    {action: 'progress', created_at: '2026-10-12T15:00:00Z'},
    {action: 'assigned', new_assigned_to_user_id: 'someone-else', created_at: '2026-10-12T16:00:00Z'},
  ]);
  assert.deepEqual(ids(app.sortUnifiedTasks(rows)), ['reassigned', 'new']);
  assert.equal(app.getTaskAssignedSortTime(rows[1]), Date.parse('2026-10-12T13:00:00Z'));
  assert.deepEqual(ids(app.sortUnifiedTasks(rows, 'assigned_asc')), ['new', 'reassigned']);
});

test('missing dates sort last and ties stay stable even when tasks are updated or returned in a different order', () => {
  const app = workspace();
  const rows = [task('b', '2026-10-12T12:00:00Z'), task('a', '2026-10-12T12:00:00Z'), task('unknown', 'invalid')];
  assert.deepEqual(ids(app.sortUnifiedTasks(rows)), ['a', 'b', 'unknown']);
  rows[0].updated_at = '2026-10-13T12:00:00Z';
  assert.deepEqual(ids(app.sortUnifiedTasks(rows.reverse())), ['a', 'b', 'unknown']);
  app.taskState.taskHistorySort = 'recent';
  assert.equal(app.sortHistoryTasks(rows)[0].id, 'b', 'the optional recent-updates sort remains available');
});
