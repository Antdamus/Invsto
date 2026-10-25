(function(){
 'use strict';
 window.TikTokApi={start};
 async function start({db,refresh}){
  const panel=document.getElementById('tk-api'),status=document.getElementById('tk-api-status'),connect=document.getElementById('tk-api-connect'),sync=document.getElementById('tk-api-sync'),pause=document.getElementById('tk-api-pause');
  if(!panel)return;
  let connection=null,working=false;
  async function call(action){
   const {data,error}=await db.functions.invoke('tiktok-order-sync',{body:{action}});
   if(error){let detail;try{detail=await error.context?.json();}catch{}throw Error(detail?.error||'Could not reach the TikTok connection. Try again shortly.');}
   if(data?.error)throw Error(data.error);return data;
  }
  async function load(){
   const result=await call('status');connection=result.connection;
   panel.hidden=false;connect.hidden=!result.admin;connect.disabled=!result.configured;
   connect.textContent=connection?'Reconnect shop':'Connect TikTok Shop';
   sync.hidden=!connection;sync.disabled=!connection?.enabled||connection?.syncing;
   pause.hidden=!result.admin||!connection;pause.textContent=connection?.enabled?'Pause auto sync':'Resume auto sync';
   if(!result.configured)status.textContent='TikTok API setup is being completed on the server.';
   else if(!connection)status.textContent='Connect your US shop to update orders automatically.';
   else{
    const last=connection.last_synced_at?new Date(connection.last_synced_at).toLocaleString():'Not synced yet';
    status.textContent=`${connection.shop_name} · ${connection.enabled?'Auto sync every 5 minutes':'Auto sync paused'} · ${connection.syncing?'Sync in progress':`Last synced: ${last}`}${connection.last_error?` · ${connection.last_error}`:''}`;
   }
  }
  async function act(fn){if(working)return;working=true;for(const button of [connect,sync,pause])button.disabled=true;try{await fn();await load();}catch(error){status.textContent=error.message;}finally{working=false;connect.disabled=false;sync.disabled=!connection?.enabled||connection?.syncing;pause.disabled=false;}}
  connect.onclick=()=>act(async()=>{const result=await call('connect');const url=new URL(result.url);if(url.origin!=='https://services.tiktokshops.us'||url.pathname!=='/open/authorize')throw Error('Unexpected TikTok authorization destination.');location.assign(url.href);});
  sync.onclick=()=>act(async()=>{await call('sync');status.textContent='TikTok sync queued. You can keep working.';});
  pause.onclick=()=>act(async()=>{await call(connection?.enabled?'pause':'resume');});
  document.getElementById('tk-api-reload').onclick=()=>act(async()=>{await load();await refresh();});
  try{await load();}catch(error){panel.hidden=false;status.textContent=error.message;connect.hidden=true;sync.hidden=true;pause.hidden=true;}
  setInterval(()=>{if(!document.hidden&&!working)load().catch(()=>{});},60000);
 }
})();
