(function(root){
 'use strict';
 async function build(model,progress=()=>{}){
  const {PDFDocument,StandardFonts,rgb,PDFName,PDFString}=root.PDFLib,M=root.OGIssueReviewModel,B=root.OGBuyerReport;
  const pdf=await PDFDocument.create(),fonts=await Promise.all([StandardFonts.Helvetica,StandardFonts.HelveticaBold,StandardFonts.TimesRoman].map(f=>pdf.embedFont(f)));
  const color=h=>rgb(...h.match(/\w\w/g).map(v=>parseInt(v,16)/255)),ink=color('19372e'),muted=color('66766c'),gold=color('9b722c'),paper=color('f5f3ec'),rose=color('943d48'),white=rgb(1,1,1);
  const clean=s=>String(s??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/[\u2011\u2013\u2014]/g,'-');
  const pages=[],dest=new Map(),jumps=[];let page,y,issue=null;
  pdf.setTitle('eBay case review | Evidence and our position');pdf.setAuthor('OG Jewelers');
  function width(s,size=10,font=0){s=clean(s);try{return [...s].reduce((n,c)=>n+fonts[font].widthOfTextAtSize(c,size),0);}catch{const ctx=document.createElement('canvas').getContext('2d');ctx.font=`${font===1?'bold ':''}${size}px ${font===2?'Georgia':'Arial'}`;return ctx.measureText(s).width;}}
  function wrap(s,w=532,size=10,font=0){const lines=[];for(const p of clean(s).split(/\r?\n/)){let line='';for(const word of p.split(/\s+/).filter(Boolean)){if(line&&width(line+' '+word,size,font)>w){lines.push(line);line='';}if(width(word,size,font)>w){for(const c of word){if(line&&width(line+c,size,font)>w){lines.push(line);line='';}line+=c;}}else line=line?line+' '+word:word;}lines.push(line);}return lines;}
  async function text(p,s,x,yy,size=10,font=0,fill=ink){s=clean(s);if(!s)return;try{fonts[font].encodeText(s);p.drawText(s,{x,y:yy,size,font:fonts[font],color:fill});}catch{const c=document.createElement('canvas'),ctx=c.getContext('2d'),css=`${font===1?'bold ':''}${size*3}px ${font===2?'Georgia':'Arial'}`;ctx.font=css;c.width=Math.ceil(ctx.measureText(s).width)+8;c.height=Math.ceil(size*4.6);ctx.font=css;ctx.fillStyle=`rgb(${[fill.red,fill.green,fill.blue].map(n=>Math.round(n*255)).join(',')})`;ctx.textBaseline='alphabetic';ctx.fillText(s,0,size*3.4);const im=await pdf.embedPng(c.toDataURL('image/png'));p.drawImage(im,{x,y:yy-size*.35,width:c.width/3,height:c.height/3});}}
  function rect(p,x,yy,w,h,fill){p.drawRectangle({x,y:yy,width:w,height:h,color:fill});}
  function rule(p,yy){p.drawLine({start:{x:40,y:yy},end:{x:572,y:yy},thickness:.7,color:color('d4ddd2')});}
  function annot(p,box,action){const a=pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Link',Rect:box,Border:[0,0,0],...action}));const existing=p.node.lookup(PDFName.of('Annots'));if(existing)existing.push(a);else p.node.set(PDFName.of('Annots'),pdf.context.obj([a]));}
  async function newPage(){page=pdf.addPage([612,792]);rect(page,0,0,612,792,paper);rect(page,0,784,612,8,issue?.against?rose:gold);await text(page,'OG JEWELERS / EBAY CASE REVIEW',40,755,8,1,gold);await text(page,`Prepared ${M.date(model.generatedAt)}`,310,755,7,0,muted);rule(page,742);pages.push({page,issue:issue?.id});y=716;if(issue){for(const s of wrap(`${issue.buyer} / Cases ${issue.statuses.map(s=>s.number).join(', ')}`,532,9,1)){await text(page,s,40,y,9,1);y-=13;}y-=15;}return page;}
  async function ensure(h){if(y-h<74)await newPage();}
  async function write(s,size=10,font=0,fill=ink,gap=10){for(const line of wrap(s,532,size,font)){await ensure(size*1.45);await text(page,line,40,y,size,font,fill);y-=size*1.45;}y-=gap;}
  async function heading(label){await ensure(65);y-=8;await write(label,12,1,gold,14);}
  async function url(label,value){if(!M.safe(value))return;await ensure(24);await text(page,label,40,y,9,1,color('235f64'));annot(page,[40,y-4,40+Math.min(532,width(label,9,1)),y+12],{A:{Type:'Action',S:'URI',URI:PDFString.of(value)}});y-=23;}
  async function jump(label,key,size=11){for(const line of wrap(label,532,size,1)){await ensure(size*1.5);await text(page,line,40,y,size,1);jumps.push({page,key,box:[40,y-4,40+Math.min(532,width(line,size,1)),y+size+2]});y-=size*1.5;}y-=8;}
  await newPage();dest.set('summary',page.ref);rect(page,0,478,612,256,ink);await text(page,'THE EBAY REVIEW COLLECTION',40,695,10,1,color('e6c88f'));await text(page,'The evidence.',40,636,40,2,white);await text(page,'Our position.',40,586,40,2,color('e6c88f'));await text(page,'A case-by-case record prepared for review.',40,523,12,0,white);y=435;
  await write(`${model.issues.length} marked issues / ${model.issues.reduce((n,i)=>n+i.members,0)} linked case records`,18,1);await write(`${model.issues.filter(i=>i.against).length} issues decided against us / ${model.issues.filter(i=>!i.review.position.trim()).length} positions still to write`,11,0,muted,20);
  await write('This packet brings together saved case outcomes, original purchases, shipment evidence and written exchanges. Our position is the text saved by the team; the underlying records remain separately identified.',11,0,ink,16);
  await write('All displayed times are Eastern. Missing dates, images or receipt links are explicitly identified. Shipment labels and internal completions do not establish carrier delivery.',10,0,muted,16);
  await write(model.includeInternal?'This edition includes internal staff notes, clearly labeled.':'This edition excludes internal staff notes. Saved positions are included.',10,1,model.includeInternal?rose:ink);
  await write('Prepared for review. This report has not been submitted to eBay. External links may require sign-in.',10,0,muted);await jump('Open the case directory','index');
  await newPage();dest.set('index',page.ref);await write('Every issue, at a glance.',29,2,ink,22);
  for(const [n,i] of model.issues.entries()){await ensure(110);await jump(`${n+1}. ${i.name||i.buyer} / ${i.buyer}`,i.id,13);await write(`Order ${i.orderNumbers.join(', ')||'not linked'} / Cases ${i.statuses.map(s=>s.number).join(', ')}`,9,0,muted,4);await write(i.title,10,0,ink,5);await write(`${i.against?'Decision against us':i.statuses.at(-1)?.label||'Review case'} / ${i.review.position.trim()?'Position saved':'Position needed'} / ${i.files.length} evidence files`,9,1,i.against?rose:ink,12);rule(page,y);y-=18;}
  for(const [n,i] of model.issues.entries()){
   progress(`Preparing PDF: issue ${n+1} of ${model.issues.length}…`);issue=i;await newPage();dest.set(i.id,page.ref);
   await write(i.name||i.buyer,27,2);await write(`eBay username: ${i.buyer} / Order ${i.orderNumbers.join(', ')||'not linked'}`,10,1,muted);await write(i.title,15,1,ink,14);
   for(const warning of i.warnings)await write(warning,9,1,rose);
   await heading('OUR POSITION');await write(i.review.position||'Our position has not been written yet.',11);await write('Requested resolution',10,1,gold);await write(i.review.requested_resolution||'No requested resolution saved.',11);
   if(i.review.position_updated_at)await write(`Saved by ${i.review.position_by_name||i.review.updated_by_name||'Team member'} / ${M.date(i.review.position_updated_at)}`,8,0,muted);
   await heading('01 / CASE OUTCOMES');
   for(const s of i.statuses){await ensure(110);await write(`${s.lane} ${s.number} / ${s.label}`,12,1,s.outcome==='against_us'?rose:ink);await write(`eBay status: ${s.status}\nOutcome reason: ${s.reason}\nRefund status: ${s.refund}${s.claim?'\nClaim amount: '+s.claim:''}\nOpened: ${s.opened}\nResponse deadline: ${s.deadline}\nLast successful sync: ${s.synced}`,10,0,ink,9);await url('Open eBay case / original order',s.url);}
   await heading('02 / ORIGINAL PURCHASE & SHIPMENT');
   for(const item of i.items){await ensure(100);await write(item.title,12,1);await write(`${B.totalsFor([item])} / Quantity ${item.quantity}\nPurchased: ${item.purchased}\nOrder ${item.orderNumber} / Item ${item.item||'not recorded'}\nSystem state: ${item.state}`,10);await url('Open eBay order',item.orderUrl);await url(item.videoUrl?'Watch video receipt':'Find video receipt in eBay order',item.videoUrl||item.orderUrl);if(!item.videoUrl)await write('No direct video receipt URL is saved; use the order link to locate it.',8,0,muted);}
   if(!i.items.length)await write('No exact item lines are linked to this issue.',10,0,rose);
   for(const t of i.tracking){await write(`${t.label}: ${t.code}\n${t.status}`,10);await url('Look up tracking',`https://www.17track.net/en/track?nums=${encodeURIComponent(t.code)}`);}
   if(!i.tracking.length)await write('No tracking saved for this issue.',10,0,muted);
   await write('A saved label or tracking number does not establish delivery. Completion and packaging evidence may include other items in the same shipment.',9,0,muted);
   if(i.files.some(f=>f.image))await ensure(440);
   await heading('03 / VISUAL EVIDENCE');
   if(!i.files.length)await write('No photos saved for these exact order lines or their shipment.',10,0,muted);
   for(const [idx,f] of i.files.entries()){
    if(f.image){await ensure(390);await write(`Evidence ${idx+1} / ${niceGroup(f.group)}`,10,1,gold,6);const im=await pdf.embedJpg(f.image.crop);const fit=im.scale(Math.min(532/im.width,310/im.height));rect(page,40,y-318,532,318,white);page.drawImage(im,{x:40+(532-fit.width)/2,y:y-310+(310-fit.height)/2,width:fit.width,height:fit.height});y-=334;await write(f.label,10,1,ink,4);await write(`${M.date(f.created_at)}${f.image.cropped?' / Item crop; original retained in Invsto.':''}`,8,0,muted);}
    else{await ensure(70);await write(`Evidence ${idx+1} / ${niceGroup(f.group)} / ${f.label}`,10,1);await write(f.video?'Video evidence saved; open the system record to view.':f.error||'Preview unavailable; open the system record.',9,0,muted);}
    await url('View original evidence in Invsto',i.historyUrl);
   }
   await heading('04 / TIMELINE & WRITTEN EXCHANGES');await write('Oldest to newest. Undated entries appear last. Source and author distinguish buyer messages, our replies, eBay activity and internal records.',9,0,muted);
   for(const e of i.timeline.filter(e=>model.includeInternal||!e.internal)){await ensure(70);await write(e.date,9,1,gold,4);await write(e.title,11,1,e.internal?muted:ink,4);await write([e.actor,e.source].filter(Boolean).join(' / '),8,0,muted,7);await write(e.body,10,0,ink,16);rule(page,y);y-=18;}
   await url('Open the full issue record',i.historyUrl);
  }
  for(const [n,meta] of pages.entries()){const p=meta.page;rule(p,48);let x=40;for(const [label,key] of [['Case index','index'],...(meta.issue?[['This issue',meta.issue]]:[]),['Summary','summary']]){await text(p,label,x,29,8,1);jumps.push({page:p,key,box:[x,23,x+width(label,8,1),41]});x+=110;}await text(p,`${n+1} / ${pages.length}`,532,29,8,0,muted);}
  for(const j of jumps)if(dest.has(j.key))annot(j.page,j.box,{Dest:[dest.get(j.key),PDFName.of('Fit')]});
  return pdf.save();
 }
 const niceGroup=g=>({item:'Item screenshots',completion:'Completion photos',packaging:'Packaging evidence',certificate:'Certificates',returned:'Returned-item evidence'})[g]||g;
 root.OGIssueReviewPdf={build};
})(globalThis);
