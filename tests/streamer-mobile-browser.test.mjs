import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium,webkit} from '@playwright/test';
import {fileURLToPath} from 'node:url';

async function openReport(page){
 await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><main>Dashboard</main>');
 await page.addStyleTag({path:fileURLToPath(new URL('../weekly-production-report.css',import.meta.url))});
 for(const f of ['streamer-performance','streamer-distributions','streamer-commercial-analysis','weekly-production-report'])await page.addScriptTag({path:fileURLToPath(new URL('../'+f+'.js',import.meta.url))});
 await page.evaluate(()=>{
  const shows=Array.from({length:8},(_,i)=>({event_id:'show-'+i,title:'Original Rolex Cartier Breitling Watches · '+i,seller:'Otello',seller_source:'time_rule',scheduled_start:i<2?'2026-10-04T22:00-04:00':'2026-10-'+String(11+(i-2)*7%21).padStart(2,'0')+'T22:'+String(i).padStart(2,'0')+'-04:00',orders:1,linked_lines:1,booked:1400+i*100,cancelled:100,refunded:100,held:0,net:1200+i*100,airtime_seconds:18000,insights:{sales_status:'ready',paid_items:1,total_viewers:2773+i,peak_viewers:102+i},commercial:{version:1,orders:1,precise_orders:1,halves:[{bin:0,net:1000,booked:1200,orders:1},{bin:2,net:200+i*100,booked:200+i*100,orders:0}]}}));
  shows[1].net=shows[0].net;shows[1].commercial=shows[0].commercial;
  const history={from:'2026-09-01',until:'2026-11-09',as_of:'2026-11-08T20:00Z',coverage:{},shows};
  const data={as_of:history.as_of,days:[{day:'2026-11-02',week:'2026-11-02'}],orders:[{order:'order',day:'2026-11-02',week:'2026-11-02',show:'current',seller:'Otello',booked:1400,cancelled:100,refunded:100,held:0,net:1200}],timing:[{event_id:'current',starts_at:'2026-11-02T23:00-05:00',title:'Current watch show',airtime_seconds:18000}]};
  window.WeeklyProductionReport.open(data,'2026-11-02',{rpc:async()=>({data:history})});
 });
 await page.locator('.sde-explorer').waitFor();
}

test('swiping over a chart scrolls the report without opening a point',async()=>{
 const browser=await chromium.launch();try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});await openReport(page);
  const report=page.getByRole('dialog',{name:'Production report'}),chart=page.locator('.sde-card svg').first();await chart.scrollIntoViewIfNeeded();
  const dot=await chart.locator('circle[data-sde-show]').first().boundingBox(),before=await report.evaluate(e=>e.scrollTop),cdp=await page.context().newCDPSession(page);
  const x=dot.x+dot.width/2,y=dot.y+dot.height/2;
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
  for(const dy of [20,50,90,130])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-dy}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForFunction(before=>document.querySelector('.wpr-dialog').scrollTop>before+20,before);
  assert.equal(await page.locator('.sde-touch-dialog[open]').count(),0);assert.equal(await page.locator('.sde-show-detail').count(),0);
 }finally{await browser.close();}
});

for(const [engine,width,height] of [[chromium,320,740],[chromium,390,844],[chromium,430,932],[chromium,844,390],[webkit,390,844]])test(`${engine.name()} touch charts and report navigation at ${width}px`,async()=>{
 const browser=await engine.launch();try{
  const page=await browser.newPage({viewport:{width,height},isMobile:true,hasTouch:true,deviceScaleFactor:2});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await openReport(page);
  const report=page.getByRole('dialog',{name:'Production report'}),panel=report.locator('#wpr-commercial');
  const header=await report.locator('.wpr-toolbar').boundingBox();assert.ok(header.height<=125,'toolbar leaves room for the chart');
  assert.ok((await report.getByRole('button',{name:'Close',exact:true}).boundingBox()).height>=44);
  assert.equal(await panel.locator('[data-wpr-filter-panel="analysis"]').getAttribute('open'),null);
  assert.equal(await panel.locator('[data-wpr-filter-panel="distribution"]').getAttribute('open'),null);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const schedule=report.locator('.wpr-shows');assert.ok((await schedule.boundingBox()).width<=width);
  assert.equal(await schedule.locator('tbody tr').evaluate(row=>getComputedStyle(row).display),'grid');
  assert.equal(await schedule.locator('td[data-label="Net sales"]').textContent(),'$1,200.00');

  await panel.getByText('Chart filters and display options',{exact:true}).tap();
  const average=panel.getByLabel('Average over',{exact:true});assert.equal(await average.inputValue(),'3');
  assert.ok(Number.parseFloat(await average.evaluate(e=>getComputedStyle(e).fontSize))>=16);
  await average.selectOption('2');assert.equal(await panel.locator('[data-wpr-filter-panel="distribution"]').getAttribute('open'),'');
  await panel.getByText('Chart filters and display options',{exact:true}).tap();
  const card=panel.locator('.sde-card').first(),svg=card.locator('svg'),dots=svg.locator('circle[data-sde-show]');
  await svg.scrollIntoViewIfNeeded();
  const box=await dots.first().boundingBox(),scrollBefore=await report.evaluate(e=>e.scrollTop);
  if(engine===chromium&&width===390)await page.screenshot({path:'output/phone-chart-preview.png'});
  // Land beside the dot, within a fingertip-sized target, rather than on its tiny painted circle.
  await page.touchscreen.tap(box.x+box.width/2+15,box.y+box.height/2);
  const sheet=page.getByRole('dialog',{name:'Chart details'});await sheet.waitFor();
  assert.equal(await report.evaluate(e=>e.scrollTop),scrollBefore,'tapping preserves the chart position');
  assert.match(await sheet.locator('.sde-touch-content').innerText(),/Peak concurrent\s+102/);
  assert.match(await sheet.locator('.sde-touch-content').innerText(),/Total viewers\s+2,773/);
  assert.match(await sheet.locator('.sde-touch-content').innerText(),/Canceled|Refunded/);
  assert.match(await sheet.locator('.sde-touch-content').innerText(),/First 2 hours/);
  if(engine===chromium&&width===390)await page.screenshot({path:'output/phone-point-preview.png'});
  assert.equal(await sheet.getByRole('button',{name:'Previous',exact:true}).isDisabled(),true);
  await sheet.getByRole('button',{name:'Next',exact:true}).tap();
  assert.match(await sheet.locator('.sde-touch-content').innerText(),/Watches · 1/,'overlapping shows are reachable');
  assert.match(await sheet.locator('[data-touch-count]').innerText(),/Show 2 of/);
  const sheetBox=await sheet.boundingBox();assert.ok(sheetBox.x>=0&&sheetBox.x+sheetBox.width<=width+.5&&sheetBox.y>=0&&sheetBox.y+sheetBox.height<=height+.5);
  assert.equal(await sheet.evaluate(e=>e.scrollWidth<=e.clientWidth),true);
  const allShows=await dots.count();for(let i=2;i<allShows;i++)await sheet.getByRole('button',{name:'Next',exact:true}).tap();
  assert.equal(await sheet.getByRole('button',{name:'Next',exact:true}).isDisabled(),true);
  await sheet.getByRole('button',{name:'Close chart details'}).tap();assert.equal(await report.evaluate(e=>e.scrollTop),scrollBefore);

  await card.getByRole('button',{name:'Enlarge chart',exact:true}).tap();
  assert.equal(await card.locator('.sde-timeline-scroll').evaluate(e=>e.scrollWidth>e.clientWidth),true);
  await card.getByRole('button',{name:'Fit chart',exact:true}).tap();
  assert.equal(await card.locator('.sde-timeline-scroll').evaluate(e=>e.scrollWidth<=e.clientWidth+1),true);
  await card.getByRole('button',{name:/Viewer and duration labels/}).tap();assert.ok(await card.locator('.sde-point-label').count()>0);
  await dots.last().tap();await sheet.waitFor();await sheet.getByRole('button',{name:'Open full show details'}).tap();
  await panel.locator('.sde-show-detail').waitFor();assert.equal(await sheet.isVisible(),false);assert.match(await panel.locator('.sde-show-detail').innerText(),/First 2 hours/);
  await panel.getByText('Chart filters and display options',{exact:true}).tap();await panel.getByLabel('Chart view',{exact:true}).selectOption('histogram');
  await panel.getByText('Chart filters and display options',{exact:true}).tap();
  await panel.locator('.sde-card [data-sde-bin]').first().tap();await sheet.waitFor();assert.match(await sheet.locator('[data-touch-count]').innerText(),/Range 1 of/);
  await sheet.getByRole('button',{name:'Close chart details'}).tap();
  assert.deepEqual(errors,[]);
  await report.getByRole('button',{name:'Close',exact:true}).tap();await page.locator('.sde-touch-dialog').waitFor({state:'detached'});assert.equal(await page.locator('.sde-touch-dialog').count(),0);
 }finally{await browser.close();}
});
