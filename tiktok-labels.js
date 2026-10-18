/* TikTok-only label receipt: match pages in the browser, save once, then use the printer picker. */
(function(){
 'use strict';
 let config,panel,bytes,pageCount=0,received=false,saving=false,saved=false,printPath,loadReader;const previews=[];
 const id=new URLSearchParams(location.search).get('tiktokLabels');
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const status=message=>panel.querySelector('[data-label-status]').textContent=message;
 function mapping(orders,entries){
  const byNumber=new Map(orders.map(o=>[o.order_number,o])),result=new Map();
  for(const entry of entries){
   const ids=[...new Set(entry.orders.split(/[;,\s]+/).filter(Boolean))];if(!ids.length)throw Error(`Choose the order IDs for page ${entry.page}.`);
   const matches=ids.map(number=>byNumber.get(number));if(matches.some(o=>!o))throw Error(`Page ${entry.page} contains an order not imported in TikTok. Import it before saving.`);
   if(new Set(matches.map(o=>o.buyer_username.toLowerCase())).size!==1)throw Error(`Page ${entry.page} includes different buyers. A combined shipping label must belong to one buyer.`);
   for(const o of matches){if(!result.has(o.id))result.set(o.id,{order:o,pages:[],tracking:new Set()});const item=result.get(o.id);item.pages.push(entry.page);if(entry.tracking)item.tracking.add(entry.tracking);}
  }
  return [...result.values()];
 }
 async function reader(){
  if(window.pdfjsLib)return;
  loadReader ||= new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='pdf.min.js';script.onload=resolve;script.onerror=()=>{loadReader=null;reject(Error('Could not load the PDF reader. Refresh and try again.'));};document.head.append(script);});await loadReader;
 }
 async function textPages(value){
  await reader();window.pdfjsLib.GlobalWorkerOptions.workerSrc=new URL('pdf.worker.min.js',location.href).href;
  const task=window.pdfjsLib.getDocument({data:value.slice(),isEvalSupported:false});
  try{const doc=await task.promise,result=[];for(let page=1;page<=doc.numPages;page++){const p=await doc.getPage(page),content=await p.getTextContent();result.push(content.items.map(i=>i.str||'').join(' '));p.cleanup();}return result;}finally{await task.destroy();}
 }
 function build(){
  if(panel)return;panel=document.createElement('section');panel.className='tk-label-receiver';panel.id='tk-label-receiver';
  panel.innerHTML='<h2>TikTok shipping labels</h2><p>Check which order each label page covers. Combined labels may cover several orders from the same buyer.</p><p data-label-status role="status">Receiving the PDF…</p><div data-label-pages></div><label class="tk-confirm"><input data-label-confirm type="checkbox">I checked the recipient, items and order IDs for every label page.</label><div class="tk-actions"><button data-label-save type="button" disabled>Save labels to orders</button><button data-label-print type="button" disabled>Choose printer</button><button data-label-close type="button">Close</button></div>';
  document.getElementById('tk-status').after(panel);panel.querySelector('[data-label-save]').onclick=save;panel.querySelector('[data-label-print]').onclick=print;panel.querySelector('[data-label-close]').onclick=()=>{if(saving)return;panel.hidden=true;};
 }
 async function receive(value,suggested=[]){
  build();panel.hidden=false;saved=false;printPath=null;bytes=null;panel.querySelector('[data-label-save]').disabled=true;panel.querySelector('[data-label-save]').textContent='Save labels to orders';panel.querySelector('[data-label-print]').disabled=true;panel.querySelector('[data-label-print]').textContent='Choose printer';panel.querySelector('[data-label-confirm]').checked=false;panel.querySelector('[data-label-confirm]').disabled=false;
  for(const url of previews.splice(0))URL.revokeObjectURL(url);panel.querySelector('[data-label-pages]').replaceChildren();
  status('Reading and matching the label pages in this browser…');
  await window.shippingLabelPrint.assertComplete(value);const normalized=await fitA6Labels(value);bytes=normalized.value;
  const info=await window.shippingPdf.inspect(bytes);pageCount=info.count;const orders=config.getOrders(),known=new Map(orders.map(o=>[o.order_number,o]));
  const text=await textPages(bytes).catch(()=>Array(pageCount).fill(''));
  for(let i=0;i<pageCount;i++){
   const tokens=new Set(text[i].match(/\b\d{10,30}\b/g)||[]);let matched=orders.filter(o=>tokens.has(o.order_number)||o.lines.some(l=>(l.package_id&&tokens.has(l.package_id))||(l.tracking_number&&text[i].includes(l.tracking_number)))).map(o=>o.order_number);
   let suggestedOnly=false;if(!matched.length&&pageCount===1&&suggested.length&&suggested.every(n=>known.has(n))&&new Set(suggested.map(n=>known.get(n).buyer_username.toLowerCase())).size===1){matched=suggested;suggestedOnly=true;}
   const tracking=[...new Set((text[i].match(/\b1Z[A-Z0-9]{16}\b|\b9(?:[ -]?\d){19,21}\b/g)||[]).map(n=>n.replace(/[ -]/g,'')))];
   const row=document.createElement('section');row.className='tk-label-page';row.dataset.page=String(i+1);
   row.innerHTML=`<h3>Label page ${i+1}</h3><button type="button" data-preview-page>Preview this page</button><label>TikTok order IDs (separate with semicolons)<input data-page-orders value="${esc(matched.join(';'))}" spellcheck="false"></label><label>Tracking number (if visible)<input data-page-tracking value="${esc(tracking.length===1?tracking[0]:'')}" spellcheck="false"></label><p class="tk-help">${suggestedOnly?'Suggested from your label-creation request; verify the actual PDF before saving.':matched.length?'Matched from the PDF. Verify the recipient and order coverage.':'No exact match found. Read the PDF and enter the order ID(s) it covers.'}</p>`;
   row.querySelector('[data-preview-page]').onclick=async()=>{const tab=window.open('about:blank','_blank');if(!tab){status('Allow a new tab to preview the label page.');return;}tab.opener=null;try{const output=await window.shippingPdf.prepare(bytes,String(i+1)),url=URL.createObjectURL(new Blob([output.bytes],{type:'application/pdf'}));previews.push(url);tab.location.replace(url);}catch(e){tab.close();status(e.message);}};
   panel.querySelector('[data-label-pages]').append(row);
  }
  panel.querySelector('[data-label-save]').disabled=false;status(`${pageCount} label page(s) ready.${normalized.fitted?' A6 pages were fitted to 4 × 6 in this browser.':''} Review the pages, then save.`);panel.scrollIntoView({block:'start'});
 }
 async function upload(value){
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',value)),n=>n.toString(16).padStart(2,'0')).join(''),path=`tiktok-orders/${config.user.id}/${hash}.pdf`;
  const {error}=await config.db.storage.from('ebay-labels').upload(path,new Blob([value],{type:'application/pdf'}),{contentType:'application/pdf',cacheControl:'3600',upsert:false});
  if(error&&!['409','Duplicate'].includes(String(error.statusCode||error.code))&&!/already exists/i.test(error.message||''))throw error;return path;
 }
 async function save(){
  if(saving||saved||!bytes)return;saving=true;const button=panel.querySelector('[data-label-save]');button.disabled=true;
  try{
   if(!panel.querySelector('[data-label-confirm]').checked)throw Error('Confirm the recipient and order coverage before saving.');
   const entries=[...panel.querySelectorAll('.tk-label-page')].map(row=>({page:Number(row.dataset.page),orders:row.querySelector('[data-page-orders]').value.trim(),tracking:row.querySelector('[data-page-tracking]').value.trim()}));
   const targets=mapping(config.getOrders(),entries),files=new Map(),documents=[];
   for(const target of targets){const selection=target.pages.join(',');if(!files.has(selection)){const prepared=await window.shippingPdf.prepare(bytes,selection);files.set(selection,await upload(prepared.bytes));}documents.push({order_id:target.order.id,path:files.get(selection),filename:`TikTok-label-${target.order.order_number}.pdf`,tracking_number:[...target.tracking].join(', '),pages:target.pages});}
   const {error}=await config.db.rpc('attach_tiktok_label_batch',{_documents:documents});if(error)throw error;saved=true;
   panel.querySelectorAll('[data-page-orders],[data-page-tracking],[data-label-confirm]').forEach(el=>el.disabled=true);
   button.textContent='Labels saved';status(`Labels saved to ${targets.length} TikTok order(s). Each order has only its matching label pages. Choose your printer, then add completion photos.`);
   if(id)window.postMessage({type:'OG_TIKTOK_LABELS_DONE',transferId:id},location.origin);
   const all=Array.from({length:pageCount},(_,i)=>i+1).join(',');if(files.has(all))printPath=files.get(all);
   panel.querySelector('[data-label-print]').disabled=false;
   try{await config.refresh();}catch(e){status('Labels saved. Refresh the order list to see them. You can still choose your printer here.');}
  }catch(e){status(e.message||'Could not save these labels. Retry saving.');}finally{saving=false;button.disabled=saved;}
 }
 async function print(){
  if(saving||!saved||!bytes)return;saving=true;const button=panel.querySelector('[data-label-print]');button.disabled=true;
  try{if(!printPath){const all=await window.shippingPdf.prepare(bytes,'all');printPath=await upload(all.bytes);}const result=await window.shippingLabelPrint.printSaved({path:printPath,title:'TikTok shipping labels'});status(result.message||'Print dialog opened.');button.textContent='Print again';}
  catch(e){status(e.cancelled?'Printing cancelled. The labels remain saved on their orders.':e.message);}finally{saving=false;button.disabled=false;}
 }
 function start(value){
  config=value;const button=document.createElement('label');button.className='secondary-btn tk-label-file';button.textContent='Add shipping-label PDF';const input=document.createElement('input');input.type='file';input.accept='application/pdf,.pdf';input.hidden=true;button.append(input);document.getElementById('tk-label-batch').prepend(button);
  input.onchange=async()=>{if(saving||!input.files[0])return;const file=input.files[0];try{if(file.size>10*1024*1024)throw Error('Choose a PDF smaller than 10 MB.');await receive(new Uint8Array(await file.arrayBuffer()));}catch(e){build();status(e.message);}finally{input.value='';}};
  if(id){build();window.postMessage({type:'OG_TIKTOK_LABELS_READY'},location.origin);}
 }
 window.addEventListener('message',async e=>{
  if(e.source!==window||e.origin!==location.origin||!id)return;
  if(e.data?.type==='OG_TIKTOK_LABELS_BRIDGE_READY'&&config){window.postMessage({type:'OG_TIKTOK_LABELS_READY'},location.origin);return;}
  if(e.data?.type!=='OG_TIKTOK_LABELS_DATA'||!config||received)return;
  const p=e.data.payload;build();if(p?.error){status(p.error);return;}if(p?.transferId!==id)return;received=true;
  if(p.completed){status('These labels are already saved to their TikTok orders. Open Shipping labels on the buyer card to preview or print.');return;}
  try{if(typeof p.base64!=='string'||p.base64.length>13981016)throw Error('Choose a PDF smaller than 10 MB.');await receive(Uint8Array.from(atob(p.base64),c=>c.charCodeAt(0)),p.orderNumbers||[]);}catch(error){status(error.message);}
 });
  async function fitA6Labels(value) {
    let info;
    try { info = await window.shippingPdf.inspect(value); }
    catch (error) {
      // Protected documents still go through the shared permission-aware printer.
      if (error.code === 'PDF_ENCRYPTED') return {value, fitted: 0};
      throw error;
    }
    const pages = info.doc.getPages();
    const isA6 = page => {
      const sizes = [page.getMediaBox().width, page.getMediaBox().height].sort((a, b) => a - b);
      return Math.abs(sizes[0] - 297.64) <= 2 && Math.abs(sizes[1] - 419.53) <= 2;
    };
    if (!pages.some(isA6)) return {value, fitted: 0};
    const lib = window.PDFLib, output = await lib.PDFDocument.create();
    output.setCreationDate(new Date('2026-01-01T00:00:00Z'));
    output.setModificationDate(new Date('2026-01-01T00:00:00Z'));
    let fitted = 0;
    for (let index = 0; index < pages.length; index++) {
      const source = pages[index], media = source.getMediaBox(), crop = source.getCropBox();
      if (!isA6(source)) {
        // Mixed documents may contain existing 4x6 pages; never resize Letter/A4.
        await window.shippingPdf.prepare(value, String(index + 1));
        const [copy] = await output.copyPages(info.doc, [index]); output.addPage(copy);
        continue;
      }
      if (source.node.has(lib.PDFName.of('UserUnit')) || ['x', 'y', 'width', 'height'].some(key => Math.abs(media[key] - crop[key]) > 0.01)
        || ![0, 90, 180, 270].includes(source.getRotation().angle) || source.node.Annots()?.size()) {
        throw new Error(`TikTok page ${index + 1} has a custom crop or scale, rotation, or annotations. Export a standard 4x6 shipping label.`);
      }
      // TikTok can reuse an A6 label even after its format setting changes to 4x6.
      // Embed the full page as vector content, uniformly fit it, and center it.
      // The original media/crop bounds must agree so nothing hidden is discarded.
      const width = media.width > media.height ? 432 : 288, height = width === 432 ? 288 : 432;
      const scale = Math.min(width / media.width, height / media.height);
      const embedded = await output.embedPage(source, {left: media.x, bottom: media.y, right: media.x + media.width, top: media.y + media.height});
      const page = output.addPage([width, height]);
      page.drawPage(embedded, {x: (width - media.width * scale) / 2, y: (height - media.height * scale) / 2, width: media.width * scale, height: media.height * scale});
      page.setRotation(source.getRotation()); fitted++;
    }
    const result = await output.save({useObjectStreams: false});
    await window.shippingPdf.validate(result, info.count);
    return {value: result, fitted};
  }

 window.TikTokLabels={start,mapping};
})();
