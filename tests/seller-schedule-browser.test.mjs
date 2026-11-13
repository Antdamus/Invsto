import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, webkit } from '@playwright/test';

const root=new URL('../',import.meta.url);
const mock = `
const testEmployee={id:'seller-admin',user_id:'user-admin',display_name:'Jose',email:'jose@example.test',role:'admin',active:true};
window.testCalls=[];window.testFailSave=false;window.testFailLoad=false;
const base=new Date();base.setHours(0,0,0,0);const monday=new Date(base);monday.setDate(monday.getDate()-((monday.getDay()+6)%7));
const at=(day,hour)=>{const d=new Date(monday);d.setDate(d.getDate()+day);d.setHours(hour);return d.toISOString()};
window.testRows=[
 {shift_id:'s1',seller_employee_id:'seller-otello',seller_name:'Otello',channel:'ebay',start_at:at(0,18),end_at:at(0,21),notes:'The watch edit · Collectors’ favorites'},
 {shift_id:'s2',seller_employee_id:'seller-sydney',seller_name:'Sydney',channel:'whatnot',start_at:at(1,14),end_at:at(1,17),notes:'A little gold, a lot to love'},
 {shift_id:'s3',seller_employee_id:'seller-otello',seller_name:'Otello',channel:'ebay',start_at:at(2,19),end_at:at(2,22),notes:'After-hours watch club'},
 {shift_id:'s4',seller_employee_id:'seller-sydney',seller_name:'Sydney',channel:'tiktok',start_at:at(3,12),end_at:at(3,15),notes:'Everyday pieces. Exceptional finds.'},
 {shift_id:'s5',seller_employee_id:'seller-manny',seller_name:'Manny',channel:'whatnot',start_at:at(3,18),end_at:at(3,21),notes:'The vintage collection'},
 {shift_id:'s6',seller_employee_id:'seller-otello',seller_name:'Otello',channel:'ebay',start_at:at(4,20),end_at:at(5,1),notes:'Friday night, in good company'},
 {shift_id:'s7',seller_employee_id:'seller-sydney',seller_name:'Sydney',channel:'whatnot',start_at:at(5,13),end_at:at(5,16),notes:'Weekend treasures'},
 {shift_id:'s8',seller_employee_id:'seller-manny',seller_name:'Manny',channel:'tiktok',start_at:at(6,16),end_at:at(6,19),notes:'The Sunday selection'},
].map(r=>({...r,metadata:['s1','s3'].includes(r.shift_id)?{recurrence_id:'repeat-1'}:{},row_type:'shift',store_id:'store-1',store_name:'Airport Store',status:'booked',is_blocked:false,is_mine:false,can_change_without_approval:true}));
window.testSellers=[testEmployee,{id:'seller-otello',display_name:'Otello'},{id:'seller-sydney',display_name:'Sydney'},{id:'seller-manny',display_name:'Manny'}];
window.supabase={auth:{getSession:async()=>({data:{session:{user:{id:testEmployee.user_id}}}}),signOut:async()=>({})},from(table){
 const q={select(){return q},eq(){return q},in(){return q},order(){return q},limit(){return q},update(){return q},maybeSingle:async()=>({data:testEmployee}),then(resolve){resolve({data:table==='store_locations'?[{id:'store-other',name:'Seybold Store',active:true},{id:'store-1',name:'Airport Store',active:true}]:[]})}};return q;
},rpc:async(name,args)=>{
 window.testCalls.push({name,args});
 if(name==='notification_inbox'){
   const notice={id:'notification-1',recipient_user_id:testEmployee.user_id,notification_type:'task_assigned',category:'tasks',title:'Sample update',body:'Review your assigned work.',created_at:new Date().toISOString(),read_at:null};
   return {data:{unread:[notice],entries:[notice],unread_count:124,total:1,counts:{all:124,tasks:124}}};
 }
 if(name==='current_user_can_use_seller_schedule')return {data:true};
 if(name==='get_seller_schedule_month')return window.testFailLoad?{error:{message:'Connection unavailable'}}:{data:window.testRows};
 if(name==='get_live_sale_seller_directory')return {data:window.testSellers};
 if(name==='get_seller_show_sms_readiness')return {data:window.testSellers.map(s=>({seller_employee_id:s.id,sms_ready:s.id!=='seller-otello',phone_last_four:s.id==='seller-sydney'?'7356':'1234',reason:s.id==='seller-otello'?'missing_phone':'ready'}))};
 if(name==='admin_create_seller_show_recurrence'){
   if(window.testFailSave)return {error:{message:'Please try again. Connection interrupted.'}};
   return {data:{status:'scheduled',recurrence_id:'new-pattern',created:4}};
 }
 if(['admin_schedule_seller_show','book_seller_sale_shift'].includes(name)){
   if(window.testFailSave)return {error:{message:'Please try again. Connection interrupted.'}};
   const person=window.testSellers.find(s=>s.id===args._seller_employee_id)||testEmployee;
   window.testRows.push({row_type:'shift',shift_id:'created',seller_employee_id:person.id,seller_name:person.display_name,channel:args._channel,store_id:args._store_id,store_name:'Airport Store',start_at:args._start_at,end_at:args._end_at,notes:args._notes,status:'booked',is_mine:false,can_change_without_approval:true});return {data:{status:'booked'}};
 }
 if(name==='request_seller_sale_shift_edit'){const row=window.testRows.find(r=>r.shift_id===args._shift_id);Object.assign(row,{channel:args._channel,start_at:args._start_at,end_at:args._end_at,notes:args._reason});return {data:{status:'updated'}};}
 if(name==='cancel_seller_sale_shift'){window.testRows=window.testRows.filter(r=>r.shift_id!==args._shift_id);return {data:{status:'cancelled'}};}
 if(name==='admin_stop_seller_show_recurrence'){window.testRows=window.testRows.filter(r=>r.metadata?.recurrence_id!==args._recurrence_id);return {data:{status:'stopped',cancelled_shows:2}};}
 return {data:[]};
}};
`;

async function openPage(browser,width,employeeHost=false){
  const page=await browser.newPage({viewport:{width,height:width<600?844:1060},timezoneId:'America/New_York'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.hostname!=='schedule.test')return route.fulfill({body:'',contentType:url.pathname.endsWith('.css')?'text/css':'text/javascript'});
    const file=url.pathname.slice(1)||'seller-dashboard.html';
    if(file==='initSupabase.js')return route.fulfill({body:mock+(employeeHost?"testEmployee.role='employee';testEmployee.id='seller-sydney';":''),contentType:'text/javascript'});
    try{await route.fulfill({body:await readFile(new URL(file,root)),contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript'});}catch{await route.fulfill({status:404,body:''});}
  });
  await page.goto('https://schedule.test/seller-dashboard.html');
  await page.waitForFunction(()=>document.querySelector('#ss-total').textContent==='8');
  return {page,errors};
}

for(const width of [360,390,430,1440])test(`show planner at ${width}px: views, filters, assignments, save retry, overnight and cancellation`,async()=>{
  const browser=await chromium.launch();
  try{
    const {page,errors}=await openPage(browser,width);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no page overflow');
    if(width<600){
      assert.equal(await page.locator('.ss-week-grid').count(),0,'phone week is a touch-friendly daily agenda');
      await page.locator('#ss-mobile-week button').nth(3).click();
      assert.equal(await page.locator('#seller-calendar .ss-show-card').count(),2);
    }else assert.equal(await page.locator('.ss-week-grid .ss-platform-heading').count(),3);
    await mkdir(new URL('../output/show-studio/',import.meta.url),{recursive:true});
    await page.screenshot({path:new URL('../output/show-studio/'+width+'.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'),fullPage:true});
    await page.locator('[data-view="agenda"]').click();
    await page.locator('.ss-agenda').waitFor();
    await page.locator('[data-platform="tiktok"]').click();
    assert.equal(await page.locator('#seller-calendar [data-show-id]').count(),2);
    await page.locator('#ss-seller-filter').selectOption('seller-sydney');
    assert.equal(await page.locator('#seller-calendar [data-show-id]').count(),1);
    await page.locator('[data-platform="all"]').click();
    await page.locator('#ss-seller-filter').selectOption('all');
    await page.locator('[data-view="month"]').click();
    await page.locator('.ss-month-grid').waitFor();
    const month=await page.locator('#seller-month-label').innerText();
    await page.locator('#ss-next').click();
    await page.waitForFunction(old=>document.querySelector('#seller-month-label').textContent!==old,month);
    const call=await page.evaluate(()=>window.testCalls.filter(c=>c.name==='get_seller_schedule_month').at(-1));
    assert.ok(call.args._month);
    await page.locator('#ss-today').click();
    await page.locator('[data-view="week"]').click();
    const newButton=width<600?page.locator('.ss-mobile-dock [data-new-show]'):page.locator('.ss-add-desktop');
    await newButton.click();
    const dialog=page.getByRole('dialog');await dialog.waitFor();
    if(width<600){assert.equal(Math.round((await dialog.boundingBox()).width),width);}
    await page.locator('#booking-seller').selectOption('seller-manny');
    assert.match(await page.locator('#ss-reminder-status').innerText(),/30 minutes before/);
    await page.locator('[data-channel="tiktok"]').click();
    const date=await page.evaluate(()=>{const d=new Date();d.setDate(d.getDate()+10);return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')});
    await page.locator('#booking-date').fill(date);
    await page.locator('#booking-start').fill('22:00');await page.locator('#booking-end').fill('01:00');
    await page.locator('#booking-overnight').check();
    await page.locator('#booking-note').fill('<img src=x onerror=alert(1)> Midnight jewelry');
    assert.match(await page.locator('#booking-availability').innerText(),/3h/);
    await page.evaluate(()=>window.testFailSave=true);
    await page.locator('#booking-submit').click();
    await page.getByText('Please try again. Connection interrupted.').waitFor();
    assert.equal(await dialog.isVisible(),true);
    assert.match(await page.locator('#booking-note').inputValue(),/Midnight jewelry/);
    await page.evaluate(()=>window.testFailSave=false);
    await page.locator('#booking-submit').click();
    await page.waitForFunction(()=>!document.querySelector('#ss-editor').open);
    await page.waitForFunction(()=>document.querySelector('#schedule-status').textContent.includes('stage is set'));
    const saved=await page.evaluate(()=>window.testCalls.filter(c=>c.name==='admin_schedule_seller_show').at(-1));
    assert.equal(saved.args._seller_employee_id,'seller-manny');assert.equal(saved.args._channel,'tiktok');
    assert.equal(saved.args._store_id,'store-1','automatically uses Airport Store even when another store is listed first');
    assert.equal((new Date(saved.args._end_at)-new Date(saved.args._start_at))/3600000,3);
    assert.equal(await page.locator('#seller-calendar img').count(),0,'notes are escaped');
    await page.locator('#seller-calendar [data-show-id="created"]').first().click();
    await page.locator('#booking-note').fill('Updated theme');await page.locator('#booking-submit').click();
    await page.waitForFunction(()=>!document.querySelector('#ss-editor').open);
    await page.locator('#seller-calendar [data-show-id="created"]').first().click();
    await page.locator('#booking-cancel-shift').click();
    await page.locator('#ss-cancel-reason').fill('Schedule changed');
    await page.locator('#ss-cancel-submit').click();
    await page.waitForFunction(()=>document.querySelector('#schedule-status').textContent==='Show cancelled.');
    assert.equal(await page.locator('#seller-calendar [data-show-id="created"]').count(),0,'cancel refreshes immediately');
    assert.deepEqual(errors,[]);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }finally{await browser.close();}
});

test('seller permissions, conflicts across platforms, and load failure remain visible',async()=>{
  const browser=await chromium.launch();try{
    const {page,errors}=await openPage(browser,390);
    await page.evaluate(()=>{state.employee.role='seller';state.employee.id='seller-sydney';renderAll();});
    await page.locator('.ss-mobile-dock [data-new-show]').click();
    assert.equal(await page.locator('#ss-booking-seller-label').isVisible(),false);
    assert.equal(await page.locator('#seller-management-panel').isVisible(),false);
    await page.locator('#ss-editor-close').click();
    await page.locator('[data-view="agenda"]').click();
    await page.locator('#seller-calendar [data-show-id="s1"]').click();
    assert.equal(await page.locator('#booking-submit').isEnabled(),false,'cannot edit another seller');
    await page.keyboard.press('Escape');
    await page.evaluate(async()=>{state.employee.role='admin';await loadSellerDirectory();renderAll();});
    await page.locator('.ss-mobile-dock [data-new-show]').click();
    await page.locator('#booking-seller').selectOption('seller-otello');
    assert.match(await page.locator('#ss-reminder-status').innerText(),/needs an SMS-enabled phone/);
    const existing=await page.evaluate(()=>window.testRows.find(r=>r.shift_id==='s4'));
    const day=await page.evaluate(start=>dateKey(new Date(start)),existing.start_at);
    await page.locator('#booking-date').fill(day);await page.locator('#booking-seller').selectOption('seller-sydney');
    await page.locator('#booking-start').fill('12:00');await page.locator('#booking-end').fill('14:00');
    await page.locator('[data-channel="ebay"]').click();
    assert.match(await page.locator('#booking-availability').innerText(),/another platform/);
    await page.locator('#booking-submit').click();
    assert.equal(await page.evaluate(()=>window.testCalls.filter(c=>c.name==='admin_schedule_seller_show').length),0);
    await page.locator('#ss-editor-close').click();
    await page.evaluate(()=>window.testFailLoad=true);await page.locator('#seller-refresh').click();
    await page.getByText(/Could not load the schedule. Connection unavailable/).waitFor();
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('assigned employee host can follow the schedule link on a phone',async()=>{
 const browser=await chromium.launch();try{
   const {page,errors}=await openPage(browser,390,true);
   assert.equal(await page.locator('#seller-management-panel').isVisible(),false);
   await page.locator('.ss-mobile-dock [data-new-show]').click();
   assert.equal(await page.locator('#booking-recurrence-panel').isVisible(),false);
   assert.equal(await page.evaluate(()=>window.testCalls.filter(c=>c.name==='current_user_can_use_seller_schedule').length),1);
   assert.equal(new URL(page.url()).pathname,'/seller-dashboard.html');
   assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

for(const width of [320,360,390,1440])test(`month calendar at ${width}px separates compact dates, clear daily times and overnight carryover, and saves repeats`,async()=>{
 const browser=await chromium.launch();try{
   const {page,errors}=await openPage(browser,width);
   await page.locator('[data-view="month"]').click();
   await page.evaluate(()=>{
     const first=showGridRange().start,rows=[];
     function add(d,start,end,id,name,overnight=false){
       const begins=new Date(d),ends=new Date(d);begins.setHours(...start,0,0);ends.setHours(...end,0,0);if(overnight)ends.setDate(ends.getDate()+1);
       rows.push({row_type:'shift',shift_id:id+'-'+dateKey(d)+'-'+start[0],seller_employee_id:id,seller_name:name,channel:'ebay',store_id:'store-1',store_name:'Airport Store',start_at:begins.toISOString(),end_at:ends.toISOString(),status:'booked',metadata:{recurrence_id:'repeat-'+id},is_mine:false,can_change_without_approval:true});
     }
     for(let i=-1;i<42;i++){const d=addDays(first,i);if([1,2,3,4,5].includes(d.getDay())){add(d,[10,0],[13,0],'seller-sydney','Sydney Miller');add(d,[14,0],[17,0],'seller-sydney','Sydney Miller');}if([0,5,6].includes(d.getDay()))add(d,[22,30],[1,30],'seller-otello','Otello Guillen',true);}
     window.testRows=rows;state.rows=rows;renderAll();
   });
   assert.equal(await page.locator('.ss-month-grid').isVisible(),true);
   assert.ok(await page.locator('.ss-month-day').count()>=28);
   assert.ok(await page.locator('.ss-mini-hosts').getByText('SM',{exact:true}).count()>0);
   assert.ok((await page.locator('.ss-month-grid').boundingBox()).height<600,'whole-month overview stays compact');
   const saturday=await page.evaluate(()=>dateKey(addDays(showWeekStart(new Date()),5)));
   await page.locator('[data-select-day="'+saturday+'"]').click();
   assert.equal(await page.locator('[data-select-day="'+saturday+'"]').getAttribute('aria-pressed'),'true');
   assert.equal(await page.locator('#ss-month-lineup .ss-day-show.is-continuation').count(),1);
   assert.equal(await page.locator('#ss-month-lineup .ss-day-show:not(.is-continuation)').count(),1);
   assert.match(await page.locator('.ss-lineup-summary').innerText(),/1 show starting/);
   assert.match(await page.locator('.is-continuation .ss-day-show-time').innerText(),/Midnight[\s\S]*1:30 AM/);
   assert.match(await page.locator('.is-continuation .ss-day-show-detail').innerText(),/Started Friday at 10:30 PM/);
   assert.match(await page.locator('.ss-day-show:not(.is-continuation) .ss-day-show-detail').innerText(),/Ends Sunday/);
   assert.match(await page.locator('.ss-day-show:not(.is-continuation) .ss-day-show-time').innerText(),/10:30 PM[\s\S]*1:30 AM/);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   assert.equal(await page.evaluate(()=>[...document.querySelectorAll('.ss-day-show-time')].every(el=>el.scrollWidth<=el.clientWidth+1)),true,'daily time ranges fit without clipping');
   await page.evaluate(()=>window.OGTaskNotifications.ready);
   assert.equal(await page.locator('#task-updates-slot .og-tu-launcher').count(),1);
   assert.equal(await page.locator('#og-task-updates .og-tu-launcher').count(),0,'no floating launcher covers the calendar');
   assert.equal(await page.locator('.og-tu-alert').isVisible(),false,'new-update preview cannot cover calendar cells');
   assert.equal(await page.locator('#task-updates-slot .og-tu-count').innerText(),'99+');
   await page.locator('#task-updates-slot .og-tu-launcher').click();
   await page.locator('#og-tu-panel').waitFor();await page.locator('[data-tu-close]').click();
   await page.locator('.ss-planner').scrollIntoViewIfNeeded();
   await page.screenshot({path:new URL('../output/show-studio/month-'+width+'.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'),fullPage:true});
   await page.locator('#ss-seller-filter').selectOption('seller-sydney');
   assert.equal(await page.locator('#ss-month-lineup .ss-day-show').count(),0);
   assert.equal(await page.locator('#ss-month-lineup .ss-day-empty').isVisible(),true);
   await page.locator('#ss-seller-filter').selectOption('all');
   await page.locator('#ss-month-lineup .ss-day-show.is-continuation').click();assert.equal(await page.locator('#ss-editor-title').innerText(),'Edit show');
   await page.locator('#ss-editor-close').click();
   assert.equal(await page.locator('[data-select-day="'+saturday+'"]').getAttribute('aria-pressed'),'true','opening a carryover keeps the selected calendar date');
   const dates=await page.evaluate(()=>{const first=new Date();first.setDate(first.getDate()+((8-first.getDay())%7||7));return {first:dateKey(first),last:dateKey(addDays(first,13))};});
   await page.locator('[data-select-day="'+dates.first+'"]').click();
   await page.locator('.ss-lineup-add').click();
   assert.equal(await page.locator('#booking-date').inputValue(),dates.first);
   assert.equal(await page.locator('#booking-shift-id').inputValue(),'');
   await page.locator('#booking-seller').selectOption('seller-manny');
   await page.locator('#booking-start').fill('10:00');await page.locator('#booking-end').fill('13:00');
   await page.locator('#booking-repeat').selectOption('weekdays');assert.equal(await page.locator('[data-repeat-day][aria-pressed="true"]').count(),5);
   await page.locator('#booking-repeat').selectOption('daily');assert.equal(await page.locator('[data-repeat-day][aria-pressed="true"]').count(),7);
   await page.locator('#booking-repeat').selectOption('weekly');
   await page.locator('[data-repeat-day="5"]').click();assert.equal(await page.locator('#booking-repeat').inputValue(),'custom');
   await page.locator('#booking-repeat-end').selectOption('date');await page.locator('#booking-repeat-until').fill(dates.last);
   await page.locator('#booking-repeat-summary').scrollIntoViewIfNeeded();
   await page.screenshot({path:new URL('../output/show-studio/repeat-editor-'+width+'.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});
   await page.evaluate(()=>window.testFailSave=true);await page.locator('#booking-submit').click();
   await page.getByText('Please try again. Connection interrupted.').waitFor();
   await page.evaluate(()=>window.testFailSave=false);await page.locator('#booking-submit').click();
   await page.waitForFunction(()=>document.querySelector('#schedule-status').textContent.includes('4 upcoming shows scheduled'));
   const calls=await page.evaluate(()=>window.testCalls.filter(c=>c.name==='admin_create_seller_show_recurrence'));
   assert.equal(calls.length,2);assert.equal(calls[0].args._request_id,calls[1].args._request_id);
   assert.deepEqual(calls[1].args._weekdays,[1,5]);assert.equal(calls[1].args._effective_to,dates.last);assert.equal(calls[1].args._timezone,'America/New_York');
   assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('phone recurring show distinguishes one cancellation from stopping its series',async()=>{
 const browser=await chromium.launch();try{
   const {page,errors}=await openPage(browser,360);
   await page.locator('[data-view="agenda"]').click();
   const card=page.locator('#seller-calendar [data-show-id="s1"]');
   assert.match(await card.innerText(),/Repeats weekly/);
   await card.click();
   assert.match(await page.locator('#booking-repeat-info').innerText(),/this show only/);
   await page.locator('#booking-stop-repeat').click();
   assert.match(await page.locator('#ss-cancel-caption').innerText(),/All future shows/);
   await page.locator('#ss-cancel-keep').click();
   await page.locator('#booking-cancel-shift').click();
   assert.equal(await page.locator('#ss-cancel-title').innerText(),'Cancel this show?');
   await page.locator('#ss-cancel-keep').click();
   await page.locator('#booking-stop-repeat').click();
   await page.screenshot({path:new URL('../output/show-studio/phone-stop-repeating.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});
   await page.locator('#ss-cancel-submit').click();
   await page.waitForFunction(()=>document.querySelector('#schedule-status').textContent.includes('Repeating time slot stopped'));
   assert.equal(await page.locator('#seller-calendar [data-show-id="s1"]').count(),0);
   assert.equal(await page.locator('#seller-calendar [data-show-id="s3"]').count(),0);
   assert.equal(await page.locator('#seller-calendar [data-show-id="s4"]').count(),1);
   assert.equal(await page.evaluate(()=>window.testCalls.filter(c=>c.name==='admin_stop_seller_show_recurrence').at(-1).args._recurrence_id),'repeat-1');
   assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('WebKit phone layout: calendar date selection, weekly repeat editor, and keyboard escape',async()=>{
  const browser=await webkit.launch();try{
    const {page,errors}=await openPage(browser,390);
    await page.locator('#ss-mobile-week button').nth(3).click();
    assert.equal(await page.locator('#seller-calendar [data-show-id]').count(),2);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.locator('[data-view="month"]').click();
    const selected=await page.evaluate(()=>dateKey(addDays(new Date(),2)));
    await page.locator('[data-select-day="'+selected+'"]').click();
    await page.locator('.ss-lineup-add').click();
    assert.equal(await page.locator('#booking-date').inputValue(),selected);
    await page.locator('#booking-seller').selectOption('seller-manny');
    await page.locator('#booking-start').fill('22:00');await page.locator('#booking-end').fill('01:00');
    await page.locator('#booking-overnight').check();
    await page.locator('#booking-repeat').selectOption('weekly');
    assert.equal(await page.locator('[data-repeat-day][aria-pressed="true"]').count(),1);
    await page.screenshot({path:new URL('../output/show-studio/phone-editor.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});
    assert.equal(Math.round((await page.getByRole('dialog').boundingBox()).width),390);
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>!document.querySelector('#ss-editor').open);
    assert.equal(await page.getByRole('dialog').count(),0);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
