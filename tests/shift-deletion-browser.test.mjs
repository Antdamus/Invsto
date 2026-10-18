import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test,before,after} from 'node:test';
import {chromium,expect} from '@playwright/test';

const root=new URL('../',import.meta.url);
let server,browser,origin,modalCode,liveCode;
before(async()=>{
  const admin=await readFile(new URL('admin.js',root),'utf8');
  modalCode=admin.slice(admin.indexOf('let shiftAdminMode = null;'),admin.indexOf('async function fetchLiveNow()'));
  const overview=await readFile(new URL('admin-overview.js',root),'utf8');
  liveCode=overview.slice(overview.indexOf('// recompute durations'),overview.indexOf('// ---------- public ----------'));
  server=createServer(async(req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname.slice(1);
    if(!/^[\w./-]+$/.test(path)||path.includes('..'))return res.writeHead(404).end();
    try{
      let body=await readFile(new URL(path,root));
      if(path.endsWith('.html'))body=body.toString().replace(/<script\b[\s\S]*?<\/script>/gi,'');
      res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(body);
    }catch{res.writeHead(404).end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch();await mkdir(new URL('test-results/',root),{recursive:true});
});
after(async()=>{await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});});

async function open(t,width=1366){
  const context=await browser.newContext({viewport:{width,height:950},timezoneId:'America/New_York',hasTouch:width<700});
  t.after(()=>context.close());await context.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
  const page=await context.newPage();page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
  await page.goto(origin+'/admin.html');
  await page.evaluate(()=>{
    document.getElementById('adminApp').classList.remove('hidden');document.getElementById('guardLoading').classList.add('hidden');
    window.qs=id=>document.getElementById(id);window.show=(el,yes)=>el?.classList.toggle('hidden',!yes);
    window.fmtDurationHM=ms=>`${Math.floor(ms/3600000)}h ${Math.floor(ms/60000)%60}m`;
    window.fmtLocal=s=>new Date(s).toLocaleString();window.monthLabel=s=>s;
    window.escapeHtml=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
    window.getInitials=()=> 'NM';window.TimeCorrection={label:s=>s};
    window.OffsiteWork={loadAdmin:async()=>{}};
    window.entry={id:'shift-1',employee_id:'worker-1',store_id:null,clock_in:'2026-10-18T05:02:00Z',clock_out:null};
    window.rows=[{...entry,entry_id:entry.id,display_name:'Narelia Montiel',status:'work',has_anomaly:true,anomalies:['Unscheduled day'],photo_in_url:'https://example.test/photo.jpg'}];
    window.rpcCalls=[];window.toasts=[];window.liveRefreshes=0;window.summaryRefreshes=0;window.workCalls=[];window.drawerCalls=[];
    window.failRpc=null;window.failLookup=null;window.holdRpc=false;window.failSummary=false;window.failDrawer=false;
    window.showToast=(message,kind)=>toasts.push({message,kind});
    window.drawerContext={employeeId:null,monthStart:null,displayName:null};
    window.currentShiftsById=new Map();window.auditCache=new Map();
    window.ensureStoresCache=async()=>{};window.storeOptionsHTML=()=>'';
    window.refreshOverviewSummary=async()=>{summaryRefreshes++;if(failSummary)throw new Error('Summary unavailable');};
    window.fetchLiveNow=async()=>{liveRefreshes++;return rows;};
    window.fetchWorkerShifts=async()=>{if(failDrawer)throw new Error('Drawer unavailable');return [];};
    window.renderDrawerSummary=()=>{};window.renderDrawerList=()=>{};window.toggleAudit=async()=>{};
    window.AdminWorkReport={openShift:(...args)=>workCalls.push(args)};
    window.openWorkerDrawer=args=>drawerCalls.push(args);
    window.supabaseClient={
      from:()=>({select:()=>({eq:()=>({single:async()=>({data:entry,error:failLookup})})})}),
      rpc:async(name,args)=>{
        rpcCalls.push({name,args:structuredClone(args)});
        if(holdRpc)await new Promise(resolve=>window.releaseRpc=resolve);
        if(failRpc)return {error:{message:failRpc}};
        rows=[];return {data:{deleted:true,time_entry_id:entry.id,employee_id:entry.employee_id}};
      }
    };
  });
  await page.addScriptTag({content:modalCode});
  await page.addScriptTag({content:liveCode});
  await page.evaluate(()=>{
    window.deleteLiveShift=openLiveShiftDeletion;
    window.overviewApi={loadLiveNow};
    wireShiftAdminModal();wireLiveList();renderLiveNow(rows);
  });
  return page;
}
const deleteButton=page=>page.locator('[data-live-delete]');
const modal=page=>page.locator('#shiftAdminModal');

for(const width of [320,390,1366])test(`${width}px live delete opens the right worker with a required reason and safe cancel`,async t=>{
  const page=await open(t,width);
  await deleteButton(page).scrollIntoViewIfNeeded();
  assert.ok((await deleteButton(page).boundingBox()).height>=44);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:`test-results/shift-delete-card-${width}.png`});
  await deleteButton(page).click();
  await expect(modal(page)).toBeVisible();await expect(page.locator('#shiftAdminWorker')).toHaveText('Narelia Montiel');
  await expect(page.locator('#shiftAdminReason')).toBeFocused();
  await expect(page.locator('#shiftAdminWarning')).toContainText('payroll totals');
  await expect(page.locator('#shiftAdminDuration')).toContainText('audit trail');
  await expect(page.locator('#shiftAdminClockInRow')).not.toBeVisible();await expect(page.locator('#shiftAdminStoreRow')).not.toBeVisible();
  assert.equal(await page.evaluate(()=>workCalls.length+drawerCalls.length),0);
  await page.screenshot({path:`test-results/shift-delete-confirm-${width}.png`});
  await page.locator('#shiftAdminSaveBtn').click();await expect(page.locator('#shiftAdminError')).toContainText('3 to 2000');
  assert.equal(await page.evaluate(()=>rpcCalls.length),0);
  await page.locator('#shiftAdminCancelBtn').click();await expect(modal(page)).not.toBeVisible();await expect(deleteButton(page)).toBeFocused();
  assert.equal(await page.evaluate(()=>rpcCalls.length),0);
});

test('save uses the live shift identity independently of a previous drawer; one RPC, refresh and no dismissal while pending',async t=>{
  const page=await open(t);
  await page.evaluate(()=>{drawerContext={employeeId:'other-worker',monthStart:'2026-10-01',displayName:'Other Worker'};holdRpc=true;});
  await deleteButton(page).click();await page.locator('#shiftAdminReason').fill('  Opened by mistake; no work performed.  ');
  await page.locator('#shiftAdminSaveBtn').click();await expect(page.locator('#shiftAdminSaveBtn')).toBeDisabled();
  await page.keyboard.press('Escape');await expect(modal(page)).toBeVisible();await expect(page.locator('#shiftAdminCancelBtn')).toBeDisabled();
  await page.evaluate(()=>saveShiftAdminAction());assert.equal(await page.evaluate(()=>rpcCalls.length),1);
  await page.evaluate(()=>releaseRpc());await expect(modal(page)).not.toBeVisible();await expect(page.locator('#liveList')).toContainText('No one is clocked in');
  const state=await page.evaluate(()=>({rpcCalls,liveRefreshes,summaryRefreshes,drawerContext,toasts}));
  assert.deepEqual(state.rpcCalls,[{name:'admin_delete_shift_entry',args:{_time_entry_id:'shift-1',_reason:'Opened by mistake; no work performed.',_expected_clock_in:'2026-10-18T05:02:00Z',_expected_clock_out:null}}]);
  assert.equal(state.drawerContext.employeeId,'other-worker');assert.equal(state.liveRefreshes,1);assert.equal(state.summaryRefreshes,1);
  assert.ok(state.toasts.some(t=>t.message==='Shift deleted with audit snapshot'));
});

test('server errors keep the reason and shift visible; retry succeeds and refresh failures are reported as saved',async t=>{
  const page=await open(t);await page.evaluate(()=>failRpc='This shift changed after you opened it.');
  await deleteButton(page).click();await page.locator('#shiftAdminReason').fill('Opened by mistake');await page.locator('#shiftAdminSaveBtn').click();
  await expect(page.locator('#shiftAdminError')).toContainText('changed after');await expect(page.locator('#shiftAdminReason')).toHaveValue('Opened by mistake');
  await expect(page.locator('#shiftAdminSaveBtn')).toBeEnabled();await expect(deleteButton(page)).toHaveCount(1);
  assert.equal(await page.evaluate(()=>toasts.length),0);
  await page.evaluate(()=>{failRpc=null;failSummary=true;failDrawer=true;drawerContext={employeeId:'other',monthStart:'2026-10-01'};});
  await page.locator('#shiftAdminSaveBtn').click();await expect(modal(page)).not.toBeVisible();await expect(deleteButton(page)).toHaveCount(0);
  assert.ok((await page.evaluate(()=>toasts)).some(t=>t.message.includes('saved. Refresh')));
});

test('a finished or unavailable shift does not open a delete confirmation, and keyboard focus stays in the form',async t=>{
  const page=await open(t);await page.evaluate(()=>entry.clock_out='2026-10-18T06:00:00Z');
  await deleteButton(page).click();await expect(modal(page)).not.toBeVisible();assert.equal(await page.evaluate(()=>rpcCalls.length),0);
  assert.ok((await page.evaluate(()=>toasts)).some(t=>t.message.includes('no longer open')));
  await page.evaluate(()=>{entry.clock_out=null;failLookup={message:'Shift unavailable'};});
  await deleteButton(page).click();await expect(modal(page)).not.toBeVisible();
  await page.evaluate(()=>failLookup=null);await deleteButton(page).click();await expect(modal(page)).toBeVisible();
  await page.locator('#shiftAdminSaveBtn').focus();await page.keyboard.press('Tab');await expect(page.locator('#shiftAdminCloseBtn')).toBeFocused();
  await page.keyboard.press('Shift+Tab');await expect(page.locator('#shiftAdminSaveBtn')).toBeFocused();
  await page.keyboard.press('Escape');await expect(modal(page)).not.toBeVisible();await expect(deleteButton(page)).toBeFocused();
});

test('deleting during a live poll queues a fresh read so the removed shift cannot reappear',async t=>{
  const page=await open(t);
  await page.evaluate(()=>{
    window.fetchLiveNow=async()=>{
      liveRefreshes++;
      const snapshot=structuredClone(rows);
      if(liveRefreshes===1)await new Promise(resolve=>window.releasePoll=resolve);
      return snapshot;
    };
    window.pollPromise=loadLiveNow();
  });
  await deleteButton(page).click();await page.locator('#shiftAdminReason').fill('Opened by mistake');await page.locator('#shiftAdminSaveBtn').click();
  await expect(modal(page)).not.toBeVisible();
  await page.evaluate(async()=>{releasePoll();await pollPromise;});
  await expect(page.locator('#liveList')).toContainText('No one is clocked in');
  assert.equal(await page.evaluate(()=>liveRefreshes),2);
});

test('the existing timesheet delete handles completed shifts with the same audited confirmation',async t=>{
  const page=await open(t);
  await page.evaluate(async()=>{
    drawerContext={employeeId:entry.employee_id,displayName:'Narelia Montiel',monthStart:'2026-10-01'};
    entry.clock_out='2026-10-18T06:00:00Z';
    await openShiftAdminModal('delete',entry);
  });
  await expect(page.locator('#shiftAdminWorker')).toContainText('Narelia Montiel');
  await page.locator('#shiftAdminReason').fill('Duplicate completed shift');await page.locator('#shiftAdminSaveBtn').click();
  await expect(modal(page)).not.toBeVisible();
  assert.equal((await page.evaluate(()=>rpcCalls))[0].args._expected_clock_out,'2026-10-18T06:00:00Z');
});
