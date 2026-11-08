import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {fileURLToPath} from 'node:url';
for(const width of [390,1440])test(`commercial report filters, evidence, CSV and print at ${width}px`,async()=>{
 const browser=await chromium.launch();try{
  const page=await browser.newPage({viewport:{width,height:950}});
  await page.setContent('<main>Dashboard</main>');
  await page.addStyleTag({path:fileURLToPath(new URL('../weekly-production-report.css',import.meta.url))});
  for(const f of ['streamer-performance','streamer-distributions','streamer-commercial-analysis','weekly-production-report'])await page.addScriptTag({path:fileURLToPath(new URL('../'+f+'.js',import.meta.url))});
  await page.evaluate(()=>{
   const s={title:'Rolex watches',seller:'Otello',seller_source:'time_rule',scheduled_start:'2026-10-04T22:00-04:00',starts_at:'2026-10-04T22:00-04:00',orders:1,linked_lines:1,net:1000,booked:1200,cancelled:100,refunded:100,held:0,airtime_seconds:18000,insights:{paid_items:1,sales_status:'ready',total_viewers:50,purchasers:1},commercial:{version:1,orders:1,precise_orders:1,halves:[{bin:0,net:1000,orders:1}],clocks:[{hour:22,net:1000}],merchandise:[{category:'Watch',brand:'Rolex',evidence:'Staff classification',price_band:'$1,000-$4,999',lines:1,units:1,priced_units:1,priced_lines:1,original_sales:1200}],largest_order_net:1000,top_three_orders_net:1000,largest_buyer_net:1000,missing_buyer_orders:0}};
   const history={from:'2026-09-01',until:'2026-11-09',as_of:'2026-11-08T20:00Z',coverage:{},shows:[{...s,event_id:'otello'},{...s,event_id:'sydney',title:'Gold jewelry',seller:'Sydney',scheduled_start:'2026-10-05T10:00-04:00'}]};
   const data={as_of:history.as_of,days:[{day:'2026-11-02',week:'2026-11-02'},{day:'2026-11-08',week:'2026-11-02'}],orders:[],timing:[]};
   window.WeeklyProductionReport.open(data,'2026-11-02',{rpc:async()=>({data:history})});
  });
  const d=page.getByRole('dialog',{name:'Production report'}),panel=d.locator('#wpr-commercial');
  await d.getByRole('button',{name:'Show insights',exact:true}).click();await panel.getByLabel('Analysis streamer').waitFor();
  assert.equal(await panel.getByLabel('Analysis streamer').inputValue(),'Otello');assert.equal(await panel.getByLabel('Start weekday').inputValue(),'6');
  assert.equal(await panel.locator('.sca-heatmap').count(),2);assert.match(await panel.innerText(),/exact day-30 outcomes/);
  await panel.getByLabel('Show series').selectOption('Rolex watches');await panel.getByLabel('Timing comparison length').selectOption('3');
  assert.equal(await panel.locator('.sca-heatmap').count(),1);assert.match(await panel.locator('.sca-scope').innerText(),/Rolex watches/);
  const explorer=panel.getByRole('region',{name:'Historical show distributions'});
  await explorer.getByLabel('Distribution metric',{exact:true}).selectOption('half:1');
  assert.match(await explorer.locator('.sde-stats').innerText(),/Median \$0/);
  const bar=explorer.locator('.sde-hist [data-sde-bin]:not([disabled])');
  await bar.hover();const tip=d.getByRole('tooltip');await tip.waitFor({state:'visible'});
  assert.match(await tip.innerText(),/Sunday 1/);assert.match(await tip.innerText(),/Sun, Oct 4, 2026, 10:00 PM/);
  await tip.hover();assert.equal(await tip.isVisible(),true);await page.keyboard.press('Escape');assert.equal(await tip.isVisible(),false);assert.equal(await d.isVisible(),true);
  await bar.click();assert.equal(await explorer.locator('.sde-records').getAttribute('open'),'');
  assert.equal(await explorer.locator('.sde-shows tbody tr').count(),1);assert.match(await explorer.locator('.sde-selection').innerText(),/Selected sales range/);
  await explorer.getByRole('button',{name:'Clear selection',exact:true}).click();
  await explorer.locator('[data-sde-show]').focus();await page.keyboard.press('Enter');assert.match(await explorer.locator('.sde-selection').innerText(),/Selected show/);
  await explorer.getByLabel('Part of month',{exact:true}).selectOption('2');assert.match(await explorer.innerText(),/No usable shows match/);
  await panel.getByLabel('Analysis streamer').selectOption('Sydney');assert.equal(await panel.getByLabel('Show group').inputValue(),'all');assert.equal(await panel.getByLabel('Start weekday').inputValue(),'all');
  assert.equal(await explorer.getByLabel('Part of month',{exact:true}).inputValue(),'all');
  await explorer.getByLabel('Distribution metric',{exact:true}).selectOption('net');
  await explorer.locator('button[data-sde-start]').click();assert.equal(await explorer.getByLabel('Start hour · Eastern',{exact:true}).inputValue(),'10');
  const mini=explorer.locator('.sde-card [data-sde-bin]');await mini.focus();await tip.waitFor({state:'visible'});assert.match(await tip.innerText(),/Monday 1/);
  await page.keyboard.press('Enter');assert.match(await explorer.locator('.sde-selection').innerText(),/Selected sales range/);assert.equal(await explorer.locator('.sde-shows tbody tr').count(),1);
  assert.match(await panel.locator('.sca-scope').innerText(),/Sydney/);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const pending=page.waitForEvent('download');await d.getByRole('button',{name:'Download CSV'}).click();const csv=await readFile(await (await pending).path(),'utf8');
  assert.match(csv,/"What drives show results","Streamer","Sydney"/);assert.match(csv,/Largest|largest/);
  assert.match(csv,/"Historical show distribution","Metric","Net sales per show"/);assert.match(csv,/"sydney","Gold jewelry","Sydney"/);
  assert.match(csv,/"Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"/);
  await page.evaluate(()=>{window.print=()=>{};});await d.getByRole('button',{name:'Print / Save PDF'}).click();await page.emulateMedia({media:'print'});
  for(const controls of await panel.locator('.sca-controls').all())assert.equal(await controls.isVisible(),false);
  assert.equal(await panel.locator('.sca-scope').isVisible(),true);assert.equal(await page.locator('main').isVisible(),false);
  await page.emulateMedia({media:'screen'});await d.getByRole('button',{name:'Close',exact:true}).click();assert.equal(await page.getByRole('dialog').count(),0);
 }finally{await browser.close();}
});
test('adaptive card bars show their own dates and weekday counts and open the matching range',async()=>{
 const browser=await chromium.launch();try{
  const page=await browser.newPage({viewport:{width:1440,height:950}});await page.setContent('<main>Dashboard</main>');
  await page.addStyleTag({path:fileURLToPath(new URL('../weekly-production-report.css',import.meta.url))});
  for(const f of ['streamer-performance','streamer-distributions','streamer-commercial-analysis','weekly-production-report'])await page.addScriptTag({path:fileURLToPath(new URL('../'+f+'.js',import.meta.url))});
  await page.evaluate(()=>{
   const shows=[['sun',100,'2026-10-04T22:00-04:00'],['mon',100,'2026-10-05T22:00-04:00'],['large',10000,'2026-10-06T21:00-04:00']].map(([event_id,net,scheduled_start])=>({event_id,title:'Watch '+event_id,seller:'Otello',seller_source:'time_rule',net,scheduled_start,airtime_seconds:18000,orders:1,linked_lines:1,insights:{paid_items:1,sales_status:'ready'}}));
   const history={from:'2026-09-01',until:'2026-11-09',as_of:'2026-11-08T20:00Z',coverage:{},shows},data={as_of:history.as_of,days:[{day:'2026-11-02',week:'2026-11-02'}],orders:[],timing:[]};
   window.WeeklyProductionReport.open(data,'2026-11-02',{rpc:async()=>({data:history})});
  });
  const panel=page.locator('#wpr-commercial');await panel.getByLabel('Start weekday',{exact:true}).selectOption('all');
  await panel.getByLabel('Start hour · Eastern',{exact:true}).selectOption('22');
  assert.match(await panel.locator('.sde-hist').innerText(),/\$100/);assert.doesNotMatch(await panel.locator('.sde-hist').innerText(),/10,000/);
  const cardBar=panel.locator('.sde-card [data-sde-bin][data-sde-start="21"]');await cardBar.hover();
  const tip=page.getByRole('tooltip');await tip.waitFor({state:'visible'});assert.match(await tip.innerText(),/Tuesday 1/);assert.match(await tip.innerText(),/Watch large/);
  const box=await tip.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=1440&&box.y>=0&&box.y+box.height<=950);
  await page.keyboard.press('Escape');await cardBar.focus();await page.keyboard.press('Enter');
  assert.equal(await panel.getByLabel('Start hour · Eastern',{exact:true}).inputValue(),'21');assert.match(await panel.locator('.sde-shows').innerText(),/Watch large/);assert.doesNotMatch(await panel.locator('.sde-shows').innerText(),/Watch mon/);
  await panel.getByLabel('Start hour · Eastern',{exact:true}).selectOption('22');await panel.getByLabel('Histogram scale',{exact:true}).selectOption('shared');
  assert.match(await panel.locator('.sde-hist').innerText(),/10,000/);assert.match(await panel.locator('.sde-card-weekdays').allTextContents().then(a=>a.join(' ')),/Monday 1.*Sunday 1/);
 }finally{await browser.close();}
});
