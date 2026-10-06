'use strict';
(() => {
  const eventId=location.pathname.split('/')[4];
  const key='invsto-bag-label-request:'+eventId;
  function mount(box) {
    const style=document.createElement('style');
    style.textContent=`#invsto-capture-helper{position:fixed;bottom:12px;left:12px;z-index:2147483646;background:#18251f;color:#f8f6ee;border:1px solid #526454;border-radius:16px;padding:12px;width:340px;max-width:calc(100vw - 48px);font:13px/1.4 system-ui;box-shadow:0 8px 30px #0004}#invsto-capture-helper *{box-sizing:border-box}#invsto-capture-helper .bag-bar{display:flex;align-items:center;gap:12px}#invsto-capture-helper .bag-identity{flex:1;min-width:0}#invsto-capture-helper .bag-identity small{display:block;text-transform:uppercase;letter-spacing:.12em;font-size:9px;color:#b6c1b7}#invsto-capture-helper .bag-number{display:block;font-size:24px;line-height:1.2;font-weight:750}#invsto-capture-helper .bag-buyer{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d7ded7}#invsto-capture-helper button,#invsto-capture-helper select{font:inherit;border:1px solid #546356;border-radius:10px;padding:9px 11px;background:#29372e;color:inherit;cursor:pointer}#invsto-capture-helper button:disabled{opacity:.45;cursor:default}#invsto-capture-helper [data-bag-print]{background:#efd295;color:#19241d;border:0;font-weight:750;min-height:42px;white-space:nowrap}#invsto-capture-helper details{margin-top:8px}#invsto-capture-helper summary{cursor:pointer;color:#bfcabe;font-size:11px;width:fit-content}#invsto-capture-helper .bag-settings{display:grid;gap:8px;padding-top:10px;max-height:45vh;overflow:auto}#invsto-capture-helper .bag-settings label{display:grid;gap:4px}#invsto-capture-helper select{width:100%;min-width:0}#invsto-capture-helper [data-bag-status]{margin:6px 0 0;font-size:11px;color:#c5d9c0}#invsto-capture-helper [data-bag-status]:empty{display:none}#invsto-capture-helper [data-bag-status].error{color:#ffb8aa}#og-ebay-cancellation-panel{display:none!important}`;
    document.head.append(style);
    style.textContent+=`#invsto-capture-helper [data-bag-receipt]{display:grid;gap:2px;margin:9px 0 0;padding:9px 11px;border-radius:10px;background:#ffffff0a;border:1px solid #ffffff16}#invsto-capture-helper [data-bag-receipt] strong{font-size:13px}#invsto-capture-helper [data-bag-receipt] small{font-size:11px;color:#bfccc2}#invsto-capture-helper [data-bag-receipt][data-state="submitted"]{background:#263e31;border-color:#5c8968;color:#c4ebcc}#invsto-capture-helper [data-bag-receipt][data-state="failed"],#invsto-capture-helper [data-bag-receipt][data-state="uncertain"]{border-color:#98644f;color:#ffceb5}`;
    box.removeAttribute('style');
    box.innerHTML='<div class="bag-bar"><div class="bag-identity"><small data-bag-heading>Latest paid bag</small><strong class="bag-number">—</strong><span class="bag-buyer">Connecting to Invsto…</span></div><button type="button" data-bag-print disabled>Print label</button></div><select data-bag-choice aria-label="Choose a bag to print" style="margin-top:10px"><option value="">Latest paid bag · automatic</option></select><div class="bag-auto" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px"><small data-bag-auto-state role="status">Connecting auto print…</small><button type="button" data-bag-auto-toggle style="padding:4px 8px;font-size:11px" disabled>Pause</button></div><p data-bag-auto-status role="status" style="font-size:11px;margin:5px 0 0" hidden></p><p data-bag-status role="status" aria-live="polite"></p><details><summary>Settings</summary><div class="bag-settings"><button type="button" data-bag-printer>Choose printer</button><small data-bag-printer-name></small><div data-capture-settings></div></div></details>';
    const $=s=>box.querySelector(s),print=$('[data-bag-print]'),choice=$('[data-bag-choice]'),configure=$('[data-bag-printer]');
    const receipt=document.createElement('div');receipt.dataset.bagReceipt='';receipt.setAttribute('role','status');receipt.setAttribute('aria-live','polite');receipt.innerHTML='<strong></strong><small></small>';choice.before(receipt);
    const clear=document.createElement('button');clear.type='button';clear.textContent='Clear pending send';clear.hidden=true;$('.bag-settings').append(clear);
    let sales=[],printer=null,automatic=null,chosen='',busy=false,loading=false,ready=false,pending=null,completed=new Set(),printStatusAvailable=false;
    try{pending=JSON.parse(sessionStorage.getItem(key)||'null');}catch{}
    const status=(text,error=false)=>{$('[data-bag-status]').textContent=text;$('[data-bag-status]').classList.toggle('error',error);};
    const command=async(action,extra={})=>{
      const result=await chrome.runtime.sendMessage({type:'INVSTO_BAG_LABEL_COMMAND',command:{action,event_id:eventId,...extra}});
      if(!result?.ok)throw Object.assign(Error(result?.error||'Open the signed-in Invsto receiver to print bags.'),{cancelled:result?.cancelled});
      return result;
    };
    const selected=()=>sales.find(s=>s.id===(pending?.attemptId||chosen))||pending?.sale||(!chosen&&!pending?sales[0]:null);
    const jobText=state=>({queued:'Waiting for printer',claimed:'Sending to printer',submitted:'Sent to printer',failed:'Print failed',uncertain:'Check printer',cancelled:'Print cancelled'})[state]||'Not sent yet';
    const sentTime=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'';};
    function render() {
      const sale=selected(),job=sale?.printJob,activeJob=job&&['queued','claimed'].includes(job.status);
      $('[data-bag-heading]').textContent=chosen?'Selected bag':'Latest paid bag';
      $('.bag-number').textContent=sale?.number?'#'+sale.number:sale?'Bag label':'—';
      $('.bag-buyer').textContent=sale?.buyer||(pending?'Previous send needs checking':ready?'Waiting for a paid sale':'Connect Invsto in Settings');
      $('.bag-identity').title=sale?.title||'';
      print.disabled=busy||!!automatic?.busy||!ready||!sale||!!(activeJob&&!pending);
      print.textContent=busy?'Sending…':pending?'Retry send':activeJob?'Label queued':!printer?'Choose printer':(job||completed.has(sale?.id)||automatic?.completed?.includes(sale?.id))?'Reprint label':'Print label';
      choice.disabled=busy||!!pending;configure.disabled=busy||!!pending;
      clear.hidden=!pending;clear.disabled=busy;
      const signature=JSON.stringify([printStatusAvailable,sales.map(s=>[s.id,s.number,s.buyer,s.printJob?.status])]);
      if(choice.dataset.sales!==signature){choice.dataset.sales=signature;choice.replaceChildren(new Option('Latest paid bag · automatic',''),...sales.map(s=>new Option(`${s.number?'#'+s.number+' · ':''}${s.buyer} · ${printStatusAvailable?jobText(s.printJob?.status):'Status unavailable'}`,s.id)));}
      choice.value=chosen;
      receipt.dataset.state=printStatusAvailable?job?.status||'unsent':'unknown';
      receipt.querySelector('strong').textContent=!ready?'Connecting…':!sale?'Waiting for a paid sale':!printStatusAvailable?'Print status unavailable':(job?.status==='submitted'?'✓ ':'')+jobText(job?.status);
      const details=[];
      if(ready&&sale&&printStatusAvailable){
        if(job){
          if(job.status==='submitted')details.push(sentTime(job.updated_at));
          details.push(job.station_name);
          if(job.printer_roll&&job.printer_roll!=='default')details.push(job.printer_roll+' roll');
          if(['failed','uncertain','cancelled'].includes(job.status))details.push(job.submitted_copies?`${job.submitted_copies}/${job.copies} copies sent. Check Print Stations.`:'Check Print Stations before reprinting.');
          else if(job.status==='queued')details.push('Will update when the printer accepts it');
        }else details.push(printer?.local?'Local helper receipts are shown on that computer.':automatic?.enabled===false?'Auto print is paused.':'No print job for this bag yet.');
      }else if(ready&&sale)details.push('Checking again automatically. Open Print Stations to verify.');
      receipt.querySelector('small').textContent=details.filter(Boolean).join(' · ');
      receipt.title=job?.detail||'';
      const toggle=$('[data-bag-auto-toggle]');toggle.disabled=busy||!ready;toggle.textContent=automatic?.enabled===false?'Resume':'Pause';toggle.setAttribute('aria-label',automatic?.enabled===false?'Resume automatic printing':'Pause automatic printing');
      $('[data-bag-auto-state]').textContent=automatic?.enabled===false?'Auto print paused':automatic?.busy?'Auto print · sending…':!printer?.stationId?'Auto print · choose printer':'Auto print on · '+printer.name;
      const autoStatus=$('[data-bag-auto-status]');
      autoStatus.textContent=automatic?.error|| (automatic?.pending?`${automatic.pending} bag label${automatic.pending===1?'':'s'} waiting for auto print`:'');autoStatus.hidden=!autoStatus.textContent;autoStatus.style.color=automatic?.error?'#ffb8aa':'#c5d9c0';
      configure.textContent=printer?'Change printer':'Choose printer';
      $('[data-bag-printer-name]').textContent=printer?`${printer.name}${printer.roll&&printer.roll!=='default'?' · '+printer.roll+' roll':''}${printer.local?' · downloads to the existing helper':printer.online&&printer.connected?'':' · offline; labels will wait'}`:'Uses the same printer setup as Live Sales. Choose it once for one-click printing.';
    }
    async function refresh() {
      if(loading||busy)return;loading=true;
      try{const result=await command('auto');sales=result.sales||[];printer=result.printer;automatic=result.automatic;printStatusAvailable=result.printStatusAvailable===true;const wasReady=ready;ready=true;if(!wasReady)status(pending?'A previous send needs confirmation. Retry uses the same request.':'');render();}
      catch(error){ready=false;status(error.message,true);render();}
      finally{loading=false;}
    }
    async function settings() {
      if(busy||pending)return;busy=true;render();status('Choose the printer in the Invsto print window.');
      try{const result=await command('configure');printer=result.printer;status(printer?'Printer saved. Ready for bag labels.':'Choose a printer before printing.');}
      catch(error){status(error.cancelled?'Printer choice cancelled.':error.message,!error.cancelled);}
      finally{busy=false;render();refresh();}
    }
    configure.onclick=settings;
    $('[data-bag-auto-toggle]').onclick=async()=>{
      if(busy||!ready)return;busy=true;render();
      try{const result=await command('auto',{enabled:automatic?.enabled===false});automatic=result.automatic;}
      catch(error){status(error.message,true);}
      finally{busy=false;render();}
    };
    clear.onclick=()=>{if(!pending||busy||!confirm('This label may already have been sent. Check the printer or Print Stations before clearing it. A later print will request a new copy. Clear this pending send?'))return;pending=null;sessionStorage.removeItem(key);status('Pending send cleared. Check the earlier job before printing another copy.');render();};
    choice.onchange=()=>{chosen=choice.value;status('');render();};
    print.onclick=async()=>{
      const sale=selected();if(busy||!ready||!sale)return;
      if(!printer&&!pending)return settings();
      busy=true;
      if(!pending){pending={attemptId:sale.id,requestId:crypto.randomUUID(),sale};sessionStorage.setItem(key,JSON.stringify(pending));}
      render();status('Sending bag label…');
      try{
        const result=await command('print',pending);completed.add(pending.attemptId);pending=null;sessionStorage.removeItem(key);
        const job=result.result;
        if(job?.mode==='remote-queue'){
          sale.printJob={job_id:job.jobId,status:job.status,station_name:job.stationName,printer_roll:job.roll};
          status('');
        }else status(`${sale.number?'#'+sale.number+' · ':''}Label downloaded to the local print helper.`);
      }catch(error){status(error.message,true);}
      finally{busy=false;render();}
    };
    void refresh();setInterval(refresh,2000);
    return {settings:$('[data-capture-settings]')};
  }
  window.InvstoBagLabelPanel={mount};
})();
