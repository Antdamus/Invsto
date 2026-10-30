import assert from 'node:assert/strict';
import {test, before, after} from 'node:test';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium,webkit} from '@playwright/test';
import PDFLib from '../vendor/pdf-lib/pdf-lib.min.js';

const root=new URL('../',import.meta.url),output=new URL('../tmp/pdfs/missing-gallery/',import.meta.url);
let server,browser,browserServer,origin;
before(async()=>{
  server=createServer(async(req,res)=>{
    const name=new URL(req.url,'http://localhost').pathname.slice(1);
    if(!/^[\w./-]+$/.test(name)||name.includes('..'))return res.writeHead(404).end();
    try{
      let content=await readFile(new URL(name,root));
      if(name.endsWith('.html'))content=content.toString().replace(/<script\b[\s\S]*?<\/script>/gi,'').replace('data-page="ebay-missing-report"','');
      res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(content);
    }catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  const engine=process.env.INVSTO_REPORT_BROWSER==='webkit'?webkit:chromium;
  browserServer=await engine.launchServer({headless:true});browser=await engine.connect(browserServer.wsEndpoint());await mkdir(output,{recursive:true});
});
after(async()=>{
  const timer=setTimeout(()=>browserServer?.kill().catch(()=>{}),5000);
  try{await browser?.close();await browserServer?.close();}finally{clearTimeout(timer);}
  await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
});

async function open(t){
  const page=await browser.newPage({viewport:{width:1440,height:1000}});t.after(()=>page.close());
  await page.route('**/*',r=>r.request().url().startsWith(origin)||r.request().url().startsWith(`blob:${origin}`)||r.request().url().startsWith('data:')?r.continue():r.abort());
  const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
  await page.goto(origin+'/ebay-missing-report.html');
  for(const file of ['vendor/pdf-lib/pdf-lib.min.js','buyer-report-refunds.js','ebay-buyer-report.js','ebay-missing-report.js','ebay-missing-report-pdf.js'])await page.addScriptTag({url:origin+'/'+file});
  await page.evaluate(()=>{
    const photos=Array.from({length:9},(_,i)=>({path:`video-receipts/view-${i}.png`,created_at:`2026-10-29T${String(20-i).padStart(2,'0')}:00:00Z`,
      metadata:{selectedItemId:'123456789012',videoRect:{x:20,y:20,width:i%2?400:200,height:i%2?200:400,devicePixelRatio:1},reviewNote:i===4?'Inspect clasp <carefully>':''}}));
    window.fixture={photos,downloads:[]};
    fixture.client={storage:{from(){return {async download(path){
      fixture.downloads.push(path);if(path.includes('unavailable'))return {error:{message:'Fixture storage failure'}};
      const i=Number(path.match(/view-(\d+)/)[1]),canvas=document.createElement('canvas');canvas.width=440;canvas.height=440;
      const ctx=canvas.getContext('2d');ctx.fillStyle='#eeeeee';ctx.fillRect(0,0,440,440);
      ctx.fillStyle=['#5e8178','#c1a15e','#8b6a87'][i%3];ctx.fillRect(20,20,i%2?400:200,i%2?200:400);
      ctx.strokeStyle='white';ctx.lineWidth=8;ctx.beginPath();ctx.ellipse(i%2?220:120,i%2?120:220,70,80,0,0,Math.PI*2);ctx.stroke();
      ctx.fillStyle='white';ctx.font='20px Arial';ctx.fillText(`ITEM VIEW ${i+1}`,35,55);
      return {data:await new Promise(resolve=>canvas.toBlob(resolve,'image/png'))};
    }}}}};
    fixture.make=async(count,{failFirst=false,defaultLoad=false}={})=>{
      fixture.downloads=[];
      const selected=photos.slice(0,count);
      if(failFirst)selected.unshift({path:'video-receipts/unavailable.png',created_at:'2026-10-30T00:00:00Z',metadata:{selectedItemId:'123456789012'}});
      const records={orders:[{id:'order-a',order_number:'12-34567-89012',buyer_username:'gallery_buyer',buyer_name:'Gallery Test Customer',sale_date:'2026-10-20T18:00:00Z',ship_by_date:'2026-10-29T06:59:59Z',total_price:200}],
        lines:[{id:'line-a',order_id:'order-a',line_status:'pending',item_number:'123456789012',item_title:'Sterling Silver Bracelet — Multiple Views',quantity:1,sold_for:100},
          {id:'line-b',order_id:'order-a',line_status:'pending',item_number:'999999999999',item_title:'Sibling item excluded',quantity:1,sold_for:100}],
        events:[{order_line_ids:['line-a','line-b'],photo_attachments:[...selected,...selected,{path:'video-receipts/sibling.png',metadata:{selectedItemId:'999999999999'}}]}],adminEvents:[],returnCases:[]};
      const c=OGMissingReport.makeCustomer('gallery_buyer',records,[{...records.lines[0],buyer_name:'Gallery Test Customer',item_search:{is_missing:true,updated_at:'2026-10-28T18:00:00Z',updated_by_email:'worker@example.test'}}],location.href,new Date('2026-10-30T14:00:00Z'));
      await OGBuyerReport.loadImages(fixture.client,c.rows,()=>{},{allImages:!defaultLoad});
      fixture.model=OGMissingReport.makeReport([c],'all','2026-10-30T14:00:00Z');
      document.querySelector('#report').innerHTML=OGMissingReport.render(fixture.model);document.querySelector('#progress').hidden=true;
      return {downloads:fixture.downloads,shots:OGMissingReport.screenshots(c.rows[0]).map(s=>({loaded:!!s.image,cropped:s.image?.cropped,review:s.review})),status:c.rows[0].imageStatus};
    };
  });
  return page;
}

test('all matching screenshots load once, failures stay visible, crops and phone layout are preserved',async t=>{
  const page=await open(t),result=await page.evaluate(()=>fixture.make(9,{failFirst:true}));
  assert.equal(result.downloads.length,10);assert.equal(new Set(result.downloads).size,10);assert.ok(!result.downloads.some(s=>s.includes('sibling')));
  assert.equal(result.shots.length,10);assert.equal(result.shots[0].loaded,false);assert.ok(result.shots.slice(1).every(s=>s.loaded&&s.cropped));
  assert.equal(result.status,'9 of 10 saved screenshots loaded');
  assert.equal(await page.locator('.evidence-shot').count(),10);assert.equal(await page.locator('.evidence-shot img').count(),9);
  assert.equal(await page.locator('.evidence-review').innerText(),'Inspect clasp <carefully>');
  assert.match(await page.locator('.evidence-unavailable').innerText(),/Refresh the report/);
  const dimensions=await page.locator('.evidence-shot img').evaluateAll(imgs=>Promise.all(imgs.map(async img=>{img.loading='eager';await img.decode();return [img.naturalWidth,img.naturalHeight];})));
  assert.deepEqual(dimensions[0],[200,400]);assert.deepEqual(dimensions[1],[400,200]);
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:1000});await page.locator('.evidence-gallery').scrollIntoViewIfNeeded();
    const boxes=await page.locator('.evidence-grid .evidence-shot').evaluateAll(nodes=>nodes.map(n=>({left:n.getBoundingClientRect().left,right:n.getBoundingClientRect().right,width:n.getBoundingClientRect().width})));
    assert.ok(boxes.every(b=>b.left>=0&&b.right<=width));
    if(width===390)assert.ok(boxes.every(b=>b.width>300));
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:new URL(`gallery-${width}.png`,output).pathname.replace(/^\/([A-Z]:)/,'$1')});
  }
});

test('legacy buyer loading still stops at the first usable screenshot',async t=>{
  const page=await open(t),result=await page.evaluate(()=>fixture.make(9,{failFirst:true,defaultLoad:true}));
  assert.equal(result.downloads.length,2);assert.equal(result.shots.length,1);assert.equal(result.shots[0].loaded,true);
});

test('zero, one, two and many screenshots export every view; gallery pages keep navigation and order links',async t=>{
  const page=await open(t);
  for(const count of [0,1,2,5,9]){
    await page.evaluate(count=>fixture.make(count),count);
    assert.equal(await page.locator('.evidence-shot img').count(),count);
    const bytes=Uint8Array.from(await page.evaluate(async()=>Array.from(await OGMissingReportPdf.build(fixture.model))));
    const pdf=await PDFLib.PDFDocument.load(bytes),pages=pdf.getPages(),name=PDFLib.PDFName.of;
    let images=0,itemPages=0;
    for(const p of pages){
      const xObjects=p.node.Resources()?.lookup(name('XObject'));
      if(xObjects)images+=xObjects.entries().filter(([,ref])=>pdf.context.lookup(ref).dict.get(name('Subtype'))?.toString()==='/Image').length;
      const links=(p.node.lookup(name('Annots'))?.asArray()||[]).map(ref=>pdf.context.lookup(ref));
      assert.ok(links.some(a=>a.lookup(name('Dest'))?.asArray()[0].toString()===pages[1].ref.toString()));
      if(links.some(a=>a.lookup(name('A'))?.lookup(name('URI'))?.decodeText().includes('/mesh/ord/details'))){
        itemPages++;assert.ok(links.some(a=>a.lookup(name('Dest'))?.asArray()[0].toString()===pages[2].ref.toString()));
        assert.ok(links.some(a=>a.lookup(name('A'))?.lookup(name('URI'))?.decodeText().includes('pending-orders')));
      }
    }
    assert.equal(images,count,`PDF must contain exactly ${count} item images`);if(count===9)assert.ok(itemPages>=3);
    if(count===9)await writeFile(new URL('gallery.pdf',output),bytes);
  }
});
