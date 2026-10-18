/* Uses the signed-in site's existing shipping PDF storage, validation and picker. */
(function () {
  'use strict';
  if (document.getElementById('og-online-print')) return;
  const panel = document.createElement('section'); panel.id = 'og-online-print';
  panel.style.cssText = 'margin:20px 0;padding:24px;background:#f1f9f7;border:1px solid #b6d9d0;border-radius:14px';
  panel.innerHTML = '<h2 style="margin-top:0">TikTok · Print shipping label</h2><p>Choose your online shipping printer, pages and copies. Use the <strong>PDF · 4x6 inches</strong> format from TikTok.</p><p data-status role="status">Receiving your PDF…</p><p><a data-preview hidden target="_blank" rel="noopener">Preview shipping PDF</a></p><button data-print type="button" disabled>Choose printer</button><p><label>Choose PDF <input data-file type="file" accept="application/pdf,.pdf"></label></p>';
  (document.querySelector('main') || document.body).prepend(panel);
  const status = panel.querySelector('[data-status]'), print = panel.querySelector('[data-print]'), file = panel.querySelector('[data-file]'), preview = panel.querySelector('[data-preview]');
  let bytes, savedPath, busy = false, received = false, previewUrl, dependencyPromise;
  const showError = error => { status.textContent = String(error?.message || error).replace(/eBay/g, 'TikTok'); };
  function script(name, ready) {
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const element = document.createElement('script'); element.src = new URL(name, location.href).href;
      const timer = setTimeout(() => reject(new Error('Print tools did not load. Refresh this page and try again.')), 20000);
      element.onload = () => { clearTimeout(timer); ready() ? resolve() : reject(new Error('Print tools are unavailable. Refresh this page.')); };
      element.onerror = () => { clearTimeout(timer); reject(new Error('Print tools could not load. Check your connection.')); };
      document.head.append(element);
    });
  }
  function dependencies() {
    if (!dependencyPromise) dependencyPromise = (async () => {
      await script('shipping-pdf.js', () => window.shippingPdf);
      await script('shipping-label-print.js', () => window.shippingLabelPrint);
      if (!window.printStations) throw new Error('Reload Print stations to load your printer interface.');
    })().catch(error => { dependencyPromise = null; throw error; });
    return dependencyPromise;
  }
  async function setPdf(value) {
    bytes = null; savedPath = null; print.disabled = true; preview.hidden = true;
    await dependencies();
    if (!value.length || value.length > 10 * 1024 * 1024) throw new Error('Choose a PDF smaller than 10 MB.');
    await window.shippingLabelPrint.assertComplete(value);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    bytes = value; savedPath = null;
    previewUrl = URL.createObjectURL(new Blob([bytes], {type: 'application/pdf'}));
    preview.href = previewUrl; preview.hidden = false; print.disabled = false;
    status.textContent = 'PDF ready. Check the preview, then choose your printer.';
  }
  async function send() {
    if (busy || !bytes) return;
    busy = true; print.disabled = true; file.disabled = true;
    try {
      const {data: {session} = {}} = await window.supabase.auth.getSession();
      if (!session) throw new Error('Sign in to Invsto in another tab, then choose your printer again here.');
      if (!savedPath) {
        // Validate before retaining a file; printing restrictions are checked by the shared printer.
        try { await window.shippingPdf.inspect(bytes); }
        catch (error) { if (error.code !== 'PDF_ENCRYPTED') throw error; }
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
        const path = `online-print/${session.user.id}/${hash}.pdf`;
        status.textContent = 'Preparing your shipping PDF…';
        const {error} = await window.supabase.storage.from('ebay-labels').upload(path, new Blob([bytes], {type: 'application/pdf'}), {contentType: 'application/pdf', upsert: false});
        if (error && !['409', 'Duplicate'].includes(String(error.statusCode || error.code)) && !/already exists/i.test(error.message || '')) throw error;
        savedPath = path;
      }
      const result = await window.shippingLabelPrint.printSaved({path: savedPath, title: 'TikTok shipping label'});
      const resultText = result.message || 'Opened this device’s print dialog. Check the printer for your label.';
      status.textContent = resultText;
      window.postMessage({type: 'OG_ONLINE_PRINT_COMPLETE', result: resultText}, location.origin);
      // A successful request must not silently become another print on a repeated click.
      bytes = null; print.textContent = 'Print request completed';
    } catch (error) {
      if (error.cancelled) status.textContent = 'Printing cancelled. Choose printer when you are ready.';
      else showError(error);
    } finally { busy = false; print.disabled = !bytes; file.disabled = false; }
  }
  print.onclick = send;
  file.onchange = async () => {
    if (busy || !file.files[0]) return;
    const selected = file.files[0];
    bytes = null; savedPath = null; print.disabled = true; preview.hidden = true;
    try {
      if (selected.size > 10 * 1024 * 1024) throw new Error('Choose a PDF smaller than 10 MB.');
      await setPdf(new Uint8Array(await selected.arrayBuffer())); print.textContent = 'Choose printer';
    } catch (error) { showError(error); }
    file.value = '';
  };
  window.addEventListener('message', async event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'OG_ONLINE_PRINT_DATA' || received) return;
    received = true;
    const payload = event.data.payload;
    if (payload?.error) { showError(payload.error); return; }
    if (payload?.completed) { status.textContent = payload.result; print.textContent = 'Print request completed'; return; }
    if (payload?.manual) { status.textContent = 'Choose the shipping PDF you downloaded from TikTok.'; return; }
    try {
      if (typeof payload?.base64 !== 'string' || payload.base64.length > 13981016) throw new Error('Choose a PDF smaller than 10 MB.');
      await setPdf(Uint8Array.from(atob(payload.base64), c => c.charCodeAt(0)));
      // Receiving opens only the choice UI; the shared picker requires an explicit Send.
      await send();
    } catch (error) { showError(error); }
  });
  window.postMessage({type: 'OG_ONLINE_PRINT_READY'}, location.origin);
})();
