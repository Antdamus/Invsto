import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test,before,after} from 'node:test';
import {chromium,expect} from '@playwright/test';
let server,browser,origin;const root=new URL('../',import.meta.url);
before(async()=>{
 server=createServer(async(req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1);if(!/^[\w./-]+$/.test(name)||name.includes('..'))return res.writeHead(404).end();try{let body=await readFile(new URL(name,root));if(name.endsWith('.html'))body=body.toString().replace(/<script\b[\s\S]*?<\/script>/gi,'');res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(body);}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch();await mkdir(new URL('../test-results/customer-followups',import.meta.url),{recursive:true});
});
after(async()=>{await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});});
async function open(t,width=1366){
 const context=await browser.newContext({viewport:{width,height:1000},timezoneId:'America/New_York',reducedMotion:'reduce'});t.after(()=>context.close());await context.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());const p=await context.newPage();
 await p.goto(origin+'/customer-followups.html');await p.evaluate(()=>{
  const order={line_id:'line-1',channel:'ebay',order_id:'order-1',order_number:'03-12345-67890',title:'Gold clasp',item_number:'287699891874',quantity:1,amount:75,purchased_at:'2026-11-02T20:54:24Z',buyer_username:'buyer.one',order_status:'fulfilled',history_link:'ebay-order-history.html?search=03-12345-67890',contact:{name:'Buyer One',phone:'555-0100',email:'buyer@example.test',address:'12 Test Street, Miami, FL 33101'}};
  const base={status:'open',channel:'ebay',buyer_username:'buyer.one',contact:order.contact,order_snapshot:order,ebay_order_line_id:'line-1',source_context:{},return_stage:'awaiting_shipment',carrier:'USPS',tracking_number:'94000000001',priority:'normal',due_at:'2026-11-10T20:00:00Z',created_at:'2026-11-08T12:00:00Z',updated_at:'2026-11-08T12:00:00Z',revision:1};
  const records=[{...base,id:'call-1',kind:'call',title:'Call about clasp complaint'},{...base,id:'return-1',kind:'manual_return',title:'Manual return for clasp'}];
  const events={};records.forEach(r=>events[r.id]=[{id:'e-'+r.id,action:'created',note:r.kind==='call'?'Customer asked us to call after 3 PM.':'Return label provided by phone.',photos:[],created_at:r.created_at,created_by_email:'staff@example.test'}]);
  const tasks={};window.fixture={records,events,tasks,calls:[],failSave:false,order};
  const rpc=async(name,args={})=>{fixture.calls.push({name,args});
   if(name==='can_access_customer_followups')return {data:true};
   if(name==='list_team_task_assignees')return {data:[{user_id:'staff-1',email:'staff@example.test',display_name:'Sandra'},{user_id:'staff-2',email:'otello@example.test',display_name:'Otello'}]};
   if(name==='search_customer_followup_orders')return {data:[order]};
   if(name==='customer_followup_packet')return {data:{record:records.find(r=>r.id===args._id),events:events[args._id]||[],tasks:tasks[args._id]||[]}};
   if(name==='create_customer_followup'){
    if(fixture.failSave){fixture.failSave=false;return {error:{code:'P0001',message:'Temporary validation failure'}};}
    const d=args._details,r={...base,...d,id:'saved-'+records.length,kind:d.kind,contact:d.contact,order_snapshot:d.line_id?order:{},revision:1};records.push(r);events[r.id]=[{action:'created',note:d.note,photos:d.photos,created_at:base.created_at,created_by_email:'staff@example.test'}];return {data:r};
   }
   if(name==='update_customer_followup'){const r=records.find(r=>r.id===args._id);Object.assign(r,args._details,{revision:r.revision+1});events[r.id].push({action:'updated',note:args._details.note,photos:args._details.photos,created_at:base.created_at,created_by_email:'staff@example.test'});return {data:r};}
   if(name==='create_customer_followup_task'){const d=args._details,t={id:'task-'+fixture.calls.length,title:d.title,status:'assigned',assigned_to_email:'otello@example.test',due_at:d.due_at};(tasks[args._id]??=[]).push(t);return {data:t};}
   return {error:{message:'Unknown RPC '+name}};
  };
  window.supabase={auth:{getSession:async()=>({data:{session:{user:{id:'staff-1'}}}})},rpc,from:()=>{const q={select:()=>q,order:()=>q,range:async()=>({data:records})};return q;},storage:{from:()=>({upload:async(path)=>{fixture.calls.push({name:'upload',path});return {};},createSignedUrl:async()=>({data:{signedUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA4sAAAAASUVORK5CYII='}})})}};
 });
 await p.addScriptTag({url:origin+'/customer-followups.js'});await p.addScriptTag({url:origin+'/customer-followups-page.js'});await expect(p.locator('#cf-count')).toContainText('1 records');return p;
}
for(const width of [390,1366])test(`standalone return ${width}px: explicit item, customer details, notes, photo and assigned task`,async t=>{
 const p=await open(t,width);await p.getByRole('button',{name:'New manual return',exact:true}).click();const d=p.getByRole('dialog');
 await d.getByLabel('Title',{exact:true}).fill('Damaged clasp return');await d.getByLabel('Message / notes').fill('Customer received a damaged clasp. Return label supplied.');
 await d.getByRole('button',{name:'Save follow-up',exact:true}).click();await expect(d.locator('.cf-error')).toContainText('Select the exact purchased item');
 await d.getByLabel('Search order history').fill('03-12345-67890');await d.getByRole('button',{name:'Search orders'}).click();await d.getByRole('button',{name:/03-12345-67890 · Gold clasp/}).click();
 await expect(d.getByLabel('Phone',{exact:true})).toHaveValue('555-0100');await expect(d.getByLabel('Address',{exact:true})).toHaveValue('12 Test Street, Miami, FL 33101');
 await d.getByLabel('Return tracking number').fill('9400123456789');await d.getByLabel('Carrier',{exact:true}).fill('USPS');await d.getByLabel('Assign a follow-up task').selectOption('staff-2');
 await d.getByLabel('Add photos',{exact:true}).setInputFiles({name:'clasp.jpg',mimeType:'image/jpeg',buffer:Buffer.from('sample image fixture')});
 const sizes=await d.evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));assert.ok(sizes.scroll<=sizes.width+1,'dialog must fit phone screen');
 await d.screenshot({path:`test-results/customer-followups/return-composer-${width}.png`});await d.getByRole('button',{name:'Save follow-up'}).click();await expect(d).not.toBeVisible();
 await expect(p.locator('#cf-detail')).toContainText('Damaged clasp return');await expect(p.locator('#cf-detail')).toContainText('9400123456789');await expect(p.locator('#cf-detail')).toContainText('otello@example.test');
 const calls=await p.evaluate(()=>fixture.calls);const created=calls.find(c=>c.name==='create_customer_followup').args._details;assert.equal(created.line_id,'line-1');assert.equal(created.photos.length,1);assert.equal(created.contact.phone,'555-0100');assert.ok(calls.some(c=>c.name==='create_customer_followup_task'));
 await p.locator('#cf-detail').screenshot({path:`test-results/customer-followups/return-record-${width}.png`});
});
test('standalone non-customer call, saved notes, multiple tasks, and separate reports with formula-safe CSV',async t=>{
 const p=await open(t);await p.getByRole('button',{name:'New call reminder'}).click();let d=p.getByRole('dialog');
 await d.getByLabel('Customer / contact name').fill('Repair supplier');await d.getByLabel('Phone',{exact:true}).fill('555-0199');await d.getByLabel('Title',{exact:true}).fill('Follow up about repair');await d.getByLabel('Message / notes').fill('Call supplier to confirm repair ETA.');await d.getByLabel('Assign a follow-up task').selectOption('');
 await d.getByRole('button',{name:'Save follow-up'}).click();await expect(d).not.toBeVisible();await expect(p.locator('#cf-detail')).toContainText('Repair supplier');
 await p.getByRole('button',{name:'Add note / photos or update'}).click();d=p.getByRole('dialog');await d.getByLabel('Note / call outcome').fill('Spoke with supplier. Ready Tuesday.');await d.getByRole('button',{name:'Save update'}).click();await expect(d).not.toBeVisible();await expect(p.locator('#cf-detail')).toContainText('Spoke with supplier. Ready Tuesday.');
 await p.getByRole('button',{name:'Create task',exact:true}).click();d=p.getByRole('dialog');await d.getByLabel('Instructions').fill('Collect the repaired piece on Tuesday.');await d.getByLabel('Responsible person').selectOption('staff-2');await d.getByRole('button',{name:'Create task',exact:true}).click();await expect(d).not.toBeVisible();
 await p.getByRole('button',{name:'Generate calls report',exact:true}).click();await expect(p.locator('#cf-report-ready')).toContainText('2 records');await expect(p.locator('#cf-report')).toContainText('Spoke with supplier. Ready Tuesday.');await expect(p.locator('#cf-report')).not.toContainText('Return label provided by phone');
 let downloadPromise=p.waitForEvent('download');await p.getByRole('button',{name:'Download CSV'}).click();let download=await downloadPromise;assert.match(download.suggestedFilename(),/^customer-calls-/);
 const formula=await p.evaluate(()=>CustomerFollowupsReport.csvCell(' =HYPERLINK("bad")'));assert.ok(formula.startsWith('"\''));
 await p.getByRole('button',{name:'Generate manual returns report',exact:true}).click();await expect(p.locator('#cf-report-ready')).toContainText('1 records');await expect(p.locator('#cf-report')).toContainText('Return label provided by phone');await expect(p.locator('#cf-report')).not.toContainText('Spoke with supplier');
 downloadPromise=p.waitForEvent('download');await p.getByRole('button',{name:'Download CSV'}).click();download=await downloadPromise;assert.match(download.suggestedFilename(),/^manual-returns-/);
 await p.emulateMedia({media:'print'});await expect(p.locator('#cf-report')).toBeVisible();await expect(p.locator('#cf-detail')).not.toBeVisible();await p.pdf({path:'test-results/customer-followups/manual-returns-report.pdf'});
});
test('chat call retains conversation and message context, escapes customer text and keeps failed drafts',async t=>{
 const p=await open(t);await p.evaluate(()=>{fixture.failSave=true;OGCustomerFollowups.open('call',{channel:'ebay',buyer:'buyer.one',name:'<img src=x onerror=alert(1)>',conversationId:'chat-1',messageId:'message-1'});});
 const d=p.getByRole('dialog');await expect(d.getByLabel('Marketplace')).toBeDisabled();await d.getByLabel('Title',{exact:true}).fill('Call about complaint');await d.getByLabel('Message / notes').fill('Call back this afternoon.');await d.getByLabel('Assign a follow-up task').selectOption('');await d.getByRole('button',{name:'Save follow-up'}).click();await expect(d.locator('.cf-error')).toContainText('Temporary validation failure');await expect(d.getByLabel('Message / notes')).toHaveValue('Call back this afternoon.');await expect(d.getByLabel('Marketplace')).toBeDisabled();assert.equal(await d.locator('img').count(),0);
 await d.getByRole('button',{name:'Save follow-up'}).click();await expect(d).not.toBeVisible();const saved=await p.evaluate(()=>fixture.calls.filter(c=>c.name==='create_customer_followup').at(-1).args._details);assert.equal(saved.conversation_id,'chat-1');assert.equal(saved.message_id,'message-1');assert.equal(saved.line_id,null);
});
