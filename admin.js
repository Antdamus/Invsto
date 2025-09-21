// admin.js — Overview + Drawer/Edit/Audit + Payroll Weekly + Period Lock/Unlock (Phase 3.3)
let supabaseClient = null;
let drawerOnlyAnoms = false;
let lastDrawerShifts = []; // keep latest list to re-render on toggle

function qs(id){ return document.getElementById(id); }
function show(el, v){ el.classList.toggle('hidden', !v); }
function fmtHours(n){ if (n == null || Number.isNaN(n)) return '—'; const s = Number(n).toFixed(2); return s.replace(/\.00$/, ''); }
function fmtDurationHM(ms){ if (ms == null || !Number.isFinite(ms)) return '—'; const m=Math.round(ms/60000), h=Math.floor(m/60), r=m%60; return `${h}h ${String(r).padStart(2,'0')}m`; }
function debounce(fn, ms=300){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }
function monthInputToStart(){ const v=qs('monthInput')?.value; if(!v||!/^\d{4}-\d{2}$/.test(v)){ const now=new Date(); return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`; } return `${v}-01`; }
function monthLabel(yyyyMm01){ const d=new Date(yyyyMm01+'T00:00:00'); return d.toLocaleString(undefined,{month:'long',year:'numeric'}); }
function toDatetimeLocalValue(iso){ if(!iso) return ''; const d=new Date(iso); const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
function localInputToOffsetISO(localStr){ const d=new Date(localStr); if(Number.isNaN(d.getTime())) return null; const p=n=>String(n).padStart(2,'0'); const tzMin=-d.getTimezoneOffset(); const sign=tzMin>=0?'+':'-'; const offH=p(Math.floor(Math.abs(tzMin)/60)); const offM=p(Math.abs(tzMin)%60); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00${sign}${offH}:${offM}`; }
function fmtLocal(iso){ if(!iso) return '—'; return new Date(iso).toLocaleString(); }
function showToast(msg, type='ok'){ let t=document.querySelector('.toast'); if(!t){ t=document.createElement('div'); t.className='toast'; document.body.appendChild(t); } t.textContent=msg; t.classList.remove('ok','err'); t.classList.add(type); t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2200); }

/* ============== Admin Guard ============== */
async function ensureAdmin() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) { window.location.href = "index.html?next=" + encodeURIComponent("admin.html"); return false; }
  const { data: isAdmin, error } = await supabaseClient.rpc('is_admin');
  if (error || !isAdmin) { window.location.href = `index.html?reason=${encodeURIComponent('Admin only')}`; return false; }
  return true;
}
function wireHeaderActions() {
  qs('signOutBtn').addEventListener('click', async () => { await supabaseClient.auth.signOut(); window.location.href = 'index.html'; });
  qs('printBtn').addEventListener('click', () => window.print());
}

function dateStrAddDays(yyyyMmDd, days){
  const d = new Date(yyyyMmDd + 'T00:00:00');
  d.setDate(d.getDate() + days);
  const p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

/* ============== Overview (monthly) ============== */
async function fetchMonthlySummary(monthStart, searchTerm){
  const apply = q => { q = q.eq('month_start', monthStart); if (searchTerm?.trim()) q = q.ilike('display_name', `%${searchTerm.trim()}%`); return q.order('display_name', { ascending: true }); };
  let { data, error } = await apply(supabaseClient.from('mv_monthly_hours').select('employee_id, display_name, month_start, shifts_count, total_hours'));
  if (!error && data?.length) return { rows: data, source: 'mv' };
  const res = await apply(supabaseClient.from('v_monthly_hours').select('employee_id, display_name, month_start, shifts_count, total_hours'));
  if (res.error) throw res.error;
  return { rows: res.data||[], source: 'view' };
}
function renderKPIs(rows){
  const tot = rows.reduce((a,r)=>a+(+r.total_hours||0),0);
  const shf = rows.reduce((a,r)=>a+(+r.shifts_count||0),0);
  const avg = shf>0? tot/shf : 0;
  qs('kpiTotalHours').textContent = fmtHours(tot);
  qs('kpiTotalShifts').textContent = String(shf);
  qs('kpiAvgHrs').textContent = fmtHours(avg);
}
let currentRows=[], sortState={ key:'display_name', dir:'asc' };
function sortRows(rows){
  const a=rows.slice(), {key,dir}=sortState, m = dir==='asc'?1:-1;
  a.sort((x,y)=>{
    let xv=x[key], yv=y[key];
    if (key==='shifts_count' || key==='total_hours'){ xv=+xv||0; yv=+yv||0; return (xv-yv)*m; }
    const xs=(xv||'').toString().toLowerCase(), ys=(yv||'').toString().toLowerCase();
    return xs<ys?-1*m: xs>ys?1*m: 0;
  });
  return a;
}
function applySortIndicators(){
  [{el:qs('thWorker'),key:'display_name'},{el:qs('thShifts'),key:'shifts_count'},{el:qs('thHours'),key:'total_hours'}].forEach(({el,key})=>{
    const s = sortState.key===key? sortState.dir : 'none';
    el.setAttribute('aria-sort', s==='asc'?'ascending':s==='desc'?'descending':'none');
    el.querySelector('.sort-indicator').textContent = s==='asc'?'▲':s==='desc'?'▼':'↕';
  });
}
function renderTable(rows){
  const tb=qs('summaryTbody'); tb.innerHTML='';
  const data = sortRows(rows);
  if (!data.length){ tb.innerHTML=`<tr><td colspan="3" class="muted">No results for this month/search.</td></tr>`; return; }
  for(const r of data){
    const tr=document.createElement('tr');
    tr.dataset.employeeId=r.employee_id; tr.dataset.monthStart=r.month_start; tr.dataset.displayName=r.display_name||'';
    tr.className='summary-row';
    tr.innerHTML=`<td>${r.display_name||'—'}</td><td>${r.shifts_count??'—'}</td><td>${fmtHours(r.total_hours)}</td>`;
    tb.appendChild(tr);
  }
  applySortIndicators();
}
let isLoading=false;
async function loadSummary(){
  if (isLoading) return; isLoading=true; qs('summaryTbody').style.opacity='0.6';
  try{
    const monthStart=monthInputToStart(); const search=qs('searchInput').value||'';
    qs('printMonthLabel').textContent = monthLabel(monthStart);
    const { rows } = await fetchMonthlySummary(monthStart, search);
    currentRows=rows; renderKPIs(rows); renderTable(rows);
  }catch(err){
    console.error(err);
    qs('summaryTbody').innerHTML=`<tr><td colspan="3" class="muted">Error loading data. Check console.</td></tr>`;
    qs('kpiTotalHours').textContent=qs('kpiTotalShifts').textContent=qs('kpiAvgHrs').textContent='—';
  }finally{ qs('summaryTbody').style.opacity='1'; isLoading=false; }
}
function wireFilters(){ qs('monthInput').addEventListener('change', loadSummary); qs('searchInput').addEventListener('input', debounce(loadSummary,300)); }
function toggleSort(key){ if (sortState.key===key) sortState.dir = sortState.dir==='asc'?'desc':'asc'; else sortState={key,dir:'asc'}; renderTable(currentRows); }
function wireSorting(){ qs('thWorker').addEventListener('click',()=>toggleSort('display_name')); qs('thShifts').addEventListener('click',()=>toggleSort('shifts_count')); qs('thHours').addEventListener('click',()=>toggleSort('total_hours')); }

/* ============== Drawer + Edit/Audit ============== */
async function fetchPeriodSummary(periodId){
  const cols = 'employee_id, display_name, regular_hours, overtime_hours, total_hours, shifts_count';
  // Use the live view so exports are always up to date
  const { data, error } = await supabaseClient
    .from('v_payroll_period_hours')
    .select(cols)
    .eq('period_id', periodId)
    .order('display_name', { ascending: true });
  if (error) throw error;
  return data || [];
}


let currentShiftsById=new Map(), drawerContext={ employeeId:null, displayName:null, monthStart:null }, auditCache=new Map();

async function fetchWorkerShifts(employeeId, monthStartStr){
  const start = new Date(`${monthStartStr}T00:00:00`);
  const end   = new Date(start); end.setMonth(start.getMonth()+1);

  // 1) Base closed shifts
  const { data: entries, error } = await supabaseClient.from('time_entries')
    .select('id, clock_in, clock_out, store_id, photo_in_path, photo_out_path')
    .eq('employee_id', employeeId)
    .gte('clock_in', start.toISOString())
    .lt('clock_in', end.toISOString())
    .not('clock_out','is',null)
    .order('clock_in',{ascending:true});
  if (error) throw error;

  const rows = entries || [];
  const ids = rows.map(r => r.id);

  // 2) Anomalies + approvals for these shifts
  let anomalyById = new Map();
  if (ids.length){
    const { data: anoms } = await supabaseClient.from('v_shift_anomalies')
      .select('time_entry_id, anomalies, has_anomaly, approval_status, approval_note, approved_at')
      .in('time_entry_id', ids);
    anomalyById = new Map((anoms||[]).map(a => [a.time_entry_id, a]));
  }

  // 3) Breaks for these shifts
  let breaksByEntry = new Map();
  if (ids.length){
    const { data: breaks } = await supabaseClient.from('time_breaks')
      .select('time_entry_id, started_at, ended_at')
      .in('time_entry_id', ids)
      .order('started_at', { ascending: true });
    for (const b of (breaks||[])){
      const list = breaksByEntry.get(b.time_entry_id) || [];
      list.push(b);
      breaksByEntry.set(b.time_entry_id, list);
    }
  }

  // 4) Build final records (+signed photo URLs)
  const map = new Map(), out = [];
  for (const r of rows){
    const durMs = new Date(r.clock_out) - new Date(r.clock_in);

    // Break summary
    const bks = breaksByEntry.get(r.id) || [];
    const breakMs = bks.reduce((sum, b) => {
      if (!b.ended_at) return sum;
      return sum + (new Date(b.ended_at) - new Date(b.started_at));
    }, 0);

    let inUrl=null,outUrl=null;
    try{
      if (r.photo_in_path){
        const { data:s } = await supabaseClient.storage.from('timeclock-photos').createSignedUrl(r.photo_in_path,180);
        inUrl = s?.signedUrl || null;
      }
      if (r.photo_out_path){
        const { data:s2 } = await supabaseClient.storage.from('timeclock-photos').createSignedUrl(r.photo_out_path,180);
        outUrl = s2?.signedUrl || null;
      }
    }catch(_e){}

    const a = anomalyById.get(r.id) || {};
    const rec = {
      id: r.id,
      clock_in: r.clock_in,
      clock_out: r.clock_out,
      duration_ms: durMs,
      store_id: r.store_id || null,
      photo_in_url: inUrl,
      photo_out_url: outUrl,
      // anomalies + approvals
      anomalies: Array.isArray(a.anomalies) ? a.anomalies : [],
      has_anomaly: !!a.has_anomaly,
      approval_status: a.approval_status || null,
      approval_note: a.approval_note || null,
      approved_at: a.approved_at || null,
      // NEW: breaks
      breaks: bks,                 // [{started_at, ended_at}, ...]
      break_count: bks.length,
      break_ms: breakMs
    };
    map.set(r.id, rec); out.push(rec);
  }
  currentShiftsById = map;
  lastDrawerShifts = out;
  return out;
}


function openDrawer(){ qs('drawer').classList.add('open'); qs('drawer').classList.remove('hidden'); qs('drawerBackdrop').classList.add('show'); qs('drawerBackdrop').classList.remove('hidden'); }
function closeDrawer(){ qs('drawer').classList.remove('open'); qs('drawerBackdrop').classList.remove('show'); setTimeout(()=>{ qs('drawer').classList.add('hidden'); qs('drawerBackdrop').classList.add('hidden'); },250); }
function renderDrawerHeader(name,monthStartStr){ qs('drawerTitle').textContent=name||'—'; qs('drawerSubtitle').textContent=monthLabel(monthStartStr); }
function renderDrawerSummary(shifts){ const n=shifts.length, tot=shifts.reduce((a,s)=>a+(s.duration_ms||0),0)/3600000, avg=n?tot/n:0; qs('dsShifts').textContent=String(n); qs('dsHours').textContent=fmtHours(tot); qs('dsAvg').textContent=fmtHours(avg); }

function renderDrawerList(shifts){
  const host = qs('drawerList'); host.innerHTML = '';

  const src = drawerOnlyAnoms ? shifts.filter(s => s.has_anomaly) : shifts;
  if (!src.length){
    host.innerHTML = `<div class="drawer-empty">${drawerOnlyAnoms ? 'No anomalies in this month.' : 'No closed shifts in this month.'}</div>`;
    return;
  }

  for (const s of src){
    const inStr  = fmtLocal(s.clock_in);
    const outStr = fmtLocal(s.clock_out);
    const durStr = fmtDurationHM(s.duration_ms);

    // Status chip
    const st = s.approval_status || 'pending';
    const stClass = st === 'approved' ? 'approved' : st === 'waived' ? 'waived' : 'pending';
    const statusChip = `<span class="chip ${stClass}">${st.toUpperCase()}</span>`;

    // Anomaly chips
    const anomChips = (s.anomalies||[]).map(code => `<span class="chip anom">⚠︎ ${code}</span>`).join('');

    // Break summary
    const breaksText = s.break_count ? `${s.break_count} break(s) • ${fmtDurationHM(s.break_ms)}` : 'No breaks';

    // Actions per status
    let actions = '';
    if (st === 'approved'){
      actions = `
        <button class="btn small" data-waive-id="${s.id}">Waive…</button>
        <button class="btn small ghost" data-unapprove-id="${s.id}">Unapprove</button>
      `;
    } else if (st === 'waived'){
      actions = `
        <button class="btn small" data-approve-id="${s.id}">Approve</button>
        <button class="btn small ghost" data-unapprove-id="${s.id}">Unapprove</button>
      `;
    } else {
      actions = `
        <button class="btn small" data-approve-id="${s.id}">Approve</button>
        <button class="btn small" data-waive-id="${s.id}">Waive…</button>
      `;
    }

    const noteLine = s.approval_note ? `<div class="shift-meta">Note: ${s.approval_note}</div>` : '';

    const div = document.createElement('div');
    div.className = 'shift';
    div.innerHTML = `
      <div class="shift-row" style="justify-content:space-between;">
        <div class="shift-time"><strong>In:</strong> ${inStr}</div>
        <div class="shift-time"><strong>Out:</strong> ${outStr}</div>
        <div class="shift-meta">${durStr}</div>
      </div>

      <div class="shift-row" style="margin-top:6px; justify-content:space-between;">
        <div class="chips">
          ${statusChip}
          ${anomChips}
          <span class="chip">${breaksText}</span>
        </div>
        <div class="shift-actions">
          ${s.photo_in_url ? `<a href="${s.photo_in_url}" target="_blank" rel="noopener">Photo In</a>` : ''}
          ${s.photo_out_url ? `<a href="${s.photo_out_url}" target="_blank" rel="noopener">Photo Out</a>` : ''}
          <button class="btn small" data-edit-id="${s.id}">Edit</button>
          <button class="btn small" data-audit-id="${s.id}">Audit</button>
          ${actions}
        </div>
      </div>

      ${noteLine}

      <div class="audit hidden" id="audit-${s.id}">
        <div class="drawer-empty">Loading…</div>
      </div>`;
    host.appendChild(div);
  }
}


async function fetchAuditsForShift(shiftId){
  const { data, error } = await supabaseClient.from('v_shift_adjustments')
    .select('id, time_entry_id, editor_name, editor_user_id, edited_at, reason, fields_changed, old_value, new_value')
    .eq('time_entry_id', shiftId).order('edited_at',{ascending:false});
  if (error) throw error; return data||[];
}
async function toggleAudit(shiftId){
  const c=document.getElementById(`audit-${shiftId}`); if(!c) return;
  if (!c.classList.contains('hidden')){ c.classList.add('hidden'); return; }
  c.classList.remove('hidden'); c.innerHTML=`<div class="drawer-empty">Loading…</div>`;
  try{ const audits = auditCache.get(shiftId) || await fetchAuditsForShift(shiftId); auditCache.set(shiftId,audits); renderAuditList(c,audits,shiftId); }
  catch(err){ console.error(err); c.innerHTML=`<div class="drawer-empty">Error loading audit trail.</div>`; }
}
function renderAuditList(container, audits, shiftId){
  if (!audits.length){ container.innerHTML=`<div class="drawer-empty">No adjustments yet.</div>`; return; }
  const parts=audits.map(a=>{
    const who=a.editor_name||'(unknown)', when=fmtLocal(a.edited_at), why=a.reason||'';
    const fields=Array.isArray(a.fields_changed)?a.fields_changed:[]; const oldIn=a.old_value?.clock_in, oldOut=a.old_value?.clock_out, newIn=a.new_value?.clock_in, newOut=a.new_value?.clock_out;
    const diffs=[]; if(fields.includes('clock_in')) diffs.push(`<div>clock_in: <code>${fmtLocal(oldIn)}</code> → <code>${fmtLocal(newIn)}</code></div>`); if(fields.includes('clock_out')) diffs.push(`<div>clock_out: <code>${fmtLocal(oldOut)}</code> → <code>${fmtLocal(newOut)}</code></div>`);
    return `
      <div class="ai" data-adjustment-id="${a.id}">
        <div class="row ai-hd">
          <div class="who">${who}</div>
          <div class="when">• ${when}</div>
          <div class="acts" style="margin-left:auto;">
            <button class="btn small" data-revert="${a.id}" title="Revert to OLD values">Revert</button>
          </div>
        </div>
        <div class="why">${why}</div>
        ${diffs.length?`<div class="chg">${diffs.join('')}</div>`:''}
      </div>`;
  });
  container.innerHTML = `<div class="ai-list">${parts.join('')}</div>`;
  container.querySelectorAll('button[data-revert]').forEach(btn=>btn.addEventListener('click',()=>onRevertClick(shiftId, btn.getAttribute('data-revert'))));
}
async function onRevertClick(shiftId, adjustmentId){
  const audits=auditCache.get(shiftId)||[]; const a=audits.find(x=>x.id===adjustmentId); if(!a) return;
  const oldIn=a.old_value?.clock_in, oldOut=a.old_value?.clock_out; if(!oldIn||!oldOut){ showToast('Cannot revert: missing old values','err'); return; }
  const reason=window.prompt('Reason for revert (required):', `Revert to ${fmtLocal(oldIn)} – ${fmtLocal(oldOut)}`); if(!reason||reason.trim().length<3){ showToast('Revert cancelled (reason required)','err'); return; }
  try{
    const { error } = await supabaseClient.rpc('admin_update_shift_time', { _time_entry_id: shiftId, _new_clock_in: oldIn, _new_clock_out: oldOut, _reason: reason.trim() });
    if (error) throw error;
    showToast('Shift reverted','ok'); auditCache.delete(shiftId);
    const { employeeId, monthStart } = drawerContext;
    const shifts=await fetchWorkerShifts(employeeId, monthStart); renderDrawerSummary(shifts); renderDrawerList(shifts);
    await toggleAudit(shiftId); await loadSummary();
  }catch(err){ console.error(err); showToast(err?.message||'Failed to revert','err'); }
}
let editingShiftId=null, saving=false;
function openEditModal(shift){ editingShiftId=shift.id; qs('editIn').value=toDatetimeLocalValue(shift.clock_in); qs('editOut').value=toDatetimeLocalValue(shift.clock_out); qs('editReason').value=''; qs('editError').textContent=''; show(qs('editError'),false); updateEditDuration(); qs('editModal').classList.add('open'); qs('editModal').classList.remove('hidden'); qs('editModalBackdrop').classList.add('show'); qs('editModalBackdrop').classList.remove('hidden'); qs('editIn').focus(); }
function closeEditModal(){ editingShiftId=null; saving=false; qs('editModal').classList.remove('open'); qs('editModalBackdrop').classList.remove('show'); setTimeout(()=>{ qs('editModal').classList.add('hidden'); qs('editModalBackdrop').classList.add('hidden'); },180); }
function updateEditDuration(){ const a=qs('editIn').value, b=qs('editOut').value; if(!a||!b){ qs('editDuration').textContent='—'; return; } const diff=new Date(b)-new Date(a); qs('editDuration').textContent = diff>0? fmtDurationHM(diff):'—'; }
function setEditError(msg){ const el=qs('editError'); el.textContent=msg||''; show(el,!!msg); }
async function saveEdit(){
  if(saving||!editingShiftId) return;
  const iv=qs('editIn').value, ov=qs('editOut').value, reason=(qs('editReason').value||'').trim();
  if(!iv||!ov) return setEditError('Both times are required.');
  const s=new Date(iv), e=new Date(ov); if(isNaN(s)||isNaN(e)) return setEditError('Invalid date/time values.'); if(e<s) return setEditError('Clock-out must be after clock-in.'); if(reason.length<3) return setEditError('Reason is required (min 3 characters).');
  setEditError(''); saving=true; qs('editSaveBtn').disabled=true; qs('editSaveBtn').textContent='Saving…';
  try{
    const inISO=localInputToOffsetISO(iv), outISO=localInputToOffsetISO(ov);
    const { error } = await supabaseClient.rpc('admin_update_shift_time', { _time_entry_id: editingShiftId, _new_clock_in: inISO, _new_clock_out: outISO, _reason: reason });
    if (error) throw error;
    showToast('Shift updated','ok'); closeEditModal();
    auditCache.delete(editingShiftId);
    const { employeeId, monthStart } = drawerContext;
    const shifts=await fetchWorkerShifts(employeeId, monthStart); renderDrawerSummary(shifts); renderDrawerList(shifts); await loadSummary();
  }catch(err){ console.error(err); setEditError(err?.message||'Failed to save changes'); }
  finally{ saving=false; qs('editSaveBtn').disabled=false; qs('editSaveBtn').textContent='Save'; }
}
function wireEditModal(){
  qs('editCloseBtn').addEventListener('click', closeEditModal);
  qs('editCancelBtn').addEventListener('click', closeEditModal);
  qs('editModalBackdrop').addEventListener('click', closeEditModal);
  qs('editIn').addEventListener('input', updateEditDuration);
  qs('editOut').addEventListener('input', updateEditDuration);
  qs('editSaveBtn').addEventListener('click', saveEdit);
  document.addEventListener('keydown',(e)=>{ const open=!qs('editModal').classList.contains('hidden'); if(!open) return; if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){ e.preventDefault(); const b=qs('editSaveBtn'); if(b&&!b.disabled) b.click(); }});
}
async function onRowClick(e){
  const tr=e.target.closest('tr.summary-row'); if(!tr) return;
  const employeeId=tr.dataset.employeeId, monthStart=tr.dataset.monthStart, displayName=tr.dataset.displayName||'—';
  drawerContext={ employeeId, monthStart, displayName };
  renderDrawerHeader(displayName, monthStart);
  qs('dsShifts').textContent=qs('dsHours').textContent=qs('dsAvg').textContent='…';
  qs('drawerList').innerHTML=`<div class="drawer-empty">Loading shifts…</div>`; openDrawer();
  try{ const shifts=await fetchWorkerShifts(employeeId, monthStart); renderDrawerSummary(shifts); renderDrawerList(shifts); }
  catch(err){ console.error(err); qs('drawerList').innerHTML=`<div class="drawer-empty">Error loading shifts.</div>`; }
}


function wireDrawer(){
  // Close actions
  const closeBtn = qs('drawerCloseBtn');
  if (closeBtn) closeBtn.addEventListener('click', closeDrawer);

  const backdrop = qs('drawerBackdrop');
  if (backdrop) backdrop.addEventListener('click', closeDrawer);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });

  // Click a summary row to open drawer
  const tbody = qs('summaryTbody');
  if (tbody) tbody.addEventListener('click', onRowClick);

  // Delegated actions inside the drawer list
  const list = qs('drawerList');
  if (list) {
    list.addEventListener('click', (e) => {
      const t = e.target;

      // Edit shift
      const editBtn = t.closest('button[data-edit-id]');
      if (editBtn) {
        const id = editBtn.getAttribute('data-edit-id');
        const shift = currentShiftsById.get(id);
        if (shift) openEditModal(shift);
        return;
      }

      // Audit toggle
      const auditBtn = t.closest('button[data-audit-id]');
      if (auditBtn) {
        toggleAudit(auditBtn.getAttribute('data-audit-id'));
        return;
      }

      // Approvals
      const approveBtn = t.closest('button[data-approve-id]');
      if (approveBtn) {
        onApproveClick(approveBtn.getAttribute('data-approve-id'));
        return;
      }

      const waiveBtn = t.closest('button[data-waive-id]');
      if (waiveBtn) {
        onWaiveClick(waiveBtn.getAttribute('data-waive-id'));
        return;
      }

      const unapproveBtn = t.closest('button[data-unapprove-id]');
      if (unapproveBtn) {
        onUnapproveClick(unapproveBtn.getAttribute('data-unapprove-id'));
        return;
      }
    });
  }

  // Toggle: only anomalies
  const toggle = qs('toggleAnoms');
  if (toggle) {
    toggle.addEventListener('change', () => {
      drawerOnlyAnoms = !!toggle.checked;
      renderDrawerList(lastDrawerShifts); // re-render with current cache
    });
  }
}

/* ============== Payroll (weekly) ============== */
let payWeeks=[], paySelected=null, payRows=[];
function formatWeekRange(weekStartStr){ const s=new Date(weekStartStr+'T00:00:00'); const e=new Date(s); e.setDate(s.getDate()+6); const f=d=>d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}); return `${f(s)} — ${f(e)}`; }
async function fetchWeekList(){
  const get = async t => { const {data,error}=await supabaseClient.from(t).select('week_start').order('week_start',{descending:true}).limit(2000); if(error) throw error; return (data||[]).map(r=>r.week_start); };
  let weeks=[]; try{ weeks=await get('mv_weekly_hours'); }catch(_e){}
  if(!weeks.length){ const {data}=await supabaseClient.from('v_weekly_hours').select('week_start').order('week_start',{descending:true}).limit(2000); weeks=(data||[]).map(r=>r.week_start); }
  const set=new Set(), out=[]; for(const w of weeks){ if(!set.has(w)){ set.add(w); out.push(w); } } return out;
}
async function fetchWeeklyHours(weekStartStr){
  const cols='employee_id, display_name, week_start, regular_hours, overtime_hours, total_hours';
  const get = async t => { const {data,error}=await supabaseClient.from(t).select(cols).eq('week_start',weekStartStr).order('display_name',{ascending:true}); if(error) throw error; return data||[]; };
  try{ const mv=await get('mv_weekly_hours'); if(mv.length) return {rows:mv,source:'mv'}; }catch(_e){}
  const v=await get('v_weekly_hours'); return {rows:v,source:'view'};
}
function renderPayWeekOptions(){
  const sel=qs('payWeekSelect'); sel.innerHTML=''; for(const w of payWeeks){ const o=document.createElement('option'); o.value=w; o.textContent=formatWeekRange(w); sel.appendChild(o); }
  if (paySelected) sel.value=paySelected;
}
function renderPayKPIs(rows){
  const reg=rows.reduce((a,r)=>a+(+r.regular_hours||0),0), ot=rows.reduce((a,r)=>a+(+r.overtime_hours||0),0), tot=rows.reduce((a,r)=>a+(+r.total_hours||0),0);
  qs('payTotalReg').textContent=fmtHours(reg); qs('payTotalOT').textContent=fmtHours(ot); qs('payTotalAll').textContent=fmtHours(tot);
}
function renderPayTable(rows){
  const tb=qs('payTbody'); tb.innerHTML=''; if(!rows.length){ tb.innerHTML=`<tr><td colspan="4" class="muted">No data for this week.</td></tr>`; return; }
  for(const r of rows){ const tr=document.createElement('tr'); tr.innerHTML=`<td>${r.display_name||'—'}</td><td>${fmtHours(r.regular_hours)}</td><td>${fmtHours(r.overtime_hours)}</td><td>${fmtHours(r.total_hours)}</td>`; tb.appendChild(tr); }
}
async function loadPayroll(){
  if(!paySelected){ qs('payTbody').innerHTML=`<tr><td colspan="4" class="muted">Pick a week.</td></tr>`; return; }
  qs('payWeekLabel').textContent = formatWeekRange(paySelected); qs('payTbody').style.opacity='0.6';
  try{
    const { rows } = await fetchWeeklyHours(paySelected); payRows=rows;
    renderPayKPIs(rows); renderPayTable(rows);
    await updatePeriodForSelectedWeek(); // NEW: sync period UI
  }catch(err){
    console.error(err);
    qs('payTbody').innerHTML = `<tr><td colspan="4" class="muted">Error loading payroll.</td></tr>`;
    qs('payTotalReg').textContent=qs('payTotalOT').textContent=qs('payTotalAll').textContent='—';
  }finally{ qs('payTbody').style.opacity='1'; }
}
async function bootPayroll(){
  payWeeks = await fetchWeekList();
  if (payWeeks.length){ paySelected = payWeeks[0]; renderPayWeekOptions(); qs('payWeekLabel').textContent = formatWeekRange(paySelected); await loadPayroll(); }
  else { qs('payWeekSelect').innerHTML=`<option value="">No weeks found</option>`; qs('payTbody').innerHTML=`<tr><td colspan="4" class="muted">No weekly data yet.</td></tr>`; }
}
function wirePayroll(){
  qs('payWeekSelect').addEventListener('change', async (e)=>{ paySelected=e.target.value||null; await loadPayroll(); });
  qs('payPrevBtn').addEventListener('click', async ()=>{ if(!paySelected) return; const i=payWeeks.indexOf(paySelected); if(i<payWeeks.length-1){ paySelected=payWeeks[i+1]; qs('payWeekSelect').value=paySelected; await loadPayroll(); }});
  qs('payNextBtn').addEventListener('click', async ()=>{ if(!paySelected) return; const i=payWeeks.indexOf(paySelected); if(i>0){ paySelected=payWeeks[i-1]; qs('payWeekSelect').value=paySelected; await loadPayroll(); }});
}

/* ============== Periods (lock/unlock) — NEW in 3.3 ============== */
let payPeriods = [];     // rows from pay_periods
let selectedPeriod = null;

async function fetchPayPeriods(){
  const { data, error } = await supabaseClient.from('pay_periods')
    .select('id, start_date, end_date, timezone, status, locked_at, locked_by, note')
    .order('start_date', { ascending: false });
  if (error) throw error;
  return data || [];
}
function dateOnly(str){ return new Date(str + 'T00:00:00'); }
function rangesOverlap(aStart, aEnd, bStart, bEnd){ return aStart <= bEnd && aEnd >= bStart; }
function findPeriodForWeek(weekStartStr){
  const ws=dateOnly(weekStartStr), we=new Date(ws); we.setDate(ws.getDate()+6);
  for (const p of payPeriods){
    const ps=dateOnly(p.start_date), pe=dateOnly(p.end_date); // inclusive end
    if (rangesOverlap(ws, we, ps, pe)) return p;
  }
  return null;
}
function setBadge(el, status){
  el.classList.remove('locked','open','warn');
  if (status==='locked'){ el.classList.add('locked'); el.textContent='LOCKED'; }
  else if (status==='open'){ el.classList.add('open'); el.textContent='OPEN'; }
  else { el.classList.add('warn'); el.textContent='NO PERIOD'; }
}

function renderPeriodUI(){
  const nameEl    = qs('periodName');
  const badgeEl   = qs('periodBadge');
  const hintEl    = qs('periodHint');
  const lockBtn   = qs('lockBtn');
  const unlockBtn = qs('unlockBtn');
  const exportBtn = qs('exportBtn');
  const createWeekBtn = qs('createWeekBtn');
  const newPeriodBtn  = qs('newPeriodBtn');

  function setBadge(status){
    badgeEl.classList.remove('locked','open','warn');
    if (status === 'locked') { badgeEl.classList.add('locked'); badgeEl.textContent = 'LOCKED'; }
    else if (status === 'open') { badgeEl.classList.add('open'); badgeEl.textContent = 'OPEN'; }
    else { badgeEl.classList.add('warn'); badgeEl.textContent = 'NO PERIOD'; }
  }

  if (!selectedPeriod){
    nameEl.textContent = 'No defined pay period covers this week';
    setBadge(null);
    hintEl.textContent = 'Tip: create a pay period that covers this week, then lock it for payroll.';
    if (lockBtn)   lockBtn.disabled   = true;
    if (unlockBtn) unlockBtn.disabled = true;
    if (exportBtn) exportBtn.disabled = true;
    if (createWeekBtn) createWeekBtn.disabled = false;   // enable quick-create
    if (newPeriodBtn)  newPeriodBtn.disabled  = false;
    return;
  }

  const p = selectedPeriod;
  nameEl.textContent = `${p.start_date} → ${p.end_date} (${p.timezone})`;
  setBadge(p.status);
  hintEl.textContent = p.status === 'locked'
    ? 'Edits inside this period are blocked.'
    : 'Open period — you can still edit shifts.';

  if (lockBtn)   lockBtn.disabled   = (p.status !== 'open');
  if (unlockBtn) unlockBtn.disabled = (p.status !== 'locked');
  if (exportBtn) exportBtn.disabled = false;
  if (createWeekBtn) createWeekBtn.disabled = true;  // avoid creating an overlapping week
  if (newPeriodBtn)  newPeriodBtn.disabled  = false; // allowed; RPC prevents overlaps anyway
}


async function updatePeriodForSelectedWeek(){
  payPeriods = await fetchPayPeriods();
  selectedPeriod = paySelected ? findPeriodForWeek(paySelected) : null;
  renderPeriodUI();
}
async function onLock(){
  if (!selectedPeriod) return;
  const note = window.prompt('Optional note for this lock:', 'Locked for payroll');
  try{
    const { error } = await supabaseClient.rpc('payroll_lock_period', { _period_id: selectedPeriod.id, _note: note||null, _force: false });
    if (error) throw error;
    showToast('Period locked','ok');
    await updatePeriodForSelectedWeek();
  }catch(err){
    console.error(err);
    showToast(err?.message || 'Failed to lock period','err');
  }
}
async function onUnlock(){
  if (!selectedPeriod) return;
  const note = window.prompt('Optional note for this unlock:', 'Re-opened for corrections');
  try{
    const { error } = await supabaseClient.rpc('payroll_unlock_period', { _period_id: selectedPeriod.id, _note: note||null });
    if (error) throw error;
    showToast('Period unlocked','ok');
    await updatePeriodForSelectedWeek();
  }catch(err){
    console.error(err);
    showToast(err?.message || 'Failed to unlock period','err');
  }
}
function csvEscape(value){
  if (value == null) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function rowsToCSV(rows){
  const header = ['Employee','Regular Hours','OT Hours','Total Hours','Shifts'];
  const lines = [header.map(csvEscape).join(',')];

  let totalReg=0, totalOT=0, totalAll=0, totalShifts=0;

  for (const r of rows){
    const reg = Number(r.regular_hours)||0, ot = Number(r.overtime_hours)||0, tot = Number(r.total_hours)||0, sh = Number(r.shifts_count)||0;
    totalReg += reg; totalOT += ot; totalAll += tot; totalShifts += sh;
    lines.push([
      r.display_name || '',
      reg.toFixed(2),
      ot.toFixed(2),
      tot.toFixed(2),
      String(sh)
    ].map(csvEscape).join(','));
  }
  // Totals row
  lines.push(['TOTAL', totalReg.toFixed(2), totalOT.toFixed(2), totalAll.toFixed(2), String(totalShifts)].map(csvEscape).join(','));
  return lines.join('\n');
}
function downloadText(filename, text, mime='text/csv;charset=utf-8;'){
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
async function onExport(){
  if (!selectedPeriod) return;
  try{
    const rows = await fetchPeriodSummary(selectedPeriod.id);
    const csv = rowsToCSV(rows);
    const fname = `payroll_${selectedPeriod.start_date}_to_${selectedPeriod.end_date}_${selectedPeriod.status}.csv`;
    downloadText(fname, csv);
    showToast('CSV exported','ok');
  }catch(err){
    console.error(err);
    showToast(err?.message || 'Failed to export CSV','err');
  }
}

function dateStrAddDays(yyyyMmDd, days){
  const d = new Date(yyyyMmDd + 'T00:00:00');
  d.setDate(d.getDate() + days);
  const p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

async function onCreateThisWeek(){
  if (!paySelected) return;
  try {
    const { error } = await supabaseClient.rpc('create_weekly_pay_period', {
      week_start: paySelected, weeks: 1, p_note: 'Created from Payroll UI'
    });
    if (error) throw error;
    showToast('Pay period created','ok');
    await updatePeriodForSelectedWeek();
  } catch (err) {
    console.error(err); showToast(err?.message || 'Failed to create period','err');
  }
}

async function approveShift(shiftId, note){
  const { error } = await supabaseClient.rpc('approve_shift', {
    _time_entry_id: shiftId, _status: 'approved', _note: note || null
  });
  if (error) throw error;
}
async function waiveShift(shiftId, note){
  const n = (note || '').trim();
  if (n.length < 3) throw new Error('Waive requires a brief note (min 3 chars).');
  const { error } = await supabaseClient.rpc('approve_shift', {
    _time_entry_id: shiftId, _status: 'waived', _note: n
  });
  if (error) throw error;
}
async function unapproveShift(shiftId){
  const { error } = await supabaseClient.rpc('unapprove_shift', { _time_entry_id: shiftId });
  if (error) throw error;
}

// Click handlers
async function onApproveClick(shiftId){
  try{
    const note = window.prompt('Optional note for approval:', '');
    await approveShift(shiftId, note);
    showToast('Shift approved','ok');
    // refresh drawer list
    const { employeeId, monthStart } = drawerContext;
    const shifts = await fetchWorkerShifts(employeeId, monthStart);
    renderDrawerSummary(shifts);
    renderDrawerList(shifts);
  }catch(err){ console.error(err); showToast(err?.message || 'Failed to approve','err'); }
}
async function onWaiveClick(shiftId){
  try{
    const note = window.prompt('Reason for waiver (required):', '');
    await waiveShift(shiftId, note);
    showToast('Shift waived','ok');
    const { employeeId, monthStart } = drawerContext;
    const shifts = await fetchWorkerShifts(employeeId, monthStart);
    renderDrawerSummary(shifts);
    renderDrawerList(shifts);
  }catch(err){ console.error(err); showToast(err?.message || 'Failed to waive','err'); }
}
async function onUnapproveClick(shiftId){
  try{
    if (!window.confirm('Remove approval/waiver for this shift?')) return;
    await unapproveShift(shiftId);
    showToast('Approval removed','ok');
    const { employeeId, monthStart } = drawerContext;
    const shifts = await fetchWorkerShifts(employeeId, monthStart);
    renderDrawerSummary(shifts);
    renderDrawerList(shifts);
  }catch(err){ console.error(err); showToast(err?.message || 'Failed to unapprove','err'); }
}


function openCreateModal(){
  const start = paySelected || (payWeeks[0] || new Date().toISOString().slice(0,10));
  qs('createStart').value = start;
  qs('createEnd').value = dateStrAddDays(start, 6);
  qs('createNote').value = '';
  qs('createError').textContent = ''; show(qs('createError'), false);
  qs('createModal').classList.add('open'); qs('createModal').classList.remove('hidden');
  qs('createModalBackdrop').classList.add('show'); qs('createModalBackdrop').classList.remove('hidden');
}
function closeCreateModal(){
  qs('createModal').classList.remove('open'); qs('createModalBackdrop').classList.remove('show');
  setTimeout(() => { qs('createModal').classList.add('hidden'); qs('createModalBackdrop').classList.add('hidden'); }, 180);
}
function setCreateError(msg){ const el=qs('createError'); el.textContent=msg||''; show(el, !!msg); }

async function createCustomPeriod(){
  const s = qs('createStart').value, e = qs('createEnd').value;
  const note = (qs('createNote').value||'').trim();
  if (!s || !e) return setCreateError('Start and end dates are required.');
  if (new Date(s) > new Date(e)) return setCreateError('End date must be after start date.');
  setCreateError('');
  try {
    const { error } = await supabaseClient.rpc('create_pay_period', {
      p_start_date: s, p_end_date: e, p_note: note || null
    });
    if (error) throw error;
    closeCreateModal(); showToast('Pay period created','ok');
    await updatePeriodForSelectedWeek();
  } catch (err) {
    console.error(err); setCreateError(err?.message || 'Failed to create pay period');
  }
}

function wireCreatePeriodUI(){
  const cw = qs('createWeekBtn');
  const np = qs('newPeriodBtn');
  if (cw) cw.addEventListener('click', onCreateThisWeek);
  if (np){
    np.addEventListener('click', openCreateModal);
    qs('createCloseBtn').addEventListener('click', closeCreateModal);
    qs('createCancelBtn').addEventListener('click', closeCreateModal);
    qs('createModalBackdrop').addEventListener('click', closeCreateModal);
    qs('createSaveBtn').addEventListener('click', createCustomPeriod);
  }
}

/* ============== Tabs ============== */
function switchTab(which){
  const ovBtn=qs('tabOverview'), pyBtn=qs('tabPayroll');
  const ov=qs('panelOverview'),  py=qs('panelPayroll');
  const set=(btn,panel,active)=>{ btn.classList.toggle('active',active); btn.setAttribute('aria-selected', String(active)); show(panel, active); };
  if (which==='payroll'){ set(pyBtn,py,true); set(ovBtn,ov,false); }
  else { set(ovBtn,ov,true); set(pyBtn,py,false); }
}
function wireTabs(){
  qs('tabOverview').addEventListener('click', ()=> switchTab('overview'));
  qs('tabPayroll').addEventListener('click',  ()=> switchTab('payroll'));
}

//* ============== Boot ============== */
document.addEventListener('supabase-ready', async () => {
  supabaseClient = window.supabase;

  // Guard UI
  show(qs('guardLoading'), true);
  show(qs('guardDenied'), false);
  show(qs('adminApp'), false);

  const ok = await ensureAdmin();

  show(qs('guardLoading'), false);
  show(qs('guardDenied'), !ok);
  show(qs('adminApp'), ok);

  if (!ok) return;

  // Header + tabs
  wireHeaderActions();
  wireTabs();

  // Prefill month for Overview
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const monthInput = qs('monthInput');
  if (monthInput) monthInput.value = ym;

  // Overview + Drawer/Edit/Audit wiring
  wireFilters();
  wireSorting();
  wireDrawer();
  wireEditModal();

  // Payroll wiring
  wirePayroll();
  wireCreatePeriodUI();


  // Period actions
  qs('lockBtn').addEventListener('click', onLock);
  qs('unlockBtn').addEventListener('click', onUnlock);
  qs('exportBtn').addEventListener('click', onExport);   // <- NEW: export CSV

  // Initial data loads
  await loadSummary();
  await bootPayroll(); // loadPayroll() inside will call updatePeriodForSelectedWeek()
});

// Kickoff if init already ran
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  if (window.supabase) {
    document.dispatchEvent(new Event('supabase-ready'));
  } else {
    setTimeout(() => {
      if (window.supabase) document.dispatchEvent(new Event('supabase-ready'));
    }, 0);
  }
}
