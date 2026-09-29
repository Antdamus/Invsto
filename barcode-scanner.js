(() => {
  'use strict';
  const scriptBase = new URL('.', document.currentScript.src);
  let libraryPromise, dialog, ui, active, generation = 0;

  const cameraPreferenceKey = 'inventory-scanner-camera';
  const focusFallback = 'Focus is controlled by your phone. Move back if the label is blurry.';
  let preferredZoom = 2;
  function savedCamera() {
    try { return localStorage.getItem(cameraPreferenceKey) || ''; } catch (_) { return ''; }
  }
  function rememberCamera(deviceId) {
    try { localStorage.setItem(cameraPreferenceKey, deviceId); } catch (_) { /* Private browsing can block storage. */ }
  }

  function setZoom(value) {
    if (!active) return;
    active.zoom = preferredZoom = value;
    ui.preview.style.setProperty('--camera-zoom', value);
    ui.zoom.querySelectorAll('[data-zoom]').forEach(button => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.zoom) === value));
    });
  }

  function showFocusSupport(session) {
    ui.focusHint.textContent = session.tapFocus ? 'Tap the label in the preview to request focus.' : focusFallback;
    ui.preview.classList.toggle('camera-scanner-can-focus', session.tapFocus);
    ui.focusCenter.hidden = !session.tapFocus;
  }

  async function configureFocus(session, token) {
    const track = session.stream?.getVideoTracks()[0];
    session.tapFocus = false;
    try {
      const capabilities = track?.getCapabilities?.() || {};
      // Leave the browser's defaults alone unless this actual camera advertises autofocus.
      if (capabilities.focusMode?.includes('continuous') && track.applyConstraints) {
        await track.applyConstraints({ ...track.getConstraints?.(), advanced: [{ focusMode: 'continuous' }] });
        if (active !== session || token !== generation) return;
        session.tapFocus = navigator.mediaDevices.getSupportedConstraints?.().pointsOfInterest === true;
      }
    } catch (_) { /* Optional focus controls must never interrupt barcode scanning. */ }
    if (active === session && token === generation) showFocusSupport(session);
  }

  async function requestFocus(x = 0.5, y = 0.5) {
    const session = active, token = generation;
    if (!session?.tapFocus || session.focusBusy || !session.stream) return;
    const track = session.stream.getVideoTracks()[0];
    session.focusBusy = true;
    ui.focusHint.textContent = 'Requesting focus... Hold steady.';
    try {
      // Points of interest use normalized sensor coordinates, accounting for the zoom crop.
      await track.applyConstraints({ ...track.getConstraints?.(), advanced: [{
        focusMode: 'continuous', pointsOfInterest: [{ x: 0.5 + (x - 0.5) / session.zoom, y: 0.5 + (y - 0.5) / session.zoom }],
      }] });
      if (active === session && token === generation) ui.focusHint.textContent = 'Focus requested. Hold steady, or move back if the label is still blurry.';
    } catch (_) {
      if (active === session && token === generation) { session.tapFocus = false; showFocusSupport(session); }
    } finally {
      if (active === session && token === generation) session.focusBusy = false;
    }
  }

  // Explicitly marked inputs get the same adjacent control, including fields
  // inserted later by dropdowns and modals. Their existing listeners stay intact.
  const fieldButtons = new WeakMap();
  function enhanceField(input) {
    if (!input.matches('input[data-camera-scan]') || !input.id) return;
    let button = fieldButtons.get(input);
    if (!button) {
      const next = input.nextElementSibling;
      button = next?.dataset.scanTarget === input.id ? next : document.createElement('button');
      button.type = 'button';
      button.classList.add('camera-scan-button');
      button.dataset.scanTarget = input.id;
      button.textContent = 'Scan with camera';
      button.setAttribute('aria-label', `Scan with camera: ${input.getAttribute('aria-label') || input.placeholder || input.id}`);
      if (input.dataset.cameraAction) button.dataset.scanAction = input.dataset.cameraAction;
      const wrapper = document.createElement('span');
      wrapper.className = 'camera-scan-field';
      input.before(wrapper);
      wrapper.append(input, button);
      fieldButtons.set(input, button);
      input.autocomplete = 'off';
      input.setAttribute('autocapitalize', 'off');
      input.spellcheck = false;
    }
    button.disabled = input.disabled || input.readOnly;
    button.hidden = input.hidden || input.type === 'hidden';
  }

  function enhanceFields(root) {
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    if (root.matches('input[data-camera-scan]')) enhanceField(root);
    root.querySelectorAll('input[data-camera-scan]').forEach(enhanceField);
  }

  function watchFields() {
    enhanceFields(document.body);
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') enhanceField(record.target);
        else record.addedNodes.forEach(enhanceFields);
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['disabled', 'readonly', 'hidden', 'type', 'data-camera-scan'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchFields, { once: true });
  else watchFields();

  function loadReader() {
    if (!libraryPromise) {
      libraryPromise = (async () => {
        if (!window.ZXingWASM) {
          await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            const timeout = setTimeout(() => { script.remove(); reject(new Error('reader-load')); }, 20000);
            script.src = new URL('vendor/zxing-wasm-reader-3.1.4.js', scriptBase).href;
            script.onload = () => { clearTimeout(timeout); resolve(); };
            script.onerror = () => { clearTimeout(timeout); script.remove(); reject(new Error('reader-load')); };
            document.head.append(script);
          });
        }
        const library = window.ZXingWASM;
        // Keep the decoder and its binary on our own host. Images never leave the device.
        await library.prepareZXingModule({
          overrides: { locateFile: () => new URL('vendor/zxing-reader-3.1.4.wasm', scriptBase).href },
          fireImmediately: true,
        });
        return library;
      })().catch(() => { libraryPromise = null; throw new Error('reader-load'); });
    }
    return libraryPromise;
  }

  const readOptions = {
    formats: ['QRCode', 'DataMatrix', 'Code128', 'Code39', 'Code93', 'EAN13', 'EAN8', 'UPCA', 'UPCE', 'ITF', 'PDF417', 'Aztec', 'Codabar'],
    tryHarder: true, tryRotate: true, tryInvert: true, maxNumberOfSymbols: 4,
    returnErrors: true, textMode: 'Plain',
  };

  function isInventoryCode(raw) {
    const code = String(raw).trim();
    return code.length > 0 && code.length <= 128 && !/[^\x20-\x7e]/.test(code)
      && !/^(?:[a-z][a-z\d+.-]*:|\/\/|www\.)/i.test(code);
  }

  async function decodeCanvas(library, canvas, mode = 'inventory') {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const certificate = mode === 'certificate';
    const options = certificate ? { ...readOptions, formats: ['QRCode'] } : readOptions;
    const results = await library.readBarcodes(context.getImageData(0, 0, canvas.width, canvas.height), options);
    // A label can include both an item code and a website QR. Prefer the item code.
    const valid = results.filter(result => result.isValid && !result.error).map(result => {
      // ZXing-C++ reports UPC-A as EAN-13 with a padding zero. Match the
      // prior scanner's 12-digit UPC-A output; never alter QR/Code 128 zeros.
      if (result.format === 'EAN13' && /^0\d{12}$/.test(result.text)) return { ...result, text: result.text.slice(1) };
      return result;
    });
    return { result: certificate ? valid.find(result => result.format === 'QRCode')
      : valid.find(result => isInventoryCode(result.text)) || valid[0], detected: results.length > 0 };
  }

  function scanVideo(library, session, token) {
    const video = ui.video;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const started = Date.now();
    let stopped = false, timer;
    const current = () => !stopped && active === session && token === generation;
    const controls = { stop() { stopped = true; clearTimeout(timer); } };
    const fail = () => {
      if (!current()) return;
      stopCapture();
      ui.retry.hidden = false;
      message('The camera scan stopped. Tap Scan again or choose a barcode photo.');
    };
    const scanFrame = async () => {
      if (!current()) return;
      if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
        if (Date.now() - started > 10000) { fail(); return; }
        timer = setTimeout(scanFrame, 100);
        return;
      }
      try {
        // Use the actual frame dimensions, including portrait orientation changes.
        const sourceWidth = video.videoWidth / session.zoom, sourceHeight = video.videoHeight / session.zoom;
        const scale = Math.min(1, 1600 / Math.max(sourceWidth, sourceHeight));
        const width = Math.max(1, Math.round(sourceWidth * scale)), height = Math.max(1, Math.round(sourceHeight * scale));
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        ui.preview.style.setProperty('--camera-ratio', video.videoWidth / video.videoHeight);
        // Decode exactly the center crop shown in the preview, retaining its original pixels.
        context.drawImage(video, (video.videoWidth - sourceWidth) / 2, (video.videoHeight - sourceHeight) / 2,
          sourceWidth, sourceHeight, 0, 0, width, height);
        const { result, detected } = await decodeCanvas(library, canvas, session.mode);
        if (!current()) return;
        if (result) { receive(result.text, token); return; }
        if (detected) message('A code is visible but not clear enough to read. Hold steady, reduce glare, or choose a barcode photo.');
        else if (Date.now() - started > 7000) message('Still looking for a readable code. Move slightly farther away to focus, keep the whole code visible, or choose a barcode photo.');
        timer = setTimeout(scanFrame, 140);
      } catch (_) { fail(); }
    };
    video.srcObject = session.stream;
    video.play().catch(fail);
    timer = setTimeout(scanFrame, 0);
    return controls;
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
    ui.cameraTools.hidden = true;
    ui.cameraChoice.hidden = true;
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
    const certificate = active.mode === 'certificate';
    if (!certificate && /^(?:[a-z][a-z\d+.-]*:|\/\/|www\.)/i.test(code)) {
      message('This QR code opens a website or app. Scan the striped item barcode, or a QR code containing just the inventory code.');
      return;
    }
    if (!code || (certificate ? code.length > 2048 || /[\x00-\x1f\x7f]/.test(code) : code.length > 128 || /[^\x20-\x7e]/.test(code))) {
      message(certificate ? 'This QR could not be used. Paste the certificate QR contents on one line (up to 2,048 characters).'
        : 'This code is not a supported inventory identifier. Scan the item or location label, or enter its code manually.');
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

  async function startCamera(deviceId = savedCamera()) {
    stopCapture();
    resetResult();
    const session = active, token = generation;
    session.tapFocus = false;
    session.focusBusy = false;
    setZoom(preferredZoom);
    showFocusSupport(session);
    message('Loading barcode reader...');
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      message('Live scanning needs a browser with camera access on HTTPS. You can still choose a barcode photo below.');
      ui.retry.hidden = false;
      return;
    }
    try {
      const library = await loadReader();
      if (active !== session || token !== generation) return;
      message('Starting camera... Allow camera access when your browser asks.');
      const constraints = id => ({
        audio: false,
        video: { ...(id ? { deviceId: { exact: id } } : { facingMode: { ideal: 'environment' } }),
          width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia(constraints(deviceId)); }
      catch (error) {
        // Saved camera IDs can expire after permission or device changes.
        if (!deviceId || !['NotFoundError', 'OverconstrainedError'].includes(error.name)) throw error;
        if (active !== session || token !== generation) return;
        rememberCamera('');
        stream = await navigator.mediaDevices.getUserMedia(constraints());
      }
      // A permission prompt can finish after Cancel or after another scan opens.
      if (active !== session || token !== generation) { stream.getTracks().forEach(track => track.stop()); return; }
      session.stream = stream;
      const freshVideo = ui.video.cloneNode(false);
      freshVideo.muted = true;
      ui.video.replaceWith(freshVideo);
      ui.video = freshVideo;
      session.deviceId = stream.getVideoTracks()[0]?.getSettings?.().deviceId;
      ui.preview.hidden = false;
      ui.cameraTools.hidden = false;
      message('Center the whole barcode in the frame. For tiny labels, move back and use 2× or 3×. Use 1× for wide barcodes.');
      session.controls = scanVideo(library, session, token);
      void configureFocus(session, token);
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      if (active !== session || token !== generation) return;
      session.cameras = devices.filter(device => device.kind === 'videoinput');
      ui.switchCamera.hidden = session.cameras.length < 2;
      ui.cameraChoice.hidden = session.cameras.length < 2;
      ui.cameraSelect.replaceChildren(...session.cameras.map((camera, index) => {
        const option = document.createElement('option');
        option.value = camera.deviceId;
        option.textContent = camera.label || `Camera ${index + 1}`;
        return option;
      }));
      ui.cameraSelect.value = session.deviceId || '';
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
      const { result } = await decodeCanvas(library, canvas, session.mode);
      if (!result) throw new Error('unreadable');
      receive(result.text, token);
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
      <div data-camera="preview" class="camera-scanner-preview" hidden><div data-camera="viewfinder" class="camera-scanner-viewfinder"><video data-camera="video" autoplay muted playsinline aria-label="Camera preview"></video><span class="camera-scanner-frame" aria-hidden="true"></span></div></div>
      <div data-camera="cameraTools" class="camera-scanner-tools" hidden>
        <div data-camera="zoom" class="camera-scanner-zoom" role="group" aria-label="Preview zoom"><button type="button" data-zoom="1" aria-pressed="false">1×</button><button type="button" data-zoom="2" aria-pressed="true">2× · Small labels</button><button type="button" data-zoom="3" aria-pressed="false">3×</button></div>
        <p data-camera="focusHint" class="camera-scanner-focus-hint"></p>
        <button type="button" data-camera="focusCenter" hidden>Focus on center</button>
        <label data-camera="cameraChoice" class="camera-scanner-camera-choice" hidden>Camera<select data-camera="cameraSelect"></select><span>If close labels stay blurry, try another rear camera. Your choice is remembered.</span></label>
      </div>
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
    // Keep dropdowns and underlying dialogs open while operating the scanner.
    dialog.addEventListener('click', event => event.stopPropagation());
    ui.zoom.addEventListener('click', event => {
      const button = event.target.closest('[data-zoom]');
      if (button) setZoom(Number(button.dataset.zoom));
    });
    ui.viewfinder.addEventListener('click', event => {
      const bounds = ui.viewfinder.getBoundingClientRect();
      if (bounds.width && bounds.height) void requestFocus((event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height);
    });
    ui.focusCenter.addEventListener('click', () => { void requestFocus(); });
    ui.cameraSelect.addEventListener('change', () => {
      rememberCamera(ui.cameraSelect.value);
      startCamera(ui.cameraSelect.value);
    });
    ui.retry.addEventListener('click', () => startCamera());
    ui.switchCamera.addEventListener('click', () => {
      const cameras = active.cameras;
      const index = cameras.findIndex(camera => camera.deviceId === active.deviceId);
      const deviceId = cameras[(index + 1) % cameras.length].deviceId;
      rememberCamera(deviceId);
      startCamera(deviceId);
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
      // Only explicit lookup actions run here; never synthesize Enter, which
      // some workflows use to submit sales, finalize bags, or confirm transfers.
      const lookup = document.getElementById(trigger.dataset.scanAction || '');
      if (lookup && !lookup.disabled) lookup.click();
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
    const certificate = trigger.dataset.scanMode === 'certificate';
    active = { target, trigger, code: '', mode: certificate ? 'certificate' : 'inventory' };
    dialog.querySelector('#camera-scanner-title').textContent = certificate ? 'Scan a certificate QR' : 'Scan a barcode';
    dialog.querySelector('.camera-scanner-help').textContent = certificate
      ? 'Scan the QR on the CGL certificate or choose a clear photo of it.'
      : 'Scan a striped barcode or an inventory QR code.';
    ui.use.textContent = certificate ? 'Use QR contents' : 'Use code';
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
