import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {fileURLToPath} from 'node:url';
for(const width of [390,1440])test(`historical report loading, retry, ranges, export and print at ${width}px`,async()=>{
 const browser=await chromium.launch();try{
  const page=await browser.newPage({viewport:{width,height:950}});
  await page.setContent('<main>Dashboard</main>');
  await page.addStyleTag({path:fileURLToPath(new URL('../weekly-production-report.css',import.meta.url))});
  for(const file of ['streamer-performance','weekly-production-report'])await page.addScriptTag({path:fileURLToPath(new URL('../'+file+'.js',import.meta.url))});
  await page.evaluate(()=>{
   window.calls=[];window.reply=null;window.client={rpc:(name,args)=>{window.calls.push({name,args});return new Promise(resolve=>window.reply=resolve);}};
   window.reportData={as_of:'2026-11-08T18:00Z',days:[{day:'2026-11-02',week:'2026-11-02'},{day:'2026-11-08',week:'2026-11-02'}],orders:[],timing:[]};
   window.historyData={from:'2026-06-01',until:'2026-11-09',as_of:'2026-11-08T18:00Z',coverage:{},shows:[{event_id:'old',title:'Gold',seller:'Sydney',seller_source:'recorded',starts_at:'2026-10-05T14:00Z',airtime_seconds:3600,net:100,orders:1,linked_lines:1,insights:{paid_items:1}}]};
   window.WeeklyProductionReport.open(window.reportData,'2026-11-02',window.client);
  });
  const dialog=page.getByRole('dialog',{name:'Production report'}),print=dialog.getByRole('button',{name:'Print / Save PDF'});
  assert.equal(await print.isDisabled(),true);assert.match(await dialog.locator('#wpr-history').innerText(),/Loading historical/);
  assert.deepEqual(await page.evaluate(()=>window.calls[0]),{name:'get_streamer_performance_history',args:{_from:'2026-09-01',_until:'2026-11-09'}});
  assert.equal(await dialog.getByLabel('History months').inputValue(),'all');
  await page.evaluate(()=>window.reply({error:{message:'Temporary failure'}}));
  await dialog.getByRole('button',{name:'Retry historical analysis'}).waitFor();assert.equal(await print.isDisabled(),false);
  await dialog.getByRole('button',{name:'Retry historical analysis'}).click();await page.evaluate(()=>window.reply({data:window.historyData}));
  await dialog.locator('.spa-seller').waitFor();assert.match(await dialog.locator('#wpr-history').innerText(),/Same weekdays across months/);
  await page.evaluate(()=>{window.client.rpc=async(name,args)=>{window.calls.push({name,args});return {data:{...window.historyData,from:args._from,until:args._until,coverage:{first_show:'2025-08-08T01:58Z'},shows:window.historyData.shows.filter(s=>s.starts_at.slice(0,10)>=args._from&&s.starts_at.slice(0,10)<args._until)}};};});
  await dialog.getByLabel('History months').selectOption('12');await page.waitForFunction(()=>!document.querySelector('[data-wpr-print]').disabled);
  assert.equal(await page.evaluate(()=>window.calls.at(-1).args._from),'2025-12-01');
  await dialog.getByLabel('History months').selectOption('all');
  await page.waitForFunction(()=>!document.querySelector('[data-wpr-print]').disabled);
  assert.equal(await page.evaluate(()=>window.calls.at(-1).args._from),'2025-08-07');
  assert.match(await dialog.locator('#wpr-history').innerText(),/Aug 7, 2025/);
  await dialog.getByRole('button',{name:'Streamer analysis',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const download=page.waitForEvent('download');await dialog.getByRole('button',{name:'Download CSV'}).click();assert.match((await download).suggestedFilename(),/production-/);
  await page.evaluate(()=>{window.print=()=>{};});await print.click();await page.emulateMedia({media:'print'});
  assert.equal(await page.locator('main').isVisible(),false);assert.equal(await dialog.locator('#wpr-history').isVisible(),true);
  await page.emulateMedia({media:'screen'});await dialog.getByRole('button',{name:'Close',exact:true}).click();assert.equal(await page.getByRole('dialog').count(),0);
 }finally{await browser.close();}
});
