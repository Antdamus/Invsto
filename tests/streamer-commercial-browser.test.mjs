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
  for(const f of ['streamer-performance','streamer-commercial-analysis','weekly-production-report'])await page.addScriptTag({path:fileURLToPath(new URL('../'+f+'.js',import.meta.url))});
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
  await panel.getByLabel('Analysis streamer').selectOption('Sydney');assert.equal(await panel.getByLabel('Show group').inputValue(),'all');assert.equal(await panel.getByLabel('Start weekday').inputValue(),'all');
  assert.match(await panel.locator('.sca-scope').innerText(),/Sydney/);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const pending=page.waitForEvent('download');await d.getByRole('button',{name:'Download CSV'}).click();const csv=await readFile(await (await pending).path(),'utf8');
  assert.match(csv,/"What drives show results","Streamer","Sydney"/);assert.match(csv,/Largest|largest/);
  await page.evaluate(()=>{window.print=()=>{};});await d.getByRole('button',{name:'Print / Save PDF'}).click();await page.emulateMedia({media:'print'});
  assert.equal(await panel.locator('.sca-controls').isVisible(),false);assert.equal(await panel.locator('.sca-scope').isVisible(),true);assert.equal(await page.locator('main').isVisible(),false);
  await page.emulateMedia({media:'screen'});await d.getByRole('button',{name:'Close',exact:true}).click();assert.equal(await page.getByRole('dialog').count(),0);
 }finally{await browser.close();}
});
