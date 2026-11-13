/* Visual planning layer; bookings keep the existing seller workflow. */
"use strict";
const showPlanner = {
  view: "week", platform: "all", seller: "all", loaded: false, smsReadiness: null,
  repeatRequest: null,
  mobile: window.matchMedia("(max-width: 600px)"),
};
const showPlatforms = { ebay: "eBay", whatnot: "Whatnot", tiktok: "TikTok", all: "All platforms" };
function showWeekStart(date) { return addDays(date, -((date.getDay() + 6) % 7)); }
function showRange() {
  const start = showPlanner.view === "month" ? startOfMonth(state.currentMonth) : showWeekStart(state.selectedDate);
  return { start, end: showPlanner.view === "month" ? addDays(endOfMonth(start), 1) : addDays(start, 7) };
}
function showGridRange() {
  const range = showRange();
  return showPlanner.view === "month" ? { start: showWeekStart(range.start), end: addDays(showWeekStart(range.start), 42) } : range;
}
function showInitials(name) { return String(name || "Seller").trim().split(/\s+/).slice(0, 2).map(n => n[0]).join("").toUpperCase(); }
function showDayClasses(date) {
  return `${dateKey(date) === dateKey(new Date()) ? "is-today" : ""} ${dateKey(date) === dateKey(state.selectedDate) ? "is-selected" : ""}`;
}
function showMatches(row) {
  return (showPlanner.platform === "all" || row.channel === showPlanner.platform || row.channel === "all")
    && (showPlanner.seller === "all" || row.is_blocked || String(row.seller_employee_id) === showPlanner.seller);
}
function showRowsForDay(date) {
  const start = startOfToday(date), end = addDays(start, 1);
  return state.rows.filter(row => showMatches(row) && overlaps(new Date(row.start_at), new Date(row.end_at), start, end))
    .sort((a,b) => new Date(a.start_at) - new Date(b.start_at));
}
function showEditable(row) { return !row.is_blocked && (row.is_mine || canManageSellers()) && ["booked", "edit_pending", "cancel_pending"].includes(row.status); }
function showTimeRange(row) {
  const overnight = dateKey(new Date(row.start_at)) !== dateKey(new Date(row.end_at));
  return `${formatTime(row.start_at)} – ${formatTime(row.end_at)}${overnight ? " (+1 day)" : ""}`;
}
function showCard(row, agenda = false, day = null) {
  if (row.is_blocked) return `<div class="ss-block-card"><strong>${escapeHtml(showPlatforms[row.channel] || row.channel)} · Blocked</strong><br>${escapeHtml(showTimeRange(row))}${row.notes ? `<br>${escapeHtml(row.notes)}` : ""}</div>`;
  const pending = ["edit_pending", "cancel_pending"].includes(row.status);
  const continues = day && new Date(row.start_at) < startOfToday(day);
  const timeLabel = continues ? `Continues until ${formatTime(row.end_at)}` : showTimeRange(row);
  return `<button class="ss-show-card ss-channel-${normalizeChannel(row.channel)}" data-show-id="${escapeHtml(row.shift_id)}" aria-label="${escapeHtml(`${row.seller_name}, ${showPlatforms[row.channel]}, ${formatDayTitle(new Date(row.start_at))}, ${showTimeRange(row)}`)}">
    <span class="ss-card-time">${agenda ? `<span class="ss-card-platform">${escapeHtml(showPlatforms[row.channel] || row.channel)}</span>` : ""}${escapeHtml(timeLabel)}</span>
    <span class="ss-card-person"><span class="ss-avatar" aria-hidden="true">${escapeHtml(showInitials(row.seller_name))}</span>${escapeHtml(row.seller_name || "Seller")}</span>
    <span class="ss-card-place">${escapeHtml(row.store_name || "Studio")}</span>
    ${row.metadata?.recurrence_id ? `<span class="ss-card-status">↻ ${escapeHtml(row.metadata.recurrence_label||"Repeats weekly")}</span>` : ''}
    ${row.notes ? `<span class="ss-card-note">${escapeHtml(row.notes)}</span>` : ""}
    ${pending ? `<span class="ss-card-status"><span class="ss-dot ss-pending"></span>${row.status === "edit_pending" ? "Change requested" : "Cancellation requested"}</span>` : ""}
    ${["checked_in", "in_progress", "completed", "no_show"].includes(row.status) ? `<span class="ss-card-status">${escapeHtml(row.status.replace(/_/g, " "))}</span>` : ""}
  </button>`;
}
function renderShowWeek() {
  const { start } = showRange();
  const days = Array.from({length:7},(_,i) => addDays(start,i));
  const platforms = showPlanner.platform === "all" ? ["ebay", "whatnot", "tiktok"] : [showPlanner.platform];
  return `<div class="ss-board-scroll" tabindex="0" aria-label="Weekly platform map, scroll horizontally for all days"><div class="ss-week-grid"><div class="ss-week-corner">PLATFORM</div>${days.map(d => `<button class="ss-day-heading ${showDayClasses(d)}" data-day="${dateKey(d)}" aria-label="View ${formatDayTitle(d)}"><span>${d.toLocaleDateString([], {weekday:"short"})}</span><strong>${d.getDate()}</strong></button>`).join("")}
    ${platforms.map(channel => {
      const count = state.rows.filter(r => !r.is_blocked && r.channel === channel && showMatches(r) && new Date(r.start_at) >= start && new Date(r.start_at) < addDays(start,7)).length;
      return `<div class="ss-platform-heading ss-channel-${channel}"><span class="ss-platform-logo">${showPlatforms[channel]}</span><small>${count} show${count === 1 ? "" : "s"}</small><span class="ss-dot ss-${channel}"></span></div>${days.map(d => `<div class="ss-slot ${showDayClasses(d)}">${showRowsForDay(d).filter(r => r.channel === channel || r.channel === "all").map(r => showCard(r, false, d)).join("")}<button class="ss-add-slot" data-add-date="${dateKey(d)}" data-add-platform="${channel}" aria-label="Add ${showPlatforms[channel]} show on ${formatDayTitle(d)}">+ Add show</button></div>`).join("")}`;
    }).join("")}</div></div>`;
}
function showCompactTime(value) {
  const d=new Date(value),minutes=d.getMinutes();
  return `${d.getHours()%12||12}${minutes?":"+String(minutes).padStart(2,"0"):""}${d.getHours()<12?"a":"p"}`;
}
function showMonthEvent(row,day) {
  const start=new Date(row.start_at),end=new Date(row.end_at),dayStart=startOfToday(day);
  const continues=start<dayStart,overnight=dateKey(end)!==dateKey(day);
  const name=row.is_blocked?"Blocked":row.seller_name||"Seller";
  const label=`${name}, ${showPlatforms[row.channel]||row.channel}, ${showTimeRange(row)}${continues?", continues from previous day":""}`;
  return `<button class="ss-month-event ss-channel-${normalizeChannel(row.channel)}" ${row.is_blocked?`data-day="${dateKey(day)}"`:`data-show-id="${escapeHtml(row.shift_id)}"`} aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">
    <span class="ss-month-person"><strong>${escapeHtml(row.is_blocked?"—":showInitials(name))}</strong><span class="ss-month-name">${escapeHtml(name)}</span>${continues||overnight?`<small aria-label="${continues?"Continued from previous day":"Ends next day"}">${continues?"↳":"+1"}</small>`:""}</span>
    <span class="ss-month-range"><time>${showCompactTime(continues?dayStart:start)}</time><time>–${showCompactTime(end)}</time></span>
  </button>`;
}
function renderShowMonth() {
  const { start } = showGridRange();
  const people=new Map(state.rows.filter(r=>!r.is_blocked&&showMatches(r)&&new Date(r.end_at)>start&&new Date(r.start_at)<addDays(start,42)).map(r=>[r.seller_employee_id,r.seller_name]));
  return `<div class="ss-month-guide"><p>Tap a date to add a show. Tap a show for details.</p><div class="ss-month-key">${[...people].map(([id,name])=>`<span><b>${escapeHtml(showInitials(name))}</b>${escapeHtml(name)}</span>`).join("")}</div><small>a = AM · p = PM · +1 ends next day · ↳ continues</small></div><div class="ss-month-grid">${["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d=>`<div class="ss-month-weekday">${d}</div>`).join("")}${Array.from({length:42},(_,i)=>{
    const d=addDays(start,i),rows=showRowsForDay(d),outside=d.getMonth()!==state.currentMonth.getMonth();
    return `<div class="ss-month-day ${showDayClasses(d)} ${outside?"is-outside":""}" data-calendar-date="${dateKey(d)}"><button class="ss-month-date" data-add-date="${dateKey(d)}" aria-label="Add show on ${formatDayTitle(d)}"><strong>${d.getDate()}</strong><span aria-hidden="true">+</span></button>${rows.slice(0,3).map(r=>showMonthEvent(r,d)).join("")}${rows.length>3?`<button class="ss-month-more" data-day="${dateKey(d)}">+${rows.length-3} more</button>`:""}</div>`;
  }).join("")}</div>`;
}
function renderShowAgenda(singleDay = false) {
  const { start } = showRange();
  const days = singleDay ? [state.selectedDate] : Array.from({length:7},(_,i)=>addDays(start,i));
  return `<div class="ss-agenda">${days.map(d=>{
    const rows=showRowsForDay(d);
    return `<section class="ss-agenda-day"><h3 class="ss-agenda-date">${d.toLocaleDateString([],{weekday:"long"})}<strong>${d.toLocaleDateString([],{month:"short",day:"numeric"})}</strong></h3><div class="ss-agenda-cards">${rows.length?rows.map(r=>showCard(r,true,d)).join(""):`<div class="ss-empty-day"><span>${showPlanner.platform !== "all" || showPlanner.seller !== "all" ? "No shows match these filters." : "A little room for something great. No shows yet."}</span><button class="ss-quiet-button" data-add-date="${dateKey(d)}">+ Schedule a show</button></div>`}</div></section>`;
  }).join("")}</div>`;
}
function renderShowSummary() {
  const {start,end}=showRange();
  const rows=state.rows.filter(r=>!r.is_blocked && showMatches(r) && new Date(r.start_at)>=start && new Date(r.start_at)<end);
  $("ss-total").textContent=rows.length;
  $("ss-hours").textContent=formatHours(rows.reduce((sum,r)=>sum+minutesBetween(r.start_at,r.end_at),0));
  $("ss-sellers").textContent=new Set(rows.map(r=>r.seller_employee_id)).size;
  $("ss-period-caption").textContent=showPlanner.view === "month" ? "This month" : "This week";
  const next=state.rows.filter(r=>!r.is_blocked&&isActiveShift(r)&&showMatches(r)&&new Date(r.end_at)>new Date()).sort((a,b)=>new Date(a.start_at)-new Date(b.start_at))[0];
  $("ss-next-name").textContent=next ? next.seller_name : "Room to shine";
  $("ss-next-time").textContent=next ? `${showPlatforms[next.channel]} · ${formatDateTime(next.start_at)}` : "No upcoming shows in the loaded period";
  for(const platform of ["all","ebay","whatnot","tiktok"]) $("ss-count-"+platform).textContent=state.rows.filter(r=>!r.is_blocked&&(platform==="all"||r.channel===platform)&&(showPlanner.seller==="all"||String(r.seller_employee_id)===showPlanner.seller)&&new Date(r.start_at)>=start&&new Date(r.start_at)<end).length;
}
function renderShowControls() {
  const {start,end}=showRange();
  const last=addDays(end,-1), fmt={month:"short",day:"numeric"};
  $("seller-month-label").textContent=showPlanner.view === "month" ? formatMonth(start) : `${start.toLocaleDateString([],fmt)} – ${last.toLocaleDateString([],fmt)}`;
  $("ss-range-year").textContent=showPlanner.view==="month"?"THE MONTH AHEAD":String(start.getFullYear());
  document.querySelectorAll("[data-view]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.view===showPlanner.view)));
  document.querySelectorAll("[data-platform]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.platform===showPlanner.platform)));
  const people=new Map();
  state.sellers.forEach(s=>people.set(String(s.id),getSellerLabel(s)));
  state.rows.filter(r=>r.seller_employee_id).forEach(r=>people.set(String(r.seller_employee_id),r.seller_name));
  $("ss-seller-filter").innerHTML=`<option value="all">All sellers</option>${[...people].sort((a,b)=>a[1].localeCompare(b[1])).map(([id,name])=>`<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join("")}`;
  if(!people.has(showPlanner.seller))showPlanner.seller="all";
  $("ss-seller-filter").value=showPlanner.seller;
  const current=$("booking-seller").value;
  const editablePeople=canManageSellers()?state.sellers:[state.employee].filter(Boolean);
  $("booking-seller").innerHTML=`<option value="">Choose a seller</option>${editablePeople.map(s=>`<option value="${escapeHtml(s.id)}">${escapeHtml(getSellerLabel(s))}</option>`).join("")}`;
  $("booking-seller").value=editablePeople.some(s=>String(s.id)===current)?current:(canManageSellers()?"":state.employee?.id||"");
  $("ss-booking-seller-label").hidden=!canManageSellers();
  $("booking-seller").required=canManageSellers();
  $("booking-seller").disabled=!!$("booking-shift-id").value;
  const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone.replace(/_/g," ");
  $("ss-timezone").textContent=`All times: ${timezone}`;
  $("ss-form-timezone").textContent=`Times are in ${timezone}. ${canManageSellers()?"Plan any month, including overnight shows.":"Self-booking is available for the current month."}`;
  const week=showWeekStart(state.selectedDate);
  $("ss-mobile-week").hidden=showPlanner.view!=="week";
  $("ss-mobile-week").innerHTML=Array.from({length:7},(_,i)=>{
    const d=addDays(week,i);
    return `<button data-day="${dateKey(d)}" class="${showDayClasses(d)}" aria-pressed="${dateKey(d)===dateKey(state.selectedDate)}" aria-label="${formatDayTitle(d)}"><span>${d.toLocaleDateString([],{weekday:"narrow"})}</span><strong>${d.getDate()}</strong><span class="ss-date-dot" style="opacity:${showRowsForDay(d).length?1:0}"></span></button>`;
  }).join("");
  renderShowSummary();
}
function renderShowPlanner() {
  renderShowControls();
  $("seller-calendar").innerHTML=showPlanner.view==="month"?renderShowMonth():showPlanner.view==="agenda"?renderShowAgenda():showPlanner.mobile.matches?renderShowAgenda(true):renderShowWeek();
}
async function loadShowRange() {
  const { start,end }=showGridRange();
  const months=new Set();
  for(let d=startOfMonth(addDays(start,-1));d<=addDays(end,1);d=new Date(d.getFullYear(),d.getMonth()+1,1))months.add(dateKey(d));
  const editingDate=$("booking-date")?.value;
  if($("ss-editor")?.open&&editingDate){
    const day=dateFromKey(editingDate);
    months.add(dateKey(startOfMonth(day)));months.add(dateKey(startOfMonth(addDays(day,1))));months.add(dateKey(startOfMonth(addDays(day,-1))));
  }
  const results=await Promise.all([...months].map(_month=>window.supabase.rpc("get_seller_schedule_month",{_month})));
  const error=results.find(r=>r.error)?.error;if(error)throw error;
  const unique=new Map();results.forEach(result=>(result.data||[]).forEach(row=>unique.set(`${row.row_type}:${row.shift_id||row.block_id}`,row)));
  state.rows=[...unique.values()];showPlanner.loaded=true;
}
function showPageStatus(message,error=false){$("schedule-status").textContent=message||"";$("schedule-status").classList.toggle("is-error",error);}
async function loadShowSmsReadiness() {
  try {
    const {data,error}=await window.supabase.rpc("get_seller_show_sms_readiness");
    if(error)throw error;
    showPlanner.smsReadiness=new Map((data||[]).map(row=>[String(row.seller_employee_id),row]));
  } catch(error) {
    console.warn("Show reminder setup unavailable:",error);
    showPlanner.smsReadiness=null;
  }
}
function renderShowSmsReadiness() {
  const box=$("ss-reminder-status");if(!box)return;
  const sellerId=$("booking-seller").value || (!canManageSellers()?state.employee?.id:"");
  const row=showPlanner.smsReadiness?.get(String(sellerId));
  box.classList.remove("is-warning");
  if(!sellerId){box.textContent="Host reminder · Choose a seller to check their SMS setup.";return;}
  if(!row){box.textContent="Host reminder · SMS setup could not be verified. Refresh to check again.";box.classList.add("is-warning");return;}
  if(row.sms_ready){box.textContent=`SMS reminder on · 30 minutes before the show, sent to the host’s number ending in ${row.phone_last_four}.`;return;}
  const reason=row.reason==="sms_disabled"?"SMS is disabled for this host.":row.reason==="no_login"?"This host needs a linked login and phone number.":"This host needs an SMS-enabled phone number.";
  box.textContent=`Reminder needs attention · ${reason} ${canManageSellers()?"Update it in Admin → Users before the show.":"Ask a manager to update your phone settings."}`;
  box.classList.add("is-warning");
}
async function navigateShowPeriod(direction) {
  if(state.busy)return;
  if(showPlanner.view==="month"){
    state.currentMonth=new Date(state.currentMonth.getFullYear(),state.currentMonth.getMonth()+direction,1);
    state.selectedDate=new Date(state.currentMonth);
  }else{state.selectedDate=addDays(state.selectedDate,direction*7);state.currentMonth=startOfMonth(state.selectedDate);}
  await refreshAll();
}
function openShowEditor(date,channel) {
  if(state.busy||!showPlanner.loaded)return;
  if(date)state.selectedDate=dateFromKey(date);
  clearEditMode();
  $("ss-editor-title").textContent="Schedule a show";
  $("ss-editor-caption").textContent="Give your next show a place on the calendar.";
  $("booking-overnight").checked=false;
  $("booking-seller").disabled=false;
  $("booking-seller").value=canManageSellers()?"":state.employee?.id||"";
  setSelectedChannel(channel|| (showPlanner.platform!=="all"?showPlanner.platform:"ebay"));
  $("ss-editor").showModal();
}
function openShowDetails(row) {
  if(!row)return;
  if(showEditable(row)){setEditMode(row);return;}
  // Read-only details use the same accessible dialog, with no editable controls.
  setEditMode(row);
  $("ss-editor-title").textContent="Show details";
  $("ss-editor-caption").textContent=`${row.seller_name} · ${String(row.status||"Scheduled").replace(/_/g," ")}`;
  $("seller-booking-form").querySelectorAll("input,textarea,select,button").forEach(el=>el.disabled=true);
  $("booking-cancel-shift").classList.add("hidden");
}
function showRepeatDays() {
  const mode=$("booking-repeat").value,day=dateFromKey($("booking-date").value||dateKey(state.selectedDate)).getDay();
  if(mode==="weekly")return [day];
  if(mode==="weekdays")return [1,2,3,4,5];
  if(mode==="daily")return [0,1,2,3,4,5,6];
  if(mode==="custom")return [...document.querySelectorAll('[data-repeat-day][aria-pressed="true"]')].map(b=>Number(b.dataset.repeatDay)).sort();
  return [];
}
function showIsRepeating() {return canManageSellers()&&!$("booking-shift-id").value&&$("booking-repeat").value!=="none";}
function renderShowRepeat() {
  const editable=canManageSellers()&&!$("booking-shift-id").value,repeating=editable&&showIsRepeating();
  $("booking-recurrence-panel").hidden=!editable;
  $("booking-repeat-options").hidden=!repeating;
  const until=repeating&&$("booking-repeat-end").value==="date";
  $("booking-repeat-until-label").hidden=!until;$("booking-repeat-until").required=until;
  $("booking-repeat-until").disabled=!until;
  $("booking-repeat-until").min=$("booking-date").value;
  const days=showRepeatDays();
  document.querySelectorAll("[data-repeat-day]").forEach(b=>b.setAttribute("aria-pressed",String(days.includes(Number(b.dataset.repeatDay)))));
  const names=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  $("booking-repeat-summary").textContent=`Every ${days.map(d=>names[d]).join(", ")||"selected day"} in ${Intl.DateTimeFormat().resolvedOptions().timeZone}. ${until?"Includes the last show date.":"Continues until you stop it."} Each show gets its own SMS reminder.`;
  if(editable)$("booking-submit").textContent=repeating?"Schedule repeating shows":"Schedule show";
}
function getShowRepeatRequest() {
  if(!showIsRepeating())return null;
  const args={_seller_employee_id:$("booking-seller").value,_channel:getSelectedChannel(),_start_date:$("booking-date").value,
    _start_local:$("booking-start").value,_end_local:$("booking-end").value,_ends_next_day:$("booking-overnight").checked,
    _weekdays:showRepeatDays(),_timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
    _effective_to:$("booking-repeat-end").value==="date"?$("booking-repeat-until").value:null,_notes:$("booking-note").value||null};
  const fingerprint=JSON.stringify(args);
  if(showPlanner.repeatRequest?.fingerprint!==fingerprint)showPlanner.repeatRequest={fingerprint,id:crypto.randomUUID()};
  return {_request_id:showPlanner.repeatRequest.id,...args};
}
function setupShowPlanner() {
  const name=state.employee?.display_name||"Your workspace";
  $("ss-user-name").textContent=name;$("ss-user-initials").textContent=showInitials(name);
  document.querySelectorAll("[data-management-link]").forEach(el=>el.hidden=!canManageSellers());
  document.querySelectorAll("[data-new-show]").forEach(el=>el.addEventListener("click",()=>openShowEditor()));
  $("ss-prev").addEventListener("click",()=>navigateShowPeriod(-1));$("ss-next").addEventListener("click",()=>navigateShowPeriod(1));
  $("ss-today").addEventListener("click",async()=>{if(state.busy)return;state.selectedDate=startOfToday(new Date());state.currentMonth=startOfMonth(state.selectedDate);await refreshAll();});
  document.querySelectorAll("[data-view]").forEach(el=>el.addEventListener("click",async()=>{if(state.busy)return;showPlanner.view=el.dataset.view;await refreshAll();}));
  document.querySelectorAll("[data-platform]").forEach(el=>el.addEventListener("click",()=>{showPlanner.platform=el.dataset.platform;renderShowPlanner();renderSelectedDay();}));
  $("ss-seller-filter").addEventListener("change",e=>{showPlanner.seller=e.target.value;renderShowPlanner();renderSelectedDay();});
  async function boardClick(event) {
    if(state.busy)return;
    const card=event.target.closest("[data-show-id]");if(card){openShowDetails(state.rows.find(r=>r.shift_id===card.dataset.showId));return;}
    const add=event.target.closest("[data-add-date]");if(add){openShowEditor(add.dataset.addDate,add.dataset.addPlatform);return;}
    const day=event.target.closest("[data-day]");
    if(!day){const cell=event.target.closest("[data-calendar-date]");if(cell)openShowEditor(cell.dataset.calendarDate);return;}
    state.selectedDate=dateFromKey(day.dataset.day);
    if(showPlanner.view==="month"){showPlanner.view="week";state.currentMonth=startOfMonth(state.selectedDate);await refreshAll();}
    else{renderShowPlanner();renderSelectedDay();}
  }
  $("seller-calendar").addEventListener("click",boardClick);$("ss-mobile-week").addEventListener("click",boardClick);
  $("ss-editor-close").addEventListener("click",()=>{if(!state.busy)$("ss-editor").close();});
  $("ss-editor").addEventListener("cancel",e=>{if(state.busy)e.preventDefault();});
  $("ss-cancel-dialog").addEventListener("cancel",e=>{if(state.busy)e.preventDefault();});
  $("ss-cancel-keep").addEventListener("click",()=>{if(!state.busy)$("ss-cancel-dialog").close();});
  $("ss-cancel-form").addEventListener("submit",confirmCancelShow);
  $("ss-editor").addEventListener("close",()=>{
    $("seller-booking-form").querySelectorAll("input,textarea,select,button").forEach(el=>el.disabled=false);
    clearEditMode();
  });
  ["booking-seller","booking-overnight"].forEach(id=>$(id).addEventListener("change",updateAvailabilityPreview));
  ["booking-repeat","booking-repeat-end","booking-repeat-until"].forEach(id=>$(id).addEventListener("change",updateAvailabilityPreview));
  document.querySelectorAll("[data-repeat-day]").forEach(b=>b.addEventListener("click",()=>{
    b.setAttribute("aria-pressed",String(b.getAttribute("aria-pressed")!=="true"));$("booking-repeat").value="custom";updateAvailabilityPreview();
  }));
  $("booking-date").addEventListener("change",async()=>{
    if(!$("booking-date").value||state.busy)return;
    state.busy=true;$("booking-submit").disabled=true;
    try{await loadShowRange();updateAvailabilityPreview();}catch(error){setStatus("Could not check availability. "+error.message,"error");}finally{state.busy=false;$("booking-submit").disabled=false;}
  });
  showPlanner.mobile.addEventListener("change",()=>{renderShowPlanner();});
}
