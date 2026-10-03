/* Shared completion evidence for pending orders, including uploads from another device. */
(function () {
  "use strict";

  function create(config) {
    const $ = id => document.getElementById(id);
    const esc = config.escapeHtml;
    const watchers = new Set();
    const previews = new Map();
    let scope = [], pending = [], saving = false, stopModalWatch = null, returnFocus = null;

    function targets(lines) {
      const orders = new Map();
      for (const line of lines) {
        if (!line?.id || !line.order_id) continue;
        if (!orders.has(line.order_id)) orders.set(line.order_id, []);
        if (!orders.get(line.order_id).includes(line.id)) orders.get(line.order_id).push(line.id);
      }
      return orders;
    }

    async function readOrder(orderId) {
      const rows = [];
      for (let offset = 0; ; offset += 500) {
        const {data, error} = await config.getClient().from("ebay_order_task_events")
          .select("id,order_id,created_at,signed_by_email,payload,photo_attachments")
          .eq("order_id", orderId).eq("payload->>proof_type", "completion_photo")
          .order("created_at", {ascending: false}).order("id", {ascending: false})
          .range(offset, offset + 499);
        if (error) throw error;
        rows.push(...(data || []));
        if ((data || []).length < 500) return rows;
      }
    }

    async function read(lines) {
      const photos = new Map();
      await Promise.all([...targets(lines)].map(async ([orderId, lineIds]) => {
        for (const event of await readOrder(orderId)) {
          if (event.payload?.history_removed) continue;
          const eventIds = event.payload?.order_line_ids || [];
          if (!eventIds.some(id => lineIds.includes(id))) continue;
          for (const photo of event.photo_attachments || []) {
            if (!photo.path || !photo.bucket) continue;
            const key = `${photo.bucket}:${photo.path}`;
            if (!photos.has(key)) photos.set(key, {...photo,
              created_at: event.created_at, signed_by_email: event.signed_by_email,
              auditText: `${event.signed_by_email || "Staff"} · ${config.formatDate(event.created_at)}`,
            });
          }
        }
      }));
      return Promise.all([...photos.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .map(async photo => {
          const key = `${photo.bucket}:${photo.path}`;
          let cached = previews.get(key);
          if (!cached || Date.now() - cached.at > 300000) {
            cached = {photo: await config.hydratePhoto(photo), at: Date.now()};
            previews.set(key, cached);
          }
          return {...cached.photo, auditText: photo.auditText};
        }));
    }

    function watch(lines, onChange, onError = () => {}) {
      let active = true, loading = false, rerun = false;
      async function refresh() {
        if (!active) return;
        if (loading) { rerun = true; return; }
        loading = true;
        try {
          const photos = await read(lines);
          if (active) onChange(photos);
        } catch (error) { if (active) onError(error); }
        finally {
          loading = false;
          if (rerun && active) { rerun = false; refresh(); }
        }
      }
      const interval = setInterval(() => { if (!document.hidden) refresh(); }, config.pollMs || 5000);
      const onVisible = () => { if (!document.hidden) refresh(); };
      document.addEventListener("visibilitychange", onVisible);
      watchers.add(refresh);
      refresh();
      return () => {
        active = false;
        clearInterval(interval);
        watchers.delete(refresh);
        document.removeEventListener("visibilitychange", onVisible);
      };
    }

    function renderGrid(container, photos) {
      if (!container) return;
      const signature = JSON.stringify(photos.map(p => [p.path, p.thumbnailUrl, p.auditText]));
      if (container.dataset.photos === signature) return;
      container.dataset.photos = signature;
      container.innerHTML = photos.length ? photos.map((photo, index) => `
        <article class="completion-photo-card">
          <button type="button" data-completion-photo="${index}" aria-label="Open ${esc(photo.label || "completion photo")}">
            <img src="${esc(photo.thumbnailUrl || photo.previewUrl || "")}" alt="${esc(photo.label || "Completion photo")}" />
            <span>Saved to order</span>
          </button>
          <small>${esc(photo.auditText || "")}</small>
        </article>`).join("") : '<p class="completion-photo-empty">No completion photos saved yet.</p>';
      container.querySelectorAll("[data-completion-photo]").forEach(button => {
        button.addEventListener("click", () => config.openPhoto(photos[Number(button.dataset.completionPhoto)]));
      });
    }

    function status(message, error = false) {
      $("completion-photo-status").textContent = message;
      $("completion-photo-status").classList.toggle("is-error", error);
    }

    function renderPending() {
      $("completion-photo-pending").innerHTML = pending.map((entry, index) => `
        <article class="completion-photo-card">
          <img src="${esc(entry.url)}" alt="${esc(entry.file.name)}" />
          <small>${esc(entry.file.name)}</small>
          <button type="button" class="secondary-btn" data-remove-photo="${index}" ${saving ? "disabled" : ""}>Remove</button>
        </article>`).join("");
      $("completion-photo-pending").querySelectorAll("[data-remove-photo]").forEach(button => {
        button.addEventListener("click", () => {
          const [entry] = pending.splice(Number(button.dataset.removePhoto), 1);
          URL.revokeObjectURL(entry.url);
          renderPending();
        });
      });
      $("save-completion-photos").disabled = saving || !pending.length;
      $("save-completion-photos").textContent = saving ? "Saving photos…" : `Save ${pending.length || ""} photo${pending.length === 1 ? "" : "s"}`;
      $("completion-photo-camera").disabled = saving;
      $("completion-photo-files").disabled = saving;
      $("close-completion-photos").disabled = saving;
      $("done-completion-photos").disabled = saving;
    }

    function chooseFiles(event) {
      if (saving) return;
      const files = Array.from(event.target.files || []);
      event.target.value = "";
      let rejected = false;
      for (const file of files) {
        if (!(file.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif|gif|avif)$/i.test(file.name))) {
          rejected = true; continue;
        }
        if (pending.some(p => p.file.name === file.name && p.file.size === file.size && p.file.lastModified === file.lastModified)) continue;
        pending.push({file, url: URL.createObjectURL(file), uploaded: null, saved: new Set(), attempted: new Set()});
      }
      renderPending();
      status(rejected ? "Choose image files only. Accepted photos are ready to save." : "Photos ready. Save them to share with the other device.", rejected);
    }

    async function save() {
      if (saving || !pending.length) return;
      saving = true;
      renderPending();
      status("Saving completion photos…");
      try {
        for (const entry of [...pending]) {
          if (!entry.uploaded) entry.uploaded = await config.uploadFile(entry.file);
          for (const [orderId, lineIds] of targets(scope)) {
            if (entry.saved.has(orderId)) continue;
            // A lost response may have committed. Read before retrying the same photo.
            if (entry.attempted.has(orderId)) {
              const exists = (await readOrder(orderId)).some(event =>
                lineIds.every(id => event.payload?.order_line_ids?.includes(id)) &&
                event.photo_attachments?.some(p => p.path === entry.uploaded.path && p.bucket === entry.uploaded.bucket));
              if (exists) { entry.saved.add(orderId); continue; }
            }
            entry.attempted.add(orderId);
            const {error} = await config.getClient().rpc("add_ebay_order_history_extra_photos", {
              _order_id: orderId, _order_line_ids: lineIds, _photo_attachments: [entry.uploaded],
              _note: null, _proof_type: "completion_photo", _signed_by_email: config.getActor(),
            });
            if (error) throw error;
            entry.saved.add(orderId);
          }
          pending = pending.filter(p => p !== entry);
          URL.revokeObjectURL(entry.url);
        }
        status("Saved to the order. These photos also appear on the other device and in Order History.");
      } catch (error) {
        status(`${error.message || "Could not save photos."} Your remaining photos are still here; tap Save to retry.`, true);
      } finally {
        saving = false;
        renderPending();
        watchers.forEach(refresh => refresh());
      }
    }

    function open(lines, picker = "") {
      if (saving || pending.length) {
        config.onOpen();
        status("Save or remove the selected photos before switching orders.", true);
        return;
      }
      if (!targets(lines).size) return;
      scope = lines.filter(line => line?.id && line.order_id).map(line => ({...line}));
      returnFocus = document.activeElement;
      const orders = [...new Set(scope.map(line => {
        const order = line.order || line.ebay_orders || {};
        return `${order.buyer_username || "Buyer"} · ${order.order_number || "Order"}`;
      }))];
      $("completion-photo-context").textContent = `${orders.join(" / ")} — ${targets(scope).size} order(s), ${scope.length} item line(s). Photos apply to these items.`;
      $("completion-photo-items").textContent = scope.map(line => line.item_title || line.item_number || "Item").join(" · ");
      status("");
      renderPending();
      config.onOpen();
      stopModalWatch?.();
      $("completion-photo-saved").dataset.photos = "";
      $("completion-photo-saved").textContent = "Loading saved photos…";
      stopModalWatch = watch(scope, photos => {
        renderGrid($("completion-photo-saved"), photos);
        if ($("completion-photo-status").textContent.startsWith("Could not refresh saved photos:")) status("");
      },
        error => status(`Could not refresh saved photos: ${error.message || "Try again."}`, true));
      if (picker) $(picker === "camera" ? "completion-photo-camera" : "completion-photo-files").click();
      else $("done-completion-photos").focus();
    }

    function close() {
      if (saving || pending.length) {
        status("Save or remove the selected photos before closing.", true);
        return false;
      }
      stopModalWatch?.(); stopModalWatch = null;
      config.onClose();
      if (returnFocus?.isConnected) returnFocus.focus();
      return true;
    }

    $("completion-photo-camera").addEventListener("change", chooseFiles);
    $("completion-photo-files").addEventListener("change", chooseFiles);
    $("save-completion-photos").addEventListener("click", save);
    $("close-completion-photos").addEventListener("click", close);
    $("done-completion-photos").addEventListener("click", close);
    $("refresh-completion-photos").addEventListener("click", () => watchers.forEach(refresh => refresh()));
    $("completion-photos-modal").addEventListener("click", event => {
      if (event.target.id === "completion-photos-modal") close();
    });
    window.addEventListener("beforeunload", event => {
      if (saving || pending.length) { event.preventDefault(); event.returnValue = ""; }
    });
    return {open, close, watch, renderGrid, get hasPending() { return saving || pending.length > 0; }};
  }

  window.OGCompletionPhotos = {create};
})();
