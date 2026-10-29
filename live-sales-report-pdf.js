(function(root){
  'use strict';
  async function build(model,progress=()=>{}){
    const M=root.OGLiveReportModel,{PDFDocument,StandardFonts,rgb,PDFName,PDFString}=root.PDFLib;
    const pdf=await PDFDocument.create(),fonts=await Promise.all([StandardFonts.Helvetica,StandardFonts.HelveticaBold,StandardFonts.TimesRoman].map(f=>pdf.embedFont(f)));
    const color=h=>rgb(...h.match(/\w\w/g).map(x=>parseInt(x,16)/255));
    const ink=color('18392e'),muted=color('64766d'),gold=color('a8813c'),paper=color('f7f5ef'),white=rgb(1,1,1),line=color('dce2d9');
    const green=color('e9f1e9'),rose=color('fae9e9'),amber=color('fff0cf');
    const tint=r=>r.state==='paid'?green:r.state==='failed'?rose:r.state==='waiting'?amber:white;
    const pages=[],destinations=new Map(),jumps=[];let buyerKey=null;
    pdf.setTitle(model.title+' | Live sales ledger');pdf.setAuthor('OG Jewelers');pdf.setSubject('Snapshot '+model.date);
    const clean=v=>String(v??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');
    function width(value,size=10,font=0){
      try{return [...clean(value)].reduce((w,c)=>w+fonts[font].widthOfTextAtSize(c,size),0);}
      catch{const ctx=document.createElement('canvas').getContext('2d');ctx.font=`${font===1?'bold ':''}${size}px ${font===2?'Georgia':'Arial'}`;return ctx.measureText(clean(value)).width;}
    }
    function wrap(value,w=540,size=10,font=0){
      const result=[];for(const p of clean(value).split(/\r?\n/)){let current='';
        for(const word of p.split(/\s+/).filter(Boolean)){
          if(current&&width(current+' '+word,size,font)>w){result.push(current);current='';}
          if(width(word,size,font)>w){for(const c of word){if(current&&width(current+c,size,font)>w){result.push(current);current='';}current+=c;}}
          else current=current?current+' '+word:word;
        }result.push(current);
      }return result;
    }
    async function text(page,value,x,y,size=10,font=0,fill=ink){
      const s=clean(value);try{fonts[font].encodeText(s);page.drawText(s,{x,y,size,font:fonts[font],color:fill});}
      catch{
        // Preserve names and titles outside the built-in fonts without sending them elsewhere.
        const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d'),css=`${font===1?'bold ':''}${size*3}px ${font===2?'Georgia':'Arial'}`;
        ctx.font=css;canvas.width=Math.ceil(ctx.measureText(s).width)+6;canvas.height=Math.ceil(size*4.5);ctx.font=css;
        ctx.fillStyle=`rgb(${[fill.red,fill.green,fill.blue].map(c=>Math.round(c*255)).join(',')})`;ctx.fillText(s,0,size*3.4);
        const img=await pdf.embedPng(canvas.toDataURL('image/png'));page.drawImage(img,{x,y:y-size*.35,width:canvas.width/3,height:canvas.height/3});
      }
    }
    async function block(p,value,x,y,w=540,size=10,font=0,fill=ink){for(const s of wrap(value,w,size,font)){await text(p,s,x,y,size,font,fill);y-=size*1.4;}return y;}
    const rect=(p,x,y,w,h,fill)=>p.drawRectangle({x,y,width:w,height:h,color:fill});
    const rule=(p,x,y,w)=>p.drawLine({start:{x,y},end:{x:x+w,y},thickness:.7,color:line});
    function annotation(p,box,action){const ref=pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Link',Rect:box,Border:[0,0,0],...action})),existing=p.node.lookup(PDFName.of('Annots'));if(existing)existing.push(ref);else p.node.set(PDFName.of('Annots'),pdf.context.obj([ref]));}
    async function external(p,label,url,x,y,size=9){await text(p,label,x,y,size,1);annotation(p,[x,y-4,x+width(label,size,1),y+size+2],{A:{Type:'Action',S:'URI',URI:PDFString.of(url)}});}
    async function page(label,row){const p=pdf.addPage([612,792]);rect(p,0,0,612,792,paper);rect(p,0,784,612,8,gold);await text(p,'OG JEWELERS / THE LIVE LEDGER',36,754,8,1,gold);await text(p,model.date,326,754,8,0,muted);rule(p,36,741,540);pages.push({p,label,row,buyerKey});return p;}
    async function start(label,key,row){const p=await page(label,row);if(key)destinations.set(key,p.ref);return flow(p,710,label,row);}
    function flow(p,y,label,row){return {p,y,async ensure(h){if(this.y-h<76){this.p=await page(label,row);this.y=await block(this.p,label+' / CONTINUED',36,710,540,10,1,gold)-15;}},async write(v,size=10,font=0,fill=ink,gap=8){for(const s of wrap(v,540,size,font)){await this.ensure(size*1.4);await text(this.p,s,36,this.y,size,font,fill);this.y-=size*1.4;}this.y-=gap;}};}
    async function cards(f,items){
      for(let offset=0;offset<items.length;offset+=3){const group=items.slice(offset,offset+3),h=Math.max(...group.map(([label,value,note])=>32+wrap(label,148,8,1).length*11.2+wrap(value,148,20,1).length*28+wrap(note,148,8).length*11.2));await f.ensure(h+14);
        for(const [i,[label,value,note,bg=white]]of group.entries()){const x=36+i*184;rect(f.p,x,f.y-h,172,h,bg);let y=await block(f.p,label.toUpperCase(),x+12,f.y-19,148,8,1,muted);y=await block(f.p,value,x+12,y-9,148,20,1);await block(f.p,note,x+12,y-5,148,8,0,muted);}f.y-=h+14;
      }
    }
    let f=await start('Show overview','overview');
    await f.write('THE LIVE SALES COLLECTION',9,1,gold,16);await f.write(model.title,33,2,ink,12);
    await f.write(`${model.show.session_code||'Live show'} / ${model.customers.length} buyers / ${model.rows.length} purchases`,11,1,ink,7);
    await f.write(`Snapshot ${model.date} · All times Eastern`,9,0,muted,5);
    await f.write(`Report data updated: ${M.date(model.updatedAt)||'Unknown'} / Capture signal: ${M.date(model.connection.source_seen_at)||'Not recorded'}`,8,0,muted,18);
    const s=model.stats;
    await cards(f,[['Confirmed paid',M.money(s.paid.amount),`${s.paid.count} purchases / ${s.expectedItems} expected paid items`,green],['Pending payment',M.money(s.waiting.amount),`${s.waiting.count} purchases / excluded from paid`,amber],['Payment failed',M.money(s.failed.amount),`${s.failed.count} purchases / excluded from paid`,rose]]);
    await cards(f,[['Gross margin',s.pricedPaid?M.money(s.margin):'Not priced',`${s.pricedPaid}/${s.paid.count} paid purchases priced; before expenses / refunds`],['Estimated profit',model.expensesKnown&&s.pricedPaid?M.money(s.profit):'Not complete','After saved fee and shipping assumptions; priced paid items only'],['Needs base cost',String(s.missingCosts),'Paid purchases excluded from margin until a cost is set',amber]]);
    await f.write(`${s.review.count} need review / ${s.cancelled.count} canceled / ${s.resolved.count} resolved. These purchases are excluded from paid revenue.`,10,0,muted,16);
    if(model.unmatched)await f.write(`${model.unmatched} capture notifications still await matching. Review the Live Sales queue; unmatched notifications are not counted as additional purchases.`,9,0,muted,12);
    if(s.missingAmounts)await f.write(`${s.missingAmounts} purchases have no recorded sale amount. Totals exclude those unknown amounts.`,10,1,color('9b5b18'));
    await f.write('A BEAUTIFUL RECORD. A CLEAR NEXT STEP.',9,1,gold,8);
    await f.write('Start with the buyer directory, then open a buyer’s item index. Select any item to see its screenshots, sale details and costs. Every page has links back to the directory and overview; item pages also return to their buyer.',11,0,ink,12);
    await f.write('This PDF is a snapshot. The live report refreshes every five seconds while open.',9,0,muted);
    f=await start('Buyer directory','directory');await f.write('The buyer directory.',30,2,ink,10);await f.write('Select a buyer to open their item index. Expected paid items exclude pending and failed payments.',10,0,muted,20);
    for(const b of model.customers){const title=b.username+(b.name?' / '+b.name:''),h=76+wrap(title,510,14,1).length*19.6;await f.ensure(h+12);const top=f.y;rect(f.p,36,top-h,540,h,white);let y=await block(f.p,title,50,top-23,510,14,1);y=await block(f.p,`${b.stats.expectedItems} expected paid items · ${M.money(b.stats.paid.amount)} paid · ${b.stats.items} total purchases`,50,y-8,510,10);await block(f.p,`${b.stats.waiting.count} pending (${M.money(b.stats.waiting.amount)}) / ${b.stats.failed.count} failed (${M.money(b.stats.failed.amount)}) / ${b.stats.missingCosts} paid items need base cost`,50,y-5,510,9,0,muted);jumps.push({p:f.p,box:[36,top-h,576,top],key:b.key});f.y-=h+12;}
    if(!model.customers.length)await f.write('No purchases captured yet.',16,2);
    f=await start('Cost assumptions','assumptions');await f.write('Your cost studio.',30,2,ink,12);await f.write('Assumptions saved for this show at the time of export. All amounts are USD.',10,0,muted,18);
    for(const key of M.RATE_KEYS){await f.write(`${key==='silver'?'Silver':key.replace('gold_','')+'K gold'} / gram: ${M.number(model.settings.rates?.[key])==null?'Not set':'$'+Number(model.settings.rates[key]).toLocaleString('en-US',{maximumFractionDigits:4})}`,11);}
    await f.write(`Fee: ${M.number(model.settings.fee_percent)==null?'Not set':model.settings.fee_percent+'%'} / Fixed fee per auction: ${M.money(M.cents(model.settings.fee_fixed))} / Shipping per auction: ${M.money(M.cents(model.settings.shipping_per_sale))}`,10,1,ink,20);
    for(const note of ['Gold without stated purity assumes 10K. Silver and gold require a clear gram weight and a matching saved rate. Plated, mixed-metal and ambiguous titles require a manual cost or an explicit correction.','A manual base cost is the total cost of that auction, including a bundle. Missing costs remain unknown and are excluded from margin; a saved zero is a deliberate zero cost.','Gross margin = confirmed paid item amount minus base cost. Estimated profit also subtracts estimated fees and shipping. Fixed expenses apply per paid auction; grouped shipments may cost less. Refunds and final eBay settlement fees are not reconciled by this live estimate.','Buyer names and order/video links appear after import and matching. Missing data is labeled. Item counts use matched order-line quantity when available, otherwise one per auction; an auction bundle may contain additional physical pieces.'])await f.write(note,10,0,muted,16);
    for(const b of model.customers){buyerKey=b.key;f=await start(b.username+' / Item index',b.key);await f.write('BUYER COLLECTION / ITEM INDEX',9,1,gold,12);await f.write(b.username,30,2,ink,8);await f.write(b.name||'Customer name not yet available',13,0,muted,20);
      await cards(f,[['Expected paid items',String(b.stats.expectedItems),`${b.stats.paid.count} paid / ${b.stats.items} total purchases`,green],['Confirmed paid',M.money(b.stats.paid.amount),`${b.stats.waiting.count} pending / ${b.stats.failed.count} failed`],['Gross margin',b.stats.pricedPaid?M.money(b.stats.margin):'Not priced',`${b.stats.pricedPaid}/${b.stats.paid.count} paid priced; ${b.stats.missingCosts} need cost`]]);
      await f.write('Select an item below for photos, links and cost details.',9,0,muted,16);
      for(const r of b.rows){const title=`#${r.ordinal} / ${r.title}`,h=72+wrap(title,510,11,1).length*15.4;await f.ensure(h+12);const top=f.y;rect(f.p,36,top-h,540,h,tint(r));let y=await block(f.p,title,50,top-19,510,11,1);y=await block(f.p,`${M.money(r.price)} / ${r.stateLabel} / Base: ${r.cost.base==null?'NEEDS BASE PRICE':M.money(r.cost.base)}${r.cost.parsed?.assumed?' (10K assumed)':''}`,50,y-7,510,9,1);await block(f.p,`${r.time} / ${r.photos.length} screenshots${r.orderNumber?' / Order '+r.orderNumber:''}`,50,y-5,510,8,0,muted);jumps.push({p:f.p,box:[36,top-h,576,top],key:r.key});f.y-=h+12;}
      for(const r of b.rows){progress(`Building PDF: ${r.username} / Bag #${r.ordinal}...`);f=await start(`Bag #${r.ordinal} / ${r.username}`,r.key,r);await f.write(`BAG #${r.ordinal} / ${r.username}`,10,1,gold,8);await f.write(r.title,24,2,ink,12);
        await f.ensure(52);rect(f.p,36,f.y-42,540,42,tint(r));await text(f.p,`${M.money(r.price)} / ${r.stateLabel}`,50,f.y-26,17,1);f.y-=60;
        await f.write(`Buyer: ${r.username}${r.name?' / '+r.name:b.name?' / '+b.name:''}`,10,1,ink,5);await f.write(`Sold: ${r.time}${r.timeNote?' / '+r.timeNote:''}`,10,0,ink,5);await f.write(`Order: ${r.orderNumber||'Awaiting order import / matching'} / Quantity: ${r.quantity}`,10,0,muted,5);await f.write(`Seller: ${r.seller_name||'Not recorded'} / Bag: ${r.closed_at?'Closed':r.resolved_at?'Resolved':'Open'}${r.payment_hold?' / Payment hold':''}`,9,0,muted,16);
        await f.write(`Base cost: ${r.cost.base==null?'NEEDS BASE PRICE':M.money(r.cost.base)}`,13,1,ink,5);await f.write(r.cost.source,10,0,muted,8);if(r.cost.note)await f.write('Cost note: '+r.cost.note,10,0,muted,10);
        await f.write(`Gross margin: ${r.state!=='paid'?'Excluded until confirmed paid':r.margin==null?'Needs base price':M.money(r.margin)} / Estimated profit: ${r.state!=='paid'?'Excluded':r.profit==null?'Costs / expenses incomplete':M.money(r.profit)}`,10,1,ink,12);
        await f.ensure(60);await f.write('ORDER & RECEIPT LINKS',8,1,gold,6);let x=36;
        for(const [label,url]of r.links){const w=width(label,9,1)+22;if(x+w>576){f.y-=23;x=36;await f.ensure(24);}await external(f.p,label,url,x,f.y,9);x+=w;}f.y-=29;
        if(!r.orderNumber||!r.videoUrl)await f.write(!r.orderNumber?'Order and video receipt are not yet matched. New links appear in the live report after import.':'No direct video URL is saved. Find receipt in order opens eBay to check the Live receipt.',9,0,muted,14);
        if(!r.photos.length){await f.ensure(150);rect(f.p,36,f.y-135,540,135,green);await text(f.p,'ITEM EVIDENCE',54,f.y-35,9,1,muted);await text(f.p,'No screenshots attached yet.',54,f.y-66,21,2,muted);await text(f.p,'New saved screenshots will appear in the live report.',54,f.y-92,10,0,muted);f.y-=150;}
        for(const [i,photo]of r.photos.entries()){
          await f.ensure(210);const h=Math.min(430,f.y-90);rect(f.p,36,f.y-h,540,h,white);
          let loaded=false;try{if(!photo.url)throw Error('No image URL');const response=await fetch(photo.url);if(!response.ok)throw Error('Image unavailable');const data=new Uint8Array(await response.arrayBuffer());let img;try{img=await pdf.embedJpg(data);}catch{img=await pdf.embedPng(data);}const scale=Math.min(516/img.width,(h-40)/img.height);f.p.drawImage(img,{x:48+(516-img.width*scale)/2,y:f.y-h+30+(h-40-img.height*scale)/2,width:img.width*scale,height:img.height*scale});loaded=true;}catch{await block(f.p,'Screenshot could not be loaded. Open the live report and refresh to retry.',54,f.y-65,504,14,2,muted);}
          await text(f.p,`Screenshot ${i+1} of ${r.photos.length}${loaded?'':' / unavailable'} / ${M.date(photo.captured_at)||'Capture time not recorded'}`,48,f.y-h+13,8,0,muted);f.y-=h+20;
        }
      }
    }
    for(const [i,meta]of pages.entries()){const p=meta.p;rule(p,36,49,540);for(const [label,key,x]of [['Buyer directory','directory',36],['Show overview','overview',156],...(meta.buyerKey?[['This buyer’s index',meta.buyerKey,276]]:[['Cost assumptions','assumptions',276]])]){await text(p,label,x,30,8,1);jumps.push({p,box:[x,24,x+width(label,8,1),41],key});}await text(p,`${i+1} / ${pages.length}`,530,30,8,0,muted);}
    for(const jump of jumps){const target=destinations.get(jump.key);if(target)annotation(jump.p,jump.box,{Dest:[target,PDFName.of('Fit')]});}
    return pdf.save();
  }
  root.OGLiveReportPdf={build};if(typeof module!=='undefined')module.exports={build};
})(typeof window!=='undefined'?window:globalThis);
