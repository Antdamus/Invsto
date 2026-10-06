/* The eBay helper uses the same saved bag, label template and print queue as Live Sales. */
(() => {
  'use strict';
  const one = value => Array.isArray(value) ? value[0] : value;
  const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '');
  const prefix = 'invsto.live.bagPrinter.v1.';
  const requests = new Map();
  let installed = false;
  function install(api, sortAuctions, snapshot = () => null) {
    if (installed || new URL(location.href).searchParams.get('capture') !== '1') return;
    installed = true;
    const rpc = async (name, args = {}) => {const {data,error}=await window.supabase.rpc(name,args);if(error)throw error;return data;};
    async function user() {
      const {data,error}=await window.supabase.auth.getSession();
      if(error || !data?.session?.user?.id)throw Error('Sign in to the Invsto receiver.');
      return data.session.user.id;
    }
    async function dashboard(eventId) {
      const {data:connection,error}=await window.supabase.from('ebay_live_connections').select('event_id,session_id').eq('event_id',eventId).maybeSingle();
      if(error)throw error;
      if(!connection)throw Error('Start Invsto capture and choose the sellers for this show first.');
      const result=await rpc('get_ebay_live_dashboard',{_session_id:connection.session_id});
      if(result?.connection?.event_id!==eventId)throw Error('The receiver could not verify this eBay show.');
      return result;
    }
    const eligible = sale => sale?.payment_state==='paid' && !!String(sale.buyer||'').trim() && !sale.resolved_at && !sale.merged_into && !sale.payment_hold;
    const autoKey=(userId,eventId)=>prefix+userId+'.auto.'+eventId;
    const loadAuto=(userId,eventId)=>JSON.parse(localStorage.getItem(autoKey(userId,eventId))||'null');
    const saveAuto=(userId,eventId,state)=>localStorage.setItem(autoKey(userId,eventId),JSON.stringify(state));
    const autoView=state=>state?{enabled:state.enabled,pending:state.pending.length+Object.values(state.seen).filter(value=>value==='waiting-for-time').length,last:state.last,error:state.error,completed:Object.keys(state.done).filter(id=>state.done[id]==='sent')}:null;
    async function automatic(userId,eventId,data,printer,enabled) {
      // Web Locks serialize multiple receiver tabs. The server also deduplicates
      // automatic sends across users/computers using the original attempt ID.
      return navigator.locks.request(autoKey(userId,eventId),typeof enabled==='boolean'?{}:{ifAvailable:true},async lock=>{
        let state=loadAuto(userId,eventId);
        if(!lock)return {...autoView(state),busy:true};
        const rows=data.attempts||[],now=Date.parse(data.server_time)||Date.now();
        if(!state){state={enabled:true,since:Math.floor(now/60000)*60000,seen:{},done:{},pending:[],last:null,error:''};for(const a of rows){state.seen[a.id]=eligible(a);if(eligible(a))state.done[a.id]='earlier';}}
        if(typeof enabled==='boolean'){
          state.enabled=enabled;
          // Resuming starts with new sales; it never backfills a paused show.
          for(const a of rows){state.seen[a.id]=eligible(a);if(eligible(a)&&!state.pending.some(p=>p.id===a.id))state.done[a.id]||='paused';}
        }
        const active=!data.connection.broadcast_ended_at&&!data.connection.review_completed_at;
        for(const a of [...sortAuctions(rows)].reverse()){
          const paid=eligible(a),soldAt=Date.parse(a.sold_at);
          const witnessedPayment=state.seen[a.id]===false,recent=soldAt>=state.since;
          if(paid&&state.seen[a.id]!==true&&!state.done[a.id]&&!state.pending.some(p=>p.id===a.id)){
            // Sold cards can arrive paid before Activity supplies the win time.
            // Keep checking that sale; absence of a timestamp is not old history.
            if(state.enabled&&active&&!a.closed_at&&!witnessedPayment&&!Number.isFinite(soldAt)){
              state.seen[a.id]='waiting-for-time';continue;
            }
            if(state.enabled&&active&&!a.closed_at&&(witnessedPayment||recent))state.pending.push({id:a.id,number:window.liveBagLabel.identity({lot_code:''},a).auctionNumber});
            else state.done[a.id]='earlier';
          }
          state.seen[a.id]=paid;
        }
        saveAuto(userId,eventId,state);
        if(!state.enabled)return autoView(state);
        if(!printer?.stationId){state.error='Choose a paired printer in Settings for automatic printing.';saveAuto(userId,eventId,state);return autoView(state);}
        state.error=['failed','uncertain','cancelled'].includes(state.last?.status)?'Check Print Stations before reprinting the last bag.':'';
        const next=state.pending[0];
        if(next){
          const sale=rows.find(a=>a.id===next.id);
          if(!eligible(sale)){state.pending.shift();state.done[next.id]='payment changed';}
          else try{
            const sent=await run({action:'print',event_id:eventId,attemptId:next.id,requestId:next.id,automatic:true});
            state.pending.shift();state.done[next.id]='sent';state.last={number:next.number,attemptId:next.id,...sent.result};
            if(['failed','uncertain','cancelled'].includes(sent.result?.status))state.error='Check Print Stations before reprinting the last bag.';
          }catch(error){state.error=error.message||'Automatic print is waiting for the receiver.';}
        }
        saveAuto(userId,eventId,state);return autoView(state);
      });
    }
    async function destination(userId, override) {
      const saved=override || JSON.parse(localStorage.getItem(prefix+userId)||'null');
      const stations=await rpc('list_print_stations');
      const stationId=saved?.stationId || localStorage.getItem('invsto.print.destination.v1');
      if(saved?.local || stationId==='local')return {local:true,name:'This computer · local helper',copies:1,roll:'default'};
      const station=(stations||[]).find(s=>s.id===stationId && s.paired && !/\b5XL\b/i.test(s.printer_name+' '+s.printer_model));
      if(!station)return null;
      const twin=/twin\s*turbo/i.test(station.printer_name+' '+station.printer_model);
      const roll=saved?.roll || station.default_roll || 'default';
      if(twin && (!station.roll_selection_ready || !['Left','Right'].includes(roll)))return null;
      return {stationId:station.id,name:station.name,printer:station.printer_name,local:false,copies:1,roll,
        online:!!station.online,connected:!!station.printer_connected};
    }
    async function run(command) {
      if(!/^[A-Za-z0-9_-]{6,100}$/.test(command?.event_id||''))throw Error('Invalid eBay show.');
      const userId=await user();
      if(command.action==='configure') {
        const chosen=await window.printStations.chooseDestination({copies:1,configureOnly:true});
        localStorage.setItem(prefix+userId,JSON.stringify({...chosen,copies:1}));
        return {printer:await destination(userId)};
      }
      const data=['status','auto'].includes(command.action)?(snapshot(command.event_id)||await dashboard(command.event_id)):await dashboard(command.event_id);
      if(['status','auto'].includes(command.action)) {
        const sales=sortAuctions(data.attempts||[]).filter(eligible).map(a=>({id:a.id,
          number:window.liveBagLabel.identity({lot_code:''},a).auctionNumber,title:a.listing_title,
          buyer:a.buyer,amount:a.amount,lotId:a.lot_id,time:a.sold_at||a.win_time_label||''}));
        const printer=await destination(userId);
        const auto=command.action==='auto'?await automatic(userId,command.event_id,data,printer,command.enabled):autoView(loadAuto(userId,command.event_id));
        // An enqueue acknowledgement is not the printer acknowledgement. Read
        // current receipts without creating bags or sending any additional jobs.
        let printStatusAvailable=false;
        try {
          const receipts=await rpc('get_ebay_live_bag_print_status',{_event_id:command.event_id});
          if(!Array.isArray(receipts))throw Error('Print status unavailable');
          const byAttempt=new Map(receipts.map(j=>[j.attempt_id,j]));
          for(const sale of sales)sale.printJob=byAttempt.get(sale.id)||null;
          if(auto?.last){
            const current=receipts.find(j=>j.job_id===auto.last.jobId || j.attempt_id===auto.last.attemptId);
            if(current)auto.last={...auto.last,status:current.status,stationName:current.station_name,updatedAt:current.updated_at};
          }
          printStatusAvailable=true;
        } catch {
          // Receipt failures must not interrupt automatic printing or claim a
          // previously queued job was sent. The panel reports status unavailable.
        }
        return {sales,printer,automatic:auto,printStatusAvailable,show:data.connection.event_id};
      }
      if(command.action!=='print' || !uuid(command.requestId) || !uuid(command.attemptId))throw Error('Invalid bag print request.');
      const sale=data.attempts.find(a=>a.id===command.attemptId);
      if(!eligible(sale))throw Error('This sale is not cleared for a bag label. Check its payment in Live Sales.');
      // Persist the exact sale and printer before sending. A missing acknowledgement
      // retries the same server request, never a newly selected sale or printer.
      const key=prefix+userId+'.request.'+command.requestId;
      let saved=JSON.parse(localStorage.getItem(key)||'null');
      if(saved && (saved.attemptId!==sale.id || saved.eventId!==command.event_id))throw Error('This print request belongs to another bag.');
      if(saved?.result)return saved.result;
      const printer=await destination(userId,saved?.printer);
      if(!printer)throw Error('Choose the bag-label printer under Settings first.');
      if(command.automatic&&!printer.stationId)throw Error('Choose a paired printer for automatic printing.');
      if(!saved){saved={attemptId:sale.id,eventId:command.event_id,printer};localStorage.setItem(key,JSON.stringify(saved));}
      if(saved.localStarted)throw Error('A label file may already have downloaded. Check the local helper before requesting another copy.');
      const lot=one(await rpc('prepare_ebay_live_bag_label',{_attempt_id:sale.id}));
      if(!lot?.id || !lot.lot_code)throw Error('The saved bag could not be prepared. Try again.');
      const fresh=await dashboard(command.event_id);
      if(!eligible(fresh.attempts.find(a=>a.id===sale.id)))throw Error('Payment changed. Review this bag in Live Sales before printing.');
      if(printer.local){saved.localStarted=true;localStorage.setItem(key,JSON.stringify(saved));}
      const result=await api.printBag(lot.id,{printDestination:printer,requestId:command.requestId,automaticAttemptId:command.automatic?sale.id:undefined});
      saved.result={result,lotCode:lot.lot_code,attemptId:sale.id};localStorage.setItem(key,JSON.stringify(saved));
      return saved.result;
    }
    window.addEventListener('message',event=>{
      if(event.source!==window || event.origin!==location.origin || event.data?.type!=='INVSTO_BAG_PRINT_REQUEST')return;
      const {id,command}=event.data;
      if(!uuid(id))return;
      const key=command?.action==='print'?`${command.event_id}:${command.attemptId}:${command.requestId}`:null;
      const operation=key&&requests.has(key)?requests.get(key):run(command);
      if(key){requests.set(key,operation);operation.finally(()=>requests.delete(key)).catch(()=>{});}
      operation.then(result=>window.postMessage({type:'INVSTO_BAG_PRINT_RESPONSE',id,ok:true,...result},location.origin),
        error=>window.postMessage({type:'INVSTO_BAG_PRINT_RESPONSE',id,ok:false,error:error.message||'Could not reach the printer.',cancelled:!!error.cancelled},location.origin));
    });
  }
  window.liveBagPrintBridge={install};
})();
