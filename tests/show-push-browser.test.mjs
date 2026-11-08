import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {fileURLToPath} from 'node:url';
for(const width of [390,1440])test(`push editor, shared bins and calendar chart at ${width}px`,async()=>{
 const browser=await chromium.launch();try{
  const page=await browser.newPage({viewport:{width,height:950}});
  await page.setContent('<main>Dashboard</main>');
  await page.addStyleTag({path:fileURLToPath(new URL('../weekly-production-report.css',import.meta.url))});
  for(const f of ['streamer-performance','streamer-distributions','streamer-commercial-analysis','weekly-production-report'])await page.addScriptTag({path:fileURLToPath(new URL('../'+f+'.js',import.meta.url))});
  await page.evaluate(()=>{
   const s={title:'Rolex watch show',seller:'Otello',seller_source:'override',orders:1,linked_lines:1,booked:1000,cancelled:0,refunded:0,held:0,net:1000,airtime_seconds:18000,insights:{paid_items:1},commercial:{version:1,orders:1,precise_orders:1,halves:[]}};
   window.labelCalls=[];
   const shows=[{...s,event_id:'before',scheduled_start:'2026-07-05T22:00-04:00',push:{manual:null,automatic:null,manual_source:'not_recorded'}},{...s,event_id:'after',scheduled_start:'2026-09-06T19:00-04:00',push:{manual:false,automatic:null,manual_source:'date_rule'},net:2000,booked:2000}];
   const history={from:'2026-07-01',until:'2026-11-09',as_of:'2026-11-08T20:00Z',coverage:{first_show:'2026-07-05T22:00-04:00'},shows};
   window.WeeklyProductionReport.open({as_of:history.as_of,days:[{day:'2026-11-02',week:'2026-11-02'}],orders:[],timing:[]},'2026-11-02',{rpc:async(name,args)=>{
    if(name==='get_streamer_performance_history')return {data:history};
    window.labelCalls.push(args);
    if(window.labelCalls.length===1)return {error:{message:'Connection failed. Try again.'}};
    return {data:{...args._labels,manual_source:'recorded',updated_at:'2026-11-08T20:30:00Z'}};
   }});
  });
  const report=page.getByRole('dialog',{name:'Production report'}),panel=report.locator('#wpr-commercial');
  await report.getByRole('button',{name:'Show insights',exact:true}).click();await panel.getByLabel('Chart view',{exact:true}).waitFor();
  await panel.getByRole('button',{name:'Same bins across start times · Off',exact:true}).click();
  assert.equal(await panel.getByLabel('Histogram scale',{exact:true}).inputValue(),'shared');
  const axes=await panel.locator('.sde-card-axis').allTextContents();assert.equal(axes.length,2);assert.equal(axes[0],axes[1]);
  await panel.getByLabel('Chart view',{exact:true}).selectOption('calendar');
  assert.equal(await panel.locator('.sde-push-cutoff').count(),3);
  assert.equal(await panel.locator('.sde-hist').count(),0);
  const cardXs=await panel.locator('.sde-calendar-card .sde-push-cutoff').evaluateAll(es=>es.map(e=>e.getAttribute('x1')));assert.equal(cardXs[0],cardXs[1]);
  const dot=panel.locator('.sde-timeline-scroll:not(.sde-calendar-card) circle[data-sde-show="after"]');
  await dot.hover();assert.match(await report.getByRole('tooltip').innerText(),/No manual push/);await page.keyboard.press('Escape');await dot.click();
  await panel.locator('.sde-show-detail').getByRole('button',{name:'Edit push labels'}).click();
  const editor=page.getByRole('dialog',{name:'Edit show push labels'});
  assert.equal(await editor.getByLabel('Manual push',{exact:true}).inputValue(),'rule');
  await editor.getByLabel('Manual push',{exact:true}).selectOption('yes');await editor.getByLabel('eBay automatic push',{exact:true}).selectOption('yes');
  await editor.getByLabel('Notes',{exact:true}).fill('<img src=x onerror=alert(1)> Both confirmed');
  await editor.getByRole('button',{name:'Save labels',exact:true}).click();assert.match(await editor.getByRole('status').innerText(),/Connection failed/);
  await editor.getByRole('button',{name:'Save labels',exact:true}).click();assert.match(await editor.getByRole('status').innerText(),/Saved/);
  await editor.getByRole('button',{name:'Done',exact:true}).click();
  const detail=panel.locator('.sde-show-detail');assert.match(await detail.innerText(),/★ Manual push/);assert.match(await detail.innerText(),/◆ eBay automatic push/);assert.equal(await detail.locator('img').count(),0);
  const call=await page.evaluate(()=>window.labelCalls.at(-1));assert.deepEqual(call._labels,{manual:true,automatic:true,note:'<img src=x onerror=alert(1)> Both confirmed'});assert.equal(call._event_id,'after');assert.equal(call._expected_updated_at,null);
  await panel.getByLabel('Push labels',{exact:true}).selectOption('manual_yes');assert.match(await panel.locator('.sde-scope').innerText(),/1 eligible show/);
  assert.equal(await panel.locator('.sde-timeline-scroll:not(.sde-calendar-card) circle').count(),1);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.evaluate(()=>{window.print=()=>{}});await report.getByRole('button',{name:'Print / Save PDF'}).click();await page.emulateMedia({media:'print'});
  for(const button of await panel.locator('[data-wpr-push]').all())assert.equal(await button.isVisible(),false);
  assert.match(await panel.locator('.sde-push-badges').first().innerText(),/Manual push/);
 }finally{await browser.close();}
});
