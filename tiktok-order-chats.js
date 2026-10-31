(function(){
 'use strict';
 let controller;
 function create({db,user,getOrders,root=document}){
  const records=new Map();let stopped=false,running=false,rerun=false,error='',permission=null,timer,channel,authSubscription;
  const slots=()=>[...root.querySelectorAll('[data-tk-chat-orders]')];
  const idsOf=el=>(el.dataset.tkChatOrders||'').split(',').filter(Boolean);
  const scope=()=>[...new Set(slots().flatMap(idsOf))];
  const validIds=()=>new Set(getOrders().map(o=>o.id));
  function summarize(ids){
   const unique=new Map();let missing=false,unlinked=false;
   for(const id of ids){const row=records.get(id);if(!row){missing=true;continue;}if(!row.buyer_linked)unlinked=true;for(const chat of row.chats||[])if(!unique.has(chat.id))unique.set(chat.id,{...chat,orderId:id});}
   const chats=[...unique.values()].sort((a,b)=>Number(b.unread_count>0)-Number(a.unread_count>0)||String(b.latest_message_at||'').localeCompare(a.latest_message_at||''));
   return {chats,unread:chats.reduce((n,c)=>n+Number(c.unread_count||0),0),missing,unlinked,
    stale:chats.some(c=>!c.synced_at||Date.now()-Date.parse(c.synced_at)>10*60*1000)};
  }
  function paint(){
   for(const el of slots()){
    const ids=idsOf(el),s=summarize(ids),chat=s.chats[0];
    const unread=permission!==false&&s.unread>0,hasChat=permission!==false&&s.chats.length>0;
    const warning=permission!==false&&(!!error||s.stale);
    let label=permission===false?'Buyer chat · access required':unread?`Buyer chat · ${s.unread} unread`:hasChat?'Buyer chat · history':s.missing?'Buyer chat · checking':s.unlinked?'Buyer chat · buyer ID needed':'Buyer chat & reply';
    if(warning)label+=' · Check updates';
    el.textContent=label;el.classList.add('tk-chat-badge');el.classList.toggle('has-unread',unread);el.classList.toggle('has-chat',hasChat&&!unread);el.classList.toggle('is-stale',warning);
    const params=new URLSearchParams({order:chat?.orderId||ids[0]||''});if(chat)params.set('conversation',chat.id);
    el.href='tiktok-messages.html?'+params;el.target='_blank';el.rel='noopener';
    el.title=permission===false?'Messaging access is required. Ask an administrator to enable Email Triage access.':'Buyer-wide conversation; it may cover other orders. Unread counts are shared across the TikTok shop. Opening this order does not mark messages read.';
    el.setAttribute('aria-label',label+' — '+el.title);
    el.closest('.tk-order-item')?.classList.toggle('has-tk-unread-chat',unread);
   }
   for(const card of root.querySelectorAll('.tk-buyer')){
    const ids=[...new Set([...card.querySelectorAll('[data-tk-chat-orders]')].flatMap(idsOf))];
    card.classList.toggle('has-tk-unread-chat',permission!==false&&summarize(ids).unread>0);
   }
   const status=root.querySelector('#tk-chat-status');if(status){
    const anyStale=slots().some(el=>summarize(idsOf(el)).stale);
    status.textContent=permission===false?'Chat indicators require messaging access.':error?'Chat updates unavailable · retrying. Keep existing alerts in mind.':anyStale?'TikTok chat sync is delayed · check the buyer’s chat for the latest messages.':'Blue: chat history · Amber: unread in TikTok (shared across the shop). Buyer chats may cover several orders; updates appear after TikTok syncs.';
    status.classList.toggle('is-warning',!!error||anyStale);
   }
  }
  async function refresh(){
   if(stopped||document.hidden)return;if(running){rerun=true;return;}running=true;
   try{
    if(permission===null){const r=await db.rpc('can_access_tiktok_messages');if(r.error)throw r.error;permission=r.data===true;}
    if(!permission){records.clear();return;}
    const ids=scope(),next=new Map(records);
    for(let i=0;i<ids.length;i+=300){
     const chunk=ids.slice(i,i+300),{data,error:failed}=await db.rpc('list_tiktok_order_chat_markers',{_order_ids:chunk});
     if(failed)throw failed;if(stopped)return;
     if(!Array.isArray(data)||chunk.some(id=>!data.some(row=>row.order_id===id)))throw Error('Incomplete chat status');
     const allowed=new Set(chunk);for(const row of data)if(allowed.has(row.order_id))next.set(row.order_id,row);
    }
    const valid=validIds();records.clear();for(const [id,row] of next)if(valid.has(id))records.set(id,row);error='';
    connect();
   }catch(e){if(e.code==='42501'){permission=false;records.clear();}else error=e.message||'Chat updates unavailable';}
   finally{running=false;if(!stopped){paint();if(rerun){rerun=false;schedule(250);}}}
  }
  function schedule(delay=150){if(stopped)return;clearTimeout(timer);timer=setTimeout(refresh,delay);}
  function resume(){if(!document.hidden){permission=null;schedule(0);}}
  function connect(){
   if(channel||!db.channel)return;
   channel=db.channel('tiktok-order-chats:'+user.id).on('postgres_changes',{event:'*',schema:'public',table:'tiktok_chat_conversations'},()=>schedule());
   channel.subscribe(state=>{if(state==='SUBSCRIBED')schedule();});
  }
  function rendered(){paint();schedule();}
  function stop(){stopped=true;records.clear();clearTimeout(timer);clearInterval(interval);window.removeEventListener('focus',resume);window.removeEventListener('online',resume);document.removeEventListener('visibilitychange',resume);authSubscription?.unsubscribe();if(channel)void db.removeChannel(channel);paint();}
  const interval=setInterval(resume,20000);
  authSubscription=db.auth?.onAuthStateChange?.((event,session)=>{if(event==='SIGNED_OUT'||session?.user?.id&&session.user.id!==user.id){permission=false;stop();}})?.data?.subscription;
  window.addEventListener('focus',resume);window.addEventListener('online',resume);document.addEventListener('visibilitychange',resume);
  rendered();return {rendered,refresh:resume,stop};
 }
 window.TikTokOrderChats={create,start:options=>{controller?.stop();controller=create(options);},rendered:()=>controller?.rendered()};
})();
