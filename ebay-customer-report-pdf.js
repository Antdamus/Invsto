(function(root){
  'use strict';
  async function build(model,progress=()=>{}){
    const report=root.OGCustomerReport,shared=root.OGMissingReport;
    const buyer=root.OGBuyerReport,refunds=root.OGBuyerRefundReport;
    const {PDFDocument,StandardFonts,rgb,PDFName,PDFString}=root.PDFLib;
    const pdf=await PDFDocument.create();
    const fonts=await Promise.all([StandardFonts.Helvetica,StandardFonts.HelveticaBold,StandardFonts.TimesRoman].map(f=>pdf.embedFont(f)));
    const color=hex=>rgb(...hex.match(/\w\w/g).map(x=>parseInt(x,16)/255));
    const ink=color('172e36'),muted=color('647479'),gold=color('a07a38'),paper=color('f5f3ed'),white=rgb(1,1,1),line=color('d9dfda');
    const rose=color('9a333f'),roseBg=color('fbecef'),amber=color('92600c'),amberBg=color('fff3da'),green=color('476b61');
    const tone=level=>level==='overdue'?rose:level==='today'?amber:green;
    const tint=level=>level==='overdue'?roseBg:level==='today'?amberBg:color('edf3ef');
    const clean=value=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');
    const pageMeta=[],destinations=new Map(),jumps=[];let customerKey=null;
    pdf.setTitle(`${model.username} | ${model.title}`);pdf.setAuthor('OG Jewelers');
    pdf.setSubject(`Prepared ${model.date} | ${model.count} item lines`);
    function width(value,size=10,font=0){
      // drawText emits glyph advances without the pair kerning used by widthOfTextAtSize.
      // Measure each glyph so long titles remain inside the actual printed margins.
      try{return [...clean(value)].reduce((total,ch)=>total+fonts[font].widthOfTextAtSize(ch,size),0);}
      catch{const ctx=document.createElement('canvas').getContext('2d');ctx.font=`${font===1?'bold ':''}${size}px ${font===2?'Georgia':'Arial'}`;return ctx.measureText(clean(value)).width;}
    }
    function wrap(value,maxWidth=540,size=10,font=0){
      const lines=[];
      for(const paragraph of clean(value).split(/\r?\n/)){
        let current='';
        for(const word of paragraph.split(/\s+/).filter(Boolean)){
          if(current&&width(`${current} ${word}`,size,font)>maxWidth){lines.push(current);current='';}
          if(width(word,size,font)>maxWidth){
            for(const ch of word){if(current&&width(current+ch,size,font)>maxWidth){lines.push(current);current='';}current+=ch;}
          }else current=current?`${current} ${word}`:word;
        }
        lines.push(current);
      }
      return lines;
    }
    async function text(page,value,x,y,size=10,font=0,fill=ink){
      const s=clean(value);
      try{fonts[font].encodeText(s);page.drawText(s,{x,y,size,font:fonts[font],color:fill});}
      catch{
        // Preserve non-Latin names and titles locally; no remote font or customer-data upload.
        const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d'),css=`${font===1?'bold ':''}${size*3}px ${font===2?'Georgia':'Arial'}`;
        ctx.font=css;canvas.width=Math.ceil(ctx.measureText(s).width)+6;canvas.height=Math.ceil(size*4.5);
        ctx.font=css;ctx.fillStyle=`rgb(${[fill.red,fill.green,fill.blue].map(c=>Math.round(c*255)).join(',')})`;ctx.textBaseline='alphabetic';ctx.fillText(s,0,size*3.4);
        const image=await pdf.embedPng(canvas.toDataURL('image/png'));page.drawImage(image,{x,y:y-size*.35,width:canvas.width/3,height:canvas.height/3});
      }
    }
    async function block(page,value,x,y,w=540,size=10,font=0,fill=ink){
      for(const s of wrap(value,w,size,font)){await text(page,s,x,y,size,font,fill);y-=size*1.4;}return y;
    }
    function rect(page,x,y,w,h,fill){page.drawRectangle({x,y,width:w,height:h,color:fill});}
    function rule(page,x,y,w,fill=line){page.drawLine({start:{x,y},end:{x:x+w,y},thickness:.7,color:fill});}
    function annotation(page,box,action){
      const ref=pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Link',Rect:box,Border:[0,0,0],...action}));
      const existing=page.node.lookup(PDFName.of('Annots'));if(existing)existing.push(ref);else page.node.set(PDFName.of('Annots'),pdf.context.obj([ref]));
    }
    async function link(page,label,url,x,y,size=9){
      await text(page,label,x,y,size,1);rule(page,x,y-3,width(label,size,1),gold);
      annotation(page,[x,y-4,x+width(label,size,1),y+size+2],{A:{Type:'Action',S:'URI',URI:PDFString.of(url)}});
    }
    async function newPage(label,row=null){
      const page=pdf.addPage([612,792]);rect(page,0,0,612,792,row?.refund?.itemRefundConfirmed?color('fff0f2'):paper);rect(page,0,784,612,8,row?.refund?.itemRefundConfirmed?rose:gold);
      await text(page,'OG JEWELERS / CUSTOMER COLLECTION',36,754,8,1,gold);
      await text(page,model.date,330,754,8,0,muted);rule(page,36,741,540);
      pageMeta.push({page,label,row,customerKey});return page;
    }
    // Flow text breaks at actual measured line boundaries, including long notes and case histories.
    function flow(page,y,label,row=null){
      return {page,y,label,async ensure(height){if(this.y-height<(row?118:78)){this.page=await newPage(this.label,row);this.y=await block(this.page,`DETAILS / CONTINUED / ${this.label}`,36,712,540,9,1,gold);this.y-=14;}},
        async write(value,size=10,font=0,fill=ink,gap=8){
          for(const s of wrap(value,540,size,font)){await this.ensure(size*1.4);await text(this.page,s,36,this.y,size,font,fill);this.y-=size*1.4;}this.y-=gap;
        }};
    }
    const c=model.customer;
    let page=await newPage('Customer summary');destinations.set('summary',page.ref);
    rect(page,0,501,612,234,ink);
    await text(page,model.scope==='pending'?'THE PENDING COLLECTION':'THE COMPLETE COLLECTION',36,706,9,1,color('d6bc8e'));
    let titleY=await block(page,c.name||'Customer name not recorded',36,666,540,30,2,white);
    titleY=await block(page,model.title,36,titleY-10,540,23,2,color('e7dcc9'));
    await block(page,`eBay: ${model.username}`,36,titleY-8,540,11,0,color('c3d1d4'));
    await text(page,`${model.orderCount} orders / ${model.count} item lines in this edition`,36,521,9,0,color('d6bc8e'));
    const overview=[[model.pending,'PENDING LINES',white,ink],[model.scope==='pending'?model.labeled:model.closed,model.scope==='pending'?'WITH A LABEL':'CLOSED LINES',white,ink],[model.overdue,'OVERDUE',roseBg,rose],[model.today,'DUE TODAY',amberBg,amber]];
    for(const [i,[value,label,bg,fg]] of overview.entries()){
      const x=36+i*138;rect(page,x,384,126,94,bg);await text(page,String(value),x+14,430,30,1,fg);await text(page,label,x+14,403,8,1,fg);
    }
    let f=flow(page,354,'Customer summary');
    await f.write(`Original item value in this edition: ${model.itemValue}`,13,1);
    if(model.orderMap){
      await f.write(`${model.orderMap.groups.length} live shows / ${model.count} matched pending item lines`,11,1);
      await f.write('Show schedule and overnight grouping use Eastern time. Host estimates are labeled; regular purchases are excluded.',9,0,muted);
      if(model.orderMap.warning)await f.write(model.orderMap.warning,9,1,amber);
    }
    if(model.unknownPrices)await f.write(`${model.unknownPrices} item amounts are not recorded and are excluded from that value.`,9,0,amber);
    await f.write(`${model.labeled} pending lines have a shipping label attached; ${model.unlabeled} do not.`,10);
    if(model.unknown)await f.write(`${model.unknown} lines have a status that needs review.`,9,1,amber);
    await f.write(model.scope==='pending'?'Only pending and partially fulfilled item lines appear in this edition.':'All saved item lines appear in this edition: pending items first, then closed items.',10,0,muted,16);
    await f.write('DESIGNED FOR A QUICK REVIEW',9,1,gold);
    await f.write('Use the clickable item index to open any purchase. Every page links back to the index and customer summary. Pending items show shipping deadlines in Eastern and Pacific time. Rose item pages identify confirmed full or partial refunds; red deadline text identifies overdue items.',10);
    await f.write('A saved label does not establish shipment or delivery. Closed is the system status, with its reason shown for each item.',9,0,muted);
    page=await newPage('Lifetime financial summary');f=flow(page,710,'Lifetime financial summary');
    await f.write('The customer, at a glance.',29,2,ink,12);
    await f.write('LIFETIME PURCHASE SUMMARY / ALL SAVED HISTORY',9,1,gold,20);
    const stats=shared.stats(c);
    for(let start=0;start<6;start+=3){
      const subset=stats.slice(start,start+3),h=Math.max(...subset.map(([,value,note])=>54+wrap(value,146,17,1).length*24+wrap(note,146,8).length*11.2));await f.ensure(h+12);
      for(const [j,[label,value,note]] of subset.entries()){
        const n=start+j,x=36+j*184,bg=n===2?ink:n===1?roseBg:white,fg=n===2?white:ink,secondary=n===2?color('cfdbd9'):muted;
        rect(f.page,x,f.y-h,172,h,bg);await text(f.page,label.toUpperCase(),x+13,f.y-19,8,1,secondary);
        const yy=await block(f.page,value,x+13,f.y-46,146,17,1,fg);await block(f.page,note,x+13,yy-4,146,8,0,secondary);
      }f.y-=h+12;
    }
    f.y-=12;await f.write(`First purchase: ${c.firstPurchase}`,10);await f.write(`Most recent purchase: ${c.lastPurchase}`,10);
    await f.write(refunds.timingText(c.financial),9,0,muted,12);
    if(c.financial.unverifiedOrders||c.financial.unmatched.length)await f.write(`Verify finances: ${c.financial.unverifiedOrders} orders with uncertain amounts; ${c.financial.unmatched.length} unmatched cases. Net spent may be unconfirmed.`,9,1,amber);
    await f.write(report.NOTES,9,0,muted);
    if(model.missingOrders.length)await f.write(`Saved orders without item lines: ${model.missingOrders.map(o=>o.order_number).join(', ')}. Their totals are in lifetime finances; item details are unavailable.`,9,1,amber);
    page=await newPage('Item index');destinations.set('index',page.ref);f=flow(page,710,'Item index');
    await f.write(model.orderMap?'Your show route.':'Your item index.',29,2,ink,12);
    await f.write('Select any row to open its item details. Every page has a return link. Item prices are original purchase amounts, before refunds.',10,0,muted,18);
    if(!model.count)await f.write('No pending item lines are saved for this buyer.',16,2);
    const sections=model.orderMap?model.orderMap.groups.map(g=>({key:g.key,title:`${g.day} / ${g.label}`,note:`${g.estimated?'Host: schedule estimate. ':''}${g.rows.length} item lines / ${g.quantity} units. ${g.show.title}`,selected:g.rows.map(r=>({r,i:model.rows.indexOf(r)}))})):['pending','closed','unknown'].map(kind=>({title:{pending:'PENDING / EARLIEST DEADLINE FIRST',closed:'CLOSED / NEWEST PURCHASES FIRST',unknown:'STATUS NEEDS REVIEW'}[kind],selected:model.rows.map((r,i)=>({r,i})).filter(({r})=>r.state.kind===kind)}));
    for(const section of sections){
      const selected=section.selected;if(!selected.length)continue;
      if(model.orderMap)f.label=section.title;
      await f.ensure(180);if(section.key)destinations.set(section.key,f.page.ref);
      await f.write(`${section.title} / ${selected.length}`,11,1,gold,10);
      if(section.note)await f.write(section.note,9,0,muted,14);
      for(const {r,i} of selected){
        const left=[`${r.showMap&&r.showMap.number!=null?'Item #'+r.showMap.number:i+1+'.'} ${r.title}`,`Order ${r.orderNumber}`,`${r.purchaseLabel||'Purchased'} ${r.date}`,...(r.groups.length?['Grouped completion / see item details']:[])];
        const right=[r.state.label,...(r.pending?[report.urgency(r),r.shippingLabel.label,`Ship by ${r.deadline.dueEastern||'Not recorded'}`]:[])];
        const amount=shared.money(r.price.total,r.price.currency),refundLabel=r.refund?.label||'Refund status not recorded';
        const leftH=wrap(left[0],236,9,1).length*12.6+left.slice(1).reduce((sum,s)=>sum+wrap(s,236,8).length*11.2+4,0);
        const rightH=right.reduce((sum,s,n)=>sum+wrap(s,157,n===1?11:8,n<2?1:0).length*(n===1?15.4:11.2)+5,0);
        const middleH=wrap(amount,91,13,1).length*18.2+wrap(refundLabel,91,8).length*11.2+25;
        const h=Math.max(88,leftH+28,rightH+25,middleH+25);await f.ensure(h);
        const top=f.y+9,bg=r.refund?.itemRefundConfirmed?roseBg:white;rect(f.page,36,top-h,540,h-5,bg);
        rect(f.page,36,top-h,3,h-5,r.pending?tone(r.deadline.level):line);
        let y=await block(f.page,left[0],48,f.y-7,236,9,1);for(const s of left.slice(1))y=await block(f.page,s,48,y-4,236,8,0,muted);
        await text(f.page,'ITEM AMOUNT',298,f.y-7,6,1,muted);y=await block(f.page,amount,298,f.y-28,91,13,1);
        await block(f.page,refundLabel,298,y-7,91,8,0,r.refund?.itemRefundConfirmed?rose:muted);
        y=f.y-7;for(const [n,s] of right.entries())y=await block(f.page,s,407,y,157,n===1?11:8,n<2?1:0,n===1?tone(r.deadline.level):n===2&&!r.shippingLabel.attached?amber:ink)-5;
        jumps.push({page:f.page,rect:[36,top-h,576,top],key:`item:${r.id}`});f.y=top-h-14;
      }f.y-=12;
    }
    if(model.orderMap){
      const m=model.orderMap;
      await f.ensure(90);await f.write('OUTSIDE THIS SHOW MAP',10,1,gold);
      await f.write(`${m.excluded.length} other pending lines have no live-show evidence. ${m.unassigned.length} likely live or conflicting items still need a verified show match. See the pending-items report for all purchases.`,9,0,muted);
      for(const r of m.unassigned){await f.ensure(65);await f.write(`${r.orderNumber} / ${r.title}`,10,1);await f.write(r.mapReason,9,0,amber);await link(f.page,'Review eBay order',r.orderUrl,36,f.y,9);f.y-=24;}
      if(m.coverage?.complete)await f.write(`eBay history captured from ${shared.date(m.coverage.since)} through ${shared.date(m.coverage.until)} / ${m.coverage.orders} orders across all buyers.`,9,0,muted);
    }
    for(const [i,r] of model.rows.entries()){
      progress(`Building ${model.title.toLowerCase()}: item ${i+1} of ${model.count}...`);
      const label=`${model.username} / Order ${r.orderNumber}`;
      page=await newPage(label,r);destinations.set(`item:${r.id}`,page.ref);f=flow(page,714,label,r);
      await f.write(`ITEM ${i+1} OF ${model.count} / ${r.customerName||c.name||model.username}`,10,1,gold,8);
      if(r.showMap){await f.write(`${r.showMap.day} / ${r.showMap.label} / ${r.showMap.number==null?'Item number not recorded':'Item #'+r.showMap.number}`,11,1,green);await f.write(`${r.showMap.reason}${r.showMap.hostEstimated?' / Host: schedule estimate':''}`,8,0,muted);if(r.purchaseNote)await f.write(r.purchaseNote,9,0,muted);}
      if(r.pending){
        const content=r.deadline.since?`Overdue since ${r.deadline.since}`:`Ship by ${r.deadline.due}`;
        const h=48+wrap(content,510,9).length*12.6;await f.ensure(h+10);rect(f.page,36,f.y-h,540,h,tint(r.deadline.level));
        await text(f.page,report.urgency(r),50,f.y-24,18,1,tone(r.deadline.level));await block(f.page,content,50,f.y-43,510,9,0,tone(r.deadline.level));f.y-=h+22;
      }
      await f.write(`ORDER ${r.orderNumber} / ${r.state.label}`,10,1);
      await f.write(r.title,20,2,ink,8);
      await f.write(`${shared.money(r.price.total,r.price.currency)} / Qty ${r.price.quantity}`,18,1,ink,5);
      await f.write('Original item amount before refunds; excludes shipping and tax.',8,0,muted,8);
      await f.write(`${r.shippingLabel.label}${r.shippingLabel.uploadedAt?` / ${shared.date(r.shippingLabel.uploadedAt)}`:''}`,10,1,r.pending&&!r.shippingLabel.attached?amber:green,14);
      const timelineH=r.timeline.reduce((h,e)=>h+wrap(e.label,233,9,1).length*12.6+wrap(e.text,233,8).length*11.2+14,0);
      const evidenceH=Math.max(216,timelineH+28);
      // Extra-long timelines use the same measured flow as notes instead of overflowing a column.
      const split= evidenceH>470,boxH=split?250:evidenceH;
      await f.ensure(boxH+12);const top=f.y;rect(f.page,36,top-boxH,258,boxH,color('e9ede7'));
      if(r.image){
        const data=r.image.crop,img=/^data:image\/png/.test(data)?await pdf.embedPng(data):await pdf.embedJpg(data),scale=Math.min(242/img.width,(boxH-40)/img.height);
        f.page.drawImage(img,{x:44+(242-img.width*scale)/2,y:top-boxH+28+(boxH-40-img.height*scale)/2,width:img.width*scale,height:img.height*scale});
        await text(f.page,r.image.cropped?'CROPPED ITEM EVIDENCE':'SAVED ITEM EVIDENCE',48,top-boxH+13,8,1,muted);
      }else{
        await text(f.page,'ITEM EVIDENCE',54,top-boxH/2+30,9,1,muted);await block(f.page,r.imageStatus||'No saved item screenshot',54,top-boxH/2+6,218,16,2,muted);
        await text(f.page,'Use the video receipt link below.',54,top-boxH+22,9,0,muted);
      }
      if(!split){
        await text(f.page,'THE ITEM TIMELINE',319,top-10,9,1,gold);let ty=top-36;
        for(const [ei,e] of r.timeline.entries()){
          const h=wrap(e.label,233,9,1).length*12.6+wrap(e.text,233,8).length*11.2+14;
          if(ei<r.timeline.length-1)f.page.drawLine({start:{x:320,y:ty-1},end:{x:320,y:ty-h-1},thickness:1.2,color:line});
          f.page.drawCircle({x:320,y:ty+3,size:3.5,color:tone(e.tone)});
          const yy=await block(f.page,e.label,333,ty,233,9,1,tone(e.tone));await block(f.page,e.text,333,yy-3,233,8,0,muted);ty-=h;
        }
      }
      f.y=top-boxH-20;
      if(split){await f.write('THE ITEM TIMELINE',9,1,gold);for(const e of r.timeline){await f.write(e.label,10,1,tone(e.tone),4);await f.write(e.text,9,0,muted);}}
      if(r.review)await f.write(r.review,9,1,amber);
      const refundActivity=r.refund?.refundSignal||r.refund?.requests?.length;
      await f.ensure(54);await f.write('REFUND STATUS',8,1,gold,5);
      for(const [n,s] of refunds.detailLines(r.refund).entries())await f.write(s,n===0?10:9,n===0?1:0,n===0&&refundActivity?rose:muted,5);
      for(const q of r.refund?.requests||[]){await f.ensure(28);await link(f.page,`Review case ${q.caseNumber}`,q.url,36,f.y,9);f.y-=26;}
      await f.write(`eBay item ${r.item||'Not recorded'} / Saved eBay status: ${r.ebayStatus}`,8,0,muted);
      for(const group of r.groups)await f.write(group,9,0,muted);
      if(r.notes.length){await f.ensure(65);await f.write('ITEM NOTES / NEWEST FIRST',9,1,gold);for(const note of r.notes){
        await f.ensure(60);await f.write(note.author,9,1,ink,3);await f.write(`${note.date} / Eastern time`,8,0,muted,5);await f.write(note.text,10,0,ink,12);
      }}
    }
    page=await newPage('Report notes');f=flow(page,710,'Report notes');await f.write('Every detail, explained.',29,2,ink,20);
    for(const [title,body] of [
      ['SCOPE & STATUS',`${model.title}. Each entry represents one saved item line. Pending lines appear first, sorted by shipping deadline. Closed lines show the system closure reason and are not treated as currently overdue. A closed or fulfilled system record is not a carrier delivery confirmation.`],
      ['FINANCIAL SUMMARY',report.NOTES],['SHIPPING DEADLINES',report.DEADLINE_NOTES],
      ['LABELS & ITEM EVIDENCE','Label attached means that specific order currently has a saved shipping-label file; another order in the buyer group does not establish label coverage. It does not mean the parcel shipped. Item images use the saved crop where available, without a duplicate full screenshot. If no crop is recorded, the saved evidence is used as-is. Missing screenshots are called out explicitly.'],
      ['REFUNDS & LINKS','Rose item pages indicate a confirmed item refund, full or partial. Refund requests, completed refunds, amounts and timing before or after shipment stay separate. When a direct video receipt URL is unavailable, its link opens the eBay order to find the Live receipt. External order, system, receipt and case links may require sign-in. Use the index and customer summary links on every page to navigate.'],
    ]){await f.ensure(65);await f.write(title,9,1,gold,8);await f.write(body,10,0,ink,18);}
    for(const [i,meta] of pageMeta.entries()){
      const p=meta.page;
      if(meta.row){rule(p,36,104,540);const receipt=buyer.receiptAction(meta.row);
        for(const [label,url,x] of [['eBay order',meta.row.orderUrl,36],[meta.row.pending?'Pending order':'System record',meta.row.pending?meta.row.pendingUrl:meta.row.historyUrl,170],[receipt.pdfLabel,receipt.href,373]])await link(p,label,url,x,84,9);
        if(!meta.row.videoUrl)await text(p,'Receipt opens the eBay order because no direct video URL is saved.',36,65,7,0,muted);
      }
      rule(p,36,47,540);
      for(const [label,key,x] of [[model.orderMap?'Show directory':'Item index','index',36],['Customer summary','summary',160],...(meta.row?.showMap?[['This show',meta.row.showMap.key,300]]:[])]){await text(p,label,x,29,8,1);rule(p,x,26,width(label,8,1),gold);jumps.push({page:p,rect:[x,23,x+width(label,8,1),40],key});}
      await text(p,`${i+1} / ${pageMeta.length}`,530,29,8,0,muted);
    }
    for(const jump of jumps)annotation(jump.page,jump.rect,{Dest:[destinations.get(jump.key),PDFName.of('Fit')]});
    return pdf.save();
  }
  const api={build};root.OGCustomerReportPdf=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
