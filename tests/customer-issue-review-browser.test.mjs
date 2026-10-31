import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test,before,after} from 'node:test';
import {webkit,expect} from '@playwright/test';
let server,browser,origin,browserServer;
const root=new URL('../',import.meta.url);
before(async()=>{
 server=createServer(async(req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1);if(!/^[\w./-]+$/.test(name)||name.includes('..'))return res.writeHead(404).end();try{let body=await readFile(new URL(name,root));if(name.endsWith('.html'))body=body.toString().replace(/<script\b[\s\S]*?<\/script>/gi,'');res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(body);}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;browserServer=await webkit.launchServer();browser=await webkit.connect(browserServer.wsEndpoint());await mkdir(new URL('../test-results/customer-issues',import.meta.url),{recursive:true});await mkdir(new URL('../output/pdf',import.meta.url),{recursive:true});
});
after(async()=>{await browser?.close();const stop=setTimeout(()=>browserServer?.process()?.kill(),2500);await browserServer?.close();clearTimeout(stop);await new Promise(r=>{server.close(r);server.closeAllConnections();});});
async function pageFor(t,width){const ctx=await browser.newContext({viewport:{width,height:1000}});t.after(()=>ctx.close());await ctx.route('**/*',r=>(r.request().url().startsWith(origin)||/^(blob:|data:)/.test(r.request().url()))?r.continue():r.abort());const page=await ctx.newPage();await page.goto(origin+'/customer-issue-review-report.html');for(const file of ['tests/fixtures/issue-review-fixture.js','vendor/pdf-lib/pdf-lib.min.js','buyer-report-refunds.js','ebay-buyer-report.js','customer-issue-evidence.js','customer-issue-review-tracking.js','customer-issue-review-model.js','customer-issue-review-pdf.js','catalogue-core.js','catalogue-viewer.js','customer-issue-review-report.js'])await page.addScriptTag({url:origin+'/'+file});await expect(page.locator('#download-packet')).toBeEnabled().catch(async error=>{throw new Error((await page.locator('body').innerText())+'\n'+error.message)});return page;}
for(const width of [390,1366])test(`Review packet ${width}px: evidence, editable position, safe exchanges and navigation`,async t=>{
 const page=await pageFor(t,width);await expect(page.locator('.review-index .index-entry')).toHaveCount(1);await expect(page.locator('.status-card')).toHaveCount(1);await expect(page.locator('.photo-grid img')).toHaveCount(2);
 await expect(page.locator('.status-card')).toContainText('earlier stage of this case');await expect(page.locator('.case-section > .timeline')).toContainText('Inquiry opened');
 await expect(page.locator('.review-index')).not.toContainText('5388000001, 5388000001');
 const thumb=page.getByRole('button',{name:'Expand evidence photo: Video receipt - 287000000001',exact:true});await thumb.click();
 const viewer=page.getByRole('dialog');await expect(viewer).toBeVisible();await expect(viewer.locator('.viewer-photo')).toBeVisible();
 const crop=await viewer.locator('.viewer-photo').getAttribute('src');await viewer.getByRole('button',{name:'Zoom in',exact:true}).click();await expect(viewer.locator('output')).toHaveText('150%');
 await viewer.getByRole('button',{name:'Fit',exact:true}).click();await expect(viewer.locator('output')).toHaveText('100%');
 await viewer.getByRole('button',{name:'Show full screenshots',exact:true}).click();await expect(viewer.locator('.viewer-photo')).toBeVisible();assert.notEqual(await viewer.locator('.viewer-photo').getAttribute('src'),crop);
 await viewer.getByRole('button',{name:'Next photograph',exact:true}).click();await expect(viewer.locator('#viewer-counter')).toHaveText('Photo 2 of 2');
 await page.screenshot({path:`test-results/customer-issues/review-photo-viewer-${width}.png`});
 await viewer.getByRole('button',{name:'Close photo viewer',exact:true}).click();await expect(viewer).not.toBeVisible();await expect(thumb).toBeFocused();
 await expect(page.locator('.tracking-card h3')).toHaveText('9400000000000000123456');await expect(page.locator('.tracking-card .pill')).toHaveText('Delivered');
 await page.getByText('Save or update carrier history',{exact:true}).click();await page.locator('textarea[name=history]').fill('Delivered, In/At Mailbox\nOctober 5, 2026 11:44 AM\nAll carrier scan events are retained.');await expect(page.locator('#download-packet')).toBeDisabled();
 await page.getByRole('button',{name:'Save tracking history',exact:true}).click();await expect(page.locator('.carrier-history')).toContainText('All carrier scan events are retained.');await expect(page.locator('#download-packet')).toBeEnabled();

 await expect(page.locator('.case-section > .timeline')).not.toContainText('INTERNAL ONLY');await expect(page.locator('.case-section > .timeline')).toContainText('<script>unsafe()</script>');assert.equal(await page.locator('.timeline script').count(),0);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:`test-results/customer-issues/review-packet-${width}.png`});
 await page.locator('.position summary').click();await page.locator('textarea[name=position]').fill('Our updated position: the package was delivered.');await expect(page.locator('#download-packet')).toBeDisabled();await expect(page.locator('#refresh-packet')).toBeDisabled();
 await page.getByRole('button',{name:'Save position',exact:true}).click();await expect(page.locator('#download-packet')).toBeEnabled();await expect(page.locator('.position')).toContainText('Our updated position: the package was delivered.');
 await page.locator('#include-internal').check();await expect(page.locator('.case-section > .timeline')).toContainText('INTERNAL ONLY');await page.locator('#include-internal').uncheck();await expect(page.locator('.case-section > .timeline')).not.toContainText('INTERNAL ONLY');
 await page.locator('.review-index a').click();await expect(page.locator('.case-heading h2')).toBeVisible();await page.screenshot({path:`test-results/customer-issues/review-case-${width}.png`});
 const writes=await page.evaluate(()=>fixtureWrites.filter(w=>w.name==='save_customer_issue_ebay_review'));assert.equal(writes.length,1);assert.equal(writes[0].args._action,'save');assert.equal(writes[0].args._version,'v1');
 if(width===1366){
  const bytes=await page.evaluate(async()=>Array.from(await OGIssueReviewPdf.build({issues:OGIssueReviewReport.issues,generatedAt:'2026-10-30T15:00:00Z',includeInternal:false})));
  await writeFile(new URL('../output/pdf/ebay-case-review-preview.pdf',import.meta.url),new Uint8Array(bytes));
  const check=await page.evaluate(async bytes=>{const pdf=await PDFLib.PDFDocument.load(new Uint8Array(bytes));return {pages:pdf.getPageCount(),links:pdf.getPages().map(p=>p.node.lookup(PDFLib.PDFName.of('Annots'))?.size()||0)};},bytes);assert.ok(check.pages>=5);assert.ok(check.links.every(n=>n>=2));
 }
});
test('Concurrent position edit preserves draft and blocks export until resolved',async t=>{const p=await pageFor(t,390);await p.locator('.position summary').click();await p.locator('textarea[name=position]').fill('Keep this unsaved draft');await p.evaluate(()=>{window.fixtureSaveConflict=true;});await p.getByRole('button',{name:'Save position',exact:true}).click();await expect(p.locator('#packet-error')).toContainText('changed by someone else');await expect(p.locator('textarea[name=position]')).toHaveValue('Keep this unsaved draft');await expect(p.locator('#download-packet')).toBeDisabled();});

test('Issue action marks the shared pile and shows the report link without closing a case',async t=>{
 const ctx=await browser.newContext();t.after(()=>ctx.close());const p=await ctx.newPage();await p.goto(origin+'/ebay-returns.html');
 await p.addScriptTag({url:origin+'/tests/fixtures/issue-review-fixture.js'});await p.addScriptTag({url:origin+'/customer-issue-review.js'});
 await p.evaluate(async()=>{reviewFixture.reviews[0].active=false;const redraw=()=>document.getElementById('issues-detail').innerHTML=OGIssueReview.button({id:'case-a'});await OGIssueReview.init({client:supabase,feedback:()=>{},onChange:redraw});redraw();});
 await p.getByRole('button',{name:'＋ Add to eBay review',exact:true}).click();await expect(p.getByRole('button',{name:'✓ In eBay review',exact:true})).toBeEnabled();await expect(p.locator('#issue-review-count')).toHaveText('1');
 assert.deepEqual(await p.evaluate(()=>fixtureWrites.map(w=>w.args._action)),['mark']);await expect(p.getByRole('link',{name:'Position & report ↗',exact:true})).toHaveAttribute('href','customer-issue-review-report.html#review-case-a');
});
