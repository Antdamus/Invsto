/* Vector calendar export; generated locally with the bundled pdf-lib. */
"use strict";
async function buildShowSchedulePdf(model,includeDetails=false,paper="tabloid") {
  const {PDFDocument,StandardFonts,rgb}=window.PDFLib;
  const pdf=await PDFDocument.create();
  const fonts=await Promise.all([StandardFonts.Helvetica,StandardFonts.HelveticaBold,StandardFonts.TimesRoman].map(name=>pdf.embedFont(name)));
  const [W,H]=paper==="letter"?[792,612]:[1224,792];
  const large=paper!=="letter",margin=32;
  const color=hex=>rgb(...hex.match(/\w\w/g).map(s=>parseInt(s,16)/255));
  const ink=color("234f42"),muted=color("67786e"),line=color("dce4db"),paperTint=color("f5f6ef"),gold=color("a18148");
  const clean=v=>String(v??"").replace(/[\u0000-\u001f]/g," ").replace(/[\u2010-\u2015]/g,"-");
  function width(value,size,font=0){
    try{return fonts[font].widthOfTextAtSize(clean(value),size);}catch{
      const ctx=document.createElement("canvas").getContext("2d");ctx.font=`${font===1?"bold ":""}${size}px Arial`;return ctx.measureText(clean(value)).width;
    }
  }
  async function text(page,value,x,y,size=10,font=0,fill=ink){
    const str=clean(value);
    try{fonts[font].encodeText(str);page.drawText(str,{x,y,size,font:fonts[font],color:fill});}
    catch{
      // Names in other scripts are preserved without transmitting report data.
      const canvas=document.createElement("canvas"),ctx=canvas.getContext("2d"),css=`${font===1?"bold ":""}${size*3}px Arial`;
      ctx.font=css;canvas.width=Math.ceil(ctx.measureText(str).width)+6;canvas.height=Math.ceil(size*4.5);ctx.font=css;
      ctx.fillStyle=`rgb(${[fill.red,fill.green,fill.blue].map(c=>Math.round(c*255)).join(",")})`;ctx.fillText(str,0,size*3.4);
      const image=await pdf.embedPng(canvas.toDataURL("image/png"));page.drawImage(image,{x,y:y-size*.35,width:canvas.width/3,height:canvas.height/3});
    }
  }
  function fit(value,max,size,font=0){let s=clean(value);if(width(s,size,font)<=max)return s;while(s&&width(s+"...",size,font)>max)s=s.slice(0,-1);return s+"...";}
  function wrap(value,max,size,font=0){
    const result=[];let current="";
    for(const word of clean(value).split(/\s+/)){
      if(current&&width(current+" "+word,size,font)>max){result.push(current);current="";}
      if(width(word,size,font)>max){for(const c of word){if(width(current+c,size,font)>max){result.push(current);current="";}current+=c;}}
      else current+=(current?" ":"")+word;
    }
    if(current)result.push(current);return result;
  }
  const rect=(p,x,y,w,h,fill)=>p.drawRectangle({x,y,width:w,height:h,color:fill});
  const rule=(p,x1,y1,x2,y2,thickness=.5,fill=line)=>p.drawLine({start:{x:x1,y:y1},end:{x:x2,y:y2},thickness,color:fill});
  const range=`${reportDate(model.start)} - ${reportDate(addDays(model.end,-1))}`;
  const filter=`${showPlatforms[model.platform]} / ${model.sellerLabel}`;
  pdf.setTitle(`Show calendar | ${range}`);pdf.setAuthor("OG Jewelry / Show Studio");
  pdf.setSubject(`Airport Store / ${model.timezone} / ${filter}`);
  pdf.setCreationDate(model.created);
  async function base(title,subtitle){
    const p=pdf.addPage([W,H]);rect(p,0,H-6,W,6,ink);
    await text(p,"OG JEWELRY  /  SHOW STUDIO",margin,H-29,9,1,gold);
    await text(p,"AIRPORT STORE",W-margin-90,H-29,9,1,muted);
    await text(p,title,margin,H-63,large?29:25,2);
    await text(p,fit(subtitle,W-margin*2,9),margin,H-82,9,0,muted);
    return p;
  }
  for(const calendar of model.pages){
    const last=addDays(calendar.end,-1);
    const title=dateKey(calendar.start)===dateKey(last)?reportDate(last,{month:"long",day:"numeric",year:"numeric"}):`${reportDate(calendar.start,{month:"long",day:"numeric"})} - ${reportDate(last)}`;
    const p=await base(title,`${filter}  |  ${model.timezone}  |  Report: ${model.shows} shows / ${Number(model.hours.toFixed(1))} host hours`);
    // Keep a full-name key above each calendar, independent of the optional detailed lineup.
    const people=[...new Map(model.rows.filter(r=>!r.is_blocked).map(r=>[r.seller_employee_id,r])).values()];
    let keyX=margin,keyY=H-102;
    for(const row of people){
      const label=`${showInitials(row.seller_name)}  ${row.seller_name}`,w=Math.min(W-2*margin,width(label,8,1)+20);
      if(keyX+w>W-margin){keyX=margin;keyY-=15;}
      if(keyY<H-132)break;
      rect(p,keyX,keyY-3,w,13,color(reportColor(row).fill));
      await text(p,fit(label,w-10,8,1),keyX+5,keyY,8,1,color(reportColor(row).ink));keyX+=w+8;
    }
    const gridTop=Math.min(H-154,keyY-43),gridBottom=43,gridHeight=gridTop-gridBottom;
    const timeWidth=large?49:42,x0=margin+timeWidth,dayWidth=(W-margin-x0)/calendar.days.length;
    rect(p,margin,gridTop,W-2*margin,31,paperTint);
    await text(p,"TIME",margin+4,gridTop+12,8,1,muted);
    for(const [i,day]of calendar.days.entries()){
      const x=x0+i*dayWidth;
      if(day.outside||[0,6].includes(day.date.getDay()))rect(p,x,gridBottom,dayWidth,gridHeight,color(day.outside?"ecefe9":"fafbf7"));
      const label=reportDate(day.date,{weekday:"short",month:"short",day:"numeric"}).toUpperCase();
      await text(p,label,x+(dayWidth-width(label,large?10:8,1))/2,gridTop+12,large?10:8,1,day.outside?muted:ink);
      rule(p,x,gridBottom,x,gridTop+31);
    }
    rule(p,W-margin,gridBottom,W-margin,gridTop+31);
    for(let half=0;half<=48;half++){
      const y=gridTop-half/48*gridHeight;
      rule(p,x0,y,W-margin,y,half%2?.25:.6,half%2?color("edf0e9"):line);
      if(half%2===0){const h=half/2,label=h===0||h===24?"12 AM":h===12?"12 PM":`${h%12} ${h<12?"AM":"PM"}`;
        await text(p,label,margin+2,y-(h===24?0:3),large?8:7,0,muted);}
    }
    for(const [i,day]of calendar.days.entries())if(day.outside){
      const x=x0+i*dayWidth;
      rect(p,x+3,gridTop-22,dayWidth-6,18,color("ecefe9"));
      await text(p,"Outside range",x+7,gridTop-16,large?8:7,0,muted);
    }
    for(const [i,day]of calendar.days.entries())for(const s of day.segments){
      const x=x0+i*dayWidth+s.lane/s.lanes*dayWidth+2,w=dayWidth/s.lanes-4;
      const top=gridTop-s.from/1440*gridHeight,h=(s.to-s.from)/1440*gridHeight-1;
      const tint=reportColor(s.row),pad=large?5:4;
      rect(p,x,top-h,w,h,color(tint.fill));rect(p,x,top-h,2,h,color(tint.ink));
      const size=large?10:7.6,small=large?8:6.5;
      const channel=showPlatforms[s.row.channel]||s.row.channel;
      const name=(s.row.is_blocked?"Blocked":s.row.seller_name||"Seller")+(s.to-s.from<120?` (${channel})`:"");
      const names=wrap(name,w-pad*2,size,1),lines=[];
      // Short overnight portions reserve room for their visible time range.
      const nameLines=Math.min(names.length,h>size*5?2:1);
      names.slice(0,nameLines).forEach((n,j)=>lines.push({value:j===nameLines-1&&names.length>nameLines?fit(names.slice(j).join(" "),w-pad*2,size,1):n,size,font:1}));
      const overnight=!s.carry&&dateKey(new Date(s.row.start_at))!==dateKey(new Date(s.row.end_at));
      const times=`${s.carry?"12a":reportCompactTime(s.row.start_at)} - ${reportCompactTime(s.row.end_at)}${overnight?" +1":""}`;
      if(h<pad+size+small+8){
        const tiny=Math.max(5,Math.min(small,h-4));
        const label=`${s.row.is_blocked?"Blocked":showInitials(s.row.seller_name)} ${times}`;
        await text(p,fit(label,w-7,tiny,1),x+4,top-tiny-1,tiny,1,color(tint.ink));continue;
      }
      lines.push({value:times,size:small,font:1});
      lines.push({value:`${channel}${s.carry?" / continued":s.continues?" / overnight":""}`,size:small,font:0});
      if(!["booked","blocked"].includes(s.row.status))lines.push({value:reportStatus(s.row),size:small,font:0});
      let y=top-pad;
      for(const l of lines){if(y-l.size<top-h+2)break;y-=l.size;await text(p,fit(l.value,w-pad*2,l.size,l.font),x+pad,y,l.size,l.font,color(tint.ink));y-=3;}
    }
    await text(p,"+1 = ends the next day. Overnight shows continue in the next column. Times shown in local clock hours.",x0,27,large?8:7,0,muted);
  }
  if(includeDetails){
    let p,y;
    async function next(){
      p=await base("The detailed lineup.",`${range}  |  ${filter}  |  ${model.timezone}`);y=H-112;
      const labels=["DATE / HOST","START","END","PLATFORM / STATUS"];
      for(const [i,label]of labels.entries())await text(p,label,margin+(W-margin*2)*[0,.34,.56,.78][i],y,8,1,muted);
      y-=12;rule(p,margin,y,W-margin,y);y-=10;
    }
    await next();
    if(!model.rows.length)await text(p,"No shows match this range and these filters.",margin,y-20,12);
    for(const row of model.rows){
      const total=W-2*margin,name=row.is_blocked?"Blocked":row.seller_name||"Seller",fontSize=large?11:9;
      const names=wrap(name,total*.31,fontSize,1),height=Math.max(50,28+names.length*(fontSize+3));
      if(y-height<55)await next();
      const tint=reportColor(row);rect(p,margin,y-height+4,total,height,color(tint.fill));
      await text(p,reportDate(row.start_at,{weekday:"short",month:"short",day:"numeric",year:"numeric"}),margin+8,y-12,8,0,muted);
      for(const [i,nameLine]of names.entries())await text(p,nameLine,margin+8,y-27-i*(fontSize+3),fontSize,1);
      for(const [i,value]of [row.start_at,row.end_at].entries()){
        const x=margin+total*(i===0?.34:.56);
        await text(p,reportTime(value),x,y-16,fontSize,1);
        await text(p,reportDate(value),x,y-31,8,0,muted);
      }
      const x=margin+total*.78;
      await text(p,showPlatforms[row.channel]||row.channel,x,y-16,fontSize,1);
      await text(p,fit(reportStatus(row),total*.21,8),x,y-31,8,0,muted);
      y-=height+5;
    }
  }
  const pages=pdf.getPages();
  for(const [i,p]of pages.entries()){
    await text(p,`Saved shows / generated ${reportDate(model.created)} ${reportTime(model.created)}`,margin,12,7,0,muted);
    const number=`${i+1} / ${pages.length}`;await text(p,number,W-margin-width(number,8),12,8,1,muted);
  }
  return pdf.save();
}
