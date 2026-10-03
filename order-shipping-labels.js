(function () {
  "use strict";
  function create(config) {
    const $ = id => document.getElementById(id), esc = config.escapeHtml;
    let scope = [], pending = [], busy = false, batch = null, stopModalWatch = null, focusBack;
    const watchers = new Set();
    function orderOptions(lines = scope) {
      return [...new Map(lines.filter(l => l?.order_id).map(line => [line.order_id,
        {id: line.order_id, number: (line.order || line.ebay_orders || {}).order_number || line.order_id,
          buyer: (line.order || line.ebay_orders || {}).buyer_username || "Buyer"}])).values()];
    }
    function status(message = "", error = false) {
      $("order-label-upload-status").textContent = message;
      $("order-label-upload-status").classList.toggle("is-error", error);
    }
    async function read(lines) {
      const ids = orderOptions(lines).map(order => order.id);
      if (!ids.length) return [];
      const client = config.getClient();
      const {data: orders, error} = await client.from("ebay_orders")
        .select("id,order_number,buyer_username,label_status,label_storage_bucket,label_file_path,label_uploaded_at,label_metadata")
        .in("id", ids);
      if (error) throw error;
      const events = [];
      for (let offset = 0; ; offset += 500) {
        const {data, error: eventError} = await client.from("ebay_order_label_events")
          .select("id,action,order_ids,order_numbers,label_storage_bucket,label_file_path,label_metadata,signed_by_email,created_at,source")
          .overlaps("order_ids", ids).in("action", ["attached", "replaced", "extra_label"])
          .order("created_at", {ascending: true}).order("id", {ascending: true}).range(offset, offset + 499);
        if (eventError) throw eventError;
        events.push(...(data || []));
        if ((data || []).length < 500) break;
      }
      const labels = new Map();
      function add(label) {
        if (!label.path) return;
        const key = `${label.bucket}:${label.path}`, old = labels.get(key);
        labels.set(key, old ? {...old, ...label,
          orderNumbers: [...new Set([...old.orderNumbers, ...label.orderNumbers])].sort(),
        } : label);
      }
      for (const event of events) {
        add({bucket: event.label_storage_bucket || "ebay-labels", path: event.label_file_path,
          metadata: event.label_metadata || {}, orderNumbers: (orders || []).filter(o => event.order_ids.includes(o.id)).map(o => o.order_number),
          createdAt: event.created_at, author: event.signed_by_email});
      }
      // The order may contain newer tracking metadata than its original audit event.
      for (const order of orders || []) add({bucket: order.label_storage_bucket || "ebay-labels",
        path: order.label_file_path, metadata: order.label_metadata || {}, orderNumbers: [order.order_number],
        createdAt: order.label_uploaded_at});
      config.onOrdersLoaded?.(orders || []);
      return [...labels.values()];
    }
    function renderSaved(container, labels) {
      if (!container) return;
      const signature = JSON.stringify(labels);
      if (container.dataset.labels === signature) return;
      container.dataset.labels = signature;
      container.innerHTML = labels.length ? labels.map((label, index) => `
        <article class="order-saved-label">
          <div><strong>${esc(label.metadata.fileName || `Shipping label ${index + 1}`)}</strong>
          <span>${esc(config.trackingDisplay(label.metadata) || "No tracking number saved")}</span>
          <small>Order ${esc(label.orderNumbers.join(", "))}${label.author ? ` · ${esc(label.author)}` : ""}</small></div>
          <div class="completion-photo-actions">
            <button type="button" class="secondary-btn" data-open-saved-label="${index}">Open PDF</button>
            <button type="button" class="secondary-btn" data-print-saved-label="${index}">Print</button>
          </div>
        </article>`).join("") : '<p class="completion-photo-help">No shipping labels saved for these orders yet.</p>';
      container.querySelectorAll("[data-open-saved-label]").forEach(button => button.addEventListener("click", async () => {
        const label = labels[Number(button.dataset.openSavedLabel)];
        const tab = window.open("about:blank", "_blank");
        if (tab) tab.opener = null;
        try {
          const {data, error} = await config.getClient().storage.from(label.bucket).createSignedUrl(label.path, 300);
          if (error || !data?.signedUrl) throw error || Error("Could not open PDF.");
          if (tab) tab.location.replace(data.signedUrl);
          else throw Error("Allow pop-ups to open this PDF.");
        } catch (error) {tab?.close(); config.reportError(error.message || "Could not open PDF.");}
      }));
      container.querySelectorAll("[data-print-saved-label]").forEach(button => button.addEventListener("click", () => {
        const label = labels[Number(button.dataset.printSavedLabel)];
        window.shippingLabelPrint.runLocal(button, {bucket: label.bucket, path: label.path,
          title: label.metadata.fileName || "Shipping label"});
      }));
    }
    function subscribe(readValue, onValue, onError, pollMs) {
      let active = true, loading = false, rerun = false;
      async function refresh() {
        if (!active) return;
        if (loading) {rerun = true; return;}
        loading = true;
        try {
          const value = await readValue();
          if (active) onValue(value);
        } catch (error) {if (active) onError?.(error);}
        finally {loading = false; if (rerun && active) {rerun = false; refresh();}}
      }
      const timer = setInterval(() => {if (!document.hidden) refresh();}, pollMs);
      const visible = () => {if (!document.hidden) refresh();};
      document.addEventListener("visibilitychange", visible);
      watchers.add(refresh); refresh();
      return () => {active = false; clearInterval(timer); watchers.delete(refresh); document.removeEventListener("visibilitychange", visible);};
    }
    function watch(lines, container, statusEl) {
      if (container) {container.dataset.labels = ""; container.textContent = "Loading shipping labels…";}
      return subscribe(() => read(lines), labels => {
        renderSaved(container, labels); if (statusEl) statusEl.textContent = "";
      }, error => {
        if (statusEl) statusEl.textContent = `Could not refresh labels: ${error.message || "Try again."}`;
      }, config.pollMs || 5000);
    }
    function watchOrderStatus(lines) {
      const ids = orderOptions(lines).map(order => order.id).sort();
      // Only fetch the saved path for queue badges, without PDFs or label audit history.
      return subscribe(async () => {
        const orders = [];
        for (let offset = 0; offset < ids.length; offset += 200) {
          const {data, error} = await config.getClient().from("ebay_orders")
            .select("id,label_file_path").in("id", ids.slice(offset, offset + 200));
          if (error) throw error;
          orders.push(...(data || []));
        }
        return orders;
      }, orders => config.onOrdersLoaded?.(orders), null, config.pollMs || 15000);
    }
    function numbers(entry) {
      return [...new Set(entry.tracking.split(/[,;\n]+/).map(window.shippingLabelReader.clean).filter(Boolean))];
    }
    function renderPending() {
      $("order-label-pending").innerHTML = pending.map(entry => `
        <article class="order-label-upload-card" data-label-entry="${entry.id}">
          <div class="order-label-upload-head"><strong>${esc(entry.file.name)}</strong>
            <button type="button" class="secondary-btn" data-remove-label="${entry.id}" ${busy || batch ? "disabled" : ""}>Remove</button></div>
          ${entry.result?.previewUrl ? `<img class="order-label-preview" src="${esc(entry.result.previewUrl)}" alt="First page of ${esc(entry.file.name)}" />` : ""}
          <a href="${esc(entry.url)}" target="_blank" rel="noopener" class="secondary-btn">Preview PDF</a>
          <p data-label-progress="${entry.id}" class="completion-photo-help">${esc(entry.progress)}</p>
          ${entry.error ? `<p class="is-error">${esc(entry.error)}</p>` : ""}
          <label>Tracking / barcode numbers
            <input id="label-tracking-${entry.id}" data-label-tracking="${entry.id}" data-camera-scan
              aria-label="Tracking or barcode numbers for ${esc(entry.file.name)}" value="${esc(entry.tracking)}"
              placeholder="Scan or type; separate multiple numbers with commas" ${busy || batch || !entry.result ? "disabled" : ""} />
          </label>
          <fieldset ${busy || batch ? "disabled" : ""}><legend>This PDF covers</legend>
            ${orderOptions().map(order => `<label class="order-label-order-choice"><input type="checkbox" data-label-order="${entry.id}" value="${esc(order.id)}" ${entry.orders.has(order.id) ? "checked" : ""} /> ${esc(order.buyer)} · ${esc(order.number)}</label>`).join("")}
          </fieldset>
        </article>`).join("");
      $("order-label-pending").querySelectorAll("[data-remove-label]").forEach(button => button.addEventListener("click", () => {
        const entry = pending.find(p => p.id === button.dataset.removeLabel);
        entry.abort.abort(); URL.revokeObjectURL(entry.url);
        pending = pending.filter(p => p !== entry); renderPending();
      }));
      $("order-label-pending").querySelectorAll("[data-label-tracking]").forEach(input => {
        input.addEventListener("input", () => {pending.find(p => p.id === input.dataset.labelTracking).tracking = input.value;});
        input.addEventListener("change", () => {pending.find(p => p.id === input.dataset.labelTracking).tracking = input.value;});
        input.addEventListener("keydown", event => {if (event.key === "Enter") {event.preventDefault(); event.stopPropagation();}});
      });
      $("order-label-pending").querySelectorAll("[data-label-order]").forEach(input => input.addEventListener("change", () => {
        const entry = pending.find(p => p.id === input.dataset.labelOrder);
        if (input.checked) entry.orders.add(input.value); else entry.orders.delete(input.value);
      }));
      $("save-order-labels").disabled = busy || !pending.length || pending.some(p => !p.result || p.error);
      $("save-order-labels").textContent = busy ? "Saving labels…" : batch ? "Retry save" : "Save labels to orders";
      $("order-label-files").disabled = busy || Boolean(batch);
      $("clear-order-label-selection").disabled = busy || !pending.length;
      $("close-order-labels").disabled = busy;
      $("done-order-labels").disabled = busy;
    }
    async function choose(event) {
      const files = Array.from(event.target.files || []); event.target.value = "";
      if (busy || batch) return;
      if (files.length + pending.length > 20) return status("Choose up to 20 PDFs at a time.", true);
      const added = [];
      for (const file of files) {
        if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {status("Choose PDF documents only.", true); continue;}
        const entry = {id: crypto.randomUUID(), file, url: URL.createObjectURL(file), abort: new AbortController(),
          orders: new Set(orderOptions().map(o => o.id)), tracking: "", progress: "Waiting to read PDF…", result: null};
        pending.push(entry); added.push(entry);
      }
      renderPending();
      for (const entry of added) {
        try {
          entry.result = await window.shippingLabelReader.read(entry.file, {signal: entry.abort.signal,
            onProgress: message => {entry.progress = message; const el = document.querySelector(`[data-label-progress="${entry.id}"]`); if (el) el.textContent = message;}});
          if (entry.abort.signal.aborted) continue;
          entry.tracking = entry.result.trackingNumbers.join(", ");
          entry.progress = `${entry.result.pageCount} page(s). ${entry.tracking ? "Check the detected numbers below." : "No tracking number was read automatically. Scan or enter it below."}${entry.result.allThermal ? "" : " For Letter/A4 pages, use Open PDF and your document printer."}`;
        } catch (error) {if (!entry.abort.signal.aborted) entry.error = error.message || "Could not read this PDF.";}
        if (!entry.abort.signal.aborted) renderPending();
      }
    }
    function clear() {
      if (busy) return;
      pending.forEach(entry => {entry.abort.abort(); URL.revokeObjectURL(entry.url);});
      pending = []; batch = null; renderPending();
    }
    async function save() {
      if (busy || !pending.length || pending.some(p => !p.result || p.error)) return;
      if (!batch) {
        for (const entry of pending) {
          const codes = numbers(entry);
          if (!entry.orders.size || !codes.length || codes.some(code => !/^[A-Z0-9]{6,80}$/.test(code))) {
            status(`Check ${entry.file.name}: select its orders and enter tracking/barcode numbers (6–80 letters or digits each).`, true);
            return;
          }
        }
      }
      busy = true; renderPending(); status("Uploading and attaching shipping labels…");
      try {
        if (!batch) {
          const labels = [];
          for (const entry of pending) {
            if (!entry.path) {
              const path = `manual-labels/${new Date().toISOString().slice(0,10)}/${crypto.randomUUID()}.pdf`;
              const {error} = await config.getClient().storage.from("ebay-labels").upload(path, entry.file,
                {contentType: "application/pdf", upsert: false});
              if (error) throw error;
              entry.path = path;
            }
            const tracking = numbers(entry);
            const approvedBarcodes = entry.result.barcodeValues.filter(code =>
              tracking.includes(code) || tracking.includes(window.shippingLabelReader.trackingFromBarcode(code)));
            labels.push({path: entry.path, order_ids: [...entry.orders].sort(), metadata: {
              fileName: entry.file.name, mimeType: "application/pdf", size: entry.file.size,
              pageCount: entry.result.pageCount, allThermal: entry.result.allThermal,
              trackingNumber: tracking[0], trackingNumbers: tracking,
              shippingBarcodeNumber: tracking[0], shippingBarcodeNumbers: [...new Set([...tracking, ...approvedBarcodes])],
              barcodeValues: entry.result.barcodeValues, pdfDetectedPages: entry.result.pages,
              lookupKeys: [...new Set([...tracking, ...approvedBarcodes])],
              trackingSource: "pdf-read-and-user-reviewed",
            }});
          }
          batch = {id: crypto.randomUUID(), labels};
        }
        const {error} = await config.getClient().rpc("attach_manual_shipping_labels", {_request_id: batch.id, _labels: batch.labels});
        if (error) throw error;
        busy = false; clear();
        status("Labels saved to the selected orders and available during checkout and in Order History.");
      } catch (error) {status(`${error.message || "Could not save labels."} Your selection is still here; retry saving.`, true);}
      finally {busy = false; renderPending(); watchers.forEach(refresh => refresh());}
    }
    function open(lines) {
      if (busy || pending.length) {config.onOpen(); status("Save or clear the selected PDFs before switching orders.", true); return;}
      if (!orderOptions(lines).length) return;
      scope = lines; focusBack = document.activeElement;
      $("order-label-context").textContent = orderOptions().map(order => `${order.buyer} · ${order.number}`).join(" / ");
      status(""); renderPending(); config.onOpen(); stopModalWatch?.();
      stopModalWatch = watch(scope, $("order-label-saved"), $("order-label-refresh-status"));
      $("done-order-labels").focus();
    }
    function close() {
      if (busy || pending.length) {status("Save or clear the selected PDFs before closing.", true); return false;}
      stopModalWatch?.(); stopModalWatch = null; config.onClose();
      if (focusBack?.isConnected) focusBack.focus(); return true;
    }
    $("order-label-files").addEventListener("change", choose);
    $("save-order-labels").addEventListener("click", save);
    $("clear-order-label-selection").addEventListener("click", clear);
    $("close-order-labels").addEventListener("click", close);
    $("done-order-labels").addEventListener("click", close);
    $("refresh-order-labels").addEventListener("click", () => watchers.forEach(refresh => refresh()));
    $("order-shipping-labels-modal").addEventListener("click", event => {if (event.target.id === "order-shipping-labels-modal") close();});
    window.addEventListener("beforeunload", event => {if (busy || pending.length) {event.preventDefault(); event.returnValue = "";}});
    return {open, close, watch, watchOrderStatus, refresh: () => watchers.forEach(refresh => refresh()),
      get hasPending() {return busy || pending.length > 0;}};
  }
  window.OGOrderShippingLabels = {create};
})();
