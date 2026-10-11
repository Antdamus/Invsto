/* Touch photo framing. Preview coordinates never determine export resolution. */
(() => {
  const MIN_ZOOM = 0.25, MAX_ZOOM = 6;
  const clampZoom = value => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value) || 1));
  const adjustments = ['brightness', 'contrast', 'saturation', 'warmth', 'sharpness'];
  const neutral = () => Object.fromEntries(adjustments.map(key => [key, 0]));
  const initial = () => ({ zoom: 1, offsetX: 0, offsetY: 0, turns: 0, tilt: 0, flipX: false, flipY: false, fill: 'black', ...neutral() });
  const angle = state => (state.turns * 90 + state.tilt) * Math.PI / 180;
  function drawRect(image, state, width, height) {
    const iw = image.naturalWidth || image.width, ih = image.naturalHeight || image.height;
    const scale = Math.min(width / iw, height / ih) * state.zoom;
    return { x: width / 2 + state.offsetX, y: height / 2 + state.offsetY, width: iw * scale, height: ih * scale };
  }
  function fit(image, state, width, height) {
    const rect = drawRect(image, { ...state, zoom: 1 }, width, height);
    const c = Math.abs(Math.cos(angle(state))), s = Math.abs(Math.sin(angle(state)));
    return { ...state, zoom: clampZoom(Math.min(width / (rect.width * c + rect.height * s), height / (rect.width * s + rect.height * c))), offsetX: 0, offsetY: 0 };
  }
  // Anchor the same part of the image under the fingers, even while their midpoint moves.
  function zoomAt(state, zoom, from, to, width, height) {
    const nextZoom = clampZoom(zoom), ratio = nextZoom / state.zoom;
    return { ...state, zoom: nextZoom,
      offsetX: to.x - width / 2 - (from.x - width / 2 - state.offsetX) * ratio,
      offsetY: to.y - height / 2 - (from.y - height / 2 - state.offsetY) * ratio };
  }
  const midpoint = points => points.length > 1
    ? { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 } : points[0];
  const distance = points => points.length > 1 ? Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) : 0;
  function gesture(state, before, after, width, height) {
    const from = midpoint(before), to = midpoint(after);
    if (!from || !to) return state;
    const startDistance = distance(before);
    return zoomAt(state, before.length > 1 && after.length > 1 && startDistance > 1
      ? state.zoom * distance(after) / startDistance : state.zoom, from, to, width, height);
  }
  function render(context, image, state, width, height, coordinateSize = width) {
    const factor = width / coordinateSize;
    const rect = drawRect(image, { ...state, offsetX: state.offsetX * factor, offsetY: state.offsetY * factor }, width, height);
    context.fillStyle = state.fill === 'white' ? '#fff' : '#000';
    context.fillRect(0, 0, width, height);
    context.save();
    context.translate(rect.x, rect.y);
    context.rotate(angle(state));
    context.scale(state.flipX ? -1 : 1, state.flipY ? -1 : 1);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, -rect.width / 2, -rect.height / 2, rect.width, rect.height);
    context.restore();
  }
  // Keep the previous minimum; preserve larger intake photos up to a phone-safe 4096 square.
  const outputSize = image => Math.max(1200, Math.min(4096, Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height)));

  // Use pixels instead of Canvas.filter, which is not available on every iPhone Safari.
  // Leave alpha untouched, and do not sharpen across transparent cutout boundaries.
  function adjustPixels(pixels, width, height, settings) {
    const exposure = 2 ** (settings.brightness / 50), contrast = 1 + settings.contrast / 100;
    const saturation = 1 + settings.saturation / 100, warmth = settings.warmth * 0.35;
    for (let i = 0; i < pixels.length; i += 4) {
      if (!pixels[i + 3]) continue;
      let r = (pixels[i] * exposure - 128) * contrast + 128 + warmth;
      let g = (pixels[i + 1] * exposure - 128) * contrast + 128;
      let b = (pixels[i + 2] * exposure - 128) * contrast + 128 - warmth;
      const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
      pixels[i] = luma + (r - luma) * saturation;
      pixels[i + 1] = luma + (g - luma) * saturation;
      pixels[i + 2] = luma + (b - luma) * saturation;
    }
    if (!settings.sharpness || width < 3 || height < 3) return pixels;
    // Three source rows keep memory bounded on phones, even at export resolution.
    const stride = width * 4;
    let above = pixels.slice(0, stride), row = pixels.slice(stride, stride * 2);
    let below = new Uint8ClampedArray(stride);
    for (let y = 1; y < height - 1; y++) {
      below.set(pixels.subarray((y + 1) * stride, (y + 2) * stride));
      for (let x = 1; x < width - 1; x++) {
        const i = x * 4;
        if (Math.min(row[i + 3], row[i - 1], row[i + 7], above[i + 3], below[i + 3]) < 250) continue;
        for (let c = 0; c < 3; c++) {
          const detail = row[i + c] - (above[i + c] + below[i + c] + row[i - 4 + c] + row[i + 4 + c]) / 4;
          if (Math.abs(detail) > 2) pixels[y * stride + i + c] = row[i + c] + detail * settings.sharpness / 100;
        }
      }
      const reusable = above; above = row; row = below; below = reusable;
    }
    return pixels;
  }
  function adjustedImage(image, state, maxSide) {
    if (!adjustments.some(key => state[key])) return image;
    const iw = image.naturalWidth || image.width, ih = image.naturalHeight || image.height;
    const scale = Math.min(1, maxSide / Math.max(iw, ih));
    const surface = document.createElement('canvas');
    surface.width = Math.max(1, Math.round(iw * scale)); surface.height = Math.max(1, Math.round(ih * scale));
    const context = surface.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, surface.width, surface.height);
    const data = context.getImageData(0, 0, surface.width, surface.height);
    adjustPixels(data.data, surface.width, surface.height, state);
    context.putImageData(data, 0, 0);
    return surface;
  }

  function mount(root, { onClose, onSave }) {
    const get = suffix => root.querySelector(`#assisted-editor-${suffix}`);
    const canvas = get('canvas'), wrap = canvas.parentElement;
    const zoom = get('zoom'), tilt = get('rotation');
    let state = initial(), image = null, busy = false, frame = 0, beforeEdit = null;
    let previewImage = null, previewKey = '', comparing = false;
    let history = [], future = [], returnFocus = null, inertElements = [];
    const pointers = new Map();
    const editable = () => image && !busy;
    const snapshot = () => ({ ...state });
    const start = () => { if (!beforeEdit) beforeEdit = snapshot(); };
    function commit() {
      if (beforeEdit && JSON.stringify(beforeEdit) !== JSON.stringify(state)) {
        history.push(beforeEdit); if (history.length > 40) history.shift(); future = [];
      }
      beforeEdit = null; update();
    }
    function change(fn) { if (!editable()) return; start(); state = fn(snapshot()); commit(); }
    function update() {
      zoom.value = String(state.zoom); tilt.value = String(state.tilt);
      get('zoom-value').textContent = `${Math.round(state.zoom * 100)}%`;
      zoom.setAttribute('aria-valuetext', `${Math.round(state.zoom * 100)} percent`);
      get('rotation-value').textContent = `${state.tilt > 0 ? '+' : ''}${state.tilt.toFixed(1)}°`;
      for (const key of adjustments) {
        get(key).value = String(state[key]);
        get(`${key}-value`).textContent = `${state[key] > 0 ? '+' : ''}${state[key]}`;
      }
      get('compare').setAttribute('aria-pressed', String(comparing));
      get('compare').textContent = comparing ? 'Original colors' : 'Compare original';
      get('preview-label').textContent = comparing ? 'Original colors · same crop' : 'Square crop';
      for (const axis of ['horizontal', 'vertical']) get(`flip-${axis}`).setAttribute('aria-pressed', String(state[axis === 'horizontal' ? 'flipX' : 'flipY']));
      for (const fill of ['black', 'white']) get(`fill-${fill}`).setAttribute('aria-pressed', String(state.fill === fill));
      root.querySelectorAll('button, input').forEach(control => { control.disabled = busy || (!image && control !== get('close')); });
      get('undo').disabled = !editable() || !history.length;
      get('redo').disabled = !editable() || !future.length;
      get('zoom-out').disabled = !editable() || state.zoom <= MIN_ZOOM;
      get('zoom-in').disabled = !editable() || state.zoom >= MAX_ZOOM;
      root.setAttribute('aria-busy', String(busy));
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        const context = canvas.getContext('2d');
        if (image) {
          const key = adjustments.map(name => state[name]).join(',');
          if (!comparing && (!previewImage || previewKey !== key)) { previewImage = adjustedImage(image, state, 1200); previewKey = key; }
          render(context, comparing ? image : previewImage, state, canvas.width, canvas.height);
        }
        else context.clearRect(0, 0, canvas.width, canvas.height);
      });
    }
    const center = () => ({ x: canvas.width / 2, y: canvas.height / 2 });
    function setZoom(value) { state = zoomAt(state, value, center(), center(), canvas.width, canvas.height); update(); }
    function point(event) {
      const rect = canvas.getBoundingClientRect();
      return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height };
    }
    function releasePointers() {
      const ids = [...pointers.keys()]; pointers.clear();
      for (const id of ids) { if (canvas.hasPointerCapture?.(id)) canvas.releasePointerCapture(id); }
      wrap.classList.remove('is-dragging'); commit();
    }
    canvas.addEventListener('pointerdown', event => {
      if (!editable() || (event.pointerType === 'mouse' && event.button !== 0) || pointers.size >= 2) return;
      event.preventDefault(); start(); pointers.set(event.pointerId, point(event));
      canvas.setPointerCapture(event.pointerId); wrap.classList.add('is-dragging');
    });
    canvas.addEventListener('pointermove', event => {
      if (!editable() || !pointers.has(event.pointerId)) return;
      event.preventDefault();
      const before = [...pointers.values()]; pointers.set(event.pointerId, point(event));
      state = gesture(state, before, [...pointers.values()], canvas.width, canvas.height); update();
    });
    function endPointer(event) {
      if (!pointers.has(event.pointerId)) return;
      pointers.delete(event.pointerId);
      if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (!pointers.size) { wrap.classList.remove('is-dragging'); commit(); }
    }
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, endPointer);
    window.addEventListener('blur', releasePointers);
    window.addEventListener('resize', () => { if (pointers.size) releasePointers(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) releasePointers(); });
    canvas.addEventListener('keydown', event => {
      if (!editable()) return;
      const step = event.shiftKey ? 25 : 5;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (moves[event.key]) {
        event.preventDefault(); change(s => ({ ...s, offsetX: s.offsetX + moves[event.key][0], offsetY: s.offsetY + moves[event.key][1] }));
      } else if (['+', '=', '-'].includes(event.key)) {
        event.preventDefault(); change(s => zoomAt(s, s.zoom * (event.key === '-' ? 1 / 1.1 : 1.1), center(), center(), canvas.width, canvas.height));
      }
    });
    for (const control of [zoom, tilt, ...adjustments.map(get)]) {
      control.addEventListener('input', () => {
        if (!editable()) return; start();
        if (control === zoom) setZoom(control.value);
        else { state[control === tilt ? 'tilt' : control.id.replace('assisted-editor-', '')] = Number(control.value); comparing = false; update(); }
      });
      control.addEventListener('change', commit);
      control.addEventListener('blur', commit);
    }
    get('zoom-in').addEventListener('click', () => change(s => zoomAt(s, s.zoom * 1.15, center(), center(), canvas.width, canvas.height)));
    get('zoom-out').addEventListener('click', () => change(s => zoomAt(s, s.zoom / 1.15, center(), center(), canvas.width, canvas.height)));
    get('center').addEventListener('click', () => change(s => ({ ...s, offsetX: 0, offsetY: 0 })));
    get('fit').addEventListener('click', () => change(s => fit(image, s, canvas.width, canvas.height)));
    get('rotate-left').addEventListener('click', () => change(s => ({ ...s, turns: (s.turns + 3) % 4 })));
    get('rotate-right').addEventListener('click', () => change(s => ({ ...s, turns: (s.turns + 1) % 4 })));
    get('level').addEventListener('click', () => change(s => ({ ...s, tilt: 0 })));
    get('flip-horizontal').addEventListener('click', () => change(s => ({ ...s, flipX: !s.flipX })));
    get('flip-vertical').addEventListener('click', () => change(s => ({ ...s, flipY: !s.flipY })));
    for (const fill of ['black', 'white']) get(`fill-${fill}`).addEventListener('click', () => change(s => ({ ...s, fill })));
    get('reset').addEventListener('click', () => change(s => ({ ...s, zoom: 1, offsetX: 0, offsetY: 0, turns: 0, tilt: 0, flipX: false, flipY: false })));
    get('reset-adjustments').addEventListener('click', () => { comparing = false; change(s => ({ ...s, ...neutral() })); });
    get('compare').addEventListener('click', () => { if (editable()) { comparing = !comparing; update(); } });
    for (const name of ['frame', 'adjust']) get(`tab-${name}`).addEventListener('click', () => {
      for (const tab of ['frame', 'adjust']) {
        get(`tab-${tab}`).setAttribute('aria-pressed', String(tab === name));
        get(`panel-${tab}`).hidden = tab !== name;
      }
    });
    get('undo').addEventListener('click', () => { if (editable() && history.length) { commit(); future.push(snapshot()); state = history.pop(); update(); } });
    get('redo').addEventListener('click', () => { if (editable() && future.length) { history.push(snapshot()); state = future.pop(); update(); } });
    get('close').addEventListener('click', () => { if (!busy) onClose(); });
    get('save').addEventListener('click', () => { if (editable()) { comparing = false; releasePointers(); onSave(); } });
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }
      if (event.key === 'Tab') {
        const controls = [...root.querySelectorAll('button:not(:disabled), input:not(:disabled), canvas[tabindex]')].filter(el => el.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    });
    return {
      open(fill) {
        state = { ...initial(), fill }; image = null; busy = false; beforeEdit = null; history = []; future = [];
        previewImage = null; previewKey = ''; comparing = false;
        for (const name of ['frame', 'adjust']) {
          get(`tab-${name}`).setAttribute('aria-pressed', String(name === 'frame'));
          get(`panel-${name}`).hidden = name !== 'frame';
        }
        returnFocus = document.activeElement;
        inertElements = [...document.body.children].filter(el => el !== root && !el.contains(root)).map(el => [el, el.inert]);
        inertElements.forEach(([el]) => { el.inert = true; });
        update(); get('close').focus({ preventScroll: true });
      },
      load(nextImage) { image = nextImage; update(); },
      close() {
        releasePointers(); image = null; previewImage = null;
        if (frame) { cancelAnimationFrame(frame); frame = 0; }
        inertElements.forEach(([el, inert]) => { el.inert = inert; }); inertElements = [];
        returnFocus?.focus?.({ preventScroll: true });
      },
      setBusy(value) { busy = value; update(); },
      exportCanvas() {
        if (!image) throw new Error('The photo is still loading.');
        const output = document.createElement('canvas'), size = outputSize(image);
        output.width = output.height = size;
        render(output.getContext('2d'), adjustedImage(image, state, 4096), state, size, size, canvas.width);
        return output;
      },
    };
  }
  const api = { mount, initial, clampZoom, drawRect, fit, zoomAt, gesture, render, outputSize, adjustPixels };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.ItemPhotoEditor = api;
})();
