/* Read-only report workspace. Exports use the same freshly loaded snapshot as the preview. */
"use strict";
const showReport = { model:null, page:0, request:0, exporting:false, url:null };
const reportPalette = [
  {fill:"e8f1eb",ink:"2e5d49"}, {fill:"edf0f8",ink:"485e89"},
  {fill:"f6eedd",ink:"80612b"}, {fill:"f2eaf4",ink:"765582"},
];
const reportDate = (d,options={month:"short",day:"numeric",year:"numeric"}) => new Date(d).toLocaleDateString("en-US",options);
const reportTime = d => new Date(d).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"});
const reportCompactTime = d => reportTime(d).replace(":00","").replace(" AM","a").replace(" PM","p");
const reportColor = row => row.is_blocked ? {fill:"eeede9",ink:"6c6a61"} : reportPalette[[...String(row.seller_employee_id||"")].reduce((n,c)=>n+c.charCodeAt(0),0)%4];
const reportStatus = row => ({booked:"Scheduled",edit_pending:"Change requested",cancel_pending:"Cancellation requested",checked_in:"Checked in",in_progress:"In progress",completed:"Completed",no_show:"No show",blocked:"Blocked"})[row.status] || row.status || "Scheduled";
function reportRowLabel(row) {
  return `${row.is_blocked?"Blocked":row.seller_name} · ${showPlatforms[row.channel]||row.channel} · ${reportDate(row.start_at)} ${reportTime(row.start_at)} to ${reportDate(row.end_at)} ${reportTime(row.end_at)} · ${reportStatus(row)}`;
}
function reportDaySegments(rows,day) {
  const end=addDays(day,1);
  const segments=rows.filter(r=>new Date(r.start_at)<end&&new Date(r.end_at)>day).map(row=>{
    const start=new Date(row.start_at),finish=new Date(row.end_at);
    const from=start<day?0:start.getHours()*60+start.getMinutes();
    let to=finish>=end?1440:finish.getHours()*60+finish.getMinutes();
    // During a repeated DST hour, preserve a visible slot; the exact timestamps remain in the lineup.
    if(to<=from)to=Math.min(1440,from+(finish-start)/60000);
    return {row,from,to,carry:start<day,continues:finish>end,lane:0,lanes:1};
  }).sort((a,b)=>a.from-b.from||b.to-a.to);
  // Assign lanes to each connected overlap group, keeping simultaneous hosts visible.
  let group=[],groupEnd=-1;
  function assign(){
    const ends=[];
    for(const segment of group){let lane=ends.findIndex(end=>end<=segment.from);if(lane<0)lane=ends.length;ends[lane]=segment.to;segment.lane=lane;}
    group.forEach(s=>s.lanes=ends.length);
  }
  for(const s of segments){if(s.from>=groupEnd){assign();group=[];groupEnd=-1;}group.push(s);groupEnd=Math.max(groupEnd,s.to);}
  assign();return segments;
}
function buildShowReportModel(rows,start,end,platform,seller,sellerLabel) {
  const unique=new Map();
  rows.forEach(r=>unique.set(`${r.row_type}:${r.shift_id||r.block_id}`,r));
  const filtered=[...unique.values()].filter(r=>!["cancelled","inactive"].includes(r.status)&&
    (platform==="all"||r.channel===platform||r.channel==="all")&&(seller==="all"||r.is_blocked||String(r.seller_employee_id)===seller)&&
    new Date(r.start_at)<end&&new Date(r.end_at)>start).sort((a,b)=>new Date(a.start_at)-new Date(b.start_at));
  const shows=filtered.filter(r=>!r.is_blocked),pages=[];
  const singleDay=dateKey(addDays(start,1))===dateKey(end);
  for(let d=singleDay?new Date(start):showWeekStart(start);d<end;d=addDays(d,singleDay?1:7)){
    const next=addDays(d,singleDay?1:7),days=[];
    for(let day=new Date(d);day<next;day=addDays(day,1)){
      const outside=day<start||day>=end;days.push({date:day,outside,segments:outside?[]:reportDaySegments(filtered,day)});
    }
    pages.push({start:new Date(Math.max(d,start)),end:new Date(Math.min(next,end)),days});
  }
  return {start,end,rows:filtered,pages,platform,sellerLabel,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,created:new Date(),
    shows:shows.length,hosts:new Set(shows.map(r=>r.seller_employee_id)).size,
    hours:shows.reduce((sum,r)=>sum+(Math.min(new Date(r.end_at),end)-Math.max(new Date(r.start_at),start))/3600000,0)};
}
function clearShowReportExport(){
  if(showReport.url){URL.revokeObjectURL(showReport.url);showReport.url=null;}
  $("ss-report-ready").hidden=true;
}
function reportSetRange(preset){
  let start=preset==="month"?startOfMonth(state.currentMonth):preset==="day"?startOfToday(state.selectedDate):showWeekStart(state.selectedDate);
  const end=preset==="month"?endOfMonth(start):preset==="day"?start:addDays(start,6);
  $("ss-report-from").value=dateKey(start);$("ss-report-to").value=dateKey(end);
  document.querySelectorAll("[data-report-range]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.reportRange===preset)));
}
async function refreshShowReport(){
  const ticket=++showReport.request;showReport.model=null;clearShowReportExport();
  $("ss-report-download").disabled=true;$("ss-report-preview").innerHTML="";$("ss-report-summary").textContent="";$("ss-report-key").innerHTML="";$("ss-report-pages").hidden=true;
  const from=$("ss-report-from").value,to=$("ss-report-to").value;
  const start=dateFromKey(from),last=dateFromKey(to),end=addDays(last,1);
  const dayCount=(Date.UTC(last.getFullYear(),last.getMonth(),last.getDate())-Date.UTC(start.getFullYear(),start.getMonth(),start.getDate()))/86400000+1;
  if(!from||!to||!Number.isFinite(dayCount)||dayCount<1||dayCount>31){$("ss-report-status").textContent="Choose a start and end date, up to 31 days apart.";return;}
  $("ss-report-status").textContent="Loading the latest schedule…";
  try{
    const months=[];
    // Adjacent dates cover timezone differences at the Eastern-time RPC boundaries.
    for(let d=startOfMonth(addDays(start,-1));d<=addDays(end,1);d=new Date(d.getFullYear(),d.getMonth()+1,1))months.push(dateKey(d));
    const results=await Promise.all(months.map(_month=>window.supabase.rpc("get_seller_schedule_month",{_month})));
    if(ticket!==showReport.request)return;
    const error=results.find(r=>r.error)?.error;if(error)throw error;
    const select=$("ss-report-seller");
    showReport.model=buildShowReportModel(results.flatMap(r=>r.data||[]),start,end,$("ss-report-platform").value,select.value,select.selectedOptions[0].textContent);
    showReport.page=0;renderShowReport();
    $("ss-report-status").textContent=showReport.model.shows?"":"No shows match this range and these filters. The PDF will show the empty calendar.";
    $("ss-report-download").disabled=false;
  }catch(error){if(ticket===showReport.request)$("ss-report-status").textContent=`Could not load the report. ${error.message||"Please try again."}`;}
}
function renderShowReport(){
  const model=showReport.model;if(!model)return;
  const page=model.pages[showReport.page];
  $("ss-report-summary").textContent=`${model.shows} shows · ${Number(model.hours.toFixed(1))} host hours · ${model.hosts} ${model.hosts===1?"host":"hosts"} · ${model.timezone}`;
  $("ss-report-pages").hidden=false;
  $("ss-report-page-title").textContent=`${reportDate(page.start,{month:"short",day:"numeric"})} – ${reportDate(addDays(page.end,-1),{month:"short",day:"numeric",year:"numeric"})}`;
  $("ss-report-page-count").textContent=`Calendar ${showReport.page+1} of ${model.pages.length}`;
  $("ss-report-prev").disabled=showReport.page===0;$("ss-report-next").disabled=showReport.page===model.pages.length-1;
  const people=[...new Map(model.rows.filter(r=>!r.is_blocked).map(r=>[r.seller_employee_id,r])).values()];
  $("ss-report-key").innerHTML=people.map(r=>`<span><i style="background:#${reportColor(r).fill};color:#${reportColor(r).ink}">${escapeHtml(showInitials(r.seller_name))}</i>${escapeHtml(r.seller_name)}</span>`).join("");
  $("ss-report-preview").innerHTML=`<div class="ss-report-grid" style="--days:${page.days.length}"><div class="ss-report-corner">TIME</div>${page.days.map(d=>`<div class="ss-report-day-heading ${d.outside?"is-outside":""}"><span>${reportDate(d.date,{weekday:"short"})}</span><strong>${reportDate(d.date,{month:"short",day:"numeric"})}</strong></div>`).join("")}<div class="ss-report-hours">${Array.from({length:24},(_,h)=>`<span style="top:${h*48}px">${h===0?"12 AM":h<12?h+" AM":h===12?"12 PM":(h-12)+" PM"}</span>`).join("")}<span class="ss-report-midnight">12 AM</span></div>${page.days.map(d=>`<section class="ss-report-day ${d.outside?"is-outside":""}" aria-label="${reportDate(d.date,{weekday:"long",month:"long",day:"numeric"})}${d.outside?", outside report range":""}">${d.outside?'<span class="ss-report-outside-label">Outside range</span>':""}${d.segments.map(s=>{
    const color=reportColor(s.row),short=s.to-s.from<90;
    return `<article tabindex="0" class="ss-report-event ${s.carry?"is-carry":""}" style="top:${s.from/30*24}px;height:${(s.to-s.from)/30*24}px;left:calc(${s.lane/s.lanes*100}% + 2px);width:calc(${100/s.lanes}% - 4px);--event-bg:#${color.fill};--event-ink:#${color.ink}" title="${escapeHtml(reportRowLabel(s.row))}" aria-label="${escapeHtml(reportRowLabel(s.row))}"><strong>${escapeHtml(s.row.is_blocked?"Blocked":s.lanes>1?showInitials(s.row.seller_name):s.row.seller_name)}</strong><span>${s.carry?"12a":reportCompactTime(s.row.start_at)} – ${s.continues?"12a ↗":reportCompactTime(s.row.end_at)}</span>${short?"":`<small>${escapeHtml(showPlatforms[s.row.channel]||s.row.channel)}${s.carry?" · continued":s.continues?" · overnight":""}</small>`}</article>`;
  }).join("")}</section>`).join("")}</div>`;
  $("ss-report-preview").scrollTop=8*48;
}
let showReportPdfLoader;
function loadShowReportPdf(){
  if(!showReportPdfLoader)showReportPdfLoader=Promise.all(["vendor/pdf-lib/pdf-lib.min.js","seller-schedule-report-pdf.js?v=20261113-calendar-report1"].map(src=>new Promise((resolve,reject)=>{
    const script=document.createElement("script");script.src=src;script.onload=resolve;script.onerror=()=>{script.remove();reject(new Error("The PDF tools could not load. Check your connection and try again."));};document.head.append(script);
  }))).catch(error=>{showReportPdfLoader=null;throw error;});
  return showReportPdfLoader;
}
async function downloadShowReport(){
  if(!showReport.model||showReport.exporting)return;
  showReport.exporting=true;$("ss-report-download").disabled=true;
  $("ss-report-options").disabled=true;$("ss-report-details").disabled=true;$("ss-report-paper").disabled=true;
  $("ss-report-status").textContent="Preparing your PDF…";
  const model=showReport.model,ticket=showReport.request;
  try{
    await loadShowReportPdf();
    const bytes=await buildShowSchedulePdf(model,$("ss-report-details").checked,$("ss-report-paper").value);
    if(ticket!==showReport.request)return;
    clearShowReportExport();showReport.url=URL.createObjectURL(new Blob([bytes],{type:"application/pdf"}));
    const link=$("ss-report-save");link.href=showReport.url;link.download=`show-schedule-${dateKey(model.start)}-to-${dateKey(addDays(model.end,-1))}.pdf`;
    $("ss-report-print").href=showReport.url;$("ss-report-ready").hidden=false;
    $("ss-report-status").textContent="PDF ready. Save it, share it, or open it to print.";link.click();
  }catch(error){if(ticket===showReport.request)$("ss-report-status").textContent=`Could not create the PDF. ${error.message||"Please try again."}`;}
  finally{showReport.exporting=false;$("ss-report-download").disabled=!showReport.model;$("ss-report-options").disabled=false;$("ss-report-details").disabled=false;$("ss-report-paper").disabled=false;}
}
function setupShowReport(){
  const dialog=document.createElement("dialog");dialog.id="ss-report";dialog.setAttribute("aria-labelledby","ss-report-title");
  dialog.innerHTML=`<header class="ss-report-head"><div><span class="seller-kicker">SHOW STUDIO / AIRPORT STORE</span><h2 id="ss-report-title">The calendar report.</h2><p>Every host. Every hour. Ready to share.</p></div><button id="ss-report-close" class="seller-icon-button" aria-label="Close report">×</button></header>
    <div class="ss-report-body"><fieldset id="ss-report-options"><legend class="ss-sr-only">Report settings</legend><div class="ss-report-presets" role="group" aria-label="Report date range"><button data-report-range="day" aria-pressed="false">Selected day</button><button data-report-range="week" aria-pressed="true">Week</button><button data-report-range="month" aria-pressed="false">Month</button><button id="ss-report-reload" class="ss-report-reload">Refresh</button></div><div class="ss-report-fields"><label>From<input id="ss-report-from" type="date" required></label><label>Through<input id="ss-report-to" type="date" required></label><label>Platform<select id="ss-report-platform"><option value="all">All platforms</option><option value="ebay">eBay</option><option value="whatnot">Whatnot</option><option value="tiktok">TikTok</option></select></label><label>Host<select id="ss-report-seller"></select></label></div></fieldset>
    <div id="ss-report-summary" class="ss-report-summary"></div><div id="ss-report-pages" hidden><div class="ss-report-navigation"><button id="ss-report-prev" class="seller-icon-button" aria-label="Previous report week">‹</button><div><h3 id="ss-report-page-title"></h3><span id="ss-report-page-count"></span></div><button id="ss-report-next" class="seller-icon-button" aria-label="Next report week">›</button></div><div class="ss-report-preview-hint"><span>Scroll for all days & hours</span><div><button data-report-hour="0">Midnight</button><button data-report-hour="8">Morning</button><button data-report-hour="20">Evening</button></div></div></div>
    <div id="ss-report-preview" tabindex="0" aria-label="Hourly calendar, scroll vertically for hours and horizontally for days"></div><div id="ss-report-key" class="ss-report-key"></div><p class="ss-report-note">Overnight shows continue in the next day's column. Host hours count only time inside your date range. The PDF is a snapshot of saved shows; recurring shows appear as they are added to the schedule.</p></div>
    <footer class="ss-report-footer"><div class="ss-report-export-settings"><label class="ss-report-paper">Paper<select id="ss-report-paper"><option value="tabloid">Large calendar · 11 × 17 in</option><option value="letter">Letter · 8.5 × 11 in</option></select></label><label class="ss-report-detail-option"><input id="ss-report-details" type="checkbox">Include detailed lineup</label></div><p id="ss-report-status" role="status" aria-live="polite"></p><div class="ss-report-export-actions"><span id="ss-report-ready" hidden><a id="ss-report-save">Save PDF again</a><a id="ss-report-print" target="_blank" rel="noopener">Open / print</a></span><button id="ss-report-download" class="seller-submit" disabled>Download PDF <span aria-hidden="true">↓</span></button></div></footer>`;
  document.body.append(dialog);
  $("ss-open-report").disabled=false;
  $("ss-open-report").addEventListener("click",()=>{
    if(state.busy)return;
    $("ss-report-seller").innerHTML=$("ss-seller-filter").innerHTML;$("ss-report-seller").value=showPlanner.seller;
    $("ss-report-platform").value=showPlanner.platform;reportSetRange(showPlanner.view==="month"?"month":"week");
    dialog.showModal();refreshShowReport();
  });
  $("ss-report-close").addEventListener("click",()=>dialog.close());
  dialog.addEventListener("close",()=>{++showReport.request;showReport.model=null;clearShowReportExport();});
  document.querySelectorAll("[data-report-range]").forEach(b=>b.addEventListener("click",()=>{reportSetRange(b.dataset.reportRange);refreshShowReport();}));
  $("ss-report-options").addEventListener("change",event=>{
    if(event.target.type==="date")document.querySelectorAll("[data-report-range]").forEach(b=>b.setAttribute("aria-pressed","false"));
    refreshShowReport();
  });
  $("ss-report-reload").addEventListener("click",refreshShowReport);
  $("ss-report-prev").addEventListener("click",()=>{showReport.page--;renderShowReport();});
  $("ss-report-next").addEventListener("click",()=>{showReport.page++;renderShowReport();});
  document.querySelectorAll("[data-report-hour]").forEach(b=>b.addEventListener("click",()=>{$("ss-report-preview").scrollTop=Number(b.dataset.reportHour)*48;}));
  $("ss-report-details").addEventListener("change",clearShowReportExport);
  $("ss-report-paper").addEventListener("change",clearShowReportExport);
  $("ss-report-download").addEventListener("click",downloadShowReport);
}
