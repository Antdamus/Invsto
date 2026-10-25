(function(){
 'use strict';
 window.EbayAutoSync={start};
 async function start({db,refresh}){
  const panel=document.getElementById('ebay-auto-sync');if(!panel)return;
  const status=document.getElementById('ebay-auto-sync-status'),sync=document.getElementById('ebay-auto-sync-now'),toggle=document.getElementById('ebay-auto-sync-toggle'),reload=document.getElementById('ebay-auto-sync-reload');
  let current=null,busy=false;
  async function load(){
   const {data,error}=await db.rpc('get_ebay_order_auto_sync_status');if(error)throw Error('Could not check automatic eBay sync. Try again shortly.');
   current=data;panel.hidden=false;toggle.hidden=!data.can_control;
   toggle.textContent=data.enabled?'Pause auto sync':'Resume auto sync';
   sync.disabled=busy||!data.enabled||data.syncing;toggle.disabled=busy;
   const last=data.last_synced_at?new Date(data.last_synced_at).toLocaleString():'Not synced yet';
   status.textContent=`${data.enabled?'Updates automatically every 5 minutes':'Automatic sync paused'} · ${data.syncing?'Sync in progress':`Last synced: ${last}`}${data.last_error?` · ${data.last_error}`:''}`;
  }
  async function act(action){
   if(busy)return;busy=true;sync.disabled=toggle.disabled=reload.disabled=true;
   try{
    if(action){const {error}=await db.rpc('control_ebay_order_auto_sync',{_action:action});if(error)throw Error('Could not update eBay sync. Check your staff permissions and try again.');}
    busy=false;await load();if(!action)await refresh();
   }catch(error){status.textContent=error.message;}
   finally{busy=false;reload.disabled=false;toggle.disabled=false;sync.disabled=!current?.enabled||current?.syncing;}
  }
  sync.onclick=()=>act('sync');toggle.onclick=()=>act(current?.enabled?'pause':'resume');reload.onclick=()=>act(null);
  try{await load();}catch(error){panel.hidden=false;status.textContent=error.message;sync.disabled=true;toggle.hidden=true;}
  setInterval(()=>{if(!document.hidden&&!busy)load().catch(()=>{});},60000);
 }
})();
