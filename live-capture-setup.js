(() => {
  'use strict';
  const valid = id => /^[A-Za-z0-9_-]{6,100}$/.test(id || '');
  const $ = id => document.getElementById(id);
  let api, dialog, eventId, busy = false, selectedEvent = null, stream = null;

  function shell() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'live-capture-setup';
    dialog.setAttribute('aria-labelledby', 'capture-setup-title');
    dialog.innerHTML = '<h2 id="capture-setup-title">Who’s selling?</h2><p id="capture-setup-description">We found your eBay event. Choose who is selling first and anyone joining the show.</p><p id="capture-setup-event"></p><form id="capture-seller-form"><label>First seller<select id="capture-main-seller" required><option value="">Choose a seller</option></select></label><details id="capture-additional"><summary>Additional sellers (optional)</summary><div id="capture-co-sellers"></div></details><p id="capture-setup-status" role="status"></p><div class="button-row"><button id="capture-start-show" type="submit" class="primary-btn">Start show</button><button id="capture-setup-cancel" type="button" class="secondary-btn">Later</button></div></form>';
    document.body.append(dialog);
    dialog.addEventListener('cancel', e => { if (busy) e.preventDefault(); });
    $('capture-setup-cancel').onclick = () => { if (!busy) dialog.close(); };
    $('capture-main-seller').onchange = () => {
      dialog.querySelectorAll('[name="capture-co-seller"]').forEach(input => {
        input.disabled = input.value === $('capture-main-seller').value;
        if (input.disabled) input.checked = false;
      });
    };
    $('capture-seller-form').onsubmit = save;
    return dialog;
  }

  function status(text, error = false) {
    $('capture-setup-status').textContent = text;
    $('capture-setup-status').classList.toggle('is-error', error);
  }

  async function existing(id) {
    const connection = await window.supabase.from('ebay_live_connections').select('session_id').eq('event_id', id).maybeSingle();
    if (connection.error) throw Error(connection.error.message);
    if (!connection.data) return null;
    const result = await window.supabase.from('live_sale_sessions').select('*').eq('id', connection.data.session_id).maybeSingle();
    if (result.error) throw Error(result.error.message);
    if (!result.data) throw Error('The linked show could not be loaded. Refresh and try again.');
    if (result.data.status !== 'active') throw Error('This show is already closed. Open the current eBay event to start a new show.');
    return result.data;
  }

  async function connect(row, id) {
    // Mark the acknowledged event before refreshing; refresh failures must never
    // cause a second session or overwrite the existing show's sellers.
    selectedEvent = id;
    await api.connected(row);
    dialog.close();
    window.postMessage({type:'INVSTO_CAPTURE_CONNECTED',event_id:id},location.origin);
  }

  function disable(value) {
    busy = value;
    $('capture-start-show').disabled = value;
    $('capture-setup-cancel').disabled = value;
    $('capture-main-seller').disabled = value;
    dialog.querySelectorAll('[name="capture-co-seller"]').forEach(input => {
      input.disabled = value || input.value === $('capture-main-seller').value;
    });
  }

  async function request(id, metadata = null) {
    if (!api || !valid(id) || busy) return;
    if (eventId === id && dialog?.open) {
      if(metadata && !stream){stream=metadata;$('capture-setup-event').textContent=`${stream.title || 'eBay show'} · ${String(stream.start_local || '').replace('T',' ')} ${stream.timezone_label || ''}`;status('Show date received. Choose your seller to continue.');}
      return;
    }
    shell(); eventId = id; stream = metadata;
    $('capture-setup-event').textContent = stream ? `${stream.title || 'eBay show'} · ${String(stream.start_local || '').replace('T',' ')} ${stream.timezone_label || ''}` : 'eBay event ' + id;
    $('capture-main-seller').replaceChildren(new Option('Choose a seller', ''));
    $('capture-co-sellers').replaceChildren();
    $('capture-additional').open = false;
    for (const seller of api.state.employees) {
      const name = seller.display_name || seller.email || 'Seller';
      $('capture-main-seller').add(new Option(name, seller.id));
      const label = document.createElement('label'), input = document.createElement('input');
      input.type = 'checkbox'; input.name = 'capture-co-seller'; input.value = seller.id;
      label.append(input, document.createTextNode(name)); $('capture-co-sellers').append(label);
    }
    $('capture-start-show').textContent = 'Start show';
    dialog.showModal(); disable(true); status('Checking this show…');
    try {
      const row = await existing(id);
      if (row) {
        if(stream){const result=await window.supabase.rpc('apply_ebay_live_stream_metadata',{_event_id:id,_stream:stream});if(result.error)throw Error(result.error.message);Object.assign(row,Array.isArray(result.data)?result.data[0]:result.data);}
        await connect(row, id); return;
      }
      status(stream ? 'Recovered sales use the first seller you choose. You can correct individual bags or the whole show afterward.' : 'Update Live Capture, then click Start Invsto capture on eBay to read the original show date.', !stream);
    } catch (error) {
      status(error.message, true);
    } finally { disable(false); }
    $('capture-main-seller').focus();
  }

  async function save(e) {
    e.preventDefault(); if (busy) return;
    const primary = $('capture-main-seller').value;
    if (!stream) { status('Click Start Invsto capture on eBay with Live Capture 1.3.0 to read the original show date.', true); return; }
    if (!primary) { status('Choose who is selling first.', true); return; }
    const id = eventId;
    const others = [...dialog.querySelectorAll('[name="capture-co-seller"]:checked')].map(input => input.value).filter(value => value !== primary);
    disable(true); status('Connecting your show…');
    try {
      const result = await window.supabase.rpc('start_ebay_live_capture_from_stream', {
        _event_id: id, _primary_seller_employee_id: primary, _co_seller_employee_ids: others, _stream: stream,
      });
      if (result.error) throw Error(result.error.message);
      const row = Array.isArray(result.data) ? result.data[0] : result.data;
      if (!row?.id) throw Error('The show could not be loaded. Please try again.');
      await connect(row, id);
    } catch (error) {
      status(selectedEvent === id ? 'Your show is saved. Refresh this page to reconnect.' : error.message, true);
    } finally { disable(false); }
  }

  function showSignIn() {
    const panel = document.createElement('dialog'); panel.id = 'live-capture-setup';
    panel.innerHTML = '<h2>Sign in to start capture</h2><p>Sign in to Invsto, then return here. Your eBay event will be ready.</p><a class="primary-btn" href="index.html" target="_blank" rel="noopener">Sign in</a><button type="button" class="secondary-btn">I’ve signed in</button>';
    panel.querySelector('button').onclick = () => location.reload(); document.body.append(panel); panel.showModal();
    window.supabase.auth.onAuthStateChange?.((event, session) => { if (event === 'SIGNED_IN' && session?.user) location.reload(); });
  }

  async function init(options) {
    api = options;
    window.addEventListener('message', e => {
      if (e.source === window && e.origin === location.origin && e.data?.type === 'INVSTO_CAPTURE_SETUP') void request(e.data.event_id,e.data.stream);
    });
    const params = new URL(location.href).searchParams;
    let metadata=null;try{metadata=JSON.parse(params.get('stream'));}catch{}
    if (params.get('capture') === '1' && valid(params.get('capture_event'))) await request(params.get('capture_event'),metadata);
  }
  window.liveCaptureSetup = {init, request, showSignIn};
})();
