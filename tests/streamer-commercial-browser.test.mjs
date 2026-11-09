import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {fileURLToPath} from 'node:url';
for(const width of [390,1440])test(`commercial report filters, evidence, CSV and print at ${width}px`,async()=>{
 const browser=await chromium.launch();try{
  const page=await browser.newPage({viewport:{width,height:width===1440?675:950}});
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
  assert.equal(await panel.getByLabel('Analysis streamer').inputValue(),'Otello');assert.equal(await panel.getByLabel('Start weekday',{exact:true}).inputValue(),'6');
  assert.equal(await panel.locator('.sca-heatmap').count(),2);assert.match(await panel.innerText(),/exact day-30 outcomes/);
  await panel.getByLabel('Show series').selectOption('Rolex watches');await panel.getByLabel('Timing comparison length').selectOption('3');
  assert.equal(await panel.locator('.sca-heatmap').count(),1);assert.match(await panel.locator('.sca-scope').innerText(),/Rolex watches/);
  const explorer=panel.getByRole('region',{name:'Historical show distributions'});
  await explorer.getByLabel('Distribution metric',{exact:true}).selectOption('half:1');
  assert.match(await explorer.locator('.sde-stats').first().innerText(),/Median \$0/);
  const bar=explorer.locator('.sde-hist [data-sde-bin]:not([disabled])');
  await bar.hover();const tip=d.getByRole('tooltip');await tip.waitFor({state:'visible'});
  const tb=await tip.boundingBox(),bb=await bar.boundingBox();assert.ok(tb.y+tb.height<=bb.y||tb.y>=bb.y+bb.height,'Hover panel must not cover its clickable bar');
  assert.match(await tip.innerText(),/Sunday 1/);assert.match(await tip.innerText(),/Canceled/);assert.match(await tip.innerText(),/Average net.hour/);assert.match(await tip.innerText(),/Sun, Oct 4, 2026, 10:00 PM/);
  await tip.hover();assert.equal(await tip.isVisible(),true);await page.keyboard.press('Escape');assert.equal(await tip.isVisible(),false);assert.equal(await d.isVisible(),true);
  await bar.click();assert.equal(await explorer.locator('.sde-records').getAttribute('open'),'');
  assert.equal(await explorer.locator('.sde-shows tbody tr').count(),1);assert.match(await explorer.locator('.sde-selection').innerText(),/Selected sales range/);
  await explorer.getByRole('button',{name:'Clear selection',exact:true}).click();
  await explorer.getByLabel('Chart view',{exact:true}).selectOption('calendar');
  await explorer.locator('.sde-timeline-scroll:not(.sde-calendar-card) circle[data-sde-show]').click();assert.match(await explorer.locator('.sde-selection').innerText(),/Selected show/);
  assert.match(await explorer.locator('.sde-show-detail').innerText(),/Sales hour by hour/);assert.match(await explorer.locator('.sde-show-detail').innerText(),/Refunded/);
  await explorer.getByLabel('Distribution metric',{exact:true}).selectOption('elapsed:1');assert.match(await explorer.locator('.sde-stats').first().innerText(),/Median \$0/);
  await explorer.getByLabel('Distribution metric',{exact:true}).selectOption('rate');
  await explorer.getByLabel('Point labels',{exact:true}).selectOption('on');
  assert.equal(await explorer.locator('.sde-timeline-scroll:not(.sde-calendar-card) .sde-point-label').count(),1);
  assert.match(await explorer.locator('.sde-timeline-scroll:not(.sde-calendar-card) .sde-point-label').textContent(),/Peak — · Total 50/);
  assert.match(await explorer.locator('.sde-timeline-scroll:not(.sde-calendar-card) .sde-point-label').textContent(),/Live 5h 00m 00s/);
  const card=explorer.locator('.sde-card:has([data-sde-label-hour="22"])');
  const coordinates=()=>card.locator('circle[data-sde-show]').evaluateAll(dots=>dots.map(dot=>[dot.getAttribute('cx'),dot.getAttribute('cy')]));
  const beforeToggle=await coordinates();
  assert.equal(await card.locator('.sde-point-label').count(),1);
  assert.match(await card.locator('.sde-extreme-guide').textContent(),/High \/ low · \$200/);
  await card.getByRole('button',{name:/Viewer and duration labels/}).click();
  assert.equal(await card.locator('.sde-point-label').count(),0);assert.equal(await card.getByRole('button',{name:/Viewer and duration labels/}).getAttribute('aria-pressed'),'false');
  assert.deepEqual(await coordinates(),beforeToggle);assert.equal(await explorer.locator('.sde-timeline-scroll:not(.sde-calendar-card) .sde-point-label').count(),1);
  assert.equal(await explorer.getByLabel('Average over',{exact:true}).inputValue(),'all');
  assert.match(await explorer.locator('.sde-stats').first().innerText(),/Median \$200/);
  for(const [window,label,average] of [['1','First hour','$1,000'],['2','First 2 hours','$500'],['3','First 3 hours','$333.33']]){
   await explorer.getByLabel('Average over',{exact:true}).selectOption(window);
   const dot=explorer.locator('.sde-timeline-scroll:not(.sde-calendar-card) circle[data-sde-show]');
   await dot.hover();await tip.waitFor({state:'visible'});
   assert.ok((await tip.innerText()).replace(/\s+/g,' ').includes('Average net/hour · '+label+' '+average));
   await page.keyboard.press('Escape');await dot.click();
   assert.ok((await explorer.locator('.sde-show-detail').innerText()).includes('Average net/hour · '+label+' '+average));
   assert.equal(await explorer.getByLabel('Average over',{exact:true}).inputValue(),window);
   assert.equal(await card.locator('.sde-point-label').count(),0);
   assert.ok((await card.locator('.sde-extreme-guide').textContent()).includes(average));
  }
  await explorer.getByLabel('Point labels',{exact:true}).selectOption('off');await explorer.getByLabel('Point labels',{exact:true}).selectOption('on');
  assert.equal(await card.locator('.sde-point-label').count(),1);
  const rangeDownload=page.waitForEvent('download');await d.getByRole('button',{name:'Download CSV'}).click();
  const rangeCsv=await readFile(await (await rangeDownload).path(),'utf8');
  assert.match(rangeCsv,/Net sales per streaming hour · First 3 hours/);assert.match(rangeCsv,/"First 3 hours","10800","1000","333\.3333333333333"/);
  await explorer.getByLabel('Distribution metric',{exact:true}).selectOption('net');
  assert.equal(await explorer.getByLabel('Average over',{exact:true}).count(),0);
  await explorer.getByLabel('Histogram scale',{exact:true}).selectOption('shared');
  await explorer.getByLabel('Distribution metric',{exact:true}).selectOption('rate');
  assert.equal(await explorer.getByLabel('Average over',{exact:true}).inputValue(),'3');
  await explorer.getByLabel('Chart view',{exact:true}).selectOption('histogram');
  await explorer.locator('.sde-hist [data-sde-bin]:not([disabled])').hover();await tip.waitFor({state:'visible'});
  assert.match(await tip.innerText(),/Average net\/hour · First 3 hours\s+\$333\.33/);
  await page.keyboard.press('Escape');
  await page.evaluate(()=>document.body.classList.add('wpr-printing'));await page.emulateMedia({media:'print'});assert.equal(await explorer.getByLabel('Average over',{exact:true}).isVisible(),false);
  assert.match(await explorer.locator('.sde-scope').innerText(),/First 3 hours/);await page.emulateMedia({media:'screen'});await page.evaluate(()=>document.body.classList.remove('wpr-printing'));
  await explorer.getByLabel('Chart view',{exact:true}).selectOption('calendar');
  assert.equal(await explorer.getByLabel('Point labels',{exact:true}).inputValue(),'on');
  const labelBox=await explorer.locator('.sde-timeline-scroll:not(.sde-calendar-card) .sde-point-label').boundingBox(),chartBox=await explorer.locator('.sde-timeline-scroll:not(.sde-calendar-card) svg').boundingBox();
  assert.ok(labelBox.x>=chartBox.x&&labelBox.x+labelBox.width<=chartBox.x+chartBox.width);
  await explorer.locator('[data-sde-weekday="all"]').click();assert.equal(await panel.getByLabel('Start weekday',{exact:true}).inputValue(),'all');
  await panel.getByLabel('Show day grouping').selectOption('night');await explorer.locator('[data-sde-weekday="6"]').click();assert.match(await explorer.locator('.sde-scope').innerText(),/Selling nights/);
  await explorer.locator('[data-sde-month]').first().click();assert.equal(await explorer.getByLabel('Calendar month',{exact:true}).inputValue(),'2026-10');
  await panel.getByLabel('Show day grouping').selectOption('calendar');
  await explorer.getByLabel('Part of month',{exact:true}).selectOption('2');assert.match(await explorer.innerText(),/No usable shows match/);
  await panel.getByLabel('Analysis streamer').selectOption('Sydney');assert.equal(await panel.getByLabel('Show group').inputValue(),'all');assert.equal(await panel.getByLabel('Start weekday',{exact:true}).inputValue(),'all');
  assert.equal(await explorer.getByLabel('Part of month',{exact:true}).inputValue(),'all');
  await explorer.getByLabel('Distribution metric',{exact:true}).selectOption('net');
  await explorer.locator('.sde-card button[data-sde-start]').click();assert.equal(await explorer.getByLabel('Start hour · Eastern',{exact:true}).inputValue(),'10');
  await explorer.getByLabel('Chart view',{exact:true}).selectOption('histogram');
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
test('calendar audience labels stay above and near their own shows when neighboring values are close',async()=>{
 const browser=await chromium.launch();try{
  const page=await browser.newPage({viewport:{width:1440,height:950}});await page.setContent('<main class="wpr-paper"></main>');
  await page.addStyleTag({path:fileURLToPath(new URL('../weekly-production-report.css',import.meta.url))});
  for(const f of ['streamer-performance','streamer-distributions','streamer-commercial-analysis'])await page.addScriptTag({path:fileURLToPath(new URL('../'+f+'.js',import.meta.url))});
  await page.evaluate(()=>{
   const shows=[8854,12139,1400,17709,15334].map((net,i)=>({event_id:String(i),title:'Show '+i,seller:'Otello',scheduled_start:'2026-05-'+String(3+i*7).padStart(2,'0')+'T20:00-04:00',net,orders:1,linked_lines:1,airtime_seconds:18000,insights:{sales_status:'ready',total_viewers:1000+i,peak_viewers:100+i,paid_items:1}}));
   const m=window.StreamerCommercialAnalysis.build({shows,from:'2026-05-01',until:'2026-11-09',as_of:'2026-11-08T20:00Z'},{from:'2026-11-02',through:'2026-11-08'},{seller:'Otello',format:'all',weekday:'all'});
   document.querySelector('main').innerHTML=window.StreamerDistributions.render(m,{distView:'calendar',distPointLabels:'on'});
  });
  const layout=await page.locator('.sde-timeline-scroll:not(.sde-calendar-card) svg').evaluate(svg=>Array.from(svg.querySelectorAll('.sde-point-label'),label=>{
   const title=label.getAttribute('aria-label').split(' · ')[0],id=title.slice(5),dot=svg.querySelector('circle[data-sde-show="'+id+'"]'),box=label.querySelector('rect').getBBox();
   return {id,x:box.x,y:box.y,width:box.width,height:box.height,dotX:Number(dot.getAttribute('cx')),dotY:Number(dot.getAttribute('cy'))};
  }));
  assert.equal(layout.length,5);
  for(const a of layout){
   assert.ok(Math.abs(a.x+a.width/2-a.dotX)<=a.width/2+.01,'label stays in its own date position: '+JSON.stringify(a));
   assert.ok(a.y+a.height<a.dotY,'label is above its dot');
   for(const b of layout.filter(b=>b.id!==a.id))assert.ok(a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y,'labels do not overlap');
  }
 }finally{await browser.close();}
});
