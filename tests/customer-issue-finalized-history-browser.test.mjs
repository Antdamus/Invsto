import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test,before,after} from 'node:test';
import {chromium,webkit,expect} from '@playwright/test';
let server,browser,origin,browserServer;
const root=new URL('../',import.meta.url);
before(async()=>{
 server=createServer(async(req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1);if(!/^[\w./-]+$/.test(name)||name.includes('..'))return res.writeHead(404).end();
  try{let body=await readFile(new URL(name,root));if(name.endsWith('.html'))body=body.toString().replace(/<script\b[\s\S]*?<\/script>/gi,'');res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(body);}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
 browserServer=await webkit.launchServer();browser=await webkit.connect(browserServer.wsEndpoint());await mkdir(new URL('../test-results/customer-issues',import.meta.url),{recursive:true});
});

for(const width of [390,1366])test(`Send to History ${width}px: visible individual button accepts a fair decision for the whole issue`,async t=>{
 const context=await browser.newContext({viewport:{width,height:1000}});t.after(()=>context.close());
 await context.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/ebay-returns.html?historyManualFixture=1');
 for(const file of ['task-workflow.js','customer-issue-evidence.js','return-receiving.js','customer-issue-chats.js','customer-issues.js','tests/fixtures/customer-issues-fixture.js'])await page.addScriptTag({url:origin+'/'+file});
 await page.waitForFunction(()=>window.fixtureReady);
 await expect(page.locator('#issues-list [data-send-history="case-0"]')).toBeEnabled();
 await page.locator('[data-case="case-0"]').click();
 await expect(page.locator('#issues-detail .issue-case-history')).toContainText('If you accept the decision as fair');
 await expect(page.locator('#issues-detail .issue-case-history')).toContainText('Includes all 2 linked request / case records.');
  await expect(page.locator('#issues-detail .issue-case-history')).toContainText('Also closes 1 related task.');
  await expect(page.locator('#issues-detail .issue-case-history')).toContainText('with your name and the time. Previous notes are kept.');
 await expect(page.locator('#issues-detail [data-send-history="case-0"]')).toBeEnabled();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.locator('#issues-detail [data-send-history="case-0"]').scrollIntoViewIfNeeded();
 await page.screenshot({path:`test-results/customer-issues/send-history-${width}.png`});
 await page.locator('#issues-detail [data-send-history="case-0"]').click();
 await expect(page.locator('#issues-feedback')).toContainText('The issue was sent to History');
  await expect(page.locator('#issues-feedback')).toContainText('1 related task was closed with an explanation.');
 const writes=await page.evaluate(()=>fixtureWrites);assert.equal(writes.length,1);assert.equal(writes[0].name,'send_customer_issue_to_history');assert.equal(writes[0].args._accept_decision,true);assert.equal(writes[0].args._expected_cases.length,2);
  assert.equal(writes[0].args._expected_cases[0].tasks_version,'task-snapshot-0');
 await expect(page.locator('[data-case="case-0"]')).toHaveCount(0);await expect(page.locator('[data-case="case-2"]')).toHaveCount(0);
 await page.locator('#issues-open-history').click();await expect(page.locator('.issue-card')).toHaveCount(2);assert.deepEqual(errors,[]);
});
after(async()=>{await browser?.close();const stop=setTimeout(()=>browserServer?.process()?.kill(),2500);await browserServer?.close();clearTimeout(stop);await new Promise(r=>{server.close(r);server.closeAllConnections();});});


for(const width of [390,1366])test(`Finalized History banner ${width}px: visible rules, one-click archive and History navigation`,async t=>{
 const context=await browser.newContext({viewport:{width,height:1000}});t.after(()=>context.close());
 await context.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/ebay-returns.html?historyArchiveFixture=1');
 for(const file of ['task-workflow.js','customer-issue-evidence.js','return-receiving.js','customer-issue-chats.js','customer-issues.js','tests/fixtures/customer-issues-fixture.js'])await page.addScriptTag({url:origin+'/'+file});
 await page.waitForFunction(()=>window.fixtureReady);
 await expect(page.locator('#issues-history-banner')).toContainText('Unfinished work stays active.');
 await expect(page.locator('#issues-history-summary')).toHaveText('1 ready for History · 35 stay active · 1 decided against us');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.screenshot({path:`test-results/customer-issues/finalized-history-${width}.png`});
 await page.getByRole('button',{name:'Move finalized cases to History (1)',exact:true}).click();
 await expect(page.locator('#issues-history-summary')).toContainText('1 moved to History. 0 ready');
 const writes=await page.evaluate(()=>fixtureWrites);assert.deepEqual(writes,[{name:'archive_finalized_customer_issues',args:{_case_ids:['case-1']}}]);
 await expect(page.locator('[data-case="case-0"]')).toBeVisible();await expect(page.locator('[data-case="case-2"]')).toBeVisible();
 await expect(page.locator('#issues-archive-finalized')).toBeDisabled();
 await page.locator('#issues-open-history').click();await expect(page.locator('.issue-card')).toHaveCount(1);await expect(page.locator('[data-case="case-1"]')).toBeVisible();
 await page.evaluate(()=>{window.fixtureHistoryFailure=true;});await page.getByRole('button',{name:'Refresh customer issues'}).click();
 await expect(page.locator('#issues-history-summary')).toContainText('Could not verify');await expect(page.locator('#issues-archive-finalized')).toBeDisabled();
 assert.deepEqual(errors,[]);
});
