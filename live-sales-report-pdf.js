(function(root){
  'use strict';
  async function build(model,progress=()=>{}){
    const M=root.OGLiveReportModel,{PDFDocument,StandardFonts,rgb,PDFName,PDFString}=root.PDFLib;
    const pdf=await PDFDocument.create(),fonts=await Promise.all([StandardFonts.Helvetica,StandardFonts.HelveticaBold,StandardFonts.TimesRoman].map(f=>pdf.embedFont(f)));
    const color=h=>rgb(...h.match(/\w\w/g).map(x=>parseInt(x,16)/255));
    const ink=color('18392e'),muted=color('64766d'),gold=color('a8813c'),paper=color('f7f5ef'),white=rgb(1,1,1),line=color('dce2d9');
    const green=color('e9f1e9'),rose=color('fae9e9'),amber=color('fff0cf');
    const lossRed=color('852c22');
    const tint=r=>r.loss>0?rose:r.state==='paid'?green:r.state==='failed'?rose:r.state==='waiting'?amber:white;
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
    await cards(f,[['Gross margin',s.pricedPaid?M.money(s.margin):'Not priced',`${s.pricedPaid}/${s.paid.count} paid purchases priced; before expenses / refunds`],[M.buyerProfit(s).label,s.profitCovered?M.money(s.profit):'Not complete',M.buyerProfit(s).basis+'; known costs only'],['Needs base cost',String(s.missingCosts),'Paid purchases excluded from margin until a cost is set',amber]]);
    await f.write(`eBay fees on paid purchases: ${M.money(s.actualFees)} actual (${s.actualFeeItems} items) / ${M.money(s.estimatedFees)} estimated (${s.estimatedFeeItems} items). Estimates are replaced after eBay fees sync. Postage is excluded unless entered.`,10,0,muted,12);
    await f.write(`${s.review.count} need review / ${s.cancelled.count} canceled / ${s.resolved.count} resolved. These purchases are excluded from paid revenue.`,10,0,muted,16);
    if(model.unmatched)await f.write(`${model.unmatched} capture notifications still await matching. Review the Live Sales queue; unmatched notifications are not counted as additional purchases.`,9,0,muted,12);
    if(s.missingAmounts)await f.write(`${s.missingAmounts} purchases have no recorded sale amount. Totals exclude those unknown amounts.`,10,1,color('9b5b18'));
    await f.write('A BEAUTIFUL RECORD. A CLEAR NEXT STEP.',9,1,gold,8);
    await f.write('Start with the buyer directory, then open a buyer’s item index. Select any item to see its screenshots, sale details and costs. Every page has links back to the directory and overview; item pages also return to their buyer.',11,0,ink,12);
    await f.write('This PDF is a snapshot. The live report refreshes every five seconds while open.',9,0,muted);
    f=await start('Profit by category','categories');await f.write('Profit, by category.',30,2,ink,12);
    await f.write('Material and item type are separate views of the same paid purchases. Gold earrings appear in both Gold and Earrings, and each view totals separately. Pending and failed payments are excluded.',10,0,muted,16);
    for(const [axis,label] of [['materials','BY MATERIAL'],['types','BY ITEM TYPE']]){
      await f.write(label,11,1,gold,10);
      await cards(f,model.breakdowns[axis].map(g=>{const p=M.buyerProfit(g.stats,model.expensesKnown);return [g.label,p.amount==null?p.status:M.money(p.amount),`${p.label}. ${p.basis}${p.partial?' / PARTIAL':''}. ${p.coverage}. ${p.missing?p.missing+'. ':''}${M.money(g.stats.paid.amount)} paid / ${g.stats.expectedItems} units.${g.key==='silver'?' '+g.assumedSilver+' paid purchases assume silver from weight.':''}`,p.amount<0?rose:p.partial?amber:white];}));
    }
    await f.write('Categories use title clues, including common earrings spellings and watch terms or brands. Explicit material corrections override title guesses. Unclear and mixed titles remain in Other. Missing costs are excluded from profit and flagged.',10,0,muted,12);
    f=await start('Buyer directory','directory');await f.write('The buyer directory.',30,2,ink,10);await f.write('Buyers with individual losses appear first and are highlighted. Select a buyer to inspect their items. Expected paid items exclude pending and failed payments. Buyer profit includes only paid purchases with known costs and sale amounts; Partial means some paid purchases are excluded.',10,0,muted,12);
    if(s.lossItems)await f.write(`${s.lossItems} paid ${s.lossItems===1?'purchase':'purchases'} at a loss / ${M.money(s.lossAmount)} loss on those items / ${model.lossBasis}. Other profitable purchases do not offset these flags.`,10,1,lossRed,18);
    for(const b of model.customers){
      const profit=M.buyerProfit(b.stats,model.expensesKnown);
      const profitLine=`${profit.label}: ${profit.amount==null?profit.status:M.money(profit.amount)}${profit.partial?' / PARTIAL':''}`;
      const coverageLine=`${profit.basis}. ${profit.coverage}${profit.missing?' / '+profit.missing:''}`;
      const title=b.username+(b.name?' / '+b.name:''),paidLine=`${b.stats.expectedItems} expected paid items · ${M.money(b.stats.paid.amount)} paid · ${b.stats.items} total purchases`,detailLine=`${b.stats.waiting.count} pending (${M.money(b.stats.waiting.amount)}) / ${b.stats.failed.count} failed (${M.money(b.stats.failed.amount)}) / ${b.stats.missingCosts} paid items need base cost`,lossLine=b.stats.lossItems?`REVIEW LOSSES: ${b.stats.lossItems} paid ${b.stats.lossItems===1?'purchase':'purchases'} / ${M.money(b.stats.lossAmount)} loss / ${model.lossBasis}`:'';
      const h=61+wrap(profitLine,510,11,1).length*15.4+wrap(coverageLine,510,9).length*12.6+wrap(title,510,14,1).length*19.6+wrap(paidLine,510,10).length*14+wrap(detailLine,510,9).length*12.6+(lossLine?8+wrap(lossLine,510,10,1).length*14:0);
      await f.ensure(h+12);const top=f.y;rect(f.p,36,top-h,540,h,b.stats.lossItems?rose:white);if(b.stats.lossItems)rect(f.p,36,top-h,4,h,lossRed);
      let y=await block(f.p,title,50,top-23,510,14,1);y=await block(f.p,paidLine,50,y-8,510,10);y=await block(f.p,detailLine,50,y-5,510,9,0,muted);y=await block(f.p,profitLine,50,y-9,510,11,1,profit.amount<0?lossRed:ink);y=await block(f.p,coverageLine,50,y-7,510,9,0,muted);if(lossLine)await block(f.p,lossLine,50,y-8,510,10,1,lossRed);
      jumps.push({p:f.p,box:[36,top-h,576,top],key:b.key});f.y-=h+12;
    }
    if(!model.customers.length)await f.write('No purchases captured yet.',16,2);
    f=await start('Cost assumptions','assumptions');await f.write('Your cost studio.',30,2,ink,12);await f.write('Assumptions saved for this show at the time of export. All amounts are USD.',10,0,muted,18);
    await f.write('Shared rates are current cost estimates. Gold without purity assumes 10K; silver assumes 925. A clear gram weight without a material assumes sterling silver 925. Show overrides take priority. Exported PDFs retain this snapshot.',10,0,muted,12);
    await f.write('TITLE COST RULES / GLOBAL',11,1,gold,10);
    await f.write('Individual manual costs and material corrections take priority. Otherwise, the longest enabled phrase found in the title supplies the total base cost per auction, before gram-based calculations. Matching ignores case and extra spaces. Equal-length matches with different costs require review.',10,0,muted,12);
    if(!model.settings.titleRules?.length)await f.write('No title cost rules saved.',10,0,muted,12);
    for(const r of model.settings.titleRules||[])await f.write(`${r.enabled?'Enabled':'Disabled'} / Title contains “${r.phrase}” / ${M.money(M.cents(r.base_cost))} total base cost per auction`,10,0,ink,8);
    await f.write('MATERIAL RATES',11,1,gold,12);
    for(const key of M.RATE_KEYS){await f.write(`${key==='silver'?'Sterling silver 925':key.replace('gold_','')+'K gold'} / gram: ${M.number(model.settings.rates?.[key])==null?'Not set':'$'+Number(model.settings.rates[key]).toLocaleString('en-US',{maximumFractionDigits:4})}${Object.hasOwn(model.settings.showRates||{},key)?' / Show override':model.settings.globalRates?.[key]!=null?' / Global default':''}`,11);}
    await f.write(`Fee: ${M.number(model.settings.fee_percent)??5.5}% / Fixed fee per eBay order: ${M.money(M.cents(model.settings.fee_fixed)??30)} / Postage estimate per auction: ${M.cents(model.settings.shipping_per_sale)==null?'Excluded until entered':M.money(M.cents(model.settings.shipping_per_sale))}`,10,1,ink,20);
    for(const note of ['Gold without stated purity assumes 10K. A clear gram weight with no material specified assumes sterling silver 925; the assumption is labeled on each item. Silver and gold require a clear gram weight and a matching saved rate. Without a matching title cost rule, plated, mixed-metal and ambiguous titles require a manual cost or an explicit correction.','A manual base cost is the total cost of that auction, including a bundle. Missing costs remain unknown and are excluded from margin; a saved zero is a deliberate zero cost.','Gross margin = paid item amount minus base cost. Profit adds known buyer-paid shipping income and deducts actual eBay fees, or estimates until actual fees sync. The default is 5.5% of checkout (shipping and tax included) plus $0.30 per eBay order, shared across all its lines. Early estimates may lack shipping and tax. Postage is excluded unless entered; tax is never income. Refunds and later adjustments are not reconciled; this is not a final settlement statement.','Buyer names and order/video links appear after import and matching. Missing data is labeled. Item counts use matched order-line quantity when available, otherwise one per auction; an auction bundle may contain additional physical pieces.'])await f.write(note,10,0,muted,16);
    for(const b of model.customers){buyerKey=b.key;f=await start(b.username+' / Item index',b.key);await f.write('BUYER COLLECTION / ITEM INDEX',9,1,gold,12);await f.write(b.username,30,2,ink,8);await f.write(b.name||'Customer name not yet available',13,0,muted,20);
      const profit=M.buyerProfit(b.stats,model.expensesKnown);
      await cards(f,[['Expected paid items',String(b.stats.expectedItems),`${b.stats.paid.count} paid / ${b.stats.items} total purchases`,green],['Confirmed paid',M.money(b.stats.paid.amount),`${b.stats.waiting.count} pending / ${b.stats.failed.count} failed`],[profit.label,profit.amount==null?profit.status:M.money(profit.amount),`${profit.partial?'PARTIAL / ':''}${profit.coverage}. ${profit.basis}.${profit.missing?' '+profit.missing:''}`,profit.amount<0?rose:profit.partial?amber:white]]);
      if(b.stats.lossItems)await f.write(`REVIEW ${b.stats.lossItems} PAID ${b.stats.lossItems===1?'PURCHASE':'PURCHASES'} AT A LOSS / ${M.money(b.stats.lossAmount)} / ${model.lossBasis}. Highlighted items below need inspection.`,11,1,lossRed,14);
      await f.write('Select an item below for photos, links and cost details.',9,0,muted,16);
      for(const r of b.rows){
        const profit=M.itemProfit(r,model.expensesKnown);
        const lines=[
          {value:`#${r.ordinal} / ${r.title}`,size:11,gap:7,fill:ink},
          {value:`${M.money(r.price)} / ${r.stateLabel} / Base: ${r.cost.base==null?'NEEDS BASE PRICE':M.money(r.cost.base)}${r.cost.rule?(r.cost.rule.conflict?' / CONFLICTING TITLE RULES':' / Title rule'):r.cost.parsed?.assumption?' ('+r.cost.parsed.assumption+')':''}`,size:9,gap:7,fill:ink},
          {value:`${profit.label}: ${profit.amount==null?profit.status:M.money(profit.amount)}${profit.status==='Loss'?' / LOSS':profit.status==='Break-even'?' / Break-even':''} / ${profit.basis}`,size:10,gap:5,fill:profit.amount<0?lossRed:profit.amount>0?color('276649'):muted},
          {value:`${r.time} / ${r.photos.length} screenshots${r.orderNumber?' / Order '+r.orderNumber:''}`,size:8,gap:0,fill:muted,font:0}
        ];
        const h=25+lines.reduce((height,l)=>height+wrap(l.value,510,l.size,l.font??1).length*l.size*1.4+l.gap,0);
        await f.ensure(h+12);const top=f.y;rect(f.p,36,top-h,540,h,tint(r));let y=top-19;
        for(const l of lines)y=await block(f.p,l.value,50,y,510,l.size,l.font??1,l.fill)-l.gap;
        jumps.push({p:f.p,box:[36,top-h,576,top],key:r.key});f.y-=h+12;
      }
      for(const r of b.rows){progress(`Building PDF: ${r.username} / Bag #${r.ordinal}...`);f=await start(`Bag #${r.ordinal} / ${r.username}`,r.key,r);await f.write(`BAG #${r.ordinal} / ${r.username}`,10,1,gold,8);await f.write(r.title,24,2,ink,12);
        await f.ensure(52);rect(f.p,36,f.y-42,540,42,tint(r));await text(f.p,`${M.money(r.price)} / ${r.stateLabel}`,50,f.y-26,17,1);f.y-=60;
        await f.write(`Buyer: ${r.username}${r.name?' / '+r.name:b.name?' / '+b.name:''}`,10,1,ink,5);await f.write(`Sold: ${r.time}${r.timeNote?' / '+r.timeNote:''}`,10,0,ink,5);await f.write(`Order: ${r.orderNumber||'Awaiting order import / matching'} / Quantity: ${r.quantity}`,10,0,muted,5);await f.write(`Seller: ${r.seller_name||'Not recorded'} / Bag: ${r.closed_at?'Closed':r.resolved_at?'Resolved':'Open'}${r.payment_hold?' / Payment hold':''}`,9,0,muted,16);
        if(r.loss>0)await f.write(`ITEM AT A LOSS: ${M.money(r.loss)} / ${model.lossBasis}`,13,1,lossRed,12);
        await f.write(`Base cost: ${r.cost.base==null?'NEEDS BASE PRICE':M.money(r.cost.base)}`,13,1,ink,5);await f.write(r.cost.source,10,0,muted,8);if(r.cost.note)await f.write('Cost note: '+r.cost.note,10,0,muted,10);
        await f.write(`Gross margin: ${r.state!=='paid'?'Excluded until confirmed paid':r.margin==null?'Needs base price':M.money(r.margin)} / ${M.itemProfit(r).label}: ${r.state!=='paid'?'Excluded':r.profit==null?M.itemProfit(r).status:M.money(r.profit)}`,10,1,ink,12);
        const fin=r.finance;
        await f.write(`${fin.source==='actual'?'Actual eBay fee':fin.source==='estimated'?'Estimated eBay fee':'Fee needs review'}: ${fin.fee==null?'Unavailable':M.money(fin.fee)} / ${fin.note}`,10,1,ink,8);
        await f.write(`Buyer-paid shipping: ${fin.shippingKnown?M.money(fin.shipping):'Awaiting import'} / Fee basis including tax: ${fin.basis==null?'Unknown':M.money(fin.basis)}${fin.basisKnown?'':' (provisional)'} / Postage: ${fin.beforePostage?'Not included yet':M.money(fin.postage)+' estimate'}`,9,0,muted,8);
        if(fin.caveat||fin.allocation)await f.write([fin.caveat,fin.allocation].filter(Boolean).join(' '),9,0,muted,8);
        if(fin.source==='actual'&&fin.syncedAt)await f.write('Fee data synced: '+M.date(fin.syncedAt),8,0,muted,8);
        await f.ensure(60);await f.write('ORDER & RECEIPT LINKS',8,1,gold,6);let x=36;
        for(const [label,url]of r.links){const w=width(label,9,1)+22;if(x+w>576){f.y-=23;x=36;await f.ensure(24);}await external(f.p,label,url,x,f.y,9);x+=w;}f.y-=29;
        if(M.receiptNote(r))await f.write(M.receiptNote(r),9,0,muted,14);
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
