/* Compact read-only chat signals. Opening a marker never sends or marks a message read. */
(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const key = value => String(value || '').trim().toLowerCase();
  const icon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-8 8H5l-4 3v-11a8 8 0 0 1 8-8h3a8 8 0 0 1 8 8Z"/><path d="M6 9h9M6 13h6"/></svg>';
  let controller;
  function create({client,userId,getLines,root=document}) {
    const records=new Map(),pending=new Set(),reviews=new Map();
    let timer,interval,channel,running=false,stopped=false,lastError='',connected=false,announced=false;
    const buyer=line=>key(line.order?.buyer_username || line.buyer_username);
    const lines=()=>getLines().filter(line=>line.id);
    const href=(id,row)=>`email-triage.html?orderLineId=${encodeURIComponent(id)}&from=pending${row?.latest_conversation_id ? `&conversationId=${encodeURIComponent(row.latest_conversation_id)}` : ''}`;
    function badge(id,row,{summary=false,stale=false}={}) {
      if(!row) return summary?'':`<a class="pending-chat-badge is-checking" href="${href(id)}" target="_blank" rel="noopener">${icon}<span>${lastError?'Chat status unavailable':'Checking chat…'}</span></a>`;
      if(!row.conversation_count) return summary?'':`<a class="pending-chat-badge is-empty" href="${href(id)}" target="_blank" rel="noopener">${icon}<span>eBay chat ↗</span></a>`;
      const fresh=Number(row.unread_count)>0;
      const label=fresh?'New buyer message':row.match_scope==='item'?'Item chat':row.match_scope==='order'?'Order chat':'Buyer chat';
      const title=[fresh?'Unread by you. Review before completing this order.':'Open the existing conversation.',row.match_scope==='buyer'?'Buyer conversation; may relate to another item.':'',row.latest_buyer_preview||'',stale?'Updates are temporarily unavailable. Open chat to check the latest messages.':''].filter(Boolean).join(' ');
      return `<a class="pending-chat-badge ${fresh?'has-unread':'has-chat'}" href="${href(id,row)}" target="_blank" rel="noopener" title="${escape(title)}" aria-label="${escape(label)}${fresh?' — review before completing':''}">${icon}<span>${label}${(fresh?row.unread_count:row.conversation_count)>1?` · ${fresh?row.unread_count:row.conversation_count}`:''}</span>${stale?'<small>Check updates</small>':''}<span aria-hidden="true">↗</span></a>`;
    }
    function put(node,html){if(node.innerHTML!==html){const focused=node.contains(document.activeElement);node.innerHTML=html;if(focused)node.querySelector('a')?.focus({preventScroll:true});}node.onclick=event=>event.stopPropagation();}
    function paint(target=root) {
      const cards=target.matches?.('.buyer-order-card')?[target]:[...target.querySelectorAll('.buyer-order-card')];
      for(const card of cards){
        const group=lines().filter(line=>buyer(line)===key(card.dataset.buyerUsername));
        const relevant=group.map(line=>({line,row:records.get(line.id)})).filter(entry=>entry.row?.conversation_count);
        relevant.sort((a,b)=>Number(b.row.unread_count>0)-Number(a.row.unread_count>0)||String(b.row.latest_buyer_message_at||'').localeCompare(a.row.latest_buyer_message_at||''));
        const selected=relevant[0],unread=new Set(relevant.flatMap(entry=>entry.row.unread_conversation_ids||[]));
        card.classList.toggle('has-buyer-message',unread.size>0);
        let marker=card.querySelector('[data-buyer-chat-marker]');
        if(!marker){marker=document.createElement('span');marker.dataset.buyerChatMarker='';card.querySelector('.buyer-card-alerts')?.append(marker);}
        const row=selected?{...selected.row,unread_count:unread.size}:null;
        put(marker,selected?badge(selected.line.id,row,{summary:true,stale:!!lastError}):'');
        for(const link of card.querySelectorAll('[data-line-chat-marker]')){
          const id=link.dataset.lineChatMarker,r=records.get(id);
          put(link,badge(id,r,{stale:!!lastError}));
          link.closest('[data-line-id]')?.classList.toggle('has-buyer-message',!!r?.unread_count);
        }
      }
      for(const [element,scope] of reviews){
        if(!element.isConnected){reviews.delete(element);continue;}
        const unread=scope.map(id=>({id,row:records.get(id)})).filter(entry=>entry.row?.unread_count);
        const byBuyer=new Map();for(const entry of unread){const name=key(entry.row.buyer_username);if(!byBuyer.has(name))byBuyer.set(name,entry);}
        element.hidden=!unread.length&&!lastError;
        put(element,unread.length?`<strong>Review buyer messages before completing</strong><p>There are messages you haven’t read yet. Your packing work stays open.</p><div>${[...byBuyer.values()].map(entry=>badge(entry.id,entry.row,{stale:!!lastError})).join('')}</div>`:lastError?'<strong>Chat updates are unavailable</strong><p>Check the buyer’s chat before completing if you are waiting for a reply.</p>':'');
      }
      const status=root.querySelector('[data-pending-chat-status]');
      if(status){status.textContent=lastError?'Chat updates unavailable · retrying':connected?'Chat updates live':'Chat updates checking periodically';status.title='Updates automatically when new eBay messages reach Invsto. Amber means unread by you.';status.classList.toggle('is-warning',!!lastError);}
    }
    function schedule(ids=lines().map(line=>line.id),delay=400) {
      if(stopped)return;
      const valid=new Set(lines().map(line=>line.id));for(const id of ids)if(valid.has(id))pending.add(id);
      if(timer||running||!pending.size||document.visibilityState==='hidden')return;
      timer=setTimeout(()=>{timer=null;void refresh();},delay);
    }
    async function refresh(){
      if(running||stopped)return;running=true;
      const ids=[...pending];pending.clear();let newlyUnread=false;
      try{
        for(let offset=0;offset<ids.length;offset+=300){
          const chunk=ids.slice(offset,offset+300);
          const {data,error}=await client.rpc('list_pending_order_chat_markers',{_line_ids:chunk});
          if(error)throw error;if(stopped)return;
          const valid=new Set(lines().map(line=>line.id));
          for(const row of data||[]){
            if(!valid.has(row.line_id))continue;
            const old=records.get(row.line_id);
            if(old&&((row.unread_conversation_ids||[]).some(id=>!old.unread_conversation_ids?.includes(id))||row.unread_count&&row.latest_buyer_message_at!==old.latest_buyer_message_at))newlyUnread=true;
            records.set(row.line_id,row);
          }
        }
        lastError='';
        if(newlyUnread&&announced){const status=root.querySelector('[data-pending-chat-announcement]');if(status)status.textContent='New buyer message received. Review the highlighted chat before completing the order.';}
        announced=true;
      }catch(error){lastError=error.message||'Chat updates unavailable';}
      finally{running=false;if(!stopped){paint();if(pending.size)schedule([],750);}}
    }
    function rendered(target=root){paint(target);schedule(lines().filter(line=>!records.has(line.id)).map(line=>line.id));}
    function changed(payload){
      const row=payload.new||payload.old||{},all=lines();
      const usernames=new Set([row.other_party_username,row.sender_username,row.recipient_username,row.buyer_username].map(key).filter(Boolean));
      const conversationId=row.conversation_id||(payload.table==='ebay_conversations'?row.id:null);
      let affected=all.filter(line=>usernames.has(buyer(line))||line.order_id===row.ebay_order_id||line.id===row.ebay_order_line_id||records.get(line.id)?.conversation_ids?.includes(conversationId));
      // Blank participant summaries may only acquire their verified buyer link later.
      if(!affected.length&&(payload.table==='ebay_conversation_links'||payload.table==='ebay_conversations'&&!row.other_party_username))affected=all;
      if(affected.length)schedule(affected.map(line=>line.id));
    }
    function resume(){if(document.visibilityState!=='hidden')schedule(undefined,0);}
    function connect(){
      if(!client.channel)return;
      channel=client.channel(`pending-order-chats:${userId}`);
      for(const table of ['ebay_conversation_messages','ebay_conversations','ebay_conversation_links'])channel.on('postgres_changes',{event:'*',schema:'public',table},payload=>changed({...payload,table}));
      channel.on('postgres_changes',{event:'*',schema:'public',table:'ebay_conversation_user_read_states',filter:`user_id=eq.${userId}`},payload=>changed({...payload,table:'ebay_conversation_user_read_states'}));
      channel.subscribe(status=>{connected=status==='SUBSCRIBED';if(connected)resume();paint();});
    }
    function review(element,scope){
      if(!element)return;
      reviews.set(element,scope.map(line=>line.id));paint();schedule(scope.map(line=>line.id),0);
    }
    function stop(){stopped=true;clearTimeout(timer);clearInterval(interval);window.removeEventListener('focus',resume);window.removeEventListener('online',resume);document.removeEventListener('visibilitychange',resume);if(channel)void client.removeChannel(channel);}
    interval=setInterval(resume,20000);window.addEventListener('focus',resume);window.addEventListener('online',resume);document.addEventListener('visibilitychange',resume);
    connect();rendered();
    return {rendered,refresh:resume,review,stop,records};
  }
  window.PendingOrderChats={create,start:options=>{controller?.stop();controller=create(options);return controller;},rendered:target=>controller?.rendered(target),review:(element,lines)=>controller?.review(element,lines)};
})();
