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
  function destinationRows(d){return [
   ['ORDER SHIP-TO ADDRESS',8,1,gold,5],
   [`Order ${d.orderNumber}`,10,1,ink,6],
   [d.addressLines.length?[d.recipient,...d.addressLines].filter(Boolean).join('\n'):'Ship-to address not saved for this order.',10,0,ink,6],
   ...(d.addressLines.length?[[`${d.source} / Intended shipping destination`,8,0,muted,0]]:[])
  ];}
  const destinationHeight=d=>20+destinationRows(d).reduce((h,[s,size,font,,gap])=>h+wrap(s,504,size,font).length*size*1.45+gap,0);
  async function writeDestination(d){
   const rows=destinationRows(d),height=destinationHeight(d);
   if(height>570){for(const [s,size,font,fill,gap] of rows)await write(s,size,font,fill,gap);return;}
   await ensure(height+10);rect(page,40,y-height+8,532,height,color('eaf0e7'));rect(page,40,y-height+8,3,height,gold);y-=4;
   for(const [s,size,font,fill,gap] of rows){for(const line of wrap(s,504,size,font)){await text(page,line,54,y,size,font,fill);y-=size*1.45;}y-=gap;}
   y-=26;
  }
  async function url(label,value){if(!M.safe(value))return;await ensure(24);await text(page,label,40,y,9,1,color('235f64'));annot(page,[40,y-4,40+Math.min(532,width(label,9,1)),y+12],{A:{Type:'Action',S:'URI',URI:PDFString.of(value)}});y-=23;}
  async function jump(label,key,size=11){for(const line of wrap(label,532,size,1)){await ensure(size*1.5);await text(page,line,40,y,size,1);jumps.push({page,key,box:[40,y-4,40+Math.min(532,width(line,size,1)),y+size+2]});y-=size*1.5;}y-=8;}
  async function factGrid(facts){
   for(let n=0;n<facts.length;n+=2){const pair=facts.slice(n,n+2),blocks=pair.map(f=>[
    [f.label.toUpperCase(),8,1,muted,6],[f.value,13,1,f.tone==='against'?rose:ink,7],[f.note,8,0,muted,0]
   ]),height=Math.max(...blocks.map(rows=>24+rows.reduce((h,[s,size,font,,gap])=>h+wrap(s,232,size,font).length*size*1.35+gap,0)));
   await ensure(height+12);const top=y;
   for(const [col,rows] of blocks.entries()){const x=40+col*272;rect(page,x,top-height+8,260,height,color(pair[col].tone==='against'?'fae9ed':pair[col].tone==='delivered'?'e7f1e8':'edf0e9'));let yy=top-8;
    for(const [s,size,font,fill,gap] of rows){for(const line of wrap(s,232,size,font)){await text(page,line,x+14,yy,size,font,fill);yy-=size*1.35;}yy-=gap;}
   }y=top-height-4;
   }
  }
  async function sectionNav(i){await ensure(36);let x=40;for(const [label,key] of [['Order & tracking','purchase'],['Photos','photos'],['Timeline','timeline'],['Our position','position'],['Full records','records']]){const w=width(label,8,1);await text(page,label,x,y,8,1,color('235f64'));jumps.push({page,key:i.id+':'+key,box:[x,y-4,x+w,y+11]});x+=w+24;}y-=26;}
  async function caseBrief(i){const o=M.overview(i);
   await write('01 / CASE AT A GLANCE',10,1,gold,6);await write(`Issue: ${i.reason}`,10,0,ink,12);
   await factGrid(o.facts);
   for(const k of i.keyDates)await write(`${k.label}: ${k.value}`,9,1,ink,4);
   await write('Completion is an internal record, not a delivery scan.',7,0,muted,12);
   await write('LATEST SAVED BUYER MESSAGE',8,1,gold,5);
   await write(i.latestBuyer?M.excerpt(i.latestBuyer.message_body,260):'No buyer message is saved for these case / order references.',9,0,ink,5);
   if(i.latestBuyer)await write(`${M.date(i.latestBuyer.sent_at)} / ${i.latestBuyer.channel}. Full exchanges in the timeline.`,7,0,muted,10);
   await write('OUR SAVED POSITION',8,1,gold,5);await write(M.excerpt(i.review.position,220)||'Our position has not been written yet.',9,0,ink,5);
   await write(`Requested resolution: ${M.excerpt(i.review.requested_resolution,160)||'Not written yet'}`,8,0,muted,9);
   if(o.needs.length)await write('To verify or complete: '+o.needs.map(n=>n.label).join('; ')+'.',8,1,gold,9);
   for(const warning of i.warnings)await write(warning,8,0,rose,6);
   await sectionNav(i);
  }
  await newPage();dest.set('summary',page.ref);dest.set('index',page.ref);
  rect(page,40,587,532,141,ink);await text(page,'OG JEWELERS / THE REVIEW COLLECTION',58,704,9,1,color('e6c88f'));await text(page,'eBay case review',58,660,30,2,white);await text(page,'The facts, the evidence and our position.',58,624,11,0,white);y=557;
  await write(`${model.issues.length} marked issues / ${model.issues.filter(i=>i.against).length} decided against us / ${model.issues.filter(i=>!i.review.position.trim()).length} positions to write`,12,1,ink,12);
  await write('Start with each case overview, then follow the section links to the original purchase, photos, exchanges and complete source records.',10,0,muted,12);
  await write('Times are Eastern; pasted carrier history retains the carrier’s displayed times. Missing information is identified. Prepared for review; not submitted to eBay.',9,0,muted,12);
  await write(model.includeInternal?'Internal staff notes are included and labeled.':'Internal staff notes are excluded. Saved positions are included.',8,0,muted,18);
  await write('Every issue, at a glance',22,2,ink,16);
  for(const [n,i] of model.issues.entries()){await ensure(125);await jump(`${n+1}. ${i.name||i.buyer} / ${i.buyer}`,i.id,12);await write(`Order ${i.orderNumbers.join(', ')||'not linked'} / Cases ${i.statuses.map(s=>s.number).join(', ')}`,8,0,muted,4);await write(i.title,10,1,ink,5);await write(`${i.against?'Decision against us':i.statuses.at(-1)?.label||'Review case'} / Claim: ${i.statuses.map(s=>s.claim||'Not recorded').join(' / ')}`,9,1,i.against?rose:ink,5);await write(`${i.review.position.trim()?'Position saved':'Position needed'} / ${i.files.length} evidence files / ${i.messages} written or case entries`,8,0,muted,12);rule(page,y);y-=18;}
  for(const [n,i] of model.issues.entries()){
   progress(`Preparing PDF: issue ${n+1} of ${model.issues.length}…`);issue=i;await newPage();dest.set(i.id,page.ref);
   await write(i.name||i.buyer,24,2,ink,6);await write(`${i.buyer} / Order ${i.orderNumbers.join(', ')||'not linked'}`,9,1,muted,6);await write(i.title,12,1,ink,12);
   await caseBrief(i);
   await newPage();dest.set(i.id+':purchase',page.ref);
   await heading('02 / ORIGINAL PURCHASE & SHIPMENT');
   for(const item of i.items){await ensure(100);await write(item.title,12,1);await write(`${B.totalsFor([item])} / Quantity ${item.quantity}\nPurchased: ${item.purchased}\nOrder ${item.orderNumber} / Item ${item.item||'not recorded'}\nSystem state: ${item.state}`,10);await url('Open eBay order',item.orderUrl);await url(item.videoUrl?'Watch video receipt':'Find video receipt in eBay order',item.videoUrl||item.orderUrl);if(!item.videoUrl)await write('No direct video receipt URL is saved; use the order link to locate it.',8,0,muted);await writeDestination(item.destination);}
   if(!i.items.length)await write('No exact item lines are linked to this issue.',10,0,rose);
   for(const t of i.tracking){await ensure(110);await write(`${t.label} / ${t.carrier||'Carrier not recorded'} / ${t.code}`,11,1,ink,6);await write(`${t.status}${t.statusSource?' / '+t.statusSource+' / Checked '+M.date(t.statusAt):''}`,9,1,ink,6);await write(t.scopes.join('\n'),8,0,muted,8);await url('Open carrier tracking',t.url);await jump('Read complete saved tracking history',i.id+':records',9);}
   if(!i.tracking.length)await write('No tracking saved for this issue.',10,0,muted);
   await write('Delivery status is attributed to its source. A shipping label or internal completion alone does not establish delivery.',9,0,muted);
   await newPage();dest.set(i.id+':photos',page.ref);
   await heading('03 / VISUAL EVIDENCE');
   if(!i.files.length)await write('No photos saved for these exact order lines or their shipment.',10,0,muted);
   for(const [idx,f] of i.files.entries()){
    if(f.image){const caption=`${M.date(f.created_at)}${f.image.cropped?' / Item crop; original retained in Invsto.':''}`,addressHeight=f.shippingOrders?.length?destinationHeight(f.shippingOrders[0])+10:0,captionHeight=wrap(f.label,532,10,1).length*14.5+wrap(caption,532,8).length*11.6+58,photoHeight=Math.max(140,Math.min(310,600-captionHeight-addressHeight-24));await ensure(Math.min(610,photoHeight+24+captionHeight+addressHeight));await write(`Evidence ${idx+1} / ${niceGroup(f.group)}`,10,1,gold,6);const im=await pdf.embedJpg(f.image.crop);const fit=im.scale(Math.min(532/im.width,photoHeight/im.height));rect(page,40,y-photoHeight-8,532,photoHeight+8,white);page.drawImage(im,{x:40+(532-fit.width)/2,y:y-photoHeight+(photoHeight-fit.height)/2,width:fit.width,height:fit.height});y-=photoHeight+24;await write(f.label,10,1,ink,4);await write(caption,8,0,muted);}
    else{await ensure(70);await write(`Evidence ${idx+1} / ${niceGroup(f.group)} / ${f.label}`,10,1);await write(f.video?'Video evidence saved; open the system record to view.':f.error||'Preview unavailable; open the system record.',9,0,muted);}
    for(const d of f.shippingOrders||[])await writeDestination(d);
    await url('View original evidence in Invsto',i.historyUrl);
   }
   await newPage();dest.set(i.id+':timeline',page.ref);
   await heading('04 / TIMELINE & WRITTEN EXCHANGES');await write('Oldest to newest. Undated entries appear last. Source and author distinguish buyer messages, our replies, eBay activity and internal records.',9,0,muted);
   for(const e of i.timeline.filter(e=>model.includeInternal||!e.internal)){
    const label=`${e.date} / ${e.title}`,source=[e.actor,e.source].filter(Boolean).join(' / '),height=wrap(label,532,9,1).length*13.05+wrap(source,532,7.5).length*10.875+wrap(e.body,532,9.5).length*13.775+30;
    await ensure(Math.min(570,height));await write(label,9,1,e.internal?muted:gold,5);await write(source,7.5,0,muted,5);await write(e.body,9.5,0,ink,10);rule(page,y);y-=10;
   }
   await ensure(210);dest.set(i.id+':position',{page:page.ref,y:y+12});
   await heading('05 / OUR POSITION');await write(i.review.position||'Our position has not been written yet.',11);await write('Requested resolution',10,1,gold);await write(i.review.requested_resolution||'No requested resolution saved.',11);
   if(i.review.position_updated_at)await write(`Saved by ${i.review.position_by_name||i.review.updated_by_name||'Team member'} / ${M.date(i.review.position_updated_at)}`,8,0,muted);
   await newPage();dest.set(i.id+':records',page.ref);
   await heading('06 / FULL DECISION & TRACKING RECORDS');await url('Open the full issue record',i.historyUrl);
   for(const s of i.statuses){await ensure(110);await write(`${s.lane} ${s.number} / ${s.label}`,12,1,s.outcome==='against_us'?rose:ink);await write(`eBay status: ${s.status}\nOutcome reason: ${s.reason}\nRefund status: ${s.refund}${s.claim?'\nClaim amount: '+s.claim:''}\nOpened: ${s.opened}\nResponse deadline: ${s.deadline}\nLast successful sync: ${s.synced}`,10,0,ink,9);await url('Open eBay case / original order',s.url);for(const prior of s.previous||[]){await write(`Earlier stage: ${prior.lane} ${prior.number}. This is the original request for the case above, not a separate case. Its opening date and exchanges remain in the timeline.`,9,0,muted);await write(`Saved request state: ${prior.label} / ${prior.status}\nRefund status: ${prior.refund}\nOpened: ${prior.opened} / Last synced: ${prior.synced}`,8,0,muted);await url('Open original request',prior.url);}}
   for(const t of i.tracking){await heading(`${t.label} / ${t.carrier||'Carrier not recorded'} / ${t.code}`);await write(`${t.status}${t.statusSource?' / '+t.statusSource+' / Checked '+M.date(t.statusAt):''}`,11,1);await write(t.scopes.join('\n'),9,0,muted);await url('Open full carrier tracking history',t.url);await url('View this tracking in Order History',t.historyUrl);if(t.history){await write(`Carrier history saved by ${t.history.captured_by_name||'Team member'} / ${M.date(t.history.captured_at)}. Scan times below are shown as reported by the carrier.`,9,0,muted);await write(t.history.history_text,10);await url('Carrier history source',t.history.source_url);}else await write('The full carrier scan history is not saved in this packet. Open the carrier link to review it.',9,0,muted);for(const e of t.events){await write(`${M.date(e.at)} / ${e.title}\n${e.source}${e.body?' / '+e.body:''}`,9,0,muted);}}
   if(!i.tracking.length)await write('No tracking saved for this issue.',10,0,muted);

  }
  for(const [n,meta] of pages.entries()){const p=meta.page;rule(p,48);let x=40;for(const [label,key] of [['Case index','index'],...(meta.issue?[['Case overview',meta.issue],['Photos',meta.issue+':photos'],['Timeline',meta.issue+':timeline']]:[['Summary','summary']])]){await text(p,label,x,29,8,1);jumps.push({page:p,key,box:[x,23,x+width(label,8,1),41]});x+=110;}await text(p,`${n+1} / ${pages.length}`,532,29,8,0,muted);}
  for(const j of jumps)if(dest.has(j.key)){const target=dest.get(j.key);annot(j.page,j.box,{Dest:target.page?[target.page,PDFName.of('XYZ'),null,target.y,null]:[target,PDFName.of('Fit')]});}
  return pdf.save();
 }
 const niceGroup=g=>({item:'Item screenshots',completion:'Completion photos',packaging:'Packaging evidence',certificate:'Certificates',returned:'Returned-item evidence'})[g]||g;
 root.OGIssueReviewPdf={build};
})(globalThis);
