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

for(const width of [390,1366])test(`return receiving ${width}px: scan, verify, inspect with media`,async t=>{
 const page=await open(t,width);
 await page.evaluate(()=>{fixtureLookup={matches:[{case_id:'case-0',order_number:'01-12345-12345',buyer:'alex.watches',status:'open'}]};fixtureItems=[{id:'return-1',order_line_id:'line-1',item_title:'Cartier Panthère',expected_quantity:1,received_quantity:1,restocked_quantity:0,disposition:'quarantine'}];});
 await page.getByRole('button',{name:'Scan return package',exact:true}).click();
 await page.getByRole('textbox',{name:'Tracking, order number or return ID'}).fill('9400123456789012345678');await page.getByRole('button',{name:'Find package',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'Find the returned package'})).not.toBeVisible();
 assert.equal((await page.evaluate(()=>fixtureWrites)).length,0,'scanning does not save or change stock');
 await page.getByRole('button',{name:'Inspect received item',exact:true}).click();
 await page.locator('#inspection-files').setInputFiles([{name:'clasp.jpg',mimeType:'image/jpeg',buffer:Buffer.from('photo')},{name:'inspection.mp4',mimeType:'video/mp4',buffer:Buffer.from('video')}]);
 await page.getByRole('textbox',{name:'Inspection notes',exact:true}).fill('Clasp damaged; keep on hold and request repair.');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.screenshot({path:`test-results/customer-issues/receiving-inspection-${width}.png`});
 await page.getByRole('button',{name:'Save inspection',exact:true}).click();
 await expect(page.locator('#issues-feedback')).toContainText('Saved.');
 const write=(await page.evaluate(()=>fixtureWrites))[0];assert.equal(write.name,'inspect_customer_return');assert.equal(write.args._evidence.length,2);assert.equal(write.args._disposition,'quarantine');
});
test('ambiguous package lookup requires explicit choice and unknown tracking is recoverable',async t=>{
 const page=await open(t,390);await page.evaluate(()=>fixtureLookup={matches:[{case_id:'case-0',order_number:'01-12345-12345',buyer:'alex',status:'open'},{case_id:'case-3',order_number:'02-12345-12345',buyer:'bob',status:'closed'}]});
 await page.getByRole('button',{name:'Scan return package',exact:true}).click();await page.getByRole('textbox',{name:'Tracking, order number or return ID'}).fill('TRACK123456');await page.getByRole('button',{name:'Find package',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Choose the correct return'})).toBeVisible();await expect(page.locator('.return-match')).toHaveCount(2);assert.equal((await page.evaluate(()=>fixtureWrites)).length,0);
 await page.evaluate(()=>fixtureLookup={matches:[]});await page.getByRole('button',{name:'Find package',exact:true}).click();await expect(page.getByRole('heading',{name:'No saved label matches'})).toBeVisible();await expect(page.locator('#return-package-code')).toHaveValue('TRACK123456');
});

test('return follow-up routes work or a decision to the selected employee',async t=>{
 const page=await open(t,390);await page.locator('.issue-card').first().click();await page.getByRole('button',{name:'Create a task',exact:true}).click();
 await page.getByLabel('Person responsible').selectOption('staff');await page.getByLabel('They need to').selectOption('decision');await page.getByRole('textbox',{name:'Instructions',exact:true}).fill('Review the clasp damage and advise before restocking.');await page.getByRole('button',{name:'Assign task',exact:true}).click();
 await expect(page.locator('#issues-feedback')).toContainText('Saved.');const write=(await page.evaluate(()=>fixtureWrites))[0];assert.equal(write.name,'request_customer_return_followup');assert.equal(write.args._case_id,'case-0');assert.equal(write.args._owner,'staff');assert.equal(write.args._kind,'decision');
});
async function open(t,width,integration=false){
 const context=await browser.newContext({viewport:{width,height:900},hasTouch:width<800});t.after(()=>context.close());
 await context.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
 const page=await context.newPage();page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
 await page.goto(origin+'/ebay-returns.html'+(integration?'?integration=1':''));for(const file of ['task-workflow.js','customer-issue-evidence.js','return-receiving.js','customer-issues.js','tests/fixtures/customer-issues-fixture.js'])await page.addScriptTag({url:origin+'/'+file});
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
 await expect(page.getByRole('heading',{name:'Complaint & conversation',exact:true})).toBeVisible();
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
 await page.locator('.issue-evidence-group summary').click();await page.locator('[data-evidence-message]').first().check();
 const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Download evidence ZIP',exact:true}).click();const download=await downloadPromise;
 assert.match(download.suggestedFilename(),/evidence.zip$/);await expect(page.locator('[data-evidence-status]')).toContainText('1 messages');
 assert.equal((await page.evaluate(()=>fixtureWrites)).length,0);
 assert.ok(await page.locator('#issues-detail').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
 await page.screenshot({path:'test-results/customer-issues/evidence-phone.png'});
});

for(const width of [390,1366])test(`original order evidence opens automatically at ${width}px, even without a task`,async t=>{
 const page=await open(t,width);
 await page.evaluate(()=>{
  fixtureSetTasks([]);fixtureUpdateCase({raw_payload:{automaticOrderMatch:{line_ids:['line-1']}}});
  window.fixtureEvidence={bag_photos:[{bucket:'photos',path:'bag.jpg',label:'Bag 016'}],completion_events:[{photo_attachments:[{bucket:'photos',path:'completion.jpg',label:'Completed order'}]}],packaging_photos:[{bucket:'photos',path:'packing.jpg',label:'Packed contents'},{bucket:'photos',path:'packing.mp4',label:'Packaging recording',mime_type:'video/mp4'}],certificates:[],packages:[{status:'sent',tracking_code:'TRACK123'}]};
 });
 await page.locator('.issue-card').first().click();
 await expect(page.locator('.issue-original-order')).toContainText('01-12345-12345');
 await expect(page.locator('.issue-original-order')).toContainText('1 linked item');
 await expect(page.getByRole('link',{name:'Open full order ↗'})).toHaveAttribute('href',/orderHistorySearch=01-12345-12345/);
 await expect(page.getByRole('img',{name:'Bag 016',exact:true})).toBeVisible();
 await expect(page.getByRole('img',{name:'Completed order',exact:true})).toBeVisible();
 await expect(page.getByRole('img',{name:'Packed contents',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Play packaging video',exact:true}).click();
 await expect(page.locator('#issues-feedback')).toHaveText('Full evidence viewer opened');
 await expect(page.getByRole('button',{name:'Match order items'})).toHaveCount(0);
 assert.ok(await page.locator('#issues-detail').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
 assert.equal((await page.evaluate(()=>fixtureWrites)).length,0);
 await page.screenshot({path:`test-results/customer-issues/original-evidence-${width}.png`});
 await page.getByText('Evidence package',{exact:true}).click();await page.getByRole('button',{name:'Prepare evidence',exact:true}).click();
 assert.equal((await page.evaluate(()=>fixtureCalls.filter(c=>c.rpc==='customer_issue_evidence'))).length,1,'archive reuses loaded case evidence');
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

for(const width of [390,1366])test(`quick case review ${width}px: global sort, card facts and inline conversation`,async t=>{
 const page=await open(t,width);
 await expect(page.locator('.issue-card').first()).toContainText('Item value');await expect(page.locator('.issue-card').first()).toContainText('$150.00');
 await expect(page.locator('.issue-card').first()).toContainText('Order placed');await expect(page.locator('.issue-card').first()).toContainText('eBay deadline');
 await page.getByRole('combobox',{name:'Sort by',exact:true}).selectOption('value_highest');await expect(page.locator('.issue-card').first()).toContainText('buyer.35');
 await page.getByRole('button',{name:'Returns 12',exact:true}).click();await expect(page.getByRole('combobox',{name:'Sort by',exact:true})).toHaveValue('value_highest');await expect(page.locator('.issue-card').first()).toContainText('buyer.33');
 await page.getByRole('combobox',{name:'Sort by',exact:true}).selectOption('newest');await page.locator('.issue-card').first().click();
 await expect(page.locator('.issue-chat-message')).toHaveCount(5);await expect(page.locator('.issue-chat-message').first()).toContainText('The clasp needs checking');
 await page.getByRole('button',{name:'Show older messages (4 more)'}).click();await expect(page.locator('.issue-chat-message')).toHaveCount(9);
 assert.ok(await page.locator('#issues-detail').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
});


test('already resolved cases close directly into History without assignment on phone',async t=>{
 const page=await open(t,390);
 await page.evaluate(()=>fixtureUpdateCase({ebay_status:'CLOSED'}));
 await page.locator('.issue-card').first().click();
 await page.getByRole('button',{name:'Mark closed',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Move to History',exact:true})).toBeVisible();
 await expect(page.getByRole('combobox',{name:'Person responsible'})).toHaveCount(0);
 await page.getByRole('button',{name:'Mark closed & move to History',exact:true}).click();
 assert.equal((await page.evaluate(()=>fixtureWrites)).length,0,'confirmation is required');
 await page.getByRole('checkbox',{name:'Everything is resolved; no further follow-up is needed.'}).check();
 await page.getByRole('textbox',{name:'Closing note (optional)'}).fill('Already handled with buyer');
 await page.getByRole('button',{name:'Mark closed & move to History',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Case closed',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Create a task',exact:true})).toHaveCount(0);
 const writes=await page.evaluate(()=>fixtureWrites);assert.equal(writes.length,1);assert.equal(writes[0].name,'close_resolved_customer_issue');assert.equal(writes[0].args._confirmed,true);
 await expect(page.locator('[data-issue-view="history"]')).toHaveAttribute('aria-pressed','true');
 assert.ok(await page.locator('#issues-detail').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
});

for(const width of [390,1366])test(`bulk close ${width}px: cross-page selection, confirmation and saved History`,async t=>{
 const page=await open(t,width);
 await page.evaluate(()=>fixtureUpdateCase({ebay_status:'CLOSED'}));
 await page.getByRole('button',{name:'Refresh customer issues'}).click();
 await page.getByRole('button',{name:'Select cases',exact:true}).click();
 await page.getByRole('button',{name:'Select eligible on this page',exact:true}).click();
 await expect(page.getByRole('button',{name:'Mark selected closed (1)',exact:true})).toBeVisible();
 await expect(page.locator('[data-select-case="case-1"]')).toBeDisabled();
 await page.getByRole('button',{name:'Next',exact:true}).click();
 await expect(page.getByRole('button',{name:'Mark selected closed (1)',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Mark selected closed (1)',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Close 1 case & move to History'})).toBeVisible();
 await expect(page.getByRole('dialog')).toContainText('1 remaining follow-up');
 await page.getByRole('button',{name:'Close 1 case',exact:true}).click();
 assert.equal((await page.evaluate(()=>fixtureWrites)).length,0);
 await page.getByRole('checkbox',{name:'These cases are resolved; no further follow-up is needed.'}).check();
 await page.getByRole('button',{name:'Close 1 case',exact:true}).click();
 await expect(page.getByRole('dialog')).toContainText('1 case saved in History.');
 assert.equal((await page.evaluate(()=>fixtureWrites)).length,1);
 assert.ok(await page.getByRole('dialog').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
 await page.getByRole('button',{name:'View History',exact:true}).click();
 await expect(page.locator('[data-issue-view="history"]')).toHaveAttribute('aria-pressed','true');
 await expect(page.locator('#issues-bulk-toolbar')).toBeHidden();
 await expect(page.locator('.issue-card')).toHaveCount(1);
});
