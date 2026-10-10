/* Shared shipping PDF validation. Only selected 4 x 6 inch thermal label pages are queued. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./vendor/pdf-lib/pdf-lib.min.js'));
  else {
    const base=new URL('.',document.currentScript.src);
    let loading;
    root.shippingPdf=factory(root.PDFLib,()=>{
      if(root.PDFLib)return Promise.resolve(root.PDFLib);
      return loading ||= new Promise((resolve,reject)=>{
        const script=document.createElement('script');
        const fail=()=>{clearTimeout(timer);script.remove();loading=null;reject(new Error('PDF tools could not load. Try again.'));};
        const timer=setTimeout(fail,20000);
        script.src=new URL('vendor/pdf-lib/pdf-lib.min.js',base).href;
        script.onload=()=>{if(!root.PDFLib){fail();return;}clearTimeout(timer);resolve(root.PDFLib);};
        script.onerror=fail;document.head.append(script);
      });
    });
  }
})(typeof globalThis==='object'?globalThis:this,function(PDFLib,loadPDFLib){
  'use strict';
  const MAX_BYTES=10*1024*1024, MAX_PAGES=100;
  function parsePages(value,count){
    if(!Number.isInteger(count)||count<1||count>MAX_PAGES)throw new Error('Choose a PDF with 1–100 pages.');
    const text=String(value||'').trim();
    if(/^all$/i.test(text))return Array.from({length:count},(_,i)=>i+1);
    if(!text)throw new Error('Choose the page numbers to print, or enter all.');
    const pages=new Set();
    for(const part of text.split(',')){
      const match=/^\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?\s*$/.exec(part);
      if(!match)throw new Error('Use page numbers such as 1, 3-5, or all.');
      const from=Number(match[1]),to=Number(match[2]||match[1]);
      if(from<1||to<from||to>count)throw new Error(`Page numbers must be between 1 and ${count}.`);
      for(let page=from;page<=to;page++)pages.add(page);
    }
    return [...pages].sort((a,b)=>a-b);
  }
  async function inspect(bytes,{geometryOnly=false}={}){
    if(!bytes?.byteLength||bytes.byteLength>MAX_BYTES)throw new Error('Shipping PDFs must be smaller than 10 MB.');
    if(!PDFLib)PDFLib=await loadPDFLib();
    let doc;
    // Geometry-only access never copies encrypted content into a print job.
    try {doc=await PDFLib.PDFDocument.load(bytes,{updateMetadata:false,ignoreEncryption:geometryOnly});}
    catch(cause) {
      const error=new Error('This PDF cannot be read. Open Label to inspect it or attach a fresh eBay shipping PDF.');
      // The bundled ES5 build returns Error instances rather than its subclass.
      if(cause instanceof PDFLib.EncryptedPDFError||cause?.message===new PDFLib.EncryptedPDFError().message)error.code='PDF_ENCRYPTED';
      throw error;
    }
    const count=doc.getPageCount();
    if(count<1||count>MAX_PAGES)throw new Error('Choose a PDF with 1–100 pages.');
    return {doc,count};
  }
  function validatePage(page,number){
    // Validate MediaBox as well as CropBox so a hidden letter-size sheet cannot be shrunk.
    for(const box of [page.getMediaBox(),page.getCropBox()]){
      const sizes=[Math.abs(box.width),Math.abs(box.height)].sort((a,b)=>a-b);
      if(Math.abs(sizes[0]-288)>8||Math.abs(sizes[1]-432)>8)
        throw new Error(`Page ${number} is not a 4 × 6 shipping label. Download the 4 × 6 thermal layout from eBay and attach that PDF. Letter/A4 sheets are not resized automatically.`);
    }
    if(page.node.has(PDFLib.PDFName.of('UserUnit')))throw new Error('This PDF uses a custom page scale. Export a standard 4 × 6 label.');
  }
  async function prepare(bytes,selection){
    const {doc,count}=await inspect(bytes),pages=parsePages(selection,count);
    const output=await PDFLib.PDFDocument.create();
    // Fixed metadata keeps retries byte-identical for the same document/page selection.
    output.setCreationDate(new Date('2026-01-01T00:00:00Z'));output.setModificationDate(new Date('2026-01-01T00:00:00Z'));
    for(const number of pages)validatePage(doc.getPage(number-1),number);
    const copied=await output.copyPages(doc,pages.map(n=>n-1));copied.forEach(page=>output.addPage(page));
    const result=await output.save({useObjectStreams:false});
    if(result.byteLength>MAX_BYTES)throw new Error('Selected pages exceed the 10 MB print limit.');
    return {bytes:result,pages,pageCount:pages.length,totalPages:count};
  }
  async function prepareRendered(bytes,selection,renderPage){
    const {doc,count}=await inspect(bytes,{geometryOnly:true}),pages=parsePages(selection,count);
    // Check the original sheet, including its MediaBox, before rasterizing anything.
    for(const number of pages)validatePage(doc.getPage(number-1),number);
    const output=await PDFLib.PDFDocument.create();
    output.setCreationDate(new Date('2026-01-01T00:00:00Z'));output.setModificationDate(new Date('2026-01-01T00:00:00Z'));
    let imageBytes=0;
    for(const number of pages){
      const rendered=await renderPage(number,count);
      const sizes=[rendered.width,rendered.height].sort((a,b)=>a-b);
      if(!sizes.every(Number.isFinite)||Math.abs(sizes[0]-288)>8||Math.abs(sizes[1]-432)>8)throw new Error('The rendered label dimensions do not match a 4 × 6 shipping label.');
      imageBytes+=rendered.png.byteLength;
      if(imageBytes>MAX_BYTES)throw new Error('Selected pages exceed the 10 MB print limit. Print fewer pages at a time.');
      const image=await output.embedPng(rendered.png),page=output.addPage([rendered.width,rendered.height]);
      page.drawImage(image,{x:0,y:0,width:rendered.width,height:rendered.height});
    }
    const result=await output.save({useObjectStreams:false});
    if(result.byteLength>MAX_BYTES)throw new Error('Selected pages exceed the 10 MB print limit.');
    return {bytes:result,pages,pageCount:pages.length,totalPages:count};
  }
  async function validate(bytes,expectedPages){
    const {doc,count}=await inspect(bytes);
    if(count!==expectedPages)throw new Error('The shipping PDF page count does not match the print request.');
    doc.getPages().forEach((page,i)=>validatePage(page,i+1));
    return count;
  }
  return {MAX_BYTES,MAX_PAGES,parsePages,inspect,prepare,prepareRendered,validate};
});
