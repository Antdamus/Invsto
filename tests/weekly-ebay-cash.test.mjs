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
      ebay_item_orders:[{fund:'available',credit:90,net_item:100,items:[{},{}],payouts:[{id:'prior',status:'SUCCEEDED',sale:10}]},
        {fund:'held',credit:28,held:28,net_item:20,items:[{}]},{fund:'available',credit:50,net_item:0,items:[{}]}],
      ebay_account_payouts:[{id:'bank',amount:60}],ebay_cash_statement:{source:'eBay Seller Hub financial overview',opening:1000,closing:3400,
        movements:[{label:'Item sales posted',cents:15000},{label:'Gross refunds',cents:-2500},{label:'Financing repayments to Liberis',cents:-4000},{label:'Payouts',cents:-6100}],
        bank_fee:100,observed_held:3500,observed_available:-100,observed_at:'2026-11-01T06:00Z'}};
    const update=()=>page.evaluate(data=>WeeklyEbayCash.update(document.querySelector('#cash'),data),report);
    await update();
    assert.deepEqual(await page.locator('.wc-cards strong').allTextContents(),['$120.00','$140.00','$28.00','$60.00']);
    assert.match(await page.locator('.wc-explain').innerText(),/\$20.00 belongs to orders with held credits and \$100.00 to orders with released credits/);
    assert.match(await page.locator('.wc-matching').innerText(),/do not identify/);
    await page.locator('.wc-ledger summary').click();
    const amounts=await page.locator('.wc-ledger dd').allTextContents();
    assert.deepEqual(amounts,['$140.00','+$10.00','+$10.00','-$25.00','-$40.00','-$34.00','-$1.00','$60.00']);
    const sum=amounts.slice(0,-1).reduce((s,a)=>s+Number(a.replace(/[$,+]/g,'')),0);assert.equal(sum,60);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    report.ebay_item_orders[0].payouts=[{id:'bank',status:'SUCCEEDED',sale:10}];await update();
    assert.match(await page.locator('.wc-matching').innerText(),/1 of 1 bank transfers/);assert.equal(await page.locator('.wc-ledger').evaluate(e=>e.open),true);
    report.ebay_cash_statement.bank_fee=null;report.ebay_item_orders[0].net_item=null;report.ebay_item_orders[0].booked=100;await update();
    assert.match(await page.locator('.wc-explain').innerText(),/under verification/);
    assert.doesNotMatch(await page.locator('.wc-ledger').innerText(),/Express payout fees/);
  }finally{await browser.close();}
});
