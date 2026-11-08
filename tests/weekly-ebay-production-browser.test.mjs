import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';

for(const width of [390,1440])test(`weekly seller, day and show expansion at ${width}px keeps exact totals and filter state`,async()=>{
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage({viewport:{width,height:950}});
  await page.setContent('<style>body{margin:16px;background:#101610;color:#ececdd;font:15px Arial;--dash-line:#3a503d;--dash-muted:#b3c4b8;--dash-gold:#ecd493}</style><section class="wi-panel"></section>');
  await page.addStyleTag({path:fileURLToPath(new URL('../weekly-marketplace-sales.css',import.meta.url))});
  await page.addStyleTag({path:fileURLToPath(new URL('../weekly-production-report.css',import.meta.url))});
  for(const name of ['weekly-production-report','weekly-ebay-production','weekly-ebay-items'])await page.addScriptTag({path:fileURLToPath(new URL(`../${name}.js`,import.meta.url))});
  const week='2026-11-02';
  const rows=[
   {order:'01-12345-67890',day:week,week,seller:'Sydney',seller_source:'recorded',show:'show0001',show_title:'Morning jewelry',show_start:'2026-11-02T15:00:00Z',show_source:'captured',booked:100,cancelled:0,refunded:20,held:0,net:80},
   {order:'02-12345-67890',day:'2026-11-03',week,seller:'Otello',seller_source:'time_rule',show:'show0002',show_title:'Overnight watches',show_start:'2026-11-03T04:00:00Z',show_source:'time_window',booked:150,cancelled:50,refunded:0,held:0,net:100},
   {order:'03-12345-67890',day:'2026-11-03',week,seller:'Otello',seller_source:'recorded',show:'show0002',show_title:'Overnight watches',show_start:'2026-11-03T04:00:00Z',show_source:'captured',booked:200,cancelled:0,refunded:0,held:1,net:199},
   {order:'04-12345-67890',day:'2026-11-04',week,seller:'Seller unassigned',seller_source:'unknown',show:null,show_source:'unmatched',booked:25,cancelled:0,refunded:0,held:0,net:25},
  ];
  const data={as_of:'2026-11-08T17:00:00Z',month:'2026-11-01',ebay_show_timing:[{event_id:'show0002',title:'Overnight watches',starts_at:'2026-11-03T04:00:00Z',scheduled_start:'2026-11-03T04:00:00Z',airtime_seconds:7200,airtime_source:'ebay_live_studio_insights',airtime_checked_at:'2026-11-08T16:00:00Z'}],cutoff:'2026-11-08T12:00:00',rows:[{market:'ebay',week,first_day:week,end_day:'2026-11-09',booked:475,cancelled:50,refunded:20,held:1,net:404}],ebay_item_orders:rows.map(r=>({id:r.order,week,date:r.day+'T15:00:00Z',buyer:'paid',fund:'held',credit:r.net,held:r.net,items:[{title:r.order,qty:1,sold:r.booked,kept:r.net}]})),ebay_production:{orders:rows,shows:[{event_id:'show0002',title:'Overnight watches',seller_override:null,assignment_updated_at:null}],sellers:[{id:'seller-1',name:'Sydney Miller'}]}};
  await page.evaluate(data=>{window.testData=data;window.reloads=0;window.failSave=true;window.calls=[];window.render=()=>window.WeeklyEbayItems.update(document.querySelector('.wi-panel'),window.testData,{rpc:async(name,args)=>{window.calls.push({name,args});return {error:window.failSave?{message:'Assignment changed. Refresh before saving.'}:null};}},async()=>{window.reloads++;});window.render();},data);
  const toggle=page.locator(`[data-production-toggle="${week}"]`),panel=page.locator('#wi-production-'+week);
  assert.equal(await panel.isVisible(),false);await toggle.click();assert.equal(await panel.isVisible(),true);
  assert.equal(await panel.locator('.wp-breakdown>header .wp-total b').innerText(),'$404.00');
  const seller=panel.locator('[data-production-group="seller:Otello"]');assert.match(await seller.locator('summary').innerText(),/\$299.00/);
  await seller.locator('summary').click();assert.match(await seller.innerText(),/1 estimated from show time/);
  await page.evaluate(()=>window.render());assert.equal(await panel.isVisible(),true);assert.ok(await seller.evaluate(e=>e.open));
  await seller.locator('[data-production-orders="seller"]').click();assert.match(await page.locator('.wi-count').innerText(),/2 matching order lines · 2 orders/);
  await page.locator('[data-production-clear]').click();assert.match(await page.locator('.wi-count').innerText(),/4 matching order lines/);
  await panel.getByRole('button',{name:'By day',exact:true}).click();assert.equal(await panel.locator('.wp-group').count(),7);
  const empty=panel.locator('[data-production-group="day:2026-11-08"]');await empty.locator('summary').click();assert.match(await empty.innerText(),/No sales recorded/);
  const nov3=panel.locator('[data-production-group="day:2026-11-03"]');await nov3.locator('summary').click();assert.match(await nov3.locator('summary').innerText(),/\$299.00/);
  await nov3.locator('[data-production-orders="day"]').click();assert.match(await page.locator('.wi-count').innerText(),/2 matching order lines/);
  await panel.getByRole('button',{name:'By show',exact:true}).click();assert.equal(await panel.locator('.wp-show').count(),3);
  const show=panel.locator('.wp-show').filter({hasText:'Overnight watches'});await show.getByRole('button',{name:'View 2 orders'}).click();assert.match(await page.locator('.wi-count').innerText(),/2 matching order lines/);
  await page.locator('.wi-balance .wi-total [data-item-week=""][data-bucket="all"]').click();assert.match(await page.locator('.wi-count').innerText(),/4 matching order lines/);
  await show.getByRole('button',{name:'Assign seller'}).click();await page.getByRole('dialog').getByLabel('Seller',{exact:true}).selectOption('seller-1');
  await page.getByRole('button',{name:'Save assignment',exact:true}).click();assert.match(await page.getByRole('dialog').innerText(),/Assignment changed/);
  assert.equal(await page.getByRole('dialog').getByLabel('Seller',{exact:true}).inputValue(),'seller-1');
  await page.evaluate(()=>window.failSave=false);await page.getByRole('button',{name:'Save assignment',exact:true}).click();assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await page.evaluate(()=>window.reloads),1);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  // Refresh/reversal must update the original seller/show and preserve the active view.
  await page.evaluate(()=>{window.testData.ebay_production.orders[1].refunded=25;window.testData.ebay_production.orders[1].net=75;window.testData.rows[0].refunded=45;window.testData.rows[0].net=379;window.render();});
  assert.equal(await panel.locator('[data-production-view="show"]').getAttribute('aria-pressed'),'true');assert.match(await panel.locator('.wp-breakdown>header .wp-total').innerText(),/\$379.00/);
  await panel.getByRole('button',{name:'By seller',exact:true}).click();await panel.locator('[data-production-group="seller:Otello"] summary').click();
  assert.match(await panel.locator('.wp-timing').first().innerText(),/Mon, Nov 2/);
  await panel.getByRole('button',{name:'Generate report',exact:true}).click();
  const report=page.getByRole('dialog',{name:'Production report'});
  await report.getByRole('button',{name:'Print / Save PDF'}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('[data-wpr-print]').disabled);
  assert.equal(await report.locator('.wpr-shows tbody tr').filter({hasText:'Overnight watches'}).count(),1);
  assert.match(await report.locator('.wpr-kpis').innerText(),/2h 00m 00s/);
  assert.match(await report.locator('#wpr-streamer-hours').innerText(),/Otello[\s\S]*2h 00m 00s/);assert.ok(!(await report.innerText()).includes('timeclock'));
  await page.evaluate(()=>{window.print=()=>{window.printSeen=document.body.classList.contains('wpr-printing');};});
  await report.getByRole('button',{name:'Print / Save PDF'}).click();assert.equal(await page.evaluate(()=>window.printSeen),true);
  await page.emulateMedia({media:'print'});assert.equal(await page.locator('.wi-panel').isVisible(),false);assert.equal(await report.locator('.wpr-paper').isVisible(),true);
  await page.emulateMedia({media:'screen'});await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')));
  const downloaded=page.waitForEvent('download');await report.getByRole('button',{name:'Download CSV'}).click();assert.match((await downloaded).suggestedFilename(),/2026-11-02-to-2026-11-08/);
  await report.getByRole('button',{name:'Close',exact:true}).click();
  await panel.getByRole('button',{name:'Streamer hours summary'}).click();assert.equal(await report.locator('#wpr-streamer-hours').isVisible(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await report.getByRole('button',{name:'Close',exact:true}).click();
  await panel.scrollIntoViewIfNeeded();await mkdir(new URL('../test-results/weekly-production/',import.meta.url),{recursive:true});
  await page.screenshot({path:fileURLToPath(new URL(`../test-results/weekly-production/breakdown-${width}.png`,import.meta.url)),fullPage:true});
 }finally{await browser.close();}
});
