import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test,before,after} from 'node:test';
import {chromium,webkit,expect} from '@playwright/test';
let server,browser,origin,tabCode;
const root=new URL('../',import.meta.url);
before(async()=>{
 const admin=await readFile(new URL('admin.js',root),'utf8');
 tabCode=admin.slice(admin.indexOf('function activateTab(which)'),admin.indexOf('let rtChannel = null;'));
 server=createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname.slice(1);if(!/^[\w./-]+$/.test(path)||path.includes('..'))return res.writeHead(404).end();try{let body=await readFile(new URL(path,root));if(path.endsWith('.html'))body=body.toString().replace(/<script\b[\s\S]*?<\/script>/gi,'');res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(body);}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
 browser=await(process.env.INVSTO_WORK_BROWSER==='webkit'?webkit:chromium).launch();await mkdir(new URL('test-results/',root),{recursive:true});
});
after(async()=>{await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});});
async function open(t,width=1366){
 const context=await browser.newContext({viewport:{width,height:950},timezoneId:'Asia/Tokyo',hasTouch:width<700});t.after(()=>context.close());
 await context.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
 const page=await context.newPage();page.setDefaultTimeout(6500);const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));await page.goto(origin+'/admin.html');
 await page.evaluate(()=>{
  document.getElementById('adminApp').classList.remove('hidden');document.getElementById('guardLoading').classList.add('hidden');
  window.qs=id=>document.getElementById(id);window.show=(el,yes)=>el?.classList.toggle('hidden',!yes);
  const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  window.calls=[];window.delays=[];window.failReport=false;window.hold=false;
  window.testWorker={id:id(2),display_name:'Sandra',email:'sandra@example.test',active:true,records:105,metrics:{tasks_completed:3,tasks_closed:2,units_checked_in:18,items_created:7,replies_sent:4,admin_closeouts:1},categories:{tasks:104,packaging:1},clocked_seconds:23400,break_seconds:1800,shifts:[{id:id(50),clock_in:'2026-10-13T12:00:00Z',clock_out:null,clocked_seconds:23400,break_seconds:1800,store:'Downtown',correction_count:0}]};
  window.testEvents=Array.from({length:105},(_,n)=>({event_key:'team_task_events:'+id(n+500),source:'team_task_events',actor_user_id:id(200),occurred_at:'2026-10-13T16:02:03Z',category:n===0?'packaging':'tasks',action:n===0?'admin_closeout':'completed_by_employee',title:n===0?'Package closed by admin':'Include certificate '+n,notes:n===1?'<img src=x onerror="window.injected=true"> Saved note':'A signed action.',quantity:0,details:n===0?{shipment_id:id(90),payload:{reason:'Owner requested administrative closeout'}}:{task_id:id(10),task_source:'team',old_status:'in_progress',new_status:'completed_by_employee',photo_attachments:[{bucket:'team-task-evidence',path:'reference.jpg'}],payload:{signature:'Sandra',before:{title:'Original'},after:{title:'Updated'}}}}));
  window.supabase={rpc:async(name,args)=>{
   calls.push({name,args:structuredClone(args)});
   if(failReport){failReport=false;return {error:{message:'Connection interrupted'}};}
   if(hold) await new Promise(r=>delays.push(r));
   const events=testEvents.filter(e=>(!args._category||e.category===args._category)&&(!args._search||JSON.stringify(e).includes(args._search)));
   const w=structuredClone(testWorker);if(args._shift_id)w.records=80;
   return {data:{day:args._day,time_zone:'America/New_York',as_of:'2026-10-13T18:30:00Z',start_at:args._shift_id?'2026-10-13T12:00:00Z':'2026-10-13T04:00:00Z',end_at:args._shift_id?'2026-10-13T18:30:00Z':'2026-10-14T04:00:00Z',shift_id:args._shift_id,unattributed_records:0,workers:args._employee_id?[w]:[w,{...w,id:id(3),display_name:'Alex',email:'alex@example.test',records:0,metrics:{},categories:{},shifts:[],clocked_seconds:0,break_seconds:0}],total:args._employee_id?events.length:0,events:args._employee_id?events.slice(args._offset||0,(args._offset||0)+(args._limit||50)):[]}};
  }};
 });
 await page.addScriptTag({url:origin+'/admin-work-report.js'});await page.addScriptTag({content:tabCode});await page.evaluate(()=>wireTabs());await page.addScriptTag({url:origin+'/admin-shell.js'});
 if(width<800){await page.getByRole('button',{name:'More',exact:true}).click();await page.locator('#moreSheet [data-tab=workreport]').click();}
 else await page.getByRole('tab',{name:'Employee work',exact:true}).click();
 try {await expect(page.locator('.work-worker')).toHaveCount(2);} catch(error) {throw new Error((await page.locator('#workStatus').textContent())+' '+JSON.stringify(await page.evaluate(()=>({calls,day:document.getElementById('workDay').value,report:typeof AdminWorkReport,wire:wireTabs.toString().slice(0,450),active:document.getElementById('tabWorkReport').getAttribute('aria-selected'),qs:qs.toString()})))+' '+error.message);}
 return page;
}
const worker=page=>page.locator('.work-worker').filter({has:page.locator('.work-person strong',{hasText:'Sandra'})});
async function expand(page){await worker(page).locator(':scope > summary').click();await expect(worker(page).locator('.work-event')).toHaveCount(50);return worker(page);}

for(const width of [320,390,1366])test(`${width}px worker accordion, New York timestamps, source details and mobile navigation`,async t=>{
 const page=await open(t,width),card=await expand(page);
 await card.locator(':scope > summary').scrollIntoViewIfNeeded();await page.screenshot({path:`test-results/work-report-summary-${width}.png`,fullPage:false});
 await expect(page.locator('#panelWorkReport')).toBeVisible();await expect(page.locator('#panelOverview')).not.toBeVisible();
 await expect(card.locator('.work-detail-status')).toContainText('50 of 105');await expect(card.locator('.work-event-time').first()).toContainText('12:02:03 PM EDT');
 await expect(card.locator('.work-stats')).toContainText('Tasks closed');await expect(card.locator('.work-stats')).toContainText('Admin package closeouts');
 await card.locator('.work-evidence summary').nth(1).click();await expect(card.locator('.work-evidence').nth(1)).toContainText('Signature');await expect(card.locator('.work-evidence').nth(1)).toContainText('reference.jpg');
 assert.equal(await page.evaluate(()=>window.injected),undefined);assert.equal(await card.locator('img[src=x]').count(),0);
 await expect(card.getByRole('link',{name:'Open task'}).first()).toHaveAttribute('href',/team-tasks\.html\?taskId=.*&source=team/);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:`test-results/work-report-${width}.png`,fullPage:false});
 await page.locator('#workWorkerSearch').fill('Alex');await expect(worker(page)).not.toBeVisible();await page.locator('#workWorkerSearch').fill('Sandra');await expect(worker(page)).toBeVisible();
});

test('full pagination, category/search filtering, stable snapshot and separate summary totals',async t=>{
 const page=await open(t),card=await expand(page);
 await card.getByRole('button',{name:'Load more actions'}).click();await expect(card.locator('.work-event')).toHaveCount(100);
 await card.getByRole('button',{name:'Load more actions'}).click();await expect(card.locator('.work-event')).toHaveCount(105);await expect(card.locator('.work-more')).not.toBeVisible();
 await card.locator('[data-work-category]').selectOption('packaging');await expect(card.locator('.work-event')).toHaveCount(1);await expect(card.locator('.work-stats')).toContainText('18');
 await card.locator('[data-work-category]').selectOption('tasks');await card.locator('[data-work-query]').fill('Include certificate 10');await card.getByRole('button',{name:'Search',exact:true}).click();await expect(card.locator('.work-event')).toHaveCount(6);
 const calls=await page.evaluate(()=>window.calls);assert.ok(calls.filter(c=>c.args._employee_id).every(c=>c.args._as_of==='2026-10-13T18:30:00Z'));
 assert.equal(calls.at(-1).args._search,'Include certificate 10');assert.equal(calls.at(-1).args._offset,0);
});

test('date changes clear previous work, errors stay visible and retry recovers',async t=>{
 const page=await open(t);await expand(page);await page.evaluate(()=>failReport=true);
 await page.locator('#workDay').fill('2026-10-12');await page.locator('#workDay').press('Tab');await expect(page.locator('#workStatus')).toContainText('Connection interrupted');await expect(page.locator('.work-worker')).toHaveCount(0);
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await expect(page.locator('.work-worker')).toHaveCount(2);
 assert.equal((await page.evaluate(()=>calls.at(-1))).args._day,'2026-10-12');
 await expand(page);await page.evaluate(()=>failReport=true);await worker(page).locator('[data-work-category]').selectOption('packaging');await expect(worker(page).locator('.work-detail-status')).toContainText('Could not load actions');
 await worker(page).getByRole('button',{name:'Retry loading actions'}).click();await expect(worker(page).locator('.work-event')).toHaveCount(1);
 await page.locator('#workDay').fill('');await page.locator('#workDay').press('Tab');await expect(page.locator('#workStatus')).toHaveText('Choose a date.');await expect(page.locator('.work-worker')).toHaveCount(0);
});

test('changing shift while a request is running discards the stale response',async t=>{
 const page=await open(t),card=await expand(page);await page.evaluate(()=>hold=true);
 await card.locator('[data-work-shift]').selectOption('00000000-0000-4000-8000-000000000050');
 await card.locator('[data-work-shift]').selectOption('');
 await page.waitForFunction(()=>delays.length===2);await page.evaluate(()=>{hold=false;delays[1]();});await expect(card.locator('.work-event')).toHaveCount(50);
 await page.evaluate(()=>delays[0]());await expect(card.locator('.work-event')).toHaveCount(50);
 await expect(card.locator('.work-window')).toContainText('end exclusive');await expect(card.locator('[data-work-shift]')).toHaveValue('');
});

test('View work opens the requested employee and full shift',async t=>{
 const page=await open(t);
 await page.evaluate(()=>AdminWorkReport.openShift('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000050','2026-10-13T12:00:00Z'));
 await expect(worker(page)).toHaveAttribute('open','');await expect(worker(page).locator('.work-event')).toHaveCount(50);
 await expect(worker(page).locator('[data-work-shift]')).toHaveValue('00000000-0000-4000-8000-000000000050');
 await expect(worker(page).locator('.work-window')).not.toContainText('end exclusive');
});
