/* Saved label printing: local browser dialog or paired shipping printer. */
(function(){
  'use strict';
  let busy=false;
  const base=new URL('.',document.currentScript.src);
  const MAX_BYTES=10*1024*1024;
  let rendererPromise, localBusy=false, releaseLocalPrint;
  const hex=buffer=>Array.from(new Uint8Array(buffer),n=>n.toString(16).padStart(2,'0')).join('');
  async function assertComplete(blobOrBytes){
    const bytes=blobOrBytes instanceof Uint8Array?blobOrBytes:new Uint8Array(await blobOrBytes.arrayBuffer());
    const head=new TextDecoder('latin1').decode(bytes.subarray(0,1024));
    const tail=new TextDecoder('latin1').decode(bytes.subarray(Math.max(0,bytes.length-4096)));
    if(!head.includes('%PDF-')||!tail.includes('%%EOF'))throw new Error('This saved PDF is incomplete. Download the full shipping label from eBay and use Replace Label / Send Label to OG to attach it again. No print request was sent.');
  }
  async function printSaved({bucket='ebay-labels',path,title='Shipping label'}){
    if(busy)throw new Error('Finish the open shipping print request first.');
    if(bucket!=='ebay-labels'||!path)throw new Error('Attach an eBay shipping PDF before printing.');
    busy=true;
    try {
      const {data,error}=await window.supabase.storage.from(bucket).createSignedUrl(path,120);
      if(error||!data?.signedUrl)throw new Error(error?.message||'Could not open the saved shipping PDF.');
      const response=await fetch(data.signedUrl,{cache:'no-store',signal:AbortSignal.timeout(30000)});
      if(!response.ok)throw new Error('Could not download the saved shipping PDF. Try again.');
      if(Number(response.headers.get('content-length'))>window.shippingPdf.MAX_BYTES)throw new Error('Shipping PDFs must be smaller than 10 MB.');
      const bytes=new Uint8Array(await response.arrayBuffer());
      await assertComplete(bytes);
      let info;try{info=await window.shippingPdf.inspect(bytes);}catch{throw new Error('This saved PDF cannot be read. Open Label to check it, then replace it with a fresh, unencrypted eBay shipping PDF. No print request was sent.');}
      const destination=await window.printStations.chooseDestination({documentType:'pdf',pageCount:info.count});
      const prepared=await window.shippingPdf.prepare(bytes,destination.pages.join(','));
      let binary='';for(let offset=0;offset<prepared.bytes.length;offset+=32768)binary+=String.fromCharCode(...prepared.bytes.subarray(offset,offset+32768));
      const pdfBase64=btoa(binary), hash=hex(await crypto.subtle.digest('SHA-256',prepared.bytes));
      const key='invsto.print.shipping.pending.'+hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${path}\n${hash}\n${destination.pages.join(',')}\n${destination.copies}`)));
      let pending=JSON.parse(localStorage.getItem(key)||'null');
      if(pending&&pending.stationId!==destination.stationId)throw new Error('An earlier send needs confirmation. Choose its original shipping printer to confirm it before changing destinations. Check Print stations for the job.');
      if(!pending){pending={requestId:crypto.randomUUID(),stationId:destination.stationId};localStorage.setItem(key,JSON.stringify(pending));}
      let job;
      try {job=await window.printStations.rpc('enqueue_shipping_label_print',{_station_id:destination.stationId,_request_id:pending.requestId,_pdf_base64:pdfBase64,_copies:destination.copies,_source_path:path,_source_pages:destination.pages,_title:title});}
      catch(error){if(/^(P0001|22023|42501|23514|23503)$/.test(error.code||''))localStorage.removeItem(key);throw error;}
      localStorage.removeItem(key);
      return {jobId:job.id,message:`Queued ${prepared.pageCount*destination.copies} shipping label(s) for ${destination.name}. View Print stations for status.`};
    } finally {busy=false;}
  }
  async function run(button,options){
    if(button?.disabled)return;
    const original=button?.textContent;if(button){button.disabled=true;button.textContent='Preparing PDF…';}
    try {const result=await printSaved(options);window.alert(result.message);}
    catch(error){if(!error.cancelled)window.alert(error.message||'Could not send the shipping label.');}
    finally {if(button){button.disabled=false;button.textContent=original;}}
  }

  function loadRenderer(){
    if(window.pdfjsLib?.getDocument)return Promise.resolve(window.pdfjsLib);
    if(!rendererPromise)rendererPromise=new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      const fail=()=>{clearTimeout(timer);script.remove();rendererPromise=null;reject(new Error('Could not load PDF printing tools. Try Print again.'));};
      const timer=setTimeout(fail,20000);
      script.src=new URL('pdf.min.js',base).href;
      script.onload=()=>{if(!window.pdfjsLib?.getDocument){fail();return;}clearTimeout(timer);resolve(window.pdfjsLib);};
      script.onerror=fail;
      document.head.append(script);
    });
    return rendererPromise;
  }

  async function downloadForLocalPrint(bucket,path){
    if(bucket!=='ebay-labels'||!path)throw new Error('Attach a shipping PDF before printing.');
    const {data,error}=await window.supabase.storage.from(bucket).createSignedUrl(path,120);
    if(error||!data?.signedUrl)throw new Error(error?.message||'Could not open the saved shipping PDF.');
    const response=await fetch(data.signedUrl,{cache:'no-store',signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error('Could not download the saved shipping PDF. Try Print again.');
    if(Number(response.headers.get('content-length'))>MAX_BYTES)throw new Error('Shipping PDFs must be smaller than 10 MB.');
    const bytes=new Uint8Array(await response.arrayBuffer());
    if(bytes.length>MAX_BYTES)throw new Error('Shipping PDFs must be smaller than 10 MB.');
    await assertComplete(bytes);
    return bytes;
  }

  async function printLocal({bucket='ebay-labels',path,title='Shipping label'}){
    if(localBusy)throw new Error('A shipping label is already being prepared for printing.');
    localBusy=true;
    // Keep the last frame alive until the dialog closes (or the next print starts).
    releaseLocalPrint?.();
    let frame,task;
    const urls=[];
    const cleanup=()=>{frame?.remove();urls.forEach(url=>URL.revokeObjectURL(url));if(releaseLocalPrint===cleanup)releaseLocalPrint=null;};
    try{
      const [bytes,renderer]=await Promise.all([downloadForLocalPrint(bucket,path),loadRenderer()]);
      renderer.GlobalWorkerOptions.workerSrc=new URL('pdf.worker.min.js',base).href;
      task=renderer.getDocument({data:bytes,isEvalSupported:false});
      let passwordRejected;
      const passwordFailure=new Promise((_,reject)=>{passwordRejected=reject;});
      task.onPassword=()=>passwordRejected(new Error('This PDF is password protected. Attach an unencrypted label before printing.'));
      const pdf=await Promise.race([task.promise,passwordFailure]);
      if(!pdf.numPages||pdf.numPages>100)throw new Error('Choose a PDF with 1–100 pages.');
      frame=document.createElement('iframe');
      frame.title='Shipping label print document';frame.setAttribute('aria-hidden','true');frame.tabIndex=-1;
      frame.style.cssText='position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
      const loaded=new Promise(resolve=>{frame.onload=resolve;});
      frame.src='about:blank';document.body.append(frame);await loaded;
      const doc=frame.contentDocument;
      doc.open();doc.write('<!doctype html><html><head><style>html,body{margin:0;padding:0}section{break-after:page;overflow:hidden}section:last-child{break-after:auto}img{display:block;width:100%;height:100%}@page{margin:0}</style></head><body></body></html>');doc.close();
      doc.title=String(title);
      const style=doc.createElement('style');doc.head.append(style);
      for(let number=1;number<=pdf.numPages;number++){
        const page=await pdf.getPage(number),size=page.getViewport({scale:1});
        if(!Number.isFinite(size.width)||!Number.isFinite(size.height)||size.width<=0||size.height<=0)throw new Error('This PDF has an invalid page size. Open PDF to inspect it.');
        // Render at 300 DPI for barcode detail, with bounded memory for oversized sheets.
        const scale=Math.min(300/72,Math.sqrt(20000000/(size.width*size.height)));
        const viewport=page.getViewport({scale}),canvas=document.createElement('canvas');
        canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
        try{
          await page.render({canvasContext:canvas.getContext('2d'),viewport,intent:'print',background:'rgb(255,255,255)'}).promise;
          const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
          if(!blob)throw new Error('Could not prepare this label for printing. Try Print again.');
          const url=URL.createObjectURL(blob);urls.push(url);
          const sheet=doc.createElement('section'),image=doc.createElement('img');
          style.textContent+=`@page label${number}{size:${size.width}pt ${size.height}pt;margin:0}`;
          sheet.style.cssText=`page:label${number};width:${size.width}pt;height:${size.height}pt`;
          image.alt=`Shipping label page ${number}`;image.src=url;
          sheet.append(image);doc.body.append(sheet);await image.decode();
        }finally{canvas.width=canvas.height=0;page.cleanup();}
      }
      await task.destroy();task=null;
      releaseLocalPrint=cleanup;
      frame.contentWindow.addEventListener('afterprint',()=>setTimeout(cleanup,1000),{once:true});
      // Printing a same-origin document avoids PDF viewer load races and blocked pop-ups.
      frame.contentWindow.focus();frame.contentWindow.print();
    }catch(error){cleanup();throw error;}
    finally{if(task)await task.destroy().catch(()=>{});localBusy=false;}
  }

  async function runLocal(button,options){
    if(button?.disabled)return;
    const original=button?.textContent;
    if(button){button.disabled=true;button.textContent='Preparing PDF…';}
    try{await printLocal(options);}
    catch(error){window.alert(error.message||'Could not print the shipping label. Try Open PDF.');}
    finally{if(button){button.disabled=false;button.textContent=original;}}
  }
  window.shippingLabelPrint={printSaved,run,assertComplete,printLocal,runLocal};
})();
