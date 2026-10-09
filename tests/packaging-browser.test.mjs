import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test,before,after} from 'node:test';
import {chromium,webkit,expect} from '@playwright/test';
let server,browser,origin;
const root=new URL('../',import.meta.url);
before(async()=>{
 server=createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname.slice(1);if(!/^[\w./-]+$/.test(path)||path.includes('..'))return res.writeHead(404).end();try{let body=await readFile(new URL(path,root));if(path.endsWith('.html'))body=body.toString().replace(/<script\b[\s\S]*?<\/script>/gi,'');res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(body);}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;browser=await(process.env.INVSTO_ITEM_BROWSER==='webkit'?webkit:chromium).launch();await mkdir(new URL('test-results/',root),{recursive:true});
});
after(async()=>{await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});});
async function open(t,width=390){const context=await browser.newContext({viewport:{width,height:900},hasTouch:width<701});t.after(()=>context.close());await context.route('**/*',route=>route.request().url().startsWith(origin)||route.request().url().startsWith('data:')?route.continue():route.abort());const page=await context.newPage();page.setDefaultTimeout(6500);const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));await page.goto(origin+'/packaging.html');
 await page.evaluate(()=>{
  const me='00000000-0000-4000-8000-000000000100',order='00000000-0000-4000-8000-000000000001',line='00000000-0000-4000-8000-000000000011';const now=new Date().toISOString();
  window.fixtureWrites=[];window.fixtureStorage=[];window.fixtureFailure=null;window.fixtureScanExisting=false;
  window.fixtureDetail={shipment:null,orders:[{id:order,order_number:'12-15247-65265',buyer_username:'jewelrybuyer',sale_date:now,ready:true,tracking_number:'9400100000000000000001'}],lines:[{id:line,order_id:order,item_title:'#049 · 10K solid gold chain',item_number:'287611495563',custom_label:'Bag 049',quantity:2,fulfilled_quantity:2,line_status:'fulfilled',packed_quantity:0,other_quantity:0}],tasks:[{id:'task-reference',title:'Include the authenticity certificate',status:'resolved',latest_note:'Certificate found and attached to the bag.',assigned_to_email:'sandra@example.test',created_at:now}],order_events:[{order_id:order,notes:'Please keep the certificate with the chain.',signed_by_email:'sandra@example.test',created_at:now,photo_attachments:[{bucket:'photos',path:'reference.jpg',label:'Bag 049 · live photo',media_type:'image'}]}],evidence:[],events:[],issues:[],related_packages:[]};
  const image='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240"><rect width="360" height="240" fill="#17261d"/><ellipse cx="180" cy="115" rx="75" ry="68" fill="none" stroke="#d9ba74" stroke-width="9"/><ellipse cx="180" cy="115" rx="75" ry="68" fill="none" stroke="#f8dea6" stroke-width="3" stroke-dasharray="5 6"/><text x="180" y="220" text-anchor="middle" font-family="sans-serif" fill="#c5ccb6">Packaging test photo</text></svg>');
  window.supabase={rpc:async(name,{_action:a,_args:args})=>{
   const d=fixtureDetail;
   if(a==='queue'){const view=d.shipment?({ready:'sending',dispatched:'history'}[d.shipment.status]||d.shipment.status):'to_package';const rows=args.view===view?[{shipment_id:d.shipment?.id,order_id:d.shipment?null:order,buyer_key:d.shipment?null:'buyer:jewelrybuyer',order_ids:d.orders.map(o=>o.id),title:d.shipment?.tracking_code||'jewelrybuyer',subtitle:d.shipment?'jewelrybuyer':d.orders.length+' orders · '+d.lines.reduce((n,l)=>n+l.quantity,0)+' items',created_at:now}]:[];return{data:{enabled:true,user_id:me,is_admin:true,counts:{[view]:1},total:rows.length,rows}};}
   if(a==='detail'||a==='buyer')return{data:structuredClone(d)};
   if(a==='staff')return{data:[{user_id:me,name:'Jose'},{user_id:'00000000-0000-4000-8000-000000000101',name:'Sandra'}]};
   if(a==='scan')return{data:{tracking:args.tracking,shipment_id:fixtureScanExisting?d.shipment?.id:null,matches:fixtureUnmatched?[]:[{order_ids:[order],orders:[{id:order,order_number:'12-15247-65265',buyer:'jewelrybuyer',ready:true}],buyer_order_ids:d.orders.map(o=>o.id),buyer_orders:d.orders.map(o=>({id:o.id,order_number:o.order_number,buyer:o.buyer_username,ready:o.ready}))}]}};
   fixtureWrites.push({action:a,args});if(fixtureFailure===a){fixtureFailure=null;return{error:{message:'Connection interrupted. Retry safely.'}};}
   if(window.fixtureDelay===a)await new Promise(r=>window.releaseFixture=r);
   if(a==='start')d.shipment={id:'00000000-0000-4000-8000-000000000200',tracking_code:args.tracking,revision:1,status:'in_progress',claimed_by:me,claimed_until:new Date(Date.now()+900000).toISOString(),created_at:now};
   else if(a==='contents')d.lines.forEach(l=>l.packed_quantity=args.items.find(i=>i.line_id===l.id)?.quantity||0);
   else if(a==='evidence')d.evidence.push({id:'proof-'+d.evidence.length,bucket:'team-task-evidence',path:args.path,label:args.label,media_type:'image'});
   else if(a==='pack'){if(!d.evidence.length)return{error:{message:'Add at least one packaging photo before finishing'}};d.shipment.status='ready';d.shipment.dispatch_date=new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'});}
   else if(a==='dispatch'){d.shipment.status='dispatched';d.shipment.dispatched_at=now;}
   else if(a==='issue'){d.shipment.status=args.blocking?'on_hold':'in_progress';d.shipment.hold_reason=args.note;d.issues.push({task_id:'new-task',title:args.note,open:true,blocking:args.blocking,status:'assigned',assigned_to_email:'sandra@example.test'});}
   if(a!=='start')d.shipment.revision++;
   d.events.unshift({action:a,notes:args.note,actor:'Jose',created_at:now});return{data:structuredClone(d)};
  },storage:{from:bucket=>({createSignedUrl:async path=>{fixtureStorage.push({type:'read',path});return{data:{signedUrl:image}};},upload:async(path,file)=>{fixtureStorage.push({type:'upload',path,name:file.name});if(window.fixtureUploadFailure){fixtureUploadFailure=false;return{error:{message:'Upload interrupted'}};}return{data:{path}};}})}};
  window.fixtureUnmatched=false;
 });
 await page.addScriptTag({url:origin+'/packaging-media.js'});await page.addScriptTag({url:origin+'/packaging.js'});await expect(page.locator('.pack-row')).toHaveCount(1);return page;
}
const noOverflow=async page=>{const result=await page.evaluate(()=>({over:document.documentElement.scrollWidth>innerWidth,els:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1&&getComputedStyle(e).position!=='fixed').slice(0,12).map(e=>e.tagName+'.'+e.className)}));assert.equal(result.over,false,JSON.stringify(result.els));};
async function start(page){await page.locator('#pack-barcode').fill('9400100000000000000001');await page.locator('#pack-barcode').press('Enter');await expect(page.getByRole('dialog',{name:'Check the label & orders'})).toBeVisible();await page.getByRole('button',{name:'Start packing',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();await expect(page.getByRole('heading',{name:'9400100000000000000001',exact:true})).toBeVisible();}
for(const width of [320,390,768,1366,1920])test(`Packaging ${width}px: scan, review, photos, notes and issue task are accessible`,async t=>{
 const page=await open(t,width);await noOverflow(page);await page.screenshot({path:`test-results/packaging-${width}-queue.png`});await start(page);await noOverflow(page);await expect(page.locator('[data-line]')).toHaveValue('0');await page.locator('[data-line]').fill('2');
 const link=page.locator('.pack-line .order-chat-link');await expect(link).toBeVisible();const chatUrl=new URL(await link.getAttribute('href'),page.url());assert.equal(chatUrl.searchParams.get('orderLineId'),await page.locator('[data-line]').getAttribute('data-line'));assert.equal(chatUrl.searchParams.get('from'),'packaging');await expect(link).toHaveAttribute('target','_blank');
 await page.getByRole('button',{name:'Add note',exact:true}).click();await page.locator('[name=note]').fill('Keep both chains in their own bags.');await page.getByRole('button',{name:'Save note',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();await expect(page.locator('[data-line]')).toHaveValue('2');
 await page.getByRole('button',{name:'Save checked quantities'}).click();await expect(page.locator('#pack-status')).toContainText('quantities saved');
 await page.locator('#pack-order-proof summary').click();await expect(page.locator('.pack-line-photos img')).toBeVisible();assert.equal(await page.locator('[data-media-source=false]').count(),0);
 await page.locator('#pack-files').setInputFiles({name:'packing.jpg',mimeType:'image/jpeg',buffer:Buffer.from('fixture-image')});await expect(page.locator('[data-media-source=false] img')).toHaveCount(1);
 await page.screenshot({path:`test-results/packaging-${width}-detail.png`,fullPage:true});await noOverflow(page);
 await page.getByRole('button',{name:'Report an issue'}).click();await page.locator('[name=owner]').selectOption('00000000-0000-4000-8000-000000000101');await page.locator('[name=note]').fill('Replace the defective clasp.');await page.locator('[name=due]').fill('2026-10-09T15:00');await page.screenshot({path:`test-results/packaging-${width}-issue.png`});await page.getByRole('button',{name:'Create task',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();await expect(page.getByRole('button',{name:'Issue resolved · Resume packing'})).toBeDisabled();await expect(page.locator('.pack-notice.error').first()).toContainText('Replace the defective clasp');await noOverflow(page);
 const issue=await page.evaluate(()=>fixtureWrites.find(w=>w.action==='issue'));assert.equal(issue.args.blocking,true);assert.equal(issue.args.kind,'work');assert.equal(issue.args.order_id,'00000000-0000-4000-8000-000000000001');
});
test('failed file upload and uncertain evidence save retain file and safe retry; quantity draft survives',async t=>{
 const page=await open(t);await start(page);await page.locator('[data-line]').fill('2');await page.evaluate(()=>fixtureUploadFailure=true);await page.locator('#pack-files').setInputFiles({name:'packing.jpg',mimeType:'image/jpeg',buffer:Buffer.from('fixture')});await expect(page.locator('#pack-upload-status')).toContainText('Upload interrupted');await expect(page.locator('[data-line]')).toHaveValue('2');
 await page.evaluate(()=>fixtureFailure='evidence');await page.getByRole('button',{name:'Retry',exact:true}).click();await expect(page.locator('#pack-upload-status')).toContainText('Connection interrupted');await page.getByRole('button',{name:'Retry',exact:true}).click();await expect(page.locator('[data-media-source=false] img')).toHaveCount(1);await expect(page.locator('#pack-upload-status')).toBeEmpty();await expect(page.locator('[data-line]')).toHaveValue('2');
 const writes=await page.evaluate(()=>fixtureWrites.filter(w=>w.action==='evidence'));assert.equal(writes[0].args.request_id,writes[1].args.request_id);assert.equal((await page.evaluate(()=>fixtureStorage.filter(w=>w.type==='upload'))).length,2);
});
test('pack and dispatch remain separate, duplicate submits are disabled, next scan clears old order context',async t=>{
 const page=await open(t);await start(page);await page.locator('[data-line]').fill('2');await page.getByRole('button',{name:'Save checked quantities'}).click();await page.locator('#pack-files').setInputFiles({name:'packing.jpg',mimeType:'image/jpeg',buffer:Buffer.from('fixture')});await expect(page.locator('#pack-upload-status')).toBeEmpty();
 await page.getByRole('button',{name:'Packaged · Sending today →',exact:true}).click();await page.getByRole('checkbox').check();await page.evaluate(()=>fixtureDelay='pack');await page.getByRole('button',{name:'Packaged · Sending today',exact:true}).click();await expect(page.getByRole('button',{name:'Packaged · Sending today',exact:true})).toBeDisabled();await page.evaluate(()=>releaseFixture());await expect(page.getByRole('dialog')).not.toBeVisible();assert.equal((await page.evaluate(()=>fixtureWrites.filter(w=>w.action==='dispatch'))).length,0);await expect(page.getByRole('button',{name:'Confirm dispatched →'})).toBeVisible();
 await page.getByRole('button',{name:'Confirm dispatched →'}).click();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Confirm',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();await page.getByRole('button',{name:'Scan next package'}).click();await expect(page.locator('#pack-barcode')).toBeFocused();await page.evaluate(()=>fixtureUnmatched=true);await page.locator('#pack-barcode').fill('9400100000000000000099');await page.locator('#pack-barcode').press('Enter');await expect(page.locator('#pack-status')).toContainText('No saved label matches');await expect(page.getByRole('dialog')).not.toBeVisible();
});
test('external label linking requires opening the order and explicit confirmation',async t=>{
 const page=await open(t);await page.locator('.pack-row').click();await page.getByRole('button',{name:'Scan this order’s label'}).click();await page.evaluate(()=>fixtureUnmatched=true);await page.locator('#pack-barcode').fill('9400100000000000000099');await page.locator('#pack-barcode').press('Enter');await expect(page.getByRole('dialog',{name:'Link this external label'})).toBeVisible();assert.equal((await page.evaluate(()=>fixtureWrites)).length,0);await page.getByRole('checkbox').check();await page.locator('[name=note]').fill('Label purchased outside eBay');await page.getByRole('button',{name:'Link & start packing'}).click();await expect(page.getByRole('dialog')).not.toBeVisible();const saved=await page.evaluate(()=>fixtureWrites[0]);assert.equal(saved.args.confirm_link,true);
});
test('an in-flight upload prevents another capture or quantity edit from being silently discarded',async t=>{
 const page=await open(t);await start(page);await page.locator('[data-line]').fill('2');await page.evaluate(()=>fixtureDelay='evidence');
 await page.locator('#pack-files').setInputFiles({name:'packing.jpg',mimeType:'image/jpeg',buffer:Buffer.from('fixture')});
 await expect(page.locator('#pack-upload-status')).toContainText('Saving evidence');await expect(page.locator('#pack-camera')).toBeDisabled();await expect(page.locator('[data-line]')).toBeDisabled();
 await page.evaluate(()=>releaseFixture());await expect(page.locator('#pack-upload-status')).toBeEmpty();await expect(page.locator('#pack-camera')).toBeEnabled();await expect(page.locator('[data-line]')).toHaveValue('2');
});

for(const width of [320,390,1366])test(`${width}px: item screenshots and completion photos are visible, correctly scoped, enlargeable, and read-only`,async t=>{
 const page=await open(t,width);
 await page.evaluate(()=>{
  const d=fixtureDetail,line=d.lines[0],other={...line,id:'other-line',item_title:'#050 · Silver bracelet',item_number:'287611495564'};d.lines.push(other);
  d.reference_events=[{order_id:line.order_id,task_line_ids:[line.id,other.id],created_at:new Date().toISOString(),signed_by_email:'sandra@example.test',payload:{},photo_attachments:[
   {bucket:'photos',path:'chain-front.jpg',label:'Chain front screenshot',metadata:{source:'video_receipt',order_line_ids:[line.id]},preview_path:'chain-front-preview.jpg'},
   {bucket:'photos',path:'chain-detail.jpg',label:'Chain clasp screenshot',metadata:{source:'video_receipt',item_number:line.item_number}}]},
   {order_id:line.order_id,created_at:new Date().toISOString(),payload:{proof_type:'completion_photo',order_line_ids:[line.id,other.id]},photo_attachments:[{bucket:'order-evidence-photos',path:'completion.jpg',label:'Order team completion photo'}]},
   {order_id:line.order_id,payload:{},photo_attachments:[{bucket:'photos',path:'order-note.jpg',label:'Certificate reference'}]}];
  d.bag_photos=[{bucket:'photos',path:'chain-front.jpg',label:'Chain front screenshot',order_ids:[line.order_id],order_line_ids:[line.id]}];
 });
 await page.locator('.pack-row').click();await noOverflow(page);
 const first=page.locator('.pack-line').first(),second=page.locator('.pack-line').nth(1);
 await expect(first.locator('.pack-reference')).toHaveCount(2);await expect(second).toContainText('No item screenshot saved');
 await expect(page.locator('#pack-completion-photos .pack-reference')).toHaveCount(1);await expect(page.getByRole('heading',{name:'Other order references'})).toBeVisible();
 await first.locator('.pack-photo-thumb').first().scrollIntoViewIfNeeded();await expect(first.locator('.pack-photo-thumb img')).toHaveCount(2);
 await page.screenshot({path:`test-results/packaging-photos-${width}.png`,fullPage:true});
 await first.locator('.pack-photo-thumb').first().click();const viewer=page.locator('#pack-photo-viewer');await expect(viewer).toBeVisible();await expect(page.locator('#pack-view-items')).toContainText('#049');await expect(page.locator('#pack-view-count')).toHaveText('1 / 2');
 await page.getByRole('button',{name:'Zoom in',exact:true}).click();await expect(page.locator('#pack-view-stage')).toHaveClass(/is-zoomed/);await page.getByRole('button',{name:'Fit photo'}).click();
 await page.getByRole('button',{name:'Next photo',exact:true}).click();await expect(page.locator('#pack-view-title')).toHaveText('Chain clasp screenshot');await expect(page.getByRole('button',{name:'Next photo',exact:true})).toBeDisabled();
 await page.screenshot({path:`test-results/packaging-viewer-${width}.png`});await page.keyboard.press('ArrowLeft');await expect(page.locator('#pack-view-count')).toHaveText('1 / 2');await page.keyboard.press('Escape');await expect(viewer).not.toBeVisible();
 await page.locator('#pack-completion-photos .pack-photo-thumb').click();await expect(page.locator('#pack-view-context')).toContainText('Order completion');await page.getByRole('button',{name:'Close photo viewer'}).click();
 assert.deepEqual(await page.evaluate(()=>fixtureWrites),[]);assert.equal(await page.locator('[data-media-source=false]').count(),0);
});
test('unidentified or contradictory screenshot metadata never gets guessed onto an item',async t=>{
 const page=await open(t);const result=await page.evaluate(()=>{
  const d=structuredClone(fixtureDetail),a=d.lines[0],b={...a,id:'line-b',item_number:'second'};d.lines.push(b);
  d.reference_events=[{order_id:a.order_id,task_line_ids:[a.id,b.id],photo_attachments:[{bucket:'photos',path:'one.jpg',metadata:{order_line_ids:[a.id],item_number:'second'}},{bucket:'photos',path:'two.jpg',metadata:{item_number:'unknown'}}]}];
  return OGPackagingMedia.index(d).map(p=>p.order_line_ids);
 });assert.deepEqual(result,[[],[]]);
});
test('unavailable media can retry without losing quantities or marking packaging complete',async t=>{
 const page=await open(t);
 await page.evaluate(()=>{fixtureDetail.order_events[0].photo_attachments[0].preview_path='reference-preview.jpg';});
 await start(page);await page.locator('[data-line]').fill('1');await expect(page.locator('.pack-photo-thumb img')).toBeVisible();
 await page.evaluate(()=>{const old=supabase.storage.from;let once=true;supabase.storage.from=bucket=>{const store=old(bucket);return {...store,createSignedUrl:async path=>{if(path==='reference.jpg'&&once){once=false;return {error:{message:'offline'}};}return store.createSignedUrl(path);}};};});
 await page.locator('.pack-photo-thumb').first().click();await expect(page.getByRole('button',{name:'Retry photo'})).toBeVisible();
 await page.getByRole('button',{name:'Retry photo'}).click();await expect(page.locator('#pack-view-stage img')).toBeVisible();
 await page.getByRole('button',{name:'Close photo viewer'}).click();await expect(page.locator('[data-line]')).toHaveValue('1');
 assert.equal(await page.evaluate(()=>fixtureWrites.filter(w=>w.action==='contents'||w.action==='pack').length),0);
});

test('the full-size viewer falls back to a saved preview when the original image format cannot display',async t=>{
 const page=await open(t);await page.evaluate(()=>{fixtureDetail.order_events[0].photo_attachments[0].preview_path='reference-preview.jpg';});
 await start(page);await expect(page.locator('.pack-photo-thumb img')).toBeVisible();
 await page.evaluate(()=>{const old=supabase.storage.from;supabase.storage.from=bucket=>{const store=old(bucket);return {...store,createSignedUrl:async path=>path==='reference.jpg'?{data:{signedUrl:'data:image/jpeg;base64,AA=='}}:store.createSignedUrl(path)};};});
 await page.locator('.pack-photo-thumb').click();await expect(page.locator('#pack-view-stage img')).toHaveAttribute('src',/^data:image\/svg/);
 await page.getByRole('button',{name:'Close photo viewer'}).click();assert.equal(await page.evaluate(()=>fixtureWrites.filter(w=>w.action!=='start').length),0);
});

for(const width of [320,390,1366])test(`Buyer package ${width}px: grouped order photos, full refresh and confirmed consolidation`,async t=>{
 const page=await open(t,width);
 await page.evaluate(()=>{
  const d=fixtureDetail,second='00000000-0000-4000-8000-000000000002';
  d.orders.push({...d.orders[0],id:second,order_number:'SECOND-ORDER',tracking_number:'9400100000000000000002'});
  d.lines.push({...d.lines[0],id:'00000000-0000-4000-8000-000000000012',order_id:second,item_title:'Bag 050 · Silver bracelet',item_number:'item-two',quantity:1,fulfilled_quantity:1});
  d.order_events.push({order_id:second,notes:'Second order note',photo_attachments:[{bucket:'photos',path:'second.jpg',label:'Bag 050 screenshot',media_type:'image'}]});
 });
 await page.getByRole('button',{name:'Refresh packaging'}).click();await expect(page.locator('#pack-list .pack-row')).toHaveCount(1);await expect(page.locator('#pack-total')).toHaveText('1 buyer');await expect(page.locator('#pack-list')).toContainText('2 orders · 3 items');
 await page.locator('#pack-list .pack-row').click();await expect(page).toHaveURL(/buyer_order=/);await expect(page.locator('.pack-line')).toHaveCount(2);await expect(page.locator('.pack-detail-head h2')).toHaveText('jewelrybuyer');await expect(page.locator('.pack-detail-head')).toContainText('2 orders · 3 items');
 await expect(page.locator('.pack-line').nth(1)).toContainText('Bag 050 screenshot');await expect(page.locator('.pack-order-list')).not.toHaveAttribute('open','');await noOverflow(page);
 await page.getByText('View order numbers & shipping labels',{exact:true}).click();await expect(page.locator('.pack-order-list')).toContainText('SECOND-ORDER');await expect(page.locator('.pack-order-list')).toContainText('9400100000000000000002');
 await page.screenshot({path:`test-results/packaging-buyer-${width}.png`,fullPage:true});
 await page.getByRole('button',{name:'Scan buyer’s shipping label'}).click();await page.locator('#pack-barcode').fill('9400100000000000000001');await page.locator('#pack-barcode').press('Enter');
 const dialog=page.getByRole('dialog',{name:'Check the label & orders'});await expect(dialog).toContainText('2 orders in this package');await expect(dialog).toContainText('SECOND-ORDER');await page.getByRole('button',{name:'Start packing',exact:true}).click();assert.equal((await page.evaluate(()=>fixtureWrites)).length,0);
 await page.locator('[name=confirm_buyer]').check();await page.getByRole('button',{name:'Start packing',exact:true}).click();await expect(dialog).not.toBeVisible();
 const req=await page.evaluate(()=>fixtureWrites.find(w=>w.action==='start'));assert.equal(req.args.order_ids.length,2);assert.equal(req.args.combine_buyer,true);assert.equal(req.args.confirm_buyer,true);await expect(page.locator('.pack-line')).toHaveCount(2);await noOverflow(page);
});
