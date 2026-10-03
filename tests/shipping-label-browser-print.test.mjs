import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {test,before,after} from 'node:test';
import {chromium,expect} from '@playwright/test';

const require=createRequire(import.meta.url);
const {PDFDocument,degrees,rgb}=require('../vendor/pdf-lib/pdf-lib.min.js');
const root=new URL('../',import.meta.url);
let server,browser,origin;
before(async()=>{
  server=createServer(async(req,res)=>{
    const name=new URL(req.url,'http://localhost').pathname.slice(1);
    if(!name)return res.setHeader('Content-Type','text/html').end('<!doctype html><title>Label print test</title><button id="print">Print</button>');
    if(!/^[\w./-]+$/.test(name)||name.includes('..'))return res.writeHead(404).end();
    try{res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':'text/html');res.end(await readFile(new URL(name,root)));}
    catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch();
});
after(async()=>{await browser?.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});});

async function fixture(sizes=[[288,432]],rotated=false){
  const doc=await PDFDocument.create();
  sizes.forEach(([width,height],i)=>{
    const page=doc.addPage([width,height]);
    page.drawText(`SHIPPING LABEL ${i+1}`,{x:20,y:height-35,size:12});
    for(let x=20;x<width-20;x+=4)page.drawRectangle({x,y:30,width:2,height:55,color:rgb(0,0,0)});
    if(rotated)page.setRotation(degrees(90));
  });
  return [...await doc.save()];
}
async function open(t,bytes){
  const context=await browser.newContext();t.after(()=>context.close());
  await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
  // Observe the native print entry point without sending paper to a real printer.
  await context.addInitScript(()=>{
    window.print=()=>{
      const root=window.top;
      root.printed.push({title:document.title,html:document.documentElement.outerHTML,
        pages:[...document.images].map(img=>({width:img.naturalWidth,height:img.naturalHeight,complete:img.complete,
          sheetWidth:img.parentElement.style.width,sheetHeight:img.parentElement.style.height})),
        css:[...document.querySelectorAll('style')].map(s=>s.textContent).join('\n')});
    };
  });
  const page=await context.newPage();page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
  await page.goto(origin);await page.addScriptTag({url:origin+'/shipping-label-print.js'});
  await page.evaluate(bytes=>{
    window.bytes=new Uint8Array(bytes);window.printed=[];window.alerts=[];window.signed=[];window.stationCalls=0;
    window.alert=message=>alerts.push(message);
    window.printStations={chooseDestination(){stationCalls++;throw Error('Unexpected station picker');},rpc(){stationCalls++;throw Error('Unexpected print job');}};
    window.supabase={storage:{from:bucket=>({createSignedUrl:async path=>{
      signed.push({bucket,path});
      if(window.signFailure)return {error:{message:'Could not sign label'}};
      return {data:{signedUrl:URL.createObjectURL(new Blob([window.bytes],{type:'application/pdf'}))}};
    }})}};
    document.getElementById('print').onclick=event=>shippingLabelPrint.runLocal(event.currentTarget,{path:'saved/first.pdf',title:'Label <one>'});
  },bytes);
  return page;
}

test('one click prints every page directly, at original dimensions with barcode-quality images',async t=>{
  const page=await open(t,await fixture([[288,432],[612,792]]));
  await page.locator('#print').click();await page.waitForFunction(()=>printed.length||alerts.length);
  const result=await page.evaluate(()=>({printed,alerts,stationCalls,signed}));
  assert.deepEqual(result.alerts,[]);assert.equal(result.printed.length,1);assert.equal(result.stationCalls,0);
  assert.deepEqual(result.signed,[{bucket:'ebay-labels',path:'saved/first.pdf'}]);
  assert.equal(result.printed[0].title,'Label <one>');
  assert.deepEqual(result.printed[0].pages,[
    {width:1200,height:1801,complete:true,sheetWidth:'288pt',sheetHeight:'432pt'},
    {width:2550,height:3301,complete:true,sheetWidth:'612pt',sheetHeight:'792pt'},
  ]);
  await expect(page.locator('#print')).toHaveText('Print');await expect(page.locator('#print')).toBeEnabled();
  assert.equal(await page.locator('dialog').count(),0);

  // Exercise Chromium's actual print compositor on the prepared document.
  const preview=await page.context().newPage();await preview.goto(origin);
  await preview.setContent(result.printed[0].html);
  await preview.evaluate(()=>Promise.all([...document.images].map(image=>image.decode())));
  const printedPdf=await PDFDocument.load(await preview.pdf({preferCSSPageSize:true,printBackground:true,displayHeaderFooter:false}));
  assert.equal(printedPdf.getPageCount(),2);
  const sizes=printedPdf.getPages().map(p=>p.getSize());
  assert.ok(Math.abs(sizes[0].width-288)<1&&Math.abs(sizes[0].height-432)<1);
  assert.ok(Math.abs(sizes[1].width-612)<1&&Math.abs(sizes[1].height-792)<1);
});

test('rotation is preserved, afterprint releases the frame, and a later click prints again',async t=>{
  const page=await open(t,await fixture([[288,432]],true));
  await page.locator('#print').click();await page.waitForFunction(()=>printed.length===1||alerts.length);
  assert.deepEqual(await page.evaluate(()=>alerts),[]);
  assert.deepEqual(await page.evaluate(()=>printed[0].pages.map(p=>[p.sheetWidth,p.sheetHeight])),[['432pt','288pt']]);
  await page.evaluate(()=>document.querySelector('iframe').contentWindow.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.locator('#print').click();await page.waitForFunction(()=>printed.length===2||alerts.length);
  assert.deepEqual(await page.evaluate(()=>alerts),[]);assert.equal(await page.locator('iframe').count(),1);
});

test('incomplete PDFs and failed downloads do not open print, and retry works without reloading',async t=>{
  const bytes=await fixture(),page=await open(t,bytes.slice(0,150));
  await page.locator('#print').click();await page.waitForFunction(()=>alerts.length===1);
  assert.match(await page.evaluate(()=>alerts[0]),/incomplete/);assert.equal(await page.evaluate(()=>printed.length),0);
  await expect(page.locator('#print')).toBeEnabled();
  await page.evaluate(bytes=>{window.bytes=new Uint8Array(bytes);window.signFailure=true;},bytes);
  await page.locator('#print').click();await page.waitForFunction(()=>alerts.length===2);
  assert.match(await page.evaluate(()=>alerts[1]),/sign label/);assert.equal(await page.evaluate(()=>printed.length),0);
  await page.evaluate(()=>window.signFailure=false);
  await page.locator('#print').click();await page.waitForFunction(()=>printed.length===1);
  assert.equal(await page.evaluate(()=>alerts.length),2);assert.equal(await page.evaluate(()=>stationCalls),0);
});
