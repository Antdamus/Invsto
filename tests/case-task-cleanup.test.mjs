import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';

test('browser and database agree on imported reminders, explicit assignments and legacy staff work',async()=>{
 const context={};vm.runInNewContext(await readFile(new URL('../task-workflow.js',import.meta.url),'utf8'),context);
 const workflow=context.OGTaskWorkflow,db=new PGlite();
 try {
  const sql=await readFile(new URL('../supabase/migrations/20261010110000_customer_issue_employee_tasks.sql',import.meta.url),'utf8');
  await db.exec(sql.slice(sql.indexOf('create or replace function public.customer_issue_is_employee_task'),sql.indexOf('revoke all on function')));
  for(const source of ['ebay_return_api','ebay_post_order_api','ebay_return_extension','customer_issue_action',' EBAY_RETURN_API ','return_receiving','og_return_queue','']){
   for(const assigned_by of [null,'staff']){
    const task={source:'return',status:'assigned',assigned_to_user_id:'me',assigned_by,created_by:'importer',metadata:{source}};
    const actual=(await db.query('select customer_issue_is_employee_task($1) yes',[JSON.stringify(task)])).rows[0].yes;
    const expected=!!assigned_by||['return_receiving','og_return_queue',''].includes(source);
    assert.equal(actual,expected,source);assert.equal(workflow.isEmployeeTask(task),actual,source);
    assert.equal(workflow.bucket(task,'me'),expected?'assigned':null);
    task.status='resolved';assert.equal(workflow.bucket(task,'me'),expected?'history':null);
   }
  }
 } finally {await db.close();}
});

test('the team and dashboard lists exclude automatic tasks even if stale data is returned',async()=>{
 const context={};vm.runInNewContext(await readFile(new URL('../task-workflow.js',import.meta.url),'utf8'),context);
 context.isTruthyMetadataFlag=v=>v===true;context.isAdminCancelledAssignmentTask=()=>false;context.DASH_PARENT_TYPES=new Set();
 const team=await readFile(new URL('../team-tasks.js',import.meta.url),'utf8'),dashboard=await readFile(new URL('../dashboard.js',import.meta.url),'utf8');
 vm.runInNewContext(team.slice(team.indexOf('function isTaskHiddenFromTaskPage('),team.indexOf('function isTaskRemovedFromActiveView(')),context);
 vm.runInNewContext(dashboard.slice(dashboard.indexOf('function visibleDashboardTask('),dashboard.indexOf('function normalizeDashboardTask(')),context);
 const task={source:'return',status:'open',metadata:{source:'customer_issue_action'},assigned_to_user_id:'me'};
 assert.equal(context.isTaskHiddenFromTaskPage(task),true);assert.equal(context.visibleDashboardTask(task),false);
 task.assigned_by='staff';assert.equal(context.isTaskHiddenFromTaskPage(task),false);assert.equal(context.visibleDashboardTask(task),true);
});

test('single and bulk case closeout retain concurrency checks for hidden tracking records',async()=>{
 const source=await readFile(new URL('../customer-issues.js',import.meta.url),'utf8');
 const context={finish:new Set(['resolved','cancelled','closed','approved_by_admin'])};
 const declaration=source.match(/const closeTaskSnapshot=.*?;/)[0];
 vm.runInNewContext(declaration+'\nthis.snapshot=closeTaskSnapshot;',context);
 const tasks=[{id:'human',status:'assigned',updated_at:'1'},{id:'automatic',status:'open',updated_at:'2',metadata:{source:'ebay_return_api'}},{id:'done',status:'resolved',updated_at:'3'}];
 assert.deepEqual(JSON.parse(JSON.stringify(context.snapshot(tasks))),[{id:'human',updated_at:'1'},{id:'automatic',updated_at:'2'}]);
 assert.match(source,/snapshot:closeTaskSnapshot\(tasks\)/);
 assert.match(source,/_expected_tasks:entry.snapshot/);
 assert.match(source,/const snapshot=closeTaskSnapshot\(detail.tasks\)/);
});
