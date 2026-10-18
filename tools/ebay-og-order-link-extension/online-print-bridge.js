(async function () {
  'use strict';
  const params = new URLSearchParams(location.search), transferId = params.get('onlinePrintTransfer');
  if (!location.pathname.endsWith('/print-stations.html') || (!transferId && params.get('onlinePrint') !== '1')) return;
  const settings = await chrome.storage.sync.get('ogPendingOrdersUrl');
  let target;
  try { target = new URL('print-stations.html', settings.ogPendingOrdersUrl); } catch (_) { return; }
  if (location.origin !== target.origin || location.pathname !== target.pathname) return;
  const post = payload => window.postMessage({type: 'OG_ONLINE_PRINT_DATA', payload}, location.origin);
  window.addEventListener('message', async event => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type === 'OG_ONLINE_PRINT_READY') {
      if (!transferId) { post({manual: true}); return; }
      try {
        const response = await chrome.runtime.sendMessage({type: 'OG_ONLINE_PRINT_GET', transferId});
        post(response?.ok ? response.payload : {error: response?.error || 'Could not receive the PDF. Send it from TikTok again.'});
      } catch (_) { post({error: 'Reload the updated extension and this page, then try again.'}); }
    }
    if (event.data?.type === 'OG_ONLINE_PRINT_COMPLETE' && transferId) {
      await chrome.runtime.sendMessage({type: 'OG_ONLINE_PRINT_DONE', transferId, result: event.data.result}).catch(() => {});
    }
  });
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('online-print-page.js');
  script.onerror = () => {
    const status = document.createElement('p'); status.textContent = 'The OG print handoff could not load. Reload the extension and this page.'; document.body.prepend(status);
  };
  document.head.append(script);
})();
