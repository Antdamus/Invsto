/* Shared shipping PDF validation. Only selected 4 x 6 inch thermal label pages are queued. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./vendor/pdf-lib/pdf-lib.min.js'));
  else root.shippingPdf=factory(root.PDFLib);
})(typeof globalThis==='object'?globalThis:this,function(PDFLib){
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
  async function inspect(bytes){
    if(!bytes?.byteLength||bytes.byteLength>MAX_BYTES)throw new Error('Shipping PDFs must be smaller than 10 MB.');
    if(!PDFLib)throw new Error('PDF tools did not load. Refresh this page and try again.');
    let doc;
    try {doc=await PDFLib.PDFDocument.load(bytes,{updateMetadata:false});}
    catch {throw new Error('This PDF cannot be read. Use an unencrypted eBay shipping-label PDF.');}
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
  async function validate(bytes,expectedPages){
    const {doc,count}=await inspect(bytes);
    if(count!==expectedPages)throw new Error('The shipping PDF page count does not match the print request.');
    doc.getPages().forEach((page,i)=>validatePage(page,i+1));
    return count;
  }
  return {MAX_BYTES,MAX_PAGES,parsePages,inspect,prepare,validate};
});
