import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from '@playwright/test';

test('purchase-week balance drilldowns keep processing, mixed credits and transfers separate as orders update', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({viewport: {width: 390, height: 750}});
    await page.setContent('<section class="wi-panel"></section>');
    await page.addStyleTag({path: fileURLToPath(new URL('../weekly-marketplace-sales.css', import.meta.url))});
    await page.addScriptTag({path: fileURLToPath(new URL('../weekly-ebay-items.js', import.meta.url))});
    const week = '2026-10-05', next = '2026-10-12';
    function order(id, fund, credit, extras = {}) {
      return {id, week, fund, credit, date: week, buyer: 'paid', items: [{title: id, credit, qty: 1}], ...extras};
    }
    const data = {month:'2026-10', rows:[
      {market:'ebay',week,first_day:week,end_day:next,booked:165.50,cancelled:20.10,refunded:10.25,held:5.05,net:130.10},
      {market:'ebay',week:next,first_day:next,end_day:'2026-10-19',booked:61.29,cancelled:0,refunded:0,held:0,net:61.29},
      {market:'tiktok',week,first_day:week,end_day:next,booked:900,cancelled:0,refunded:0,held:0,net:900}
    ], ebay_item_orders:[
        order('two lines','available',30,{buyer:'refunded',items:[{title:'Ring',credit:12,qty:1},{title:'Chain',credit:18,qty:1}]}),
        order('partial transfer','held',25,{held:20,payouts:[{sale:5,net:4,status:'SUCCEEDED'}]}),
        order('in process','processing',7), order('unknown','unknown',8),
        order('withheld','held',35,{held:35}),order('payment pending','unknown',null,{buyer:'pending'}),
        order('known release, unknown amount','initiated',null),
        order('sent','paid_out',11,{week:next}),order('next week','available',50,{week:next})
      ],ebay_account_payouts:[{day:next,id:'express',amount:99}]};
    const render=()=>page.evaluate(payload=>window.WeeklyEbayItems.update(document.querySelector('.wi-panel'),payload),data);
    await render();
    const row=page.locator('.wi-balance tbody tr').filter({has:page.locator('th button[data-item-week="'+week+'"]')});
    const released=row.locator('[data-bucket="released"]');
    const net=row.locator('[data-col="Net item sales"] button'),monthNet=page.locator('.wi-balance .wi-total [data-col="Net item sales"] button');
    assert.equal(await net.innerText(),'$130.10');
    assert.equal(await monthNet.innerText(),'$191.39');
    assert.match(await row.locator('[data-col="Original item sales"]').innerText(),/\$165.50[\s\S]+−\$20.10 canceled[\s\S]+−\$10.25 refunded/);
    assert.match(await row.locator('[data-col="Net item sales"]').innerText(),/\$5.05 excluded pending verification/);
    const mobileWeek=await row.locator('th').boundingBox(),mobileNet=await row.locator('[data-col="Net item sales"]').boundingBox();
    assert.ok(mobileNet.x>mobileWeek.x&&mobileWeek.y<mobileNet.y+mobileNet.height,'week and net share the top of the phone card');
    await net.click();assert.equal(await page.locator('.wi-week').inputValue(),week);
    assert.equal(await page.locator('.wi-filter').inputValue(),'all');
    assert.match(await page.locator('.wi-count').innerText(),/8 matching order lines · 7 orders/);
    assert.equal(await released.innerText(),'$30.00');
    assert.match(await row.innerText(),/1 order amount unconfirmed/);
    assert.equal(await row.locator('[data-bucket="held"]').innerText(),'$35.00');
    await released.click();
    assert.match(await page.locator('.wi-count').innerText(),/3 matching order lines · 2 orders/);
    assert.match(await page.locator('.wi-orders').innerText(),/Released credit · line\n\$12\.00/);
    assert.equal(await page.locator('.wi-orders').getByText('Chain',{exact:true}).count(),1);
    await row.locator('[data-bucket="review"]').click();
    assert.match(await page.locator('.wi-count').innerText(),/2 matching order lines/);
    assert.match(await page.locator('.wi-orders').innerText(),/partial transfer/);
    await row.locator('[data-bucket="processing"]').click();
    assert.match(await page.locator('.wi-orders').innerText(),/in process/);
    const creditNote=row.locator('[data-col="Released to eBay balance"] details');
    await creditNote.locator('summary').click();
    data.ebay_item_orders.find(o=>o.id==='in process').fund='available';
    await render();
    assert.equal(await released.innerText(),'$37.00');
    assert.ok(await creditNote.evaluate(e=>e.open));
    assert.match(await page.locator('.wi-count').innerText(),/0 matching order lines/);
    assert.match(await page.locator('.wi-bank summary').innerText(),/\$99\.00/);
    assert.equal(await page.locator('.wi-balance .wi-total [data-bucket="released"]').innerText(),'$98.00');
    assert.equal(await net.innerText(),'$130.10'); // A release is not another sale.
    data.rows[0].refunded=40.30;data.rows[0].net=100.05;await render();
    assert.equal(await net.innerText(),'$100.05');assert.equal(await monthNet.innerText(),'$161.34');
    await monthNet.click();assert.equal(await page.locator('.wi-week').inputValue(),'');
    assert.match(await page.locator('.wi-count').innerText(),/10 matching order lines · 9 orders/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.setViewportSize({width:1440,height:900});
    assert.equal(await row.evaluate(e=>getComputedStyle(e).display),'table-row');
    const original=await row.locator('[data-col="Original item sales"]').boundingBox(),desktopNet=await row.locator('[data-col="Net item sales"]').boundingBox(),releasedBox=await released.boundingBox();
    assert.ok(original.x<desktopNet.x&&desktopNet.x<releasedBox.x,'desktop sales trail precedes the funds columns');
    // A complete purchase cohort: the $100 refunded and $50 canceled sales still have
    // original credits; a different $40 order is on hold. Never count two item lines as two credits.
    function sale(id,booked,shipping,fee,fund,count=1){
      const credit=booked+shipping-fee;
      return order(id,fund,credit,{booked,held:fund==='held'?credit:null,
        parts:{credit,item:booked,shipping,fees:-fee,other:0},items:Array.from({length:count},()=>({title:id,qty:1}))});
    }
    data.rows=[{market:'ebay',week,first_day:week,end_day:next,booked:200,cancelled:50,refunded:100,held:10,net:40}];
    data.ebay_item_orders=[sale('later refunded',100,8,6,'available',2),sale('canceled',50,0,3,'paid_out'),
      sale('under review',10,0,1,'available'),sale('on hold',40,3,2,'held')];
    await render();const toggle=row.locator('[data-bridge]'),detail=page.locator('#wi-bridge-'+week),monthToggle=page.locator('.wi-total [data-bridge]');
    assert.match(await toggle.innerText(),/\+\$118.00/);assert.match(await row.innerText(),/deduct \$150.00 in cancellations and refunds/);
    await toggle.click();assert.equal(await detail.isVisible(),true);
    const terms=()=>detail.locator('.wi-eq-line dd').allTextContents({timeoutMs:3000});
    assert.deepEqual(await terms(),['$40.00','+$50.00','+$100.00','+$10.00','+$11.00','−$12.00','−$41.00','$158.00']);
    data.ebay_item_orders[3].fund='available';await render();
    assert.equal(await detail.isVisible(),true);assert.match(await toggle.innerText(),/\+\$159.00/);
    assert.equal((await terms()).at(-1),'$199.00');
    // Itemized proof is incomplete: disclose the unresolved amount instead of naming it a fee.
    data.ebay_item_orders[0].parts=null;await render();
    assert.match(await detail.innerText(),/Difference not yet explained[\s\S]+\+\$2.00/);
    assert.match(await detail.innerText(),/without itemized sale-credit details/);
    await monthToggle.click();assert.equal(await detail.isVisible(),false);assert.equal(await page.locator('#wi-bridge-month').isVisible(),true);
    await page.setViewportSize({width:390,height:750});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    data.ebay_item_orders[0].credit=null;await render();
    assert.match(await monthToggle.innerText(),/Not confirmed/);
  } finally {
    await browser.close();
  }
});
