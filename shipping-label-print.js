/* Print saved eBay PDFs through the paired shipping printer, with persistent request IDs. */
(function(){
  'use strict';
  let busy=false;
  const hex=buffer=>Array.from(new Uint8Array(buffer),n=>n.toString(16).padStart(2,'0')).join('');
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
      const bytes=new Uint8Array(await response.arrayBuffer()), info=await window.shippingPdf.inspect(bytes);
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
  window.shippingLabelPrint={printSaved,run};
})();
