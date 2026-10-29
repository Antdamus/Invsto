(function(root){
  'use strict';
  async function build(model,progress=()=>{}){
    const report=root.OGMissingReport||(typeof require==='function'?require('./ebay-missing-report.js'):null);
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
    pdf.setTitle('Missing items | Customer and shipping report');pdf.setAuthor('OG Jewelers');
    pdf.setSubject(`Prepared ${model.date} | ${model.count} missing item lines`);
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
      const page=pdf.addPage([612,792]);rect(page,0,0,612,792,paper);rect(page,0,784,612,8,gold);
      await text(page,'OG JEWELERS / MISSING ITEMS',36,754,8,1,gold);
      await text(page,model.date,330,754,8,0,muted);rule(page,36,741,540);
      pageMeta.push({page,label,row,customerKey});return page;
    }
    // Flow text breaks at actual measured line boundaries, including long notes and case histories.
    function flow(page,y,label,row=null){
      return {page,y,async ensure(height){if(this.y-height<(row?118:78)){this.page=await newPage(label,row);this.y=await block(this.page,`DETAILS / CONTINUED / ${label}`,36,712,540,9,1,gold);this.y-=14;}},
        async write(value,size=10,font=0,fill=ink,gap=8){
          for(const s of wrap(value,540,size,font)){await this.ensure(size*1.4);await text(this.page,s,36,this.y,size,font,fill);this.y-=size*1.4;}this.y-=gap;
        }};
    }
    let page=await newPage('Report overview');
    rect(page,0,501,612,234,ink);
    await text(page,'FULFILLMENT PRIORITIES',36,701,9,1,color('d6bc8e'));
    await text(page,'Missing items.',36,647,40,2,white);
    await text(page,'Every detail, in one place.',36,609,26,2,color('e7dcc9'));
    await text(page,'Customer history, item evidence and shipping deadlines.',36,572,11,0,color('c3d1d4'));
    await text(page,`Scope: ${{all:'All marked missing items',watches:'Missing watches','not-found':'Items marked not found'}[model.scope]}`,36,533,9,0,color('d6bc8e'));
    for(const [i,[value,label,bg,fg]] of [[model.count,'MISSING LINES',white,ink],[model.customers.length,'CUSTOMERS',white,ink],[model.overdue,'OVERDUE',roseBg,rose],[model.today,'DUE TODAY',amberBg,amber]].entries()){
      const x=36+i*138;rect(page,x,384,126,94,bg);await text(page,String(value),x+14,430,30,1,fg);await text(page,label,x+14,403,8,1,fg);
    }
    let f=flow(page,354,'Report overview');
    await f.write(`${model.orders} orders affected | Original missing-item value: ${model.missingValue}`,11,1);
    await f.write('SHIPPING NEEDS ATTENTION',9,1,amber);
    await f.write(report.NOTICE,10,0,ink,12);await link(f.page,'eBay payment-hold policy',report.POLICY_URL,36,f.y,9);f.y-=30;
    await f.write('READ THE TIMELINE',9,1,gold);
    await f.write('Purchased / Marked missing / Shipping deadline / Report snapshot. Milestones follow date order. Red identifies overdue items; amber identifies items due today. Each overdue item states its deadline and elapsed time.',10);
    if(model.unknown)await f.write(`${model.unknown} item lines have no saved shipping deadline and need verification.`,10,1,amber);
    // Customer navigation starts on its own page so the cover stays calm and easy to scan.
    page=await newPage('Customer index');f=flow(page,709,'Customer index');
    destinations.set('directory',page.ref);
    await f.write('Your customer directory',29,2,ink,12);
    await f.write('Missing-item value and the longest overdue duration for each customer. Sorted by earliest shipping deadline. Select a customer to open their profile.',10,0,muted,18);
    for(const [i,c] of model.customers.entries()){
      const urgency=report.directoryUrgency(c),name=c.name||'Customer name not recorded';
      const nameH=wrap(name,209,13,1).length*18.2+wrap(`eBay: ${c.username}`,209,9).length*12.6+20;
      const valueH=18+wrap(c.missingValue,112,16,1).length*22.4;
      const urgencyH=18+wrap(urgency.value,125,12,1).length*16.8;
      const h=Math.max(85,nameH+26,valueH+26,urgencyH+26);await f.ensure(h);
      rect(f.page,36,f.y-h+14,540,h-4,white);await text(f.page,String(i+1).padStart(2,'0'),48,f.y-7,19,2,gold);
      const nameY=await block(f.page,name,84,f.y-4,209,13,1);
      const usernameY=await block(f.page,`eBay: ${c.username}`,84,nameY-2,209,9,0,muted);
      await text(f.page,`${c.rows.length} missing ${c.rows.length===1?'line':'lines'}`,84,usernameY-3,9,0,muted);
      await text(f.page,'MISSING-ITEM VALUE',305,f.y-3,7,1,muted);
      await block(f.page,c.missingValue,305,f.y-26,112,16,1);
      await text(f.page,urgency.label.toUpperCase(),439,f.y-3,7,1,tone(urgency.level));
      await block(f.page,urgency.value,439,f.y-26,125,12,1,tone(urgency.level));
      jumps.push({page:f.page,rect:[36,f.y-h+14,576,f.y+10],key:`customer:${i}`});f.y-=h+6;
    }
    for(const [ci,c] of model.customers.entries()){
      customerKey=`customer:${ci}`;
      const customerLabel=`${c.name||'Customer name not recorded'} / eBay: ${c.username}`;
      page=await newPage(customerLabel);destinations.set(`customer:${ci}`,page.ref);f=flow(page,711,customerLabel);
      await f.write(`CUSTOMER ${String(ci+1).padStart(2,'0')} / ${model.customers.length}`,9,1,gold,22);
      await f.write(c.name||'Customer name not recorded',30,2,ink,6);await f.write(`eBay: ${c.username} | ${c.rows.length} missing lines | ${c.openOrders} open orders`,10,0,muted,16);
      const stats=report.stats(c);
      for(let start=0;start<6;start+=3){
        const subset=stats.slice(start,start+3),heights=subset.map(([label,value,note])=>40+wrap(value,146,17,1).length*24+wrap(note,146,8).length*11.2),h=Math.max(...heights);
        await f.ensure(h+12);
        for(const [j,[label,value,note]] of subset.entries()){
          const n=start+j,x=36+j*184,bg=n===2?ink:n===1?roseBg:white,fg=n===2?white:ink,secondary=n===2?color('cfdbd9'):muted;
          rect(f.page,x,f.y-h,172,h,bg);await text(f.page,label.toUpperCase(),x+13,f.y-19,8,1,secondary);
          const y=await block(f.page,value,x+13,f.y-46,146,17,1,fg);await block(f.page,note,x+13,y-4,146,8,0,secondary);
        }
        f.y-=h+12;
      }
      f.y-=8;await f.write(`First purchase: ${c.firstPurchase}`,9);await f.write(`Most recent purchase: ${c.lastPurchase}`,9);
      await f.write(refunds.timingText(c.financial),9,0,muted);
      if(c.financial.unverifiedOrders||c.financial.unmatched.length)await f.write(`Verify finances: ${c.financial.unverifiedOrders} orders with uncertain refund amounts; ${c.financial.unmatched.length} unmatched cases. Net spent may be unconfirmed.`,9,1,amber);
      await f.ensure(30);await link(f.page,'Open complete buyer report',c.historyUrl,36,f.y);f.y-=34;
      await f.write('MISSING ITEM INDEX',9,1,gold,12);
      for(const [ri,r] of c.rows.entries()){
        const lines=wrap(`${ri+1}. ${r.title}`,330,9,1),h=Math.max(44,lines.length*13+25);await f.ensure(h);
        rect(f.page,36,f.y-h+13,540,h-4,tint(r.deadline.level));
        const y=await block(f.page,`${ri+1}. ${r.title}`,48,f.y-2,330,9,1);await text(f.page,`Order ${r.orderNumber}`,48,y-2,8,0,muted);
        await text(f.page,r.deadline.label,427,f.y-2,10,1,tone(r.deadline.level));
        jumps.push({page:f.page,rect:[36,f.y-h+13,576,f.y+9],key:`item:${r.id}`});f.y-=h+5;
      }
      for(const [ri,r] of c.rows.entries()){
        progress(`Building PDF: ${c.username}, item ${ri+1} of ${c.rows.length}...`);
        const itemCustomer=`${r.customerName||c.name||'Customer name not recorded'} / eBay: ${c.username}`;
        page=await newPage(`${itemCustomer} / ${r.orderNumber}`,r);destinations.set(`item:${r.id}`,page.ref);
        f=flow(page,716,`${itemCustomer} / ${r.orderNumber}`,r);
        await f.write(`${itemCustomer} / ITEM ${ri+1} OF ${c.rows.length}`,10,1,gold,10);
        const bannerTop=f.y+4,bannerLines=wrap(r.deadline.since?`Overdue since ${r.deadline.since}`:`Ship by ${r.deadline.due}`,510,10),bannerH=46+bannerLines.length*14;
        rect(f.page,36,bannerTop-bannerH,540,bannerH,tint(r.deadline.level));
        await text(f.page,r.deadline.level==='overdue'?`Overdue for ${r.deadline.age}`:r.deadline.label,50,bannerTop-25,19,1,tone(r.deadline.level));
        await block(f.page,bannerLines.join('\n'),50,bannerTop-45,510,10,0,tone(r.deadline.level));f.y=bannerTop-bannerH-25;
        await f.write(`ORDER ${r.orderNumber}`,10,1);
        await f.write(r.title,19,2,ink,8);
        await f.write(`${report.money(r.price.total,r.price.currency)} | Qty ${r.price.quantity} | Original item amount`,15,1,ink,5);
        await f.write(`${r.price.source}. Item amount excludes shipping and tax.`,8,0,muted,16);
        const timelineH=r.timeline.reduce((h,e)=>h+wrap(e.label,233,10,1).length*14+wrap(e.text,233,9).length*12.6+16,0);
        const evidenceH=Math.max(210,timelineH+24);await f.ensure(evidenceH+15);
        const top=f.y;rect(f.page,36,top-evidenceH,258,evidenceH,color('e9ede7'));
        if(r.image){
          const data=r.image.crop,image=/^data:image\/png/.test(data)?await pdf.embedPng(data):await pdf.embedJpg(data),scale=Math.min(242/image.width,(evidenceH-38)/image.height);
          f.page.drawImage(image,{x:44+(242-image.width*scale)/2,y:top-evidenceH+28+(evidenceH-38-image.height*scale)/2,width:image.width*scale,height:image.height*scale});
          await text(f.page,'SAVED ITEM EVIDENCE',48,top-evidenceH+13,8,1,muted);
        }else{
          await text(f.page,'ITEM EVIDENCE',54,top-evidenceH/2+34,9,1,muted);
          await block(f.page,r.imageStatus||'No saved item screenshot',54,top-evidenceH/2+10,218,17,2,muted);
          await text(f.page,'Use the video receipt link below.',54,top-evidenceH+24,9,0,muted);
        }
        await text(f.page,'ITEM TIMELINE',319,top-10,9,1,gold);let ty=top-37;
        for(const [ei,e] of r.timeline.entries()){
          const h=wrap(e.label,233,10,1).length*14+wrap(e.text,233,9).length*12.6+16;
          if(ei<r.timeline.length-1)f.page.drawLine({start:{x:320,y:ty-1},end:{x:320,y:ty-h-1},thickness:1.2,color:line});
          f.page.drawCircle({x:320,y:ty+3,size:3.5,color:tone(e.tone)});
          const yy=await block(f.page,e.label,333,ty,233,10,1,tone(e.tone));await block(f.page,e.text,333,yy-3,233,9,0,muted);ty-=h;
        }
        f.y=top-evidenceH-22;
        await f.write(`Missing marker: ${r.missingReason} | ${r.markedBy} | ${r.markedAt}`,8,0,muted);
        await f.write(`eBay item ${r.item||'Not recorded'} | Saved eBay status: ${r.ebayStatus}`,8,0,muted);
        for(const group of r.groups)await f.write(group,8,0,muted);
        if(r.review)await f.write(r.review,9,1,amber);
        if(r.notes?.length){
          await f.ensure(75);await f.write('ITEM NOTES / NEWEST FIRST',8,1,gold,8);
          for(const note of r.notes){
            const meta=`${note.date}${note.date!=='Not recorded'?' / Eastern time':' / Date/time not recorded'}`;
            await f.ensure(wrap(note.author,540,9,1).length*12.6+wrap(meta,540,8).length*11.2+30);
            await f.write(note.author,9,1,ink,3);await f.write(meta,8,0,muted,6);await f.write(note.text,10,0,ink,6);
          }
        }
        const refundActivity=r.refund?.refundSignal||r.refund?.requests?.length;
        await f.ensure(refundActivity?32:30.4);
        if(refundActivity)await f.write('REFUND CONTEXT',8,1,gold,5);
        for(const [i,s] of refunds.detailLines(r.refund).entries())await f.write(s,i===0&&refundActivity?10:8,i===0?1:0,i===0&&refundActivity?rose:muted,4);
        for(const q of r.refund?.requests||[]){await f.ensure(28);await link(f.page,`Review case ${q.caseNumber}`,q.url,36,f.y,9);f.y-=26;}
      }
    }
    customerKey=null;
    page=await newPage('Report notes');f=flow(page,710,'Report notes');await f.write('How to read this report',29,2,ink,18);
    for(const [title,body] of [
      ['MISSING ITEMS','Only pending item lines explicitly marked not found or attached to an active missing-watch hold appear. Unreviewed items are not assumed missing. Other items in the same buyer package are excluded; grouped order context is shown when saved.'],
      ['CUSTOMER FINANCES',report.NOTES],
      ['DEADLINES & TIMELINE','The timeline follows the dates available in saved records. Date-only purchases do not imply an exact purchase time. Overdue duration is measured at the report preparation time. A date-only shipping deadline becomes overdue at the start of the next Pacific day; exact eBay timestamps are respected.'],
      ['ITEM EVIDENCE & LINKS','Screenshots are matched to the individual item. If a direct video receipt is not saved, the PDF links to the eBay order to find the Live receipt. Order, system, buyer-report and case links may require sign-in. Customer directory and item index entries are clickable.'],
      ['SHIPPING PRIORITY',report.NOTICE],
    ]){await f.ensure(50);await f.write(title,9,1,gold,7);await f.write(body,10,0,ink,18);}
    await f.ensure(24);await link(f.page,'eBay payment-hold policy',report.POLICY_URL,36,f.y);
    for(const [i,meta] of pageMeta.entries()){
      const p=meta.page;
      if(meta.row){
        rule(p,36,104,540);const receipt=buyer.receiptAction(meta.row);
        for(const [label,url,x] of [['eBay order',meta.row.orderUrl,36],['Pending order',meta.row.pendingUrl,142],['System record',meta.row.historyUrl,257],[receipt.pdfLabel,receipt.href,373]])await link(p,label,url,x,84,9);
        if(!meta.row.videoUrl)await text(p,'Receipt link opens the eBay order because no direct video URL is saved.',36,65,7,0,muted);
      }
      rule(p,36,47,540);
      for(const [label,key,x] of [['Customer directory','directory',36],...(meta.customerKey?[['Customer profile',meta.customerKey,180]]:[])]){
        await text(p,label,x,29,8,1,ink);rule(p,x,26,width(label,8,1),gold);
        jumps.push({page:p,rect:[x,23,x+width(label,8,1),40],key});
      }
      await text(p,`${i+1} / ${pageMeta.length}`,530,29,8,0,muted);
    }
    for(const jump of jumps)annotation(jump.page,jump.rect,{Dest:[destinations.get(jump.key),PDFName.of('Fit')]});
    return pdf.save();
  }
  const api={build};root.OGMissingReportPdf=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
