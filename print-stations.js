(function () {
  'use strict';
  const PREF = 'invsto.print.destination.v1';
  const PENDING = 'invsto.print.pending.v1.';
  const styles = document.createElement('link');styles.rel='stylesheet';styles.href='print-stations.css?v=20260927-all-labels';document.head.append(styles);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const cancelled = () => Object.assign(new Error('Printing cancelled. No new print request was sent.'), {cancelled:true});
  async function rpc(name, args={}) {
    if (!window.supabase?.auth?.getSession) throw new Error('Sign in to Invsto before sending labels.');
    const {data:{session}={}}=await window.supabase.auth.getSession();
    if (!session) throw new Error('Sign in to Invsto before sending labels.');
    const {data,error}=await window.supabase.rpc(name,args);
    if (error) throw error;
    return data;
  }
  const stationStatus = station => !station.paired ? 'Not paired' : !station.online ? 'Computer offline — jobs will wait' : !station.printer_connected ? 'Printer disconnected — jobs will wait' : 'Online · printer connected';
  const jobStatus = status => ({queued:'Waiting for computer',claimed:'Sending to printer',submitted:'Sent to printer',failed:'Failed before printing',uncertain:'Check printer before retrying',cancelled:'Cancelled'}[status] || status);
  let choosing=false;
  async function chooseDestination({copies=1,labelCount=1}={}) {
    if (choosing) throw new Error('Choose the destination in the open print window.');
    choosing=true;
    const dialog=document.createElement('dialog');dialog.className='print-station-dialog';
    dialog.innerHTML=`<form method="dialog"><div class="print-dialog-head"><h2>Print labels</h2><button value="cancel" aria-label="Close print destination">×</button></div></form><p>Choose the computer and printer that should receive these labels.</p><p role="status" data-message>Loading print stations…</p><label>Send to<select data-destination disabled></select></label><label>Copies per label<input data-copies type="number" min="1" max="100" value="${Math.max(1,Math.min(100,Number(copies)||1))}"></label><p>${labelCount>1?`${labelCount} item labels. `:''}<span data-destination-status></span></p><a href="print-stations.html">Set up a computer or view print jobs</a><div class="print-dialog-actions"><button type="button" data-cancel>Cancel</button><button type="button" data-send disabled>Send labels</button></div>`;
    const previousFocus=document.activeElement;document.body.append(dialog);dialog.showModal();
    return new Promise((resolve,reject)=>{
      let finished=false, stations=[];
      const finish=(value,error)=>{if(finished)return;finished=true;choosing=false;dialog.close();dialog.remove();previousFocus?.focus?.();error?reject(error):resolve(value);};
      dialog.addEventListener('cancel',event=>{event.preventDefault();finish(null,cancelled());});
      dialog.addEventListener('close',()=>finish(null,cancelled()));
      dialog.querySelector('[data-cancel]').onclick=()=>finish(null,cancelled());
      const select=dialog.querySelector('[data-destination]'),send=dialog.querySelector('[data-send]'),status=dialog.querySelector('[data-destination-status]');
      const update=()=>{
        const station=stations.find(row=>row.id===select.value);
        status.textContent=station?`${station.printer_name || 'DYMO'} · ${stationStatus(station)}. Labels stay assigned to this computer.`:select.value==='local'?'Downloads a label file on this device for the existing local helper.':'Choose a print station.';
        send.disabled=!station && select.value!=='local';send.textContent=select.value==='local'?'Download label file':'Send labels';
      };
      select.onchange=update;
      send.onclick=()=>{
        const amount=Number(dialog.querySelector('[data-copies]').value);
        if(!Number.isInteger(amount)||amount<1||amount>100){dialog.querySelector('[data-message]').textContent='Choose 1–100 copies per label.';return;}
        const station=stations.find(row=>row.id===select.value);if(!station&&select.value!=='local')return;
        localStorage.setItem(PREF,select.value);finish({stationId:station?.id || null,name:station?.name || 'This device',copies:amount,local:!station});
      };
      rpc('list_print_stations').then(rows=>{
        if(finished)return;stations=(rows||[]).filter(row=>row.paired);
        select.innerHTML='<option value="">Select a computer…</option>'+stations.map(station=>`<option value="${escape(station.id)}">${escape(station.name)} — ${escape(stationStatus(station))}</option>`).join('')+'<option value="local">Download on this device (local helper)</option>';
        const preferred=localStorage.getItem(PREF);if(preferred==='local'||stations.some(row=>row.id===preferred))select.value=preferred;
        select.disabled=false;dialog.querySelector('[data-message]').textContent=stations.length?'Each job goes only to the computer you select.':'No paired computers yet. Open “Set up a computer” below on your phone, and download the helper on the printing computer.';update();
      }).catch(error=>{if(finished)return;dialog.querySelector('[data-message]').textContent=error.message || 'Could not load print stations.';select.innerHTML='<option value="">Choose an option…</option><option value="local">Download on this device (local helper)</option>';select.disabled=false;update();});
    });
  }
  async function enqueueLabel(labelXml, options={}) {
    const destination=options.printDestination;
    if(!destination?.stationId)throw new Error('Select a print station.');
    const copies=destination.copies || options.copies || 1;
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${copies}\n${labelXml}`));
    const key=PENDING+Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
    let pending=JSON.parse(localStorage.getItem(key)||'null');
    if(pending && pending.stationId!==destination.stationId)throw new Error('An earlier send needs confirmation at its original computer. Check Print jobs, or choose that same station to confirm it first.');
    if(!pending){pending={requestId:crypto.randomUUID(),stationId:destination.stationId};localStorage.setItem(key,JSON.stringify(pending));}
    let job;
    try {job=await rpc('enqueue_label_print',{_station_id:destination.stationId,_request_id:pending.requestId,_label_xml:labelXml,_copies:copies,_title:options.title || '',_barcode:options.barcode || ''});}
    catch(error){if(/^(P0001|22023|42501|23514|23503)$/.test(error.code||''))localStorage.removeItem(key);throw error;}
    localStorage.removeItem(key);
    options.onProgress?.(copies,copies,{name:destination.name});
    return {mode:'remote-queue',jobId:job.id,stationName:destination.name,copies,status:job.status};
  }
  async function printLabel(labelXml,options={}) {
    const destination=options.printDestination || await chooseDestination(options);
    if(destination.stationId)return enqueueLabel(labelXml,{...options,printDestination:destination});
    const blob=new Blob([labelXml],{type:'application/xml'}),url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=options.filename ? options.filename.replace(/_Copies_\d+/i,`_Copies_${destination.copies}`) : `OGJewelers_Label_Copies_${destination.copies}_${Date.now()}.dymo`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    return {mode:'queued-download',filename:a.download,copies:destination.copies};
  }
  function deliveryMessage(result) {
    return result.mode==='remote-queue'
      ? `Queued ${result.copies} label${result.copies===1?'':'s'} for ${result.stationName}. View Print Stations for status.`
      : `Downloaded ${result.copies} label cop${result.copies===1?'y':'ies'} for the local helper.`;
  }
  function mountLabelButton(container, getLabel) {
    if (!container) return;
    const button=document.createElement('button'),status=document.createElement('p');
    button.type='button';button.className='print-label-button';button.textContent='Print DYMO Label';
    status.setAttribute('role','status');container.replaceChildren(button,status);
    button.addEventListener('click',async()=>{
      if(button.disabled)return;
      button.disabled=true;status.textContent='Preparing label…';
      try {
        const {xml,...options}=await getLabel();
        if(!xml)throw new Error('Generate a label before printing.');
        const result=await printLabel(xml,options);status.textContent=deliveryMessage(result);
      } catch(error) {status.textContent=error.message || 'Could not send this label.';}
      finally {button.disabled=false;}
    });
    return button;
  }
  async function initPage() {
    const root=document.getElementById('print-stations-page');if(!root)return;
    const message=document.getElementById('print-page-status'),stationList=document.getElementById('print-station-list'),jobsList=document.getElementById('print-job-list');
    let refreshing=false,admin=false;
    const report=error=>{message.textContent=error?.message||String(error);};
    async function pairing(result){
      const box=document.getElementById('print-pairing');box.hidden=false;
      document.getElementById('print-pair-code').textContent=result.code.match(/.{1,4}/g).join('-');
      document.getElementById('print-pair-expiry').textContent=`Use this code before ${new Date(result.expires_at).toLocaleTimeString()}. Enter it into the helper on the printing computer.`;
      box.scrollIntoView({block:'center'});
    }
    async function refresh(){
      if(refreshing)return;refreshing=true;
      try{
        const [stations,jobs]=await Promise.all([rpc('list_print_stations'),rpc('list_label_print_jobs')]);
        stationList.innerHTML=stations.length?stations.map(station=>`<article class="print-station-card"><h3>${escape(station.name)}</h3><strong>${escape(stationStatus(station))}</strong><p>${escape(station.printer_name || 'Complete pairing to choose the printer')}${station.computer_name?` · ${escape(station.computer_name)}`:''}</p>${station.last_error?`<p>${escape(station.last_error)}</p>`:''}${admin?`<div class="print-card-actions">${!station.paired?`<button data-renew="${escape(station.id)}">Get new pairing code</button>`:''}<button data-disconnect="${escape(station.id)}">Disconnect station</button></div>`:''}</article>`).join(''):'<p>No print stations yet. Add your first computer below.</p>';
        jobsList.innerHTML=jobs.length?jobs.map(job=>`<article class="print-job-card"><h3>${escape(job.title || job.barcode || 'Label')}</h3><strong>${escape(jobStatus(job.status))}</strong><p>${escape(job.station_name)} · ${escape(job.printer_name)} · ${job.submitted_copies}/${job.copies} copies submitted</p><p>${escape(new Date(job.created_at).toLocaleString())}${job.barcode?` · ${escape(job.barcode)}`:''}</p>${job.detail?`<p>${escape(job.detail)}</p>`:''}${job.status==='queued'?`<button data-cancel-job="${escape(job.id)}">Cancel queued job</button>`:['submitted','failed','uncertain','cancelled'].includes(job.status)?`<button data-retry-job="${escape(job.id)}" data-job-status="${escape(job.status)}">${job.status==='submitted'?'Print again':'Send a new request'}</button>`:''}</article>`).join(''):'<p>No print jobs yet. Use Print labels in Add Item, Add Inventory, or Stock.</p>';
      }catch(error){report(error);}finally{refreshing=false;}
    }
    root.addEventListener('click',async event=>{
      const button=event.target.closest('button');if(!button)return;
      try{
        if(button.dataset.renew){button.disabled=true;await pairing(await rpc('renew_print_station_pairing',{_station_id:button.dataset.renew}));}
        if(button.dataset.disconnect && confirm('Disconnect this computer and cancel its waiting labels? Any label already sent may still print.')){button.disabled=true;await rpc('disconnect_print_station',{_station_id:button.dataset.disconnect});}
        if(button.dataset.cancelJob){button.disabled=true;await rpc('cancel_label_print',{_job_id:button.dataset.cancelJob});}
        if(button.dataset.retryJob){
          const warning=['submitted','uncertain'].includes(button.dataset.jobStatus)?'This label may already have printed. Send the full quantity again to the same station?':'Send a new print request to the same station?';
          if(confirm(warning)){button.disabled=true;const retryKey='invsto.print.retry.'+button.dataset.retryJob;const requestId=localStorage.getItem(retryKey)||crypto.randomUUID();localStorage.setItem(retryKey,requestId);await rpc('retry_label_print',{_job_id:button.dataset.retryJob,_request_id:requestId});localStorage.removeItem(retryKey);message.textContent='New print request queued for the same computer.';}
        }
        if(button.id==='print-refresh')await refresh();
        if(button.id==='print-copy-code'){await navigator.clipboard.writeText(document.getElementById('print-pair-code').textContent);message.textContent='Pairing code copied.';}
        if(button.dataset.renew||button.dataset.disconnect||button.dataset.cancelJob||button.dataset.retryJob)await refresh();
      }catch(error){report(error);}finally{if(button.isConnected)button.disabled=false;}
    });
    document.getElementById('print-register-form').addEventListener('submit',async event=>{
      event.preventDefault();const button=event.submitter;button.disabled=true;
      try{await pairing(await rpc('register_print_station',{_name:document.getElementById('print-station-name').value.trim()}));await refresh();message.textContent='Computer added. Download and pair the helper on that computer.';}catch(error){report(error);}finally{button.disabled=false;}
    });
    try{admin=Boolean(await rpc('can_manage_print_stations'));document.getElementById('print-setup').hidden=!admin;message.textContent=admin?'Ready. Pair a computer or review your print jobs.':'Choose an existing station when printing. An administrator can pair additional computers.';}catch(error){report(error);}
    await refresh();setInterval(()=>{if(!document.hidden)void refresh();},5000);
  }
  window.printStations={chooseDestination,enqueueLabel,printLabel,stationStatus,jobStatus,deliveryMessage,mountLabelButton};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initPage);else void initPage();
})();
