import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test,before,after} from 'node:test';
import {chromium,webkit,expect} from '@playwright/test';
let server,browser,origin;
const root=new URL('../',import.meta.url);
before(async()=>{
 server=createServer(async(req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1);if(!/^[\w./-]+$/.test(name)||name.includes('..'))return res.writeHead(404).end();
  try{let body=await readFile(new URL(name,root));if(name.endsWith('.html'))body=body.toString().replace(/<script\b[\s\S]*?<\/script>/gi,'');res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(body);}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
 browser=await(process.env.INVSTO_ITEM_BROWSER==='webkit'?webkit:chromium).launch();await mkdir(new URL('../test-results/customer-issues',import.meta.url),{recursive:true});
});
after(async()=>{await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});});
async function open(t,width,integration=false){
 const context=await browser.newContext({viewport:{width,height:900},hasTouch:width<800});t.after(()=>context.close());
 await context.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
 const page=await context.newPage();page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
 await page.goto(origin+'/ebay-returns.html'+(integration?'?integration=1':''));for(const file of ['task-workflow.js','customer-issue-evidence.js','customer-issues.js','tests/fixtures/customer-issues-fixture.js'])await page.addScriptTag({url:origin+'/'+file});
 await page.waitForFunction(()=>window.fixtureReady);if(integration){await page.addScriptTag({url:origin+'/ebay-order-history.js'});await page.evaluate(()=>document.dispatchEvent(new Event('DOMContentLoaded')));await page.waitForFunction(()=>window.OGCustomerIssues.ready);await expect(page.locator('.issue-card')).toHaveCount(30);}return page;
}
for(const width of [320,390,768,1440])test(`Customer issues ${width}px: queue, detail, evidence and forms fit`,async t=>{
 const page=await open(t,width);await expect(page.locator('.issue-card')).toHaveCount(30);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'page has no horizontal overflow');
 const first=page.locator('.issue-card').first();await first.click();await expect(page.locator('#issues-detail').getByRole('heading',{name:'alex.watches',exact:true})).toBeVisible();
 await expect(page.getByRole('img',{name:'Original sold item screenshot'})).toBeVisible();
 assert.ok(await page.locator('#issues-detail').evaluate(e=>e.scrollWidth<=e.clientWidth+1),'case panel has no horizontal overflow');
 await page.screenshot({path:`test-results/customer-issues/detail-${width}.png`});
 await page.getByRole('button',{name:'Add update / hand back',exact:true}).click();await page.getByRole('textbox',{name:'Update / instructions'}).fill('Certificate checked. Please inspect the clasp.');
 await page.getByRole('button',{name:'Save update',exact:true}).click();
 assert.equal((await page.evaluate(()=>fixtureWrites))[0].args._mode,'update');
 await page.getByRole('button',{name:'Complete my part',exact:true}).click();await page.getByRole('textbox',{name:'Update / instructions'}).fill('Inspection completed. Please review.');await page.getByRole('button',{name:'Confirm',exact:true}).click();
 await expect(page.getByText('Review: Sandra',{exact:true})).toBeVisible();
 if(width<=900){await page.getByRole('button',{name:'← Cases',exact:true}).click();await expect(first).toBeVisible();}
});
test('filters and paging stay server-side; full case data loads only on selection',async t=>{
 const page=await open(t,1440);
 assert.equal((await page.evaluate(()=>fixtureCalls)).filter(c=>c.table&&c.table!=='employees').length,0);
 await page.getByRole('button',{name:'Next',exact:true}).click();await expect(page.locator('.issue-card')).toHaveCount(6);
 await page.getByRole('button',{name:'Requests 12',exact:true}).click();await expect(page.locator('.issue-card')).toHaveCount(12);
 await page.getByRole('button',{name:'All open 36',exact:true}).click();await page.getByRole('searchbox',{name:'Search customer issues'}).fill('alex.watches');await expect(page.locator('.issue-card')).toHaveCount(1);
 await page.locator('.issue-card').click();await page.getByRole('button',{name:'View full photo',exact:true}).click();await expect(page.locator('#issues-feedback')).toHaveText('Full evidence viewer opened');
});
test('background case changes keep expanded details and never erase an unsaved reply',async t=>{
 const page=await open(t,1440);await page.locator('.issue-card').first().click();
 await page.getByText('Buyer’s complaint & eBay conversation',{exact:true}).click();
 await page.evaluate(async()=>{fixtureUpdateCase({ebay_status:'ITEM_DELIVERED'});await OGCustomerIssues.refresh({detail:false});});
 await expect(page.getByText('Item delivered',{exact:true})).toBeVisible();
 await expect(page.getByText('Buyer says the clasp needs inspection.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Add update / hand back',exact:true}).click();await page.getByRole('textbox',{name:'Update / instructions'}).fill('Unsaved inspection note');
 await page.evaluate(async()=>{fixtureUpdateCase({ebay_status:'CLOSED'});await OGCustomerIssues.refresh({detail:false});});
 await expect(page.getByRole('textbox',{name:'Update / instructions'})).toHaveValue('Unsaved inspection note');
});


test('real order-history integration boots the new workspace and opens its reusable intake',async t=>{
 const page=await open(t,390,true);await page.locator('.issue-card').first().click();
 await expect(page.locator('#issues-detail').getByRole('heading',{name:'alex.watches',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Receive returned items',exact:true}).click();
 await expect(page.locator('#return-intake-modal')).toBeVisible();
 await expect(page.locator('#return-ebay-id')).toHaveValue('54001230');
 await expect(page.locator('#return-line-list')).toContainText('Cartier');
 assert.equal(await page.evaluate(()=>state.returnIntakeCaseId),'case-0');
});


test('phone evidence downloads original files and selected messages without sending anything',async t=>{
 const page=await open(t,390);await page.locator('.issue-card').first().click();
 await page.getByText('Evidence package',{exact:true}).click();await page.getByRole('button',{name:'Prepare evidence',exact:true}).click();
 await expect(page.getByRole('button',{name:'Download evidence ZIP',exact:true})).toBeVisible();
 await page.locator('.issue-evidence-group summary').click();await page.locator('[data-evidence-message]').check();
 const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Download evidence ZIP',exact:true}).click();const download=await downloadPromise;
 assert.match(download.suggestedFilename(),/evidence.zip$/);await expect(page.locator('[data-evidence-status]')).toContainText('1 messages');
 assert.equal((await page.evaluate(()=>fixtureWrites)).length,0);
 assert.ok(await page.locator('#issues-detail').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
 await page.screenshot({path:'test-results/customer-issues/evidence-phone.png'});
});

for(const width of [320,1366])test(`sync recovery at ${width}px explains the issue and retries without closing cases`,async t=>{
 const page=await open(t,width);
 await page.evaluate(()=>{window.fixtureHealth={lanes:[{lane:'payment_dispute',status:'needs_access',last_progress_at:new Date().toISOString()}],worker:{last_finished_at:new Date().toISOString()},problems:[{monitor_key:'payment_dispute',reason:'access'}],queued:3,retrying:1};});
 await page.getByRole('button',{name:'Refresh customer issues'}).click();
 await page.getByText('eBay updates need attention · view recovery steps',{exact:true}).click();
 await expect(page.getByRole('heading',{name:'Restore automatic updates'})).toBeVisible();
 await expect(page.getByRole('link',{name:'Reconnect eBay ↗'})).toHaveAttribute('href','https://project.functions.supabase.co/ebay-oauth-callback');
 await page.getByRole('button',{name:'Retry sync',exact:true}).click();
 await expect(page.locator('#issues-feedback')).toContainText('Refresh queued');
 assert.deepEqual((await page.evaluate(()=>fixtureCalls.filter(c=>c.invoke))).map(c=>c.args.body),[{action:'refresh'}]);
 assert.equal((await page.evaluate(()=>fixtureWrites)).length,0);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.screenshot({path:`test-results/customer-issues/sync-recovery-${width}.png`});
 await page.evaluate(()=>{window.fixtureHealth={lanes:[{lane:'payment_dispute',status:'ok',last_progress_at:new Date().toISOString()}],worker:{last_finished_at:new Date().toISOString()},problems:[],queued:0,retrying:0};});
 await page.getByRole('button',{name:'Refresh customer issues'}).click();
 await expect(page.locator('#issues-health-summary')).toHaveText('eBay connected · background updates active');
 await expect(page.getByRole('button',{name:'Retry sync',exact:true})).toHaveCount(0);
});
