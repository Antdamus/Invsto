(() => {
  'use strict';

  const dialog = document.getElementById('cgl-label-dialog');
  const form = document.getElementById('cgl-label-form');
  const fields = document.getElementById('cgl-label-fields');
  const qr = document.getElementById('cgl-label-qr');
  const status = document.getElementById('cgl-label-status');
  const print = document.getElementById('print-cgl-label');
  const close = document.getElementById('close-cgl-label');
  let busy = false;

  document.getElementById('open-cgl-label').addEventListener('click', () => {
    if (dialog.open) return;
    form.reset();
    status.textContent = '';
    dialog.showModal();
    qr.focus();
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('keydown', event => event.stopPropagation());
  form.addEventListener('input', () => { status.textContent = ''; });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    busy = true;
    fields.disabled = close.disabled = true;
    form.setAttribute('aria-busy', 'true');
    print.textContent = 'Preparing label…';
    status.textContent = '';
    try {
      const xml = window.dymoModule.buildCglLabelXml({ qr: qr.value });
      const result = await window.dymoModule.printDymoLabelXml(xml, {
        labelKind: 'CGLLabel', barcode: 'CGL', title: 'CGL certificate label', listenerOnly: true,
      });
      status.textContent = window.printStations.deliveryMessage(result);
    } catch (error) {
      status.textContent = error?.message || 'Could not prepare or send the CGL label. Try again.';
    } finally {
      busy = false;
      fields.disabled = close.disabled = false;
      form.removeAttribute('aria-busy');
      print.textContent = 'Choose printer & print';
    }
  });
})();
