import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';

const code = await readFile(new URL('../pending-orders.js', import.meta.url), 'utf8');
function fixture() {
  const context = vm.createContext({console, URL, URLSearchParams, setTimeout, clearTimeout,
    window: {addEventListener(){}, location:{search:''}},
    document: {addEventListener(){}, getElementById(){return null;}}});
  vm.runInContext(code, context);
  vm.runInContext(`state.orderTaskAssignees = [{user_id:'worker',display_name:'Worker'}];
    var line = {id:'line',order_id:'order',order:{buyer_username:'buyer'}};
    var task = {id:'task',source:'team',buyer_username:'buyer',assigned_to_user_id:'worker',
      question:'Cancel the order',latest_note:'Customer now wants the watch.',status:'completed_by_employee',
      created_at:'2026-10-10T16:23:00Z'};
    state.customerTaskNotes.set('buyer',{data:[task]});`, context);
  return context;
}

test('completed conversation task shows the saved update in both collapsed summary and visible entry', () => {
  const f = fixture();
  const entries = f.getGroupSharedTasks([f.line]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].notes, 'Customer now wants the watch.');
  const html = f.renderQueueTaskEntry(entries[0], [f.line]);
  const [visible, details] = html.split('<details');
  assert.match(visible, /Latest update/);
  assert.match(visible, /Customer now wants the watch/);
  assert.doesNotMatch(visible, /Cancel the order/);
  assert.match(details, /Completed by worker/);
  assert.match(details, /Original assignment.*Cancel the order/s);
  assert.match(details, /team-tasks.html\?taskId=task/);
  const group = f.renderGroupSharedNotes([f.line], 'buyer');
  assert.match(group.split('</button>')[0], /Customer now wants the watch/);
  assert.doesNotMatch(group.split('</button>')[0], /Cancel the order/);
});

test('unchanged or blank latest notes show one original instruction without a fake update', () => {
  const f = fixture();
  for (const latest of [null, '', '  ', ' Cancel the order ']) {
    f.task.latest_note = latest;
    const html = f.renderQueueTaskEntry(f.getGroupSharedTasks([f.line])[0], [f.line]);
    assert.equal(html.match(/Cancel the order/g).length, 1);
    assert.doesNotMatch(html, /Latest update|Original assignment/);
  }
});

test('return and independent customer task updates are escaped and compact with evidence still accessible', () => {
  const f = fixture();
  for (const source of ['team','return']) {
    f.task.source = source;
    f.task.latest_note = '<img src=x onerror=bad()>\nUse the <small> box & keep the receipt.';
    f.task.attachment_count = 2;
    const html = f.renderQueueTaskEntry(f.getGroupSharedTasks([f.line])[0], [f.line]);
    assert.match(html.split('<details')[0], /&lt;img src=x onerror=bad\(\)&gt;/);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /2 files/);
    assert.match(html, /Open task · 2 files/);
    assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  }
});

test('order task keeps update date, author, original instructions and photos without duplicate customer entry', () => {
  const f = fixture();
  vm.runInContext(`task.source='order'; task.order_id='order'; task.order_line_ids=['line'];
    state.sharedOrderNoteHistory.set('order',{data:{tasks:[task],events:[{
      task_id:'task',notes:task.latest_note,created_at:'2026-10-10T17:13:00Z',signed_by_email:'worker@example.test',
      photo_attachments:[{bucket:'proof',path:'photo.jpg',label:'Proof'}]
    }]}});`, f);
  const entries = f.getGroupSharedTasks([f.line]);
  assert.equal(entries.length, 1);
  const [visible, details] = f.renderQueueTaskEntry(entries[0], [f.line]).split('<details');
  assert.match(visible, /Latest update.*Oct 10.*worker@example.test/s);
  assert.match(visible, /Customer now wants the watch/);
  assert.match(details, /Original assignment/);
  assert.match(details, /data-queue-task-photo="task"/);
});

test('closed customer tasks remain excluded and unrelated buyers never enter the group', () => {
  const f = fixture();
  f.task.status = 'resolved';
  assert.equal(f.getGroupSharedTasks([f.line]).length, 0);
  f.task.status = 'assigned';
  assert.equal(f.getGroupSharedTasks([{...f.line,order:{buyer_username:'other'}}]).length, 0);
});
