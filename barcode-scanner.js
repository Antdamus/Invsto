(() => {
  'use strict';
  const scriptBase = new URL('.', document.currentScript.src);
  let libraryPromise, dialog, ui, active, generation = 0;

  function loadReader() {
    if (window.ZXingBrowser) return Promise.resolve(window.ZXingBrowser);
    if (!libraryPromise) libraryPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('vendor/zxing-browser-0.1.5.min.js', scriptBase).href;
      script.onload = () => resolve(window.ZXingBrowser);
      script.onerror = () => { script.remove(); libraryPromise = null; reject(new Error('reader-load')); };
      document.head.append(script);
    });
    return libraryPromise;
  }

  function stopControls(controls) {
    try { Promise.resolve(controls?.stop()).catch(() => {}); } catch (_) { /* Already stopped. */ }
  }

  function stopCapture() {
    generation++;
    if (!active) return;
    stopControls(active.controls);
    active.controls = null;
    active.stream?.getTracks().forEach(track => track.stop());
    active.stream = null;
    ui.video.pause();
    ui.video.srcObject = null;
    ui.preview.hidden = true;
    ui.switchCamera.hidden = true;
  }

  function finish() {
    stopCapture();
    const trigger = active?.trigger;
    active = null;
    if (dialog.open) dialog.close();
    trigger?.focus({ preventScroll: true });
  }

  function message(text) { ui.status.textContent = text; }

  function resetResult() {
    active.code = '';
    ui.result.hidden = true;
    ui.use.disabled = true;
    ui.retry.hidden = true;
  }

  function receive(raw, token) {
    if (!active || token !== generation) return;
    stopCapture();
    const code = String(raw).trim();
    ui.retry.hidden = false;
    // Labels often include a website QR beside the inventory barcode.
    // Never treat a URL as a stock identifier or navigate to scanned content.
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|www\.)/i.test(code)) {
      message('This QR code opens a website or app. Scan the striped item barcode, or a QR code containing just the inventory code.');
      return;
    }
    if (!code || code.length > 128 || /[^\x20-\x7e]/.test(code)) {
      message('This code is not a supported inventory identifier. Scan the item or location label, or enter its code manually.');
      return;
    }
    active.code = code;
    ui.value.textContent = code;
    ui.result.hidden = false;
    ui.use.disabled = false;
    message('Code found. Check it, then tap Use code.');
    ui.use.focus({ preventScroll: true });
  }

  function cameraError(error) {
    if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error?.name)) {
      return 'Camera access is blocked. Allow camera access in your browser settings, retry, or choose a barcode photo below.';
    }
    if (['NotFoundError', 'DevicesNotFoundError'].includes(error?.name)) return 'No camera was found. Choose a barcode photo or enter the code manually.';
    if (['NotReadableError', 'TrackStartError', 'AbortError'].includes(error?.name)) return 'The camera is busy or could not start. Close other camera apps and retry, or choose a barcode photo.';
    if (error?.message === 'reader-load') return 'The scanner could not load. Check your connection and retry.';
    return 'The camera could not start. Retry or choose a clear photo of the barcode.';
  }

  async function startCamera(deviceId) {
    stopCapture();
    resetResult();
    const session = active, token = generation;
    message('Starting camera... Allow camera access when your browser asks.');
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      message('Live scanning needs a browser with camera access on HTTPS. You can still choose a barcode photo below.');
      ui.retry.hidden = false;
      return;
    }
    try {
      const library = await loadReader();
      if (active !== session || token !== generation) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }), width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      // A permission prompt can finish after Cancel or after another scan opens.
      if (active !== session || token !== generation) { stream.getTracks().forEach(track => track.stop()); return; }
      session.stream = stream;
      const freshVideo = ui.video.cloneNode(false);
      freshVideo.muted = true;
      ui.video.replaceWith(freshVideo);
      ui.video = freshVideo;
      session.deviceId = stream.getVideoTracks()[0]?.getSettings?.().deviceId;
      ui.preview.hidden = false;
      message('Center the whole barcode in the frame. Hold steady with good light.');
      const reader = new library.BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 180, delayBetweenScanSuccess: 500 });
      const controls = await reader.decodeFromStream(stream, ui.video, (result, error, scanControls) => {
        if (active !== session || token !== generation) { stopControls(scanControls); return; }
        if (result) { stopControls(scanControls); receive(result.getText(), token); }
        // The minified decoder preserves exception kinds, but minifies class names.
        else if (error && !['NotFoundException', 'ChecksumException', 'FormatException'].includes(error.constructor?.kind || error.name)) {
          stopControls(scanControls);
          stopCapture();
          ui.retry.hidden = false;
          message('The camera scan stopped. Retry or choose a barcode photo.');
        }
      });
      if (active !== session || token !== generation) { stopControls(controls); return; }
      session.controls = controls;
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      if (active !== session || token !== generation) return;
      session.cameras = devices.filter(device => device.kind === 'videoinput');
      ui.switchCamera.hidden = session.cameras.length < 2;
    } catch (error) {
      if (active !== session || token !== generation) return;
      stopCapture();
      ui.retry.hidden = false;
      message(cameraError(error));
    }
  }

  async function readPhoto(file) {
    if (!active || !file) return;
    stopCapture();
    resetResult();
    const session = active, token = generation;
    message('Reading barcode photo...');
    let url;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('photo-size');
      const library = await loadReader();
      if (active !== session || token !== generation) return;
      url = URL.createObjectURL(file);
      const photo = new Image();
      photo.src = url;
      await photo.decode();
      if (active !== session || token !== generation) return;
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1800 / Math.max(photo.naturalWidth, photo.naturalHeight));
      canvas.width = Math.round(photo.naturalWidth * scale);
      canvas.height = Math.round(photo.naturalHeight * scale);
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(photo, 0, 0, canvas.width, canvas.height);
      const result = new library.BrowserMultiFormatReader().decodeFromCanvas(canvas);
      receive(result.getText(), token);
    } catch (error) {
      if (active !== session || token !== generation) return;
      ui.retry.hidden = false;
      message(error.message === 'photo-size' ? 'Choose a photo smaller than 20 MB.' : error.message === 'reader-load' ? cameraError(error) : 'No readable barcode found. Try a sharp, close-up photo with the whole barcode visible, or enter the code manually.');
    } finally {
      if (url) URL.revokeObjectURL(url);
      if (active === session) ui.photo.value = '';
    }
  }

  function createDialog() {
    if (dialog) return;
    dialog = document.createElement('dialog');
    dialog.id = 'inventory-camera-scanner';
    dialog.className = 'camera-scanner';
    dialog.setAttribute('aria-labelledby', 'camera-scanner-title');
    dialog.innerHTML = `
      <div class="camera-scanner-heading"><h2 id="camera-scanner-title">Scan a barcode</h2><button type="button" data-camera="cancel" aria-label="Close scanner">Close</button></div>
      <p class="camera-scanner-help">Scan a striped barcode or an inventory QR code.</p>
      <div data-camera="preview" class="camera-scanner-preview" hidden><video data-camera="video" autoplay muted playsinline aria-label="Camera preview"></video><span class="camera-scanner-frame" aria-hidden="true"></span></div>
      <p data-camera="status" class="camera-scanner-status" role="status" aria-live="polite"></p>
      <div data-camera="result" class="camera-scanner-result" hidden><span>Scanned code</span><strong data-camera="value"></strong><p data-camera="hint"></p><button type="button" data-camera="use" disabled>Use code</button></div>
      <div class="camera-scanner-actions"><button type="button" data-camera="retry" hidden>Scan again</button><button type="button" data-camera="switchCamera" hidden>Switch camera</button></div>
      <label class="camera-scanner-photo">Or choose a barcode photo<input data-camera="photo" type="file" accept="image/*" capture="environment" /></label>
      <p class="camera-scanner-privacy">Camera and photos are read on your device. Close this window to type a code instead.</p>`;
    document.body.append(dialog);
    ui = Object.fromEntries([...dialog.querySelectorAll('[data-camera]')].map(el => [el.dataset.camera, el]));
    ui.cancel.addEventListener('click', finish);
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
    dialog.addEventListener('close', () => { if (!dialog.open && active) finish(); });
    // Keep Enter/Escape from reaching the underlying stock confirmation modal.
    dialog.addEventListener('keydown', event => event.stopPropagation());
    ui.retry.addEventListener('click', () => startCamera());
    ui.switchCamera.addEventListener('click', () => {
      const cameras = active.cameras;
      const index = cameras.findIndex(camera => camera.deviceId === active.deviceId);
      startCamera(cameras[(index + 1) % cameras.length].deviceId);
    });
    ui.photo.addEventListener('click', () => {
      stopCapture();
      ui.retry.hidden = false;
      if (!active.code) message('Choose a clear barcode photo, or tap Scan again to restart the camera.');
    });
    ui.photo.addEventListener('change', () => readPhoto(ui.photo.files[0]));
    ui.use.addEventListener('click', () => {
      if (!active?.code) return;
      const { code, target, trigger } = active;
      if (!target.isConnected || target.disabled || target.readOnly) { finish(); return; }
      finish();
      const clearFilters = trigger.dataset.scanClearFilters;
      if (clearFilters) document.getElementById(clearFilters)?.click();
      target.value = code; // Keep strings intact, including leading zeros.
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-scan-target]');
    if (!trigger) return;
    event.preventDefault();
    const target = document.getElementById(trigger.dataset.scanTarget);
    if (!target || target.disabled || target.readOnly) return;
    createDialog();
    if (active) finish();
    active = { target, trigger, code: '' };
    ui.hint.textContent = trigger.dataset.scanHint || 'Use this code in the selected barcode field.';
    ui.photo.value = '';
    dialog.showModal();
    startCamera();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && active) {
      stopCapture();
      ui.retry.hidden = false;
      if (!active.code) message('Camera paused. Tap Scan again or choose a barcode photo.');
    }
  });
  window.addEventListener('pagehide', () => { if (active) finish(); });
})();
