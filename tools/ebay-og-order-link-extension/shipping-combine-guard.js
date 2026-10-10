/* Prevent separate shipping-label purchases for a buyer's pending orders. */
(() => {
  'use strict';
  const ID = 'og-combined-shipping-guard';
  const BUY = '[data-testid="purchase-button"], [data-testid="bulk-payment-button-review-purchase"], [data-testid="bulk-payment-button-confirm-and-pay"]';
  const COMBINE = '[data-testid="bulk-service-action-combine-cta"]';
  const isCreationPage = () => /^\/ship\/(?:bulk\/?|single\/\d{2}-\d{5}-\d{5}\/?$)$/.test(location.pathname);
  const text = (el, value) => { if (el && el.textContent !== value) el.textContent = value; };
  let payload = null, checkedAt = 0, loading = false, timer = null, lastRequest = 0, error = '';
  const visible = el => Boolean(el?.getClientRects().length);
  const orderNumbers = row => [...new Set([...row.querySelectorAll('[data-testid^="unique-order-id-link-"]')]
    .map(el => el.textContent.trim()).filter(number => /^\d{2}-\d{5}-\d{5}$/.test(number)))];
  function snapshot() {
    const single = location.pathname.startsWith('/ship/single/');
    const shipments = single
      ? [{orderNumbers:[location.pathname.match(/\d{2}-\d{5}-\d{5}/)?.[0]].filter(Boolean)}]
      : [...document.querySelectorAll('.orders-list__item')].map(row => ({orderNumbers:orderNumbers(row)}));
    const combine = document.querySelector(COMBINE);
    return window.OGShippingCombinePolicy.assess({shipments, single, priorities:payload?.priorities || [],
      ready:Boolean(payload?.ok && payload.shippingCheckReady && Date.now()-checkedAt < 45000),
      nativeCanCombine:visible(combine) && !combine.disabled});
  }
  function purchaseButtons() {
    // Stable eBay IDs plus visible text fallback if eBay renames an ID.
    return [...new Set([...document.querySelectorAll(BUY), ...document.querySelectorAll('button,input[type="submit"],[role="button"]')])]
      .filter(el => el.matches(BUY) || /^(?:review purchase|confirm and pay|buy shipping label|purchase (?:shipping )?labels?|pay (?:now|and print))$/i.test((el.textContent || el.value || '').trim()));
  }
  function notice(decision) {
    if (!document.body) return;
    let panel = document.getElementById(ID);
    if (!panel) {
      panel = document.createElement('section'); panel.id = ID; panel.setAttribute('role','status');
      panel.innerHTML = '<div><strong data-heading></strong><p data-message></p></div><div class="og-combine-actions"><button type="button" data-action></button><button type="button" data-recheck>Check again</button></div>';
      panel.querySelector('[data-recheck]').onclick = () => void check();
      panel.querySelector('[data-action]').onclick = () => {
        const current = snapshot();
        if (current.action === 'load') {
          location.assign(`https://www.ebay.com/ship/bulk?t=${current.orderNumbers.map(encodeURIComponent).join(',')}`);
        } else if (current.action === 'combine') {
          const button = document.querySelector(COMBINE);
          if (visible(button) && !button.disabled) button.click();
        }
      };
    }
    // Keep the explanation reachable if a review dialog was already open.
    const dialog = [...document.querySelectorAll('[role="dialog"],dialog[open]')].find(el => visible(el) && el.querySelector(BUY));
    const host = dialog || document.querySelector('#bulk-labels-app, [data-testid="order-page"]') || document.body;
    if (panel.parentElement !== host) host.prepend(panel);
    panel.dataset.blocked = String(decision.blocked);
    text(panel.querySelector('[data-heading]'), decision.blocked ? 'One shipping label per buyer' : 'Combined shipping checked');
    text(panel.querySelector('[data-message]'), loading && !checkedAt ? 'Checking this buyer’s pending orders in Invsto…' : error || decision.reason);
    const action = panel.querySelector('[data-action]');
    action.hidden = !decision.blocked || !decision.action;
    text(action, decision.action === 'load' ? `Load all ${decision.orderNumbers.length} orders` : 'Combine orders per buyer');
    action.disabled = decision.action === 'combine' && (!visible(document.querySelector(COMBINE)) || document.querySelector(COMBINE).disabled);
    if (action.disabled) text(panel.querySelector('[data-message]'), `${decision.reason} Check the shipping addresses if eBay cannot combine them.`);
    panel.querySelector('[data-recheck]').disabled = loading;
    panel.querySelector('[data-recheck]').hidden = !decision.blocked;
  }
  function render() {
    timer = null;
    if (!isCreationPage()) {
      document.getElementById(ID)?.remove();
      document.querySelectorAll('[data-og-shipping-blocked]').forEach(el => el.removeAttribute('data-og-shipping-blocked'));
      return;
    }
    const buttons = purchaseButtons();
    if (!buttons.length) { document.getElementById(ID)?.remove(); return; }
    const decision = snapshot();
    for (const button of buttons) button.toggleAttribute('data-og-shipping-blocked', decision.blocked);
    notice(decision);
    if (!loading && Date.now()-lastRequest > 30000) void check();
  }
  function schedule() { if (!timer) timer = setTimeout(render,100); }
  async function check() {
    if (loading || !isCreationPage()) return;
    loading = true; error = ''; lastRequest = Date.now(); render();
    let timeout;
    try {
      const response = await Promise.race([
        chrome.runtime.sendMessage({type:'OG_EBAY_GET_PENDING_PRIORITIES',payload:{useCache:false,shippingSafetyCheck:true}}),
        new Promise((_,reject) => { timeout=setTimeout(()=>reject(Error('Invsto did not respond. Open Pending Orders and check again.')),10000); }),
      ]);
      if (!response?.ok || !response.shippingCheckReady || !Array.isArray(response.priorities)) throw Error('Open or refresh Invsto Pending Orders, wait for the orders to load, then check again.');
      payload = response; checkedAt = Date.now();
    } catch (failure) { payload=null; checkedAt=0; error=failure.message || 'Could not verify the buyer’s orders. Check again before buying labels.'; }
    finally { clearTimeout(timeout); loading=false; render(); }
  }
  function intercept(event) {
    if (!isCreationPage()) return;
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (target?.closest(`#${ID}`)) return;
    const button = target?.closest('button,input[type="submit"],[role="button"]');
    const buying = event.type === 'submit' ? Boolean(event.target?.querySelector?.(BUY)) : button && purchaseButtons().includes(button);
    if (!buying) return;
    const decision = snapshot(); // Re-read eBay synchronously; Undo combine cannot race the observer.
    if (!decision.blocked) return;
    event.preventDefault(); event.stopImmediatePropagation();
    render(); document.getElementById(ID)?.scrollIntoView({block:'center'});
    if (!loading && (!checkedAt || Date.now()-checkedAt >= 45000)) void check();
  }
  // Capture before eBay handlers; never replay a purchase after an async check.
  window.addEventListener('click',intercept,true);
  window.addEventListener('submit',intercept,true);
  function start() {
    const style=document.createElement('style');
    style.textContent=`[data-og-shipping-blocked]{display:none!important}#${ID}{box-sizing:border-box;margin:12px;padding:16px;border:1px solid #c49334;border-radius:12px;background:#fff8e7;color:#30250f;display:flex;align-items:center;justify-content:space-between;gap:16px;font:15px/1.45 Arial,sans-serif}#${ID}[data-blocked="false"]{background:#eef8ef;border-color:#90b999;color:#203b26}#${ID} p{margin:4px 0 0;max-width:780px}#${ID} .og-combine-actions{display:flex;gap:8px;flex-wrap:wrap}#${ID} button{padding:10px 16px;min-height:44px;border-radius:22px;border:1px solid #765b24;background:white;color:#30250f;cursor:pointer;font:inherit}#${ID} [data-action]{background:#30250f;color:white}#${ID} [hidden]{display:none!important}#${ID} button:disabled{opacity:.55;cursor:default}@media(max-width:700px){#${ID}{align-items:stretch;flex-direction:column;margin:8px;padding:12px}#${ID} button{flex:1}}`;
    document.head.append(style);
    new MutationObserver(records => {
      if (records.every(record => record.target.closest?.(`#${ID}`))) return;
      schedule();
    }).observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['disabled','data-testid','href']});
    document.addEventListener('visibilitychange',()=>{if(!document.hidden){render();void check();}});
    setInterval(()=>{if(!document.hidden)render();},5000);
    render();
  }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',start,{once:true}); else start();
})();
