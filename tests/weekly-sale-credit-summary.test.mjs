import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {chromium,webkit} from '@playwright/test';

const file=n=>fileURLToPath(new URL('../'+n,import.meta.url));
const credit=(n,date,cents,memos=[],released=false)=>{
 const oid='01-10000-'+String(n).padStart(5,'0');
 return {kind:'sale',ref:oid,oid,date,cents,placed:date,hold_detail:{finance:{syncedAt:'2026-11-08T15:00:00Z',transactions:(released?['Released']:memos).map(memo=>({orderNumber:oid,transactionType:'SALE',bookingEntry:'CREDIT',transactionStatus:released?'FUNDS_AVAILABLE_FOR_PAYOUT':'FUNDS_ON_HOLD',memo}))}}};
};
const delivery='Funds available within 2 days of order delivery',authentication='Funds available within 24 hours of order authentication';
const fixture=()=>[
 credit(1,'2026-11-02',10001,[delivery]),credit(2,'2026-11-02',999,[delivery]),
 credit(3,'2026-11-02',2345,[authentication]),credit(4,'2026-11-03',4500,[delivery,authentication,delivery]),
 credit(5,'2026-10-31',550),credit(6,null,1000,[],true),
 {kind:'return',ref:'return1',oid:'01-10000-00001',date:'2026-11-02',placed:'2026-11-06',cents:1111}
];
async function setup(browser,width=1100){
 const page=await browser.newPage({viewport:{width,height:900}});
 await page.setContent('<main class="dash-workspace"><details class="dash-report" id="weekly-sales-report" open><summary>Weekly marketplace sales</summary><div class="dash-report-body"><section class="wh-panel" id="host"></section></div></details></main>');
 for(const css of ['dashboard.css','dashboard-workspace.css','weekly-marketplace-sales.css','weekly-production-report.css','ebay-hold-details.css'])await page.addStyleTag({path:file(css)});
 await page.addScriptTag({path:file('ebay-hold-details.js')});
 await page.addScriptTag({path:file('weekly-ebay-holds.js')});
 return page;
}
const draw=(page,entries)=>page.evaluate(entries=>window.WeeklyEbayHolds.update(document.querySelector('#host'),{month:'2026-11-01',ebay_account_holds:{verified_at:'2026-11-08T14:00:00Z',ledger_cents:entries.reduce((s,r)=>s+r.cents,0),entries}},{},()=>{}),entries);

test('purchase-date and reason totals reconcile; exact drilldowns update with payment evidence and released credits',async()=>{
 const browser=await chromium.launch();try{
  const page=await setup(browser),entries=fixture();await draw(page,entries);
  assert.equal(await page.locator('.wh-credit-total').innerText(),'6 credits · $193.95 · 4 purchase dates');
  assert.deepEqual(await page.locator('.wh-credit-body tr>th').allTextContents(),['Tue, Nov 3, 2026','Mon, Nov 2, 2026','Sat, Oct 31, 2026','Purchase date unknown']);
  const reason=key=>page.locator('.wh-credit-reasons [data-wh-credit-reason="'+key+'"]');
  assert.match(await reason('delivery').innerText(),/2 credits · \$110.00/);
  assert.match(await reason('authentication+delivery').innerText(),/1 credit · \$45.00/);
  assert.match(await reason('unknown').innerText(),/1 credit · \$5.50/);
  assert.match(await reason('updated').innerText(),/1 credit · \$10.00/);
  assert.equal(await page.locator('.wh-credit-release-note').isVisible(),true);
  assert.deepEqual(await page.locator('.wh-credit-foot td').allTextContents(),['6','$193.95','4 purchase dates · includes every page']);
  await page.locator('[data-wh-credit-day="2026-11-02"][data-wh-credit-reason="delivery"]').click();
  assert.match(await page.locator('.wh-list>p').innerText(),/2 entries · \$110.00/);
  assert.match(await page.locator('.wh-credit-filter').innerText(),/Mon, Nov 2, 2026.*Waiting for delivery/);
  entries[0].hold_detail.finance.transactions[0].memo=authentication;await draw(page,entries);
  assert.match(await page.locator('.wh-list>p').innerText(),/1 entry · \$9.99/);
  assert.match(await reason('authentication').innerText(),/2 credits · \$123.46/);
  entries.splice(1,1);await draw(page,entries);
  assert.match(await page.locator('.wh-list>p').innerText(),/0 entries · \$0.00/);
  assert.equal(await page.locator('.wh-credit-total').innerText(),'5 credits · $183.96 · 4 purchase dates');
  await page.locator('.wh-credit-clear').click();assert.equal(await page.locator('.wh-credit-filter').isVisible(),false);
  assert.match(await page.locator('.wh-list>p').innerText(),/5 entries · \$183.96/);
  await reason('authentication+delivery').click();assert.match(await page.locator('.wh-list>p').innerText(),/1 entry · \$45.00/);
  await page.locator('.wh-kind').selectOption('return');assert.equal(await page.locator('.wh-credit-filter').isVisible(),false);
  assert.match(await page.locator('.wh-list>p').innerText(),/1 entry · \$11.11/);
 }finally{await browser.close();}
});

test('month selection and pagination retain full totals and do not broaden a now-empty drilldown on refresh',async()=>{
 const browser=await chromium.launch();try{
  const page=await setup(browser),entries=Array.from({length:23},(_,i)=>credit(i+1,'2026-10-'+String(i+1).padStart(2,'0'),100,[delivery]));
  entries.push(credit(30,'2026-11-02',505,[authentication]));await draw(page,entries);
  await page.locator('.wh-credit-month').selectOption('2026-10');
  assert.equal(await page.locator('.wh-credit-body tr').count(),10);
  assert.match(await page.locator('.wh-credit-total').innerText(),/23 credits · \$23.00/);
  await page.locator('.wh-credit-next').click();await page.locator('.wh-credit-next').click();
  assert.equal(await page.locator('.wh-credit-body tr').count(),3);
  assert.match(await page.locator('.wh-credit-foot').innerText(),/23\s+\$23.00/);
  await draw(page,entries);assert.equal(await page.locator('.wh-credit-position').innerText(),'Dates 21–23 of 23');
  await page.locator('.wh-credit-reasons [data-wh-credit-reason="delivery"]').click();
  assert.match(await page.locator('.wh-list>p').innerText(),/23 entries · \$23.00/);
  await draw(page,[credit(30,'2026-11-02',505,[delivery])]);
  assert.equal(await page.locator('.wh-credit-month').inputValue(),'2026-10');
  assert.equal(await page.locator('.wh-credit-empty').isVisible(),true);
  assert.match(await page.locator('.wh-list>p').innerText(),/0 entries · \$0.00/);
  assert.match(await page.locator('.wh-credit-filter').innerText(),/October 2026/);
  await page.locator('.wh-credit-month').selectOption('');
  assert.match(await page.locator('.wh-credit-total').innerText(),/1 credit · \$5.05/);
 }finally{await browser.close();}
});

test('summary and date/reason buttons fit small phones and remain usable in Chromium and WebKit',async()=>{
 for(const engine of [chromium,webkit]){
  const browser=await engine.launch();try{
   for(const width of [320,390,700,1100]){
    const page=await setup(browser,width);await draw(page,fixture());
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,engine.name()+' '+width+' overflow');
    const button=page.locator('[data-wh-credit-day="2026-11-03"][data-wh-credit-reason="authentication+delivery"]');
    const box=await button.boundingBox();assert.ok(box.height>=44&&box.x>=0&&box.x+box.width<=width);
    await button.click();assert.match(await page.locator('.wh-list>p').innerText(),/1 entry · \$45.00/);
    await page.close();
   }
  }finally{await browser.close();}
 }
});
