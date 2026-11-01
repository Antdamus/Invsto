import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';

test('monthly cash keeps merchandise, original credits, other recipients, and bank deposits on their own basis',async()=>{
  const browser=await chromium.launch();
  try{
    const page=await browser.newPage({viewport:{width:390,height:750}});
    await page.setContent('<section id="cash"></section>');
    for(const file of ['weekly-ebay-items.js','weekly-ebay-cash.js'])await page.addScriptTag({path:fileURLToPath(new URL('../'+file,import.meta.url))});
    await page.addStyleTag({path:fileURLToPath(new URL('../weekly-marketplace-sales.css',import.meta.url))});
    const report={month:'2026-10-01',rows:[{market:'ebay',net:120},{market:'tiktok',net:999}],
      ebay_item_orders:[{id:'a',date:'2026-10-11',fund:'available',credit:90,net_item:100,items:[{},{}],payouts:[{id:'prior',status:'SUCCEEDED',sale:10}]},
        {id:'b',date:'2026-10-12',fund:'held',credit:28,held:28,net_item:20,items:[{}]},{id:'c',date:'2026-10-01T04:05Z',fund:'available',credit:50,net_item:0,items:[{}]}],
      ebay_posted_orders:[['a','2026-10-11',10000,-1000],['b','2026-10-12',3000,-200],['c','2026-09-30',5500,-500],['d','2026-10-09',2000,-200]].map(([id,day,item,fees])=>({id,day,item,fees,credit:item+fees,shipping:0,other:0})),
      ebay_account_payouts:[{id:'bank',amount:60}],ebay_cash_statement:{source:'eBay Seller Hub financial overview',opening:1000,closing:3400,
        movements:[{label:'Item sales posted',cents:15000},{label:'Shipping paid by buyers',cents:0},{label:'Gross refunds',cents:-2500},{label:'Financing repayments to Liberis',cents:-4000},{label:'Payouts',cents:-6100}],
        bank_fee:100,observed_held:3500,observed_available:-100,observed_at:'2026-11-01T06:00Z'}};
    const update=()=>page.evaluate(data=>WeeklyEbayCash.update(document.querySelector('#cash'),data),report);
    await update();
    assert.deepEqual(await page.locator('.wc-cards strong').allTextContents(),['$120.00','$140.00','$28.00','$60.00']);
    assert.match(await page.locator('.wc-explain').innerText(),/\$20.00 belongs to orders with held credits and \$100.00 to orders with released credits/);
    assert.match(await page.locator('.wc-matching').innerText(),/do not identify/);
    await page.locator('.wc-ledger summary').click();
    const amounts=await page.locator('.wc-ledger dd').allTextContents();
    assert.deepEqual(amounts,['$10.00','+$150.00','-$25.00','-$40.00','-$60.00','-$1.00','$34.00']);
    await page.locator('.wc-postings>summary').click();
    assert.deepEqual(await page.locator('.wc-postings dd').allTextContents(),['$140.00','+$28.00','+$17.00','-$55.00','+$20.00','$150.00']);
    assert.match(await page.locator('.wc-orders-proof').first().textContent(),/Oct 1[\s\S]*2026-09-30/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    report.ebay_item_orders[0].payouts=[{id:'bank',status:'SUCCEEDED',sale:10}];await update();
    assert.match(await page.locator('.wc-matching').innerText(),/1 of 1 bank transfers/);assert.equal(await page.locator('.wc-ledger').evaluate(e=>e.open),true);
    report.ebay_cash_statement.bank_fee=null;report.ebay_item_orders[0].net_item=null;report.ebay_item_orders[0].booked=100;await update();
    assert.match(await page.locator('.wc-explain').innerText(),/under verification/);
    assert.doesNotMatch(await page.locator('.wc-ledger').innerText(),/Express payout fees/);
    report.ebay_posted_orders.pop();await update();assert.equal(await page.locator('.wc-postings').count(),0);
    assert.equal(await page.locator('.wc-ledger').count(),1);
  }finally{await browser.close();}
});
