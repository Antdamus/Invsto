import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test,before,after} from 'node:test';
import {chromium,webkit,expect} from '@playwright/test';
const root=new URL('../',import.meta.url);let server,browser,origin;
before(async()=>{
 server=createServer(async(req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1);if(!/^[\w.-]+$/.test(name))return res.writeHead(404).end();
  try{let content=await readFile(new URL(name,root));if(name.endsWith('.html'))content=content.toString().replace(/<script\b[\s\S]*?<\/script>/gi,'');res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(content);}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
 browser=await(process.env.INVSTO_ITEM_BROWSER==='webkit'?webkit:chromium).launch();await mkdir(new URL('../test-results/',import.meta.url),{recursive:true});
});
after(async()=>{await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});});
async function open(t,width=390,pageName='pending-orders.html'){
 const context=await browser.newContext({viewport:{width,height:900},isMobile:width<700,hasTouch:width<700});t.after(()=>context.close());
 await context.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
 const page=await context.newPage();page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
 await page.goto(origin+'/'+pageName);
 await page.evaluate(()=>{
  document.body.innerHTML='<main><button class="certificate-trigger" data-certificate-line="00000000-0000-4000-8000-000000000010" data-certificate-title="#049 · Cartier Panthère · Order 24-15248-22137">CGL certificate</button><button class="certificate-trigger" data-certificate-line="00000000-0000-4000-8000-000000000011" data-certificate-title="#050 · Another watch">CGL certificate</button></main>';
  window.certRecords=[];window.certWrites=[];window.certUploads=[];window.certImports=[];window.failSave=false;window.failImport=false;window.failLoad=false;
  window.supabase={auth:{getUser:async()=>({data:{user:{id:'worker'}}})},
   from(table){if(table!=='ebay_order_line_certificates')throw Error('Unexpected table '+table);const predicates=[];let start=0,end=500;
    const q={select:()=>q,eq:(key,value)=>{predicates.push(r=>r[key]===value);return q;},in:(key,values)=>{predicates.push(r=>values.includes(r[key]));return q;},is:(key,value)=>{predicates.push(r=>(r[key]??null)===value);return q;},order:()=>q,range:(a,b)=>{start=a;end=b;return q;},
     then:resolve=>resolve(failLoad?{error:{message:'Offline'}}:{data:certRecords.filter(r=>predicates.every(p=>p(r))).slice(start,end+1)})};return q;},
   rpc:async(name,args)=>{if(name==='is_admin')return {data:false};certWrites.push({name,args});
    if(failSave)return {error:{message:'Connection interrupted'}};
    if(name==='save_order_line_certificate'){let r=certRecords.find(r=>r.id===args._id);if(!r){r={id:args._id,order_line_id:args._line_id,certificate_url:args._url,report_number:args._report_number,watch_serial:args._watch_serial,attachments:args._attachments,created_by:'worker',created_by_email:'worker@example.test',created_at:'2026-10-09T18:00:00Z'};certRecords.push(r);}return {data:r};}
    if(name==='void_order_line_certificate'){const r=certRecords.find(r=>r.id===args._id);r.voided_at='2026-10-09T19:00:00Z';r.void_reason=args._reason;return {data:r};}throw Error('Unexpected write '+name);},
   storage:{from(bucket){return {upload:async(path,bytes,options)=>{certUploads.push({bucket,path,size:bytes.length,options});return {};},createSignedUrl:async()=>({data:{signedUrl:'https://storage.example/copy.pdf'}})};}},
   functions:{invoke:async(name,{body})=>{certImports.push({name,body});if(failImport)return {error:{context:{json:async()=>({error:'This page does not provide one downloadable certificate. Add its PDF or a clear photo.'})}}};
    const r={id:body.id,order_line_id:body.line_id,certificate_url:body.url,created_at:'2026-10-09T18:00:00Z',created_by:'worker',attachments:[{bucket:'order-evidence-photos',path:'copy.pdf',mime_type:'application/pdf'}]};certRecords.push(r);return {data:{certificate:r}};}}
  };
 });
 await page.addScriptTag({url:origin+'/order-certificates.js'});
 await page.locator('[data-certificate-line]').first().click();await expect(page.locator('#certificate-saved')).toContainText('No certificate saved');return page;
}
for(const width of [320,390,1440])test(`${width}px: QR import saves the PDF and link for the selected watch`,async t=>{
 const page=await open(t,width);await page.locator('#certificate-qr').fill('http://www.cgl-labs.com/27-qr7732');
 await expect(page.getByRole('button',{name:'Scan QR',exact:true})).toHaveAttribute('data-scan-mode','certificate');
 await expect(page.locator('#certificate-preview-link')).toHaveAttribute('href','https://www.cgl-labs.com/27-qr7732');
 const box=await page.locator('#order-certificate-dialog').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width&&box.height<=900);
 await page.locator('#certificate-save').click();await expect(page.locator('#certificate-status')).toContainText('Certificate copy saved');
 await expect(page.locator('#certificate-saved')).toContainText('Copy saved');await expect(page.locator('#certificate-saved a')).toHaveAttribute('href','https://www.cgl-labs.com/27-qr7732');
 const calls=await page.evaluate(()=>certImports);assert.equal(calls.length,1);assert.equal(calls[0].body.line_id,'00000000-0000-4000-8000-000000000010');
 assert.deepEqual(await page.evaluate(()=>certWrites),[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:`test-results/certificate-saved-${width}.png`});
 await page.locator('#certificate-close').click();await expect(page.locator('[data-certificate-line]').first()).toContainText('· 1');
 await page.locator('[data-certificate-line]').last().click();await expect(page.locator('#certificate-saved')).toContainText('No certificate saved');
});
test('PDF upload preserves identifiers and retries the same record without touching orders',async t=>{
 const page=await open(t);await page.locator('#certificate-qr').fill('http://www.cgl-labs.com/27-qr7732');
 await page.locator('.certificate-identifiers summary').click();await page.locator('#certificate-report').fill('2778747053007732');await page.locator('#certificate-serial').fill('4016195325EY');
 await page.locator('#certificate-files').setInputFiles({name:'certificate.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\ncertificate')});
 await expect(page.locator('#certificate-file-list')).toContainText('certificate.pdf');await page.evaluate(()=>{failSave=true;});
 await page.locator('#certificate-save').click();await expect(page.locator('#certificate-status')).toContainText('Connection interrupted');await expect(page.locator('#certificate-report')).toHaveValue('2778747053007732');
 await page.evaluate(()=>{failSave=false;});await page.locator('#certificate-save').click();await expect(page.locator('#certificate-status')).toContainText('Certificate copy saved');
 const writes=await page.evaluate(()=>certWrites);assert.equal(writes.length,2);assert.equal(writes[0].args._id,writes[1].args._id);assert.equal(writes[0].name,'save_order_line_certificate');
 assert.equal(writes[1].args._watch_serial,'4016195325EY');assert.ok(writes[1].args._attachments[0].path.startsWith('certificates/'+writes[1].args._line_id+'/'+writes[1].args._id+'/'));
 assert.equal((await page.evaluate(()=>certRecords)).length,1);
 await page.locator('.certificate-correction summary').click();await page.getByRole('textbox',{name:'Correction reason'}).fill('Wrong watch');await page.getByRole('button',{name:'Mark incorrect',exact:true}).click();
 await expect(page.locator('#certificate-saved')).toContainText('Marked incorrect');await expect(page.locator('#certificate-saved')).toContainText('Open saved copy');
});
test('download failures preserve the QR and request an actual copy; unsafe links and fake files cannot save',async t=>{
 const page=await open(t);await page.locator('#certificate-qr').fill('javascript:alert(1)');await page.locator('#certificate-save').click();await expect(page.locator('#certificate-status')).toContainText('normal certificate website');
 await page.locator('#certificate-files').setInputFiles({name:'fake.pdf',mimeType:'application/pdf',buffer:Buffer.from('<html>Not a certificate</html>')});await expect(page.locator('#certificate-status')).toContainText('Use a PDF');
 await page.locator('#certificate-qr').fill('https://www.cgl-labs.com/27-qr7732');await page.evaluate(()=>{failImport=true;});await page.locator('#certificate-save').click();
 await expect(page.locator('#certificate-status')).toContainText('Add its PDF');await expect(page.locator('#certificate-qr')).toHaveValue('https://www.cgl-labs.com/27-qr7732');
 assert.equal((await page.evaluate(()=>certRecords)).length,0);assert.deepEqual(await page.evaluate(()=>certWrites),[]);
});
test('all three fulfillment/history pages load the shared certificate action',async()=>{
 for(const page of ['pending-orders','packaging','ebay-order-history']){
  const html=await readFile(new URL('../'+page+'.html',import.meta.url),'utf8'),js=await readFile(new URL('../'+page+'.js',import.meta.url),'utf8');
  assert.match(html,/order-certificates\.js/);assert.match(html,/order-certificates\.css/);assert.match(js,/data-certificate-line=/);
 }
});

test('the shared camera scanner opens above the certificate panel and closes without losing the watch',async t=>{
 const page=await open(t);
 await page.addStyleTag({url:origin+'/barcode-scanner.css'});
 await page.addScriptTag({url:origin+'/barcode-scanner.js'});
 await page.getByRole('button',{name:'Scan QR',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'Scan a certificate QR',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Close scanner',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'CGL certificates',exact:true})).toBeVisible();
 await expect(page.locator('#certificate-context')).toContainText('24-15248-22137');
 assert.deepEqual(await page.evaluate(()=>certWrites),[]);
});

test('failed loading blocks new saves and file reading cannot race a submit or another watch',async t=>{
 const page=await open(t);
 await page.locator('#certificate-close').click();await page.evaluate(()=>{failLoad=true;});
 await page.locator('[data-certificate-line]').first().click();await expect(page.locator('#certificate-status')).toContainText('Close and reopen');
 await expect(page.locator('#certificate-save')).toBeDisabled();
 await page.locator('#certificate-close').click();await page.evaluate(()=>{failLoad=false;});await page.locator('[data-certificate-line]').first().click();
 await expect(page.locator('#certificate-save')).toBeEnabled();
 await page.evaluate(()=>{const read=File.prototype.arrayBuffer;File.prototype.arrayBuffer=function(){return new Promise(resolve=>{window.finishFile=async()=>resolve(await read.call(this));});};});
 await page.locator('#certificate-files').setInputFiles({name:'slow.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\ncopy')});
 await expect(page.locator('#certificate-save')).toBeDisabled();
 await page.locator('#certificate-close').click();await page.locator('[data-certificate-line]').last().click();
 await page.evaluate(()=>finishFile());await expect(page.locator('#certificate-context')).toContainText('Another watch');
 await expect(page.locator('#certificate-file-list')).toBeEmpty();assert.deepEqual(await page.evaluate(()=>certWrites),[]);
});
