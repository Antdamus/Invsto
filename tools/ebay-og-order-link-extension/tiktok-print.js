(function () {
  'use strict';
  if (window.__ogTikTokPrintUI) return;
  window.__ogTikTokPrintUI = true;
  let bypass = null, pending = null, timer, dialog, sending = false;
  function orderNumbers(){try{const c=JSON.parse(sessionStorage.getItem('ogTikTokLabelContext')||'null');return c&&Date.now()-c.at<3600000&&Array.isArray(c.ids)?c.ids:[];}catch{return [];}}
  function message(text) {
    let box = document.getElementById('og-tiktok-print-status');
    if (!box) {
      box = document.createElement('div'); box.id = 'og-tiktok-print-status'; box.setAttribute('role', 'status');
      box.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:2147483647;max-width:390px;background:#142a28;color:white;padding:18px;border-radius:12px;font:15px/1.5 system-ui;box-shadow:0 6px 24px #0004';
      document.body.append(box);
    }
    box.replaceChildren(document.createTextNode(text));
    const close = document.createElement('button'); close.textContent = pending ? 'Cancel capture' : 'Dismiss'; close.style.cssText = 'margin-left:12px;padding:5px 8px'; close.onclick = () => { if (pending) cancel(); box.remove(); }; box.append(close);
  }
  function cancel() {
    if (pending) chrome.runtime.sendMessage({type: 'OG_TIKTOK_PRINT_CANCEL', transferId: pending.id}).catch(() => {});
    clearTimeout(timer); pending = null;
    window.postMessage({type: 'OG_TIKTOK_PRINT_CANCEL'}, location.origin);
  }
  function choose(button) {
    if (dialog?.open || pending) return;
    dialog = document.createElement('dialog');
    dialog.style.cssText = 'border:0;border-radius:16px;padding:28px;max-width:440px;color:#172b29;font:16px/1.5 system-ui;box-shadow:0 16px 80px #0006';
    dialog.innerHTML = '<h2 style="margin-top:0">Print shipping label</h2><p>Send this TikTok label to your online printer through OG.</p><p>Choose <strong>PDF</strong> and <strong>4x6 inches</strong> in TikTok. In OG, confirm the orders covered by each label page, then choose your printer and copies.</p><div style="display:flex;gap:10px;flex-wrap:wrap"><button data-og>Print through OG</button><button data-native>Use TikTok print</button><button data-cancel>Cancel</button></div>';
    for (const item of dialog.querySelectorAll('button')) item.style.cssText = 'padding:10px 14px;border:1px solid #b9c9c6;border-radius:8px;cursor:pointer';
    dialog.querySelector('[data-og]').style.cssText += ';background:#09675d;color:white';
    const close = () => { dialog.close(); dialog.remove(); dialog = null; };
    dialog.querySelector('[data-cancel]').onclick = close;
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.querySelector('[data-native]').onclick = () => { close(); bypass = button; button.click(); };
    dialog.querySelector('[data-og]').onclick = async () => {
      close();
      pending = {id: crypto.randomUUID(), button, started: false};
      timer = setTimeout(() => { cancel(); message('No PDF was received. Try Print again with PDF and 4x6 inches selected, or download the PDF and use Choose PDF in the extension options.'); }, 120000);
      const id = pending.id;
      try {
        const response = await chrome.runtime.sendMessage({type: 'OG_TIKTOK_PRINT_BEGIN', transferId: id,tiktokOrders:true,orderNumbers:orderNumbers()});
        if (!response?.ok) throw new Error(response?.error || 'Could not prepare OG printing.');
        if (pending?.id === id) window.postMessage({type: 'OG_TIKTOK_PRINT_ARM', id}, location.origin);
      } catch (error) { if (pending?.id === id) { cancel(); message(error.message); } }
    };
    document.body.append(dialog); dialog.showModal();
  }
  document.addEventListener('click', event => {
    const button = event.target?.closest?.('button');
    if (!button || button.disabled) return;
    if (button === bypass) { bypass = null; return; }
    // Only the final Print action inside TikTok's shipping document settings.
    // Leave Create labels, Arrange shipment, and reprint confirmations untouched.
    const text = (button.innerText || button.textContent || '').trim();
    const modal = button.closest('[role="dialog"],.arco-modal,.arco-dialog');
    if (pending && modal && /^(Cancel|Close)$/.test(text || button.getAttribute('aria-label') || '')) {
      cancel(); message('Capture cancelled. Click Print again when you are ready.'); return;
    }
    if (text !== 'Print' || !modal || !/Shipping label/i.test(modal.innerText || modal.textContent)) return;
    const shippingLabel = modal.querySelector('[data-id="fulfillment.print_document.selection.shipping_label"] input[type="checkbox"]');
    if (shippingLabel && !shippingLabel.checked) return;
    event.preventDefault(); event.stopImmediatePropagation(); choose(button);
  }, true);
  chrome.runtime.onMessage?.addListener(incoming => {
    if (incoming?.type !== 'OG_TIKTOK_PRINT_CAPTURE_STATUS' || incoming.transferId !== pending?.id) return;
    cancel(); message(incoming.ok ? 'The PDF is ready in TikTok orders in OG. Confirm which orders its pages cover, then choose your printer.' : incoming.error);
  });
  window.addEventListener('message', async event => {
    if (event.source !== window || event.origin !== location.origin || !pending) return;
    if (event.data?.type === 'OG_TIKTOK_PRINT_ARMED' && event.data.id === pending.id && !pending.started) {
      pending.started = true; bypass = pending.button; pending.button.click();
      message('Waiting for TikTok’s PDF. Complete any TikTok reprint confirmation; OG will open with your printer choices.');
    }
    if (event.data?.type !== 'OG_TIKTOK_PDF' || event.data.payload?.transferId !== pending?.id || sending) return;
    sending = true;
    try {
      const response = await chrome.runtime.sendMessage({type: 'OG_ONLINE_PRINT_SEND', payload: {...event.data.payload,tiktokOrders:true,orderNumbers:orderNumbers()}});
      if (!response?.ok) throw new Error(response?.error || 'Could not open OG.');
      cancel(); message('The PDF is ready in TikTok orders in OG. Confirm which orders its pages cover, then choose your printer.');
    } catch (error) { cancel(); message(error.message + ' Download the PDF and use Choose PDF in the extension options to retry.'); }
    finally { sending = false; }
  });
})();
