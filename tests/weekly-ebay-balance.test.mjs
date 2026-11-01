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
    const data = {month:'2026-10', rows:[{week,first_day:week,end_day:next},{week:next,first_day:next,end_day:'2026-10-19'}]
      .map(r=>({...r,market:'ebay',cancelled:0,refunded:0})), ebay_item_orders:[
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
    data.ebay_item_orders.find(o=>o.id==='in process').fund='available';
    await render();
    assert.equal(await released.innerText(),'$37.00');
    assert.match(await page.locator('.wi-count').innerText(),/0 matching order lines/);
    assert.match(await page.locator('.wi-bank summary').innerText(),/\$99\.00/);
    assert.equal(await page.locator('.wi-balance .wi-total [data-bucket="released"]').innerText(),'$98.00');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  } finally {
    await browser.close();
  }
});
