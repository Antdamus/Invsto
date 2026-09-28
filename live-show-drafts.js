(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let api,busy=false,loading=false;
  function notice(text,error=false){$('show-draft-status').textContent=text;$('show-draft-status').classList.toggle('is-error',error);$('show-list-status').textContent=text;}
  function canLeave(){
    if(busy||api.state.busy||window.ebayLive?.isBusy())return false;
    if(window.liveManualItems?.hasUnsaved())throw Error('Add your manual item or save its edits before changing shows. Its text and photo are still here.');
    if(api.state.selectedItem||api.state.itemSearchTimer)throw Error('Finish adding the scanned item, or clear the scanner, before changing shows.');
    return true;
  }
  async function setDraft(id,saved){
    const {data,error}=await window.supabase.rpc('set_live_sale_session_draft',{_session_id:id,_saved:saved});
    if(error)throw Error(error.message);
    const row=Array.isArray(data)?data[0]:data;
    api.state.sessions=api.state.sessions.map(s=>s.id===id?row:s);
    if(api.state.currentSession?.id===id)api.state.currentSession=row;
    return row;
  }
  function render(){
    if(!api)return;
    const current=api.state.currentSession,rows=api.state.sessions;
    for(const id of ['scan-stage','bag-label-panel','session-setup-panel'])if($(id))$(id).inert=busy;
    $('show-draft-save').hidden=!current;
    $('show-draft-save').disabled=busy||api.state.busy||!!window.ebayLive?.isBusy();
    $('show-drafts-open').disabled=busy||api.state.busy||!!window.ebayLive?.isBusy();
    $('show-drafts-open').textContent=`Shows & drafts (${rows.length})`;
    $('show-current-name').textContent=current?`${current.title} · ${current.saved_for_later_at?'Saved for later':'In progress'}`:'Start a show or return to a saved draft';
    $('show-list-new').textContent=current?'Save this show & start another':'Start new show';
    for(const button of $('show-drafts-dialog').querySelectorAll('button'))button.disabled=busy||loading;
    const html=rows.map(s=>`<article class="show-draft-card"><div><strong>${escape(s.title||'Live show')}</strong><span>${s.saved_for_later_at?'Draft · finish later':'Unfinished show'}${s.id===current?.id?' · Selected':''}</span><small>${escape(new Date(s.started_at).toLocaleString())} · ${escape(s.session_code)}</small><small>${escape(api.storeName(s.store_id)||'No store')} · ${escape(s.seller_snapshot?.primary?.display_name||'Seller not recorded')}</small></div><button type="button" class="secondary-btn" data-resume-show="${escape(s.id)}" ${busy||loading?'disabled':''}>${s.id===current?.id?'Continue':'Open show'}</button></article>`).join('')||'<p>No unfinished shows. Start a new show below.</p>';
    if($('show-draft-list').innerHTML!==html)$('show-draft-list').innerHTML=html;
  }
  async function open(){
    if(busy||api.state.busy||window.ebayLive?.isBusy())return;
    if(!$('show-drafts-dialog').open)$('show-drafts-dialog').showModal();loading=true;render();
    try{await api.reload();notice(`${api.state.sessions.length} unfinished ${api.state.sessions.length===1?'show':'shows'} in your account.`);}
    catch(error){notice(error.message,true);}
    finally{loading=false;render();}
  }
  async function save(){
    try{
      if(!canLeave()||!api.state.currentSession)return;
      busy=true;render();const name=api.state.currentSession.title;
      await setDraft(api.state.currentSession.id,true);
      await api.leave(false);
      notice(`${name} saved for later. Its auctions, bags, photos and prices are kept.`);
      $('show-drafts-dialog').showModal();
    }catch(error){notice(error.message||'Could not save this show. Try again.',true);}
    finally{busy=false;render();}
  }
  async function startNew(){
    try{
      if(!canLeave())return;
      busy=true;render();
      if(api.state.currentSession)await setDraft(api.state.currentSession.id,true);
      await api.leave(true);
      $('show-drafts-dialog').close();notice('Previous shows stay saved. Enter the new show’s event link and seller.');
    }catch(error){notice(error.message||'Could not prepare the next show.',true);}
    finally{busy=false;render();}
  }
  async function select(id){
    try{
      if(!canLeave())return false;
      const selected=api.state.sessions.find(s=>s.id===id);if(!selected)throw Error('Refresh Shows & drafts to find this show.');
      busy=true;render();
      // Switching never closes a show or releases any bag reservations.
      if(api.state.currentSession&&api.state.currentSession.id!==id)await setDraft(api.state.currentSession.id,true);
      if(selected.saved_for_later_at)await setDraft(id,false);
      await api.select(id);
      $('show-drafts-dialog').close();notice(`${selected.title} opened. Continue its bags and final checks.`);
      return true;
    }catch(error){notice(error.message||'Could not open this show.',true);return false;}
    finally{busy=false;render();}
  }
  function init(bridge){
    api=bridge;
    const bar=document.createElement('section');bar.id='show-draft-toolbar';bar.innerHTML='<strong id="show-current-name"></strong><div class="button-row"><button id="show-draft-save" type="button" class="secondary-btn" hidden>Save for later</button><button id="show-drafts-open" type="button" class="secondary-btn">Shows & drafts</button></div><p id="show-draft-status" role="status"></p>';
    document.querySelector('.live-hero').after(bar);
    const dialog=document.createElement('dialog');dialog.id='show-drafts-dialog';dialog.setAttribute('aria-labelledby','show-list-title');dialog.innerHTML='<div class="show-list-heading"><h2 id="show-list-title">Shows & drafts</h2><button id="show-list-close" type="button" class="secondary-btn">Back</button></div><p>Finish bags later. Each show keeps its own sales, prices and labels until you complete the final checks.</p><div class="button-row"><button id="show-list-new" type="button" class="primary-btn">Start new show</button><button id="show-list-refresh" type="button" class="secondary-btn">Refresh list</button></div><p id="show-list-status" role="status"></p><div id="show-draft-list"></div><small>On the capture computer, open the next eBay Stream Manager event and start capture there. Leave the Invsto receiver open; notifications stay with their linked show.</small>';document.body.append(dialog);
    $('show-draft-save').onclick=save;$('show-drafts-open').onclick=open;$('show-list-new').onclick=startNew;$('show-list-close').onclick=()=>dialog.close();$('show-list-refresh').onclick=open;
    $('show-draft-list').onclick=e=>{const b=e.target.closest('[data-resume-show]');if(b)select(b.dataset.resumeShow);};
    dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});render();
  }
  window.liveShowDrafts={init,render,select,isBusy:()=>busy};
})();
