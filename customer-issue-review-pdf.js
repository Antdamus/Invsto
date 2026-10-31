(function(root){
 'use strict';
 // Rearrange saved scans without summarizing or dropping any of their text.
 function carrierRows(value){
  return String(value||'').trim().split(/\r?\n\s*\r?\n/).filter(Boolean).map(block=>{
   const lines=block.split(/\r?\n/).map(s=>s.trim()).filter(Boolean),dates=lines.filter(s=>/^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,?\s+)?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+\d{1,2},?\s+\d{4}\b|^\d{4}-\d{2}-\d{2}\b/i.test(s));
   return dates.length===1?{date:dates[0],body:lines.filter(s=>s!==dates[0]).join('\n')}:{date:'',body:lines.join('\n')};
  });
 }
 function timelineRows(issue,includeInternal){
  const rows=[],openings=new Map();
  for(const e of issue.timeline.filter(e=>(includeInternal||!e.internal)&&e.title!=='Evidence saved')){
   const caseNumber=/^Case ([\w-]+)/.exec(e.body)?.[1];
   if(/^(Case|Inquiry) opened$/.test(e.title)&&caseNumber&&e.at){
    const key=JSON.stringify([e.at,caseNumber]),prior=openings.get(key);
    if(prior){if(/UNKNOWN/.test(prior.body)&&!/UNKNOWN/.test(e.body))prior.body=e.body;else if(!/UNKNOWN/.test(e.body)&&prior.body!==e.body)prior.body+=' / '+e.body;continue;}
    const event={...e,title:'Issue opened'};openings.set(key,event);rows.push(event);
   }else rows.push(e);
  }
  for(const t of issue.tracking){
   const observations=t.events.filter(e=>e.title.startsWith('eBay tracking status: ')),redundant=new Set();
   for(let n=0;n<observations.length;n++)if(observations[n+1]?.title===observations[n].title)redundant.add(observations[n]);
   if(observations.at(-1)?.title.toLowerCase()===`ebay tracking status: ${t.status}`.toLowerCase())redundant.add(observations.at(-1));
   for(const e of t.events){
    // The current observed status and its sync time are already beside tracking.
    if(redundant.has(e))continue;
    rows.push({...e,date:root.OGIssueReviewModel.date(e.at),body:[t.code,e.body].filter(Boolean).join(' · '),actor:'',internal:false});
   }
  }
  return rows.sort((a,b)=>(Date.parse(a.at)||Infinity)-(Date.parse(b.at)||Infinity));
 }
 async function build(model,progress=()=>{}){
  const {PDFDocument,StandardFonts,rgb,PDFName,PDFString}=root.PDFLib,M=root.OGIssueReviewModel,B=root.OGBuyerReport;
  const pdf=await PDFDocument.create(),fonts=await Promise.all([StandardFonts.Helvetica,StandardFonts.HelveticaBold,StandardFonts.TimesRoman].map(f=>pdf.embedFont(f)));
  const color=h=>rgb(...h.match(/\w\w/g).map(v=>parseInt(v,16)/255)),ink=color('19372e'),muted=color('66766c'),gold=color('9b722c'),paper=color('f5f3ec'),rose=color('943d48'),white=rgb(1,1,1),linkColor=color('235f64');
  const clean=s=>String(s??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/[\u2011\u2013\u2014]/g,'-');
  const pages=[],dest=new Map(),jumps=[];let page,y,issue=null,section='Case directory';
  pdf.setTitle('eBay case review | Facts, evidence and exchanges');pdf.setAuthor('OG Jewelers');
  function width(s,size=10,font=0){s=clean(s);try{return [...s].reduce((n,c)=>n+fonts[font].widthOfTextAtSize(c,size),0);}catch{const ctx=document.createElement('canvas').getContext('2d');ctx.font=`${font===1?'bold ':''}${size}px ${font===2?'Georgia':'Arial'}`;return ctx.measureText(s).width;}}
  function wrap(s,w=532,size=10,font=0){const lines=[];for(const p of clean(s).split(/\r?\n/)){let line='';for(const word of p.split(/\s+/).filter(Boolean)){if(line&&width(line+' '+word,size,font)>w){lines.push(line);line='';}if(width(word,size,font)>w){for(const c of word){if(line&&width(line+c,size,font)>w){lines.push(line);line='';}line+=c;}}else line=line?line+' '+word:word;}lines.push(line);}return lines;}
  async function text(p,s,x,yy,size=10,font=0,fill=ink){s=clean(s);if(!s)return;try{fonts[font].encodeText(s);p.drawText(s,{x,y:yy,size,font:fonts[font],color:fill});}catch{const c=document.createElement('canvas'),ctx=c.getContext('2d'),css=`${font===1?'bold ':''}${size*3}px ${font===2?'Georgia':'Arial'}`;ctx.font=css;c.width=Math.ceil(ctx.measureText(s).width)+8;c.height=Math.ceil(size*4.6);ctx.font=css;ctx.fillStyle=`rgb(${[fill.red,fill.green,fill.blue].map(n=>Math.round(n*255)).join(',')})`;ctx.textBaseline='alphabetic';ctx.fillText(s,0,size*3.4);const im=await pdf.embedPng(c.toDataURL('image/png'));p.drawImage(im,{x,y:yy-size*.35,width:c.width/3,height:c.height/3});}}
  function rect(x,yy,w,h,fill){page.drawRectangle({x,y:yy,width:w,height:h,color:fill});}
  function rule(p,yy){p.drawLine({start:{x:40,y:yy},end:{x:572,y:yy},thickness:.6,color:color('d4ddd2')});}
  function annot(p,box,action){const a=pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Link',Rect:box,Border:[0,0,0],...action})),existing=p.node.lookup(PDFName.of('Annots'));if(existing)existing.push(a);else p.node.set(PDFName.of('Annots'),pdf.context.obj([a]));}
  function anchor(key){dest.set(key,{page:page.ref,y:y+12});}
  async function newPage(){page=pdf.addPage([612,792]);rect(0,0,612,792,paper);rect(0,784,612,8,issue?.against?rose:gold);await text(page,'OG JEWELERS / EBAY CASE REVIEW',40,755,8,1,gold);await text(page,`Prepared ${M.date(model.generatedAt)}`,310,755,7,0,muted);rule(page,742);pages.push({page,issue:issue?.id});y=718;
   if(issue){for(const line of wrap(`${issue.buyer} / Case ${issue.statuses.map(s=>s.number).join(', ')}`,532,9,1)){await text(page,line,40,y,9,1);y-=12;}}
   await text(page,section.toUpperCase(),40,y,7,1,gold);y-=25;
  }
  async function ensure(h){if(y-h<74)await newPage();}
  async function write(s,size=10,font=0,fill=ink,gap=8){for(const line of wrap(s,532,size,font)){await ensure(size*1.35);await text(page,line,40,y,size,font,fill);y-=size*1.35;}y-=gap;}
  async function heading(label){await ensure(45);await write(label,15,2,ink,12);}
  async function links(rows){let x=40;await ensure(20);for(const r of rows.filter(r=>r.key||M.safe(r.url))){for(const line of wrap(r.label,532,8,1)){const w=width(line,8,1);if(x+w>572){y-=20;x=40;await ensure(20);}await text(page,line,x,y,8,1,linkColor);const box=[x,y-4,x+w,y+11];if(r.key)jumps.push({page,key:r.key,box});else annot(page,box,{A:{Type:'Action',S:'URI',URI:PDFString.of(r.url)}});x+=w+22;}}y-=22;}
  async function factGrid(i){const facts=M.overview(i).facts.map((f,n)=>({...f,note:n===1?'Claim amount; item prices are in the evidence section.':n===2?'Saved refund state':f.note}));
   for(let n=0;n<facts.length;n+=2){const pair=facts.slice(n,n+2),blocks=pair.map(f=>[[f.label.toUpperCase(),7,1,muted,5],[f.value,12,1,f.tone==='against'?rose:ink,5],[f.note,7,0,muted,0]]),height=Math.max(...blocks.map(rows=>21+rows.reduce((h,[s,size,font,,gap])=>h+wrap(s,236,size,font).length*size*1.3+gap,0)));
    await ensure(height+10);const top=y;for(const [col,rows] of blocks.entries()){const x=40+col*272;rect(x,top-height+8,260,height,color(pair[col].tone==='against'?'fae9ed':pair[col].tone==='delivered'?'e7f1e8':'edf0e9'));let yy=top-7;for(const [s,size,font,fill,gap] of rows){for(const line of wrap(s,236,size,font)){await text(page,line,x+12,yy,size,font,fill);yy-=size*1.3;}yy-=gap;}}y=top-height-4;
   }
  }
  async function milestones(i){
   for(const k of i.keyDates){const value=wrap(k.value,390,9,1),source=wrap(k.source,390,7),h=Math.max(15,value.length*12+source.length*9+8);await ensure(h);await text(page,k.label,40,y,9,1,k.tone==='against'?rose:gold);let yy=y;for(const line of value){await text(page,line,182,yy,9,1,k.tone==='against'?rose:ink);yy-=12;}for(const line of source){await text(page,line,182,yy,7,0,muted);yy-=9;}y-=h;}
   y-=5;
  }
  async function overview(i){
   await write(i.name||i.buyer,25,2,ink,5);await write(`Order ${i.orderNumbers.join(', ')||'not linked'} / ${i.title}`,10,1,ink,8);await write(`Issue: ${i.reason}`,9,0,muted,12);
   await factGrid(i);await milestones(i);
   // The decision's unique details belong here, rather than in a repeated appendix.
   for(const s of i.statuses){await ensure(45);await write(`${i.statuses.length>1?`${s.lane} ${s.number} / ${s.label} / Claim ${s.claim||'not recorded'} / Refund ${s.refund}\n`:''}eBay: ${s.status} / Reason: ${s.reason}${s.deadline==='No current deadline recorded'?'':' / Response due: '+s.deadline}`,8,0,muted,3);await write(`Last synced: ${s.synced}`,7,0,muted,6);
    await links([{label:`Open eBay ${s.lane.toLowerCase()} ${s.number}`,url:s.url},...s.previous.map(p=>({label:`Original ${p.lane.toLowerCase()} ${p.number}`,url:p.url}))]);
    for(const p of s.previous)await write(`Earlier stage: ${p.lane} ${p.number} / ${p.label}. Linked to the case above.`,7,0,muted,5);
   }
   await ensure(65);anchor(i.id+':position');await write('OUR POSITION & REQUESTED RESOLUTION',8,1,gold,5);
   await write(i.review.position||'Our position has not been written yet.',9,0,ink,6);await write(`Requested resolution: ${i.review.requested_resolution||'Not written yet.'}`,9,0,ink,7);
   if(i.review.position_updated_at)await write(`Saved by ${i.review.position_by_name||i.review.updated_by_name||'Team member'} / ${M.date(i.review.position_updated_at)}`,7,0,muted,7);
   const needs=M.overview(i).needs.filter(n=>n.section!=='position');if(needs.length)await write('To verify: '+needs.map(n=>n.label).join('; ')+'.',8,1,gold,6);
   for(const warning of i.warnings)await write(warning,7,0,rose,4);
   await write('Times are Eastern unless marked carrier local time. '+(model.includeInternal?'Internal staff notes included.':'Internal staff notes excluded.'),7,0,muted,0);
  }
  const addressRows=d=>[
   ['ORDER SHIP-TO ADDRESS',7,1,gold],
   [`Order ${d.orderNumber}`,8,1,ink],
   [d.addressLines.length?[d.recipient,...d.addressLines].filter(Boolean).join('\n'):'Ship-to address not saved.',8.5,0,ink],
   ...(d.addressLines.length?[[`${d.source} / Intended destination`,7,0,muted]]:[])
  ];
  async function address(d){const rows=addressRows(d),h=rows.reduce((h,[s,size,font])=>h+wrap(s,508,size,font).length*size*1.25+5,12);await ensure(Math.min(h+8,580));if(h<580)rect(40,y-h+6,532,h,color('eaf0e7'));for(const [s,size,font,fill] of rows){for(const line of wrap(s,508,size,font)){await ensure(size*1.3);await text(page,line,52,y,size,font,fill);y-=size*1.25;}y-=5;}y-=12;}
  async function photoCard(f,number,x,top){let yy=top;const height=photoHeight(f);rect(x,top-height+8,260,height,white);await text(page,`EVIDENCE ${number} / ${niceGroup(f.group)}`,x+12,yy-8,7,1,gold);yy-=26;
   if(f.image){const im=await pdf.embedJpg(f.image.crop),fit=im.scale(Math.min(236/im.width,220/im.height));page.drawImage(im,{x:x+12+(236-fit.width)/2,y:yy-220+(220-fit.height)/2,width:fit.width,height:fit.height});yy-=232;}
   else{for(const line of wrap(f.video?'Video saved; use the original evidence link.':f.error||'Preview unavailable.',236,8)){await text(page,line,x+12,yy,8,0,muted);yy-=10;}yy-=12;}
   for(const [s,size,font,fill] of photoRows(f)){for(const line of wrap(s,236,size,font)){await text(page,line,x+12,yy,size,font,fill);yy-=size*1.25;}yy-=5;}
   const label='Open original evidence';await text(page,label,x+12,yy-2,8,1,linkColor);annot(page,[x+12,yy-6,x+12+width(label,8,1),yy+9],{A:{Type:'Action',S:'URI',URI:PDFString.of(issue.historyUrl)}});
  }
  function photoRows(f){return [[f.label,9,1,ink],[M.date(f.created_at),7,0,muted],...(f.image?.cropped?[['Item close-up; original retained in Invsto.',7,0,muted]]:[]),...(f.shippingOrders||[]).flatMap(addressRows)];}
  const photoHeight=(f,w=236)=>26+(f.image?220:wrap(f.video?'Video saved; use the original evidence link.':f.error||'Preview unavailable.',236,8).length*10)+12+photoRows(f).reduce((h,[s,size,font])=>h+wrap(s,w,size,font).length*size*1.25+5,0)+26;
  async function largePhoto(f,number){await ensure(400);await write(`Evidence ${number} / ${niceGroup(f.group)}`,9,1,gold);if(f.image){const im=await pdf.embedJpg(f.image.crop),fit=im.scale(Math.min(532/im.width,220/im.height));page.drawImage(im,{x:40+(532-fit.width)/2,y:y-220,width:fit.width,height:fit.height});y-=238;}else await write(f.error||'Preview unavailable.',9,0,muted);await write(f.label,10,1);await write(M.date(f.created_at),8,0,muted);for(const d of f.shippingOrders||[])await address(d);await links([{label:'Open original evidence',url:issue.historyUrl}]);}
  async function evidence(i){
   await heading('Order & visual evidence');
   for(const item of i.items){await ensure(100);await write(item.title,12,1,ink,5);await write(`${B.totalsFor([item])} / Qty ${item.quantity} / ${item.state}\nOrder ${item.orderNumber} / Item ${item.item||'not recorded'}${i.items.length>1?'\nPurchased: '+item.purchased:''}`,9,0,ink,6);await links([{label:'Open eBay order',url:item.orderUrl},...(item.videoUrl?[{label:'Watch video receipt',url:item.videoUrl}]:[]),{label:'Open system evidence',url:item.historyUrl}]);if(!item.videoUrl)await write('Video receipt: use the eBay order link; no direct receipt URL is saved.',7,0,muted,7);
    if(!i.files.some(f=>f.shippingOrders?.some(d=>d.orderNumber===item.destination.orderNumber)))await address(item.destination);
   }
   if(!i.items.length)await write('No exact item lines are linked.',9,0,rose);
   for(let n=0;n<i.files.length;){const row=i.files.slice(n,n+2),height=Math.max(...row.map(f=>photoHeight(f)));if(height>580){await largePhoto(i.files[n],n+1);n++;continue;}await ensure(height+8);const top=y;for(const [col,f] of row.entries())await photoCard(f,n+col+1,40+col*272,top);y=top-height-12;n+=row.length;}
   if(!i.files.length)await write('No saved photo evidence for these order lines.',9,0,muted);
  }
  async function scanTable(rows){
   const header=async()=>{await ensure(40);rect(40,y-8,532,21,color('e6ece4'));await text(page,'CARRIER DATE / TIME',48,y,7,1,muted);await text(page,'SCAN / LOCATION',207,y,7,1,muted);y-=23;};await header();
   for(const [n,r] of rows.entries()){
    if(!r.date){await write(r.body,9,0,ink,8);continue;}
    const left=wrap(r.date.replace(/(\d{4}),?\s+(?:at\s+)?/,'$1\n'),145,8),right=wrap(r.body,355,8.5),h=Math.max(left.length*10,right.length*11)+7;
    if(y-h<74){await newPage();await header();}if(h>580){await write(r.date,8,1,gold);await write(r.body,9);continue;}
    if(n%2===0)rect(40,y-h+7,532,h,color('edf1ea'));let yy=y;for(const line of left){await text(page,line,48,yy,8,0,muted);yy-=10;}yy=y;for(const [j,line] of right.entries()){await text(page,line,207,yy,8.5,j===0?1:0,ink);yy-=11;}y-=h;
   }y-=9;
  }
  async function tracking(i){await heading('Tracking & complete carrier history');
   if(!i.tracking.length){await write('No tracking is saved for this issue.',10,0,muted);return;}
   for(const t of i.tracking){await ensure(160);await write(`${t.label} / ${t.carrier||'Carrier not recorded'} / ${t.code}`,10,1,ink,4);await write(`${t.status} / ${t.statusSource||'Saved tracking'}${t.statusAt?' / Checked '+M.date(t.statusAt):''}`,8,0,muted,5);
    const precise=t.scopes.filter(s=>/\b(?:Order|Item)\b/.test(s));await write((precise.length?precise:t.scopes).join('\n'),8,0,muted,5);
    await links([{label:'Open carrier tracking',url:t.url},{label:'View in Order History',url:t.historyUrl},...(t.history?.source_url&&t.history.source_url!==t.url?[{label:'Saved history source',url:t.history.source_url}]:[])]);
    if(t.history){await write(`History saved by ${t.history.captured_by_name||'Team member'} / ${M.date(t.history.captured_at)}. Scan times and order are as supplied by the carrier.`,7,0,muted,8);await scanTable(carrierRows(t.history.history_text));}
    else await write('Full scan history is not saved. Open the carrier link to review it.',9,0,muted);
   }
  }
  async function chronology(i){await heading('Timeline & written exchanges');await write('Full messages, oldest to newest. Photo timestamps appear with the evidence. Label and completion records are internal records, not delivery scans.',8,0,muted,10);
   for(const e of timelineRows(i,model.includeInternal)){
    const left=wrap(e.date,132,8),source=[e.actor,String(e.source||'').replace(/ · case [\w-]+$/,'')].filter(Boolean).join(' / '),body=e.title==='Order purchased'&&i.items.length===1?'':e.body;
    const right=[[e.title,9,1,e.internal?muted:ink],[source,7,0,muted],...(body?[[body,9,0,ink]]:[])],h=Math.max(left.length*11,right.reduce((h,[s,size,font])=>h+wrap(s,366,size,font).length*size*1.35+4,0))+8;
    if(h>570){await ensure(65);await write(`${e.date} / ${e.title}`,9,1,gold,5);await write(source,7,0,muted,6);await write(body,9);continue;}
    await ensure(h);if(e.title==='Buyer message'||e.title==='Our response')rect(194,y-h+8,378,h,color(e.title==='Buyer message'?'fbf2df':'e8f1e8'));
    let yy=y;for(const line of left){await text(page,line,40,yy,8,1,gold);yy-=11;}yy=y;for(const [s,size,font,fill] of right){for(const line of wrap(s,366,size,font)){await text(page,line,200,yy,size,font,fill);yy-=size*1.35;}yy-=4;}y-=h;rule(page,y+3);y-=3;
   }
  }
  if(model.issues.length!==1){await newPage();anchor('index');await write('eBay case review',28,2,ink,9);await write(`${model.issues.length} marked issues / ${model.issues.filter(i=>i.against).length} decisions against us`,11,1,ink,18);
   for(const [n,i] of model.issues.entries()){await ensure(100);await links([{label:`${n+1}. ${M.excerpt(i.name||i.buyer,65)} / ${i.buyer}`,key:i.id}]);await write(`Order ${i.orderNumbers.join(', ')} / Case ${i.statuses.map(s=>s.number).join(', ')}`,8,0,muted,5);await write(i.title,10,1,ink,5);await write(`${i.statuses.map(s=>s.label).join(' / ')} / Claim ${i.statuses.map(s=>s.claim||'not recorded').join(' / ')} / ${i.review.position?.trim()?'Position saved':'Position needed'}`,8,0,i.against?rose:muted,14);rule(page,y);y-=16;}
  }
  for(const [n,i] of model.issues.entries()){
   progress(`Preparing PDF: issue ${n+1} of ${model.issues.length}…`);issue=i;section='01 / Case at a glance';await newPage();anchor(i.id);if(model.issues.length===1)anchor('index');await overview(i);
   section='02 / Order & visual evidence';await newPage();anchor(i.id+':photos');await evidence(i);
   section='03 / Tracking & carrier history';await newPage();anchor(i.id+':tracking');await tracking(i);
   section='04 / Timeline & written exchanges';await newPage();anchor(i.id+':timeline');await chronology(i);
  }
  for(const [n,meta] of pages.entries()){const p=meta.page;rule(p,48);let x=40;for(const [label,key] of [['Case index','index'],...(meta.issue?[['Overview',meta.issue],['Evidence',meta.issue+':photos'],['Tracking',meta.issue+':tracking'],['Exchanges',meta.issue+':timeline']]:[])]){await text(p,label,x,29,8,1);jumps.push({page:p,key,box:[x,23,x+width(label,8,1),41]});x+=96;}await text(p,`${n+1} / ${pages.length}`,538,29,8,0,muted);}
  for(const j of jumps)if(dest.has(j.key)){const target=dest.get(j.key);annot(j.page,j.box,{Dest:[target.page,PDFName.of('XYZ'),null,target.y,null]});}
  return pdf.save();
 }
 const niceGroup=g=>({item:'ITEM SCREENSHOT',completion:'SHIPMENT PROOF',packaging:'PACKAGING',certificate:'CERTIFICATE',returned:'RETURNED ITEM'})[g]||g;
 const api={build,carrierRows,timelineRows};root.OGIssueReviewPdf=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
