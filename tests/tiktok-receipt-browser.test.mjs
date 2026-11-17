import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium,expect} from '@playwright/test';
let server,browser,origin;
const source=await readFile(new URL('../tiktok-receipt-browser.js',import.meta.url),'utf8');
const style=await readFile(new URL('../tiktok-receipt-browser.css',import.meta.url),'utf8');
const receipt='https://seller-us.tiktok.com/order/detail?order_no=577681512483951404&shop_region=US&ogReceipt=1&ogSku=1732855573992804598';
before(async()=>{
 server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body><button data-tk-receipt-settings>Receipt settings</button><a id="receipt" href="'+receipt+'" target="_blank">Open item video receipt</a><input id="draft" value="unsaved work"></body></html>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;browser=await chromium.launch();
});
after(async()=>{await browser?.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});});
async function pageFor(t,userAgent,viewport={width:1200,height:800}){
 const context=await browser.newContext({userAgent,viewport});t.after(()=>context.close());const page=await context.newPage();await page.goto(origin);await page.addStyleTag({content:style});await page.addScriptTag({content:source});return page;
}
const edge='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/157.0 Safari/537.36 Edg/157.0';
test('receipt preference persists locally, routes the exact order/SKU and preserves the queue',async t=>{
 const page=await pageFor(t,edge);await page.getByRole('button',{name:'Receipt settings',exact:true}).click();
 await page.getByLabel('Open video receipts with').selectOption('firefox');await expect(page.getByRole('status')).toHaveText('Saved for this computer.');await page.getByRole('button',{name:'Done',exact:true}).click();
 assert.equal(await page.evaluate(url=>TikTokReceiptBrowser.route(url),receipt),'invsto-receipt://tiktok/?order=577681512483951404&sku=1732855573992804598');
 await page.locator('#draft').fill('keep this draft');await page.locator('#receipt').click();await expect(page.locator('.tk-receipt-launch-notice')).toBeVisible();await expect(page.locator('#draft')).toHaveValue('keep this draft');assert.equal(page.url(),origin+'/');
 await page.reload();await page.addScriptTag({content:source});assert.equal(await page.evaluate(()=>TikTokReceiptBrowser.preference()),'firefox');
 const other=await pageFor(t,edge);assert.equal(await other.evaluate(()=>TikTokReceiptBrowser.preference()),'current');
});
test('Edge, Firefox, mobile and unrelated links use the correct route without changing defaults',async t=>{
 const page=await pageFor(t,edge);
 assert.equal(await page.evaluate(url=>TikTokReceiptBrowser.route(url,'edge'),receipt),receipt);
 for(const url of [receipt.replace('seller-us.tiktok.com','evil.test'),receipt.replace('ogReceipt=1','ogReceipt=0'),receipt.replace('1732855573992804598','bad'),receipt.replace('https:','http:')])assert.equal(await page.evaluate(url=>TikTokReceiptBrowser.route(url,'firefox'),url),null);
 const ff=await pageFor(t,'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:160.0) Gecko/20100101 Firefox/160.0');
 assert.equal(await ff.evaluate(url=>TikTokReceiptBrowser.route(url,'firefox'),receipt),receipt);
 assert.equal(await ff.evaluate(url=>TikTokReceiptBrowser.route(url,'edge'),receipt),'microsoft-edge:'+receipt);
 const mobile=await pageFor(t,'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1',{width:390,height:844});
 assert.equal(await mobile.evaluate(url=>TikTokReceiptBrowser.route(url,'firefox'),receipt),receipt);
 await mobile.getByRole('button',{name:'Receipt settings',exact:true}).click();await expect(mobile.getByLabel('Open video receipts with')).toBeDisabled();
 assert.ok(await mobile.locator('dialog').evaluate(el=>el.getBoundingClientRect().right<=innerWidth&&el.scrollWidth<=el.clientWidth));
 await mobile.screenshot({path:'output/firefox-order-link/receipt-settings-phone.png'});
 await page.getByRole('button',{name:'Receipt settings',exact:true}).click();await page.getByLabel('Open video receipts with').selectOption('firefox');await page.screenshot({path:'output/firefox-order-link/receipt-settings-desktop.png'});
});
