/* Pair an authenticated phone with a workstation. No images or QR links leave OG. */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const scriptBase = new URL(".", document.currentScript.src);
  let qrLoading;
  function sessionIdFromUrl() {
    const id = new URLSearchParams(location.hash.slice(1)).get("phone-camera");
    return UUID.test(id || "") ? id : "";
  }
  function label(lines = []) {
    return [...new Set(lines.map(line => `${line.order?.buyer_name || line.order?.buyer_username || "Customer"} · ${line.item_title || line.item_number || "Item"}`))].join(" / ");
  }
  async function rpc(client, name, args) {
    const {data, error} = await client.rpc(name, args);
    if (error) throw error;
    return data;
  }
  async function qr(url) {
    if (!window.ZXingBrowser?.BrowserQRCodeSvgWriter) {
      qrLoading ||= new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = new URL("vendor/zxing-browser-0.1.5.min.js", scriptBase).href;
        script.onload = resolve; script.onerror = () => {qrLoading = null; reject(Error("Could not load QR code. Use the phone link below or retry."));};
        document.head.append(script);
      });
      await qrLoading;
    }
    return new window.ZXingBrowser.BrowserQRCodeSvgWriter().write(url, 256, 256);
  }

  function createDesktop(config) {
    let sessionId = "", data = null, busy = false, timer, stopPhotos, retryRequest = null, visible = false, polling = false, revision = 0;
    const key = () => `og-order-phone:${config.getUserId()}`;
    function remember() {try {sessionId ? localStorage.setItem(key(), sessionId) : localStorage.removeItem(key());} catch (_) {}}
    function stored() {try {const id = localStorage.getItem(key()); return UUID.test(id || "") ? id : "";} catch (_) {return "";}}
    function status(message, error = false) {$("phone-pair-status").textContent = message; $("phone-pair-status").classList.toggle("is-error", error);}
    function paint(next) {
      const wasPaired = data ? Boolean(data.phone_email) : null;
      data = next;
      const recent = Date.now() - new Date(data.phone_seen_at || 0).getTime() < 20000;
      $("phone-pair-connection").textContent = data.phone_email
        ? `${recent ? "Phone connected" : "Phone paired — open its camera page"} · ${data.phone_email}`
        : "Waiting for your phone. Scan the QR code and sign in if needed.";
      window.OGCompletionPhotos.renderOrderContext($("phone-pair-order"), data.request?.lines, config.getCustomerName);
      $("phone-pair-progress").textContent = data.request?.saved_at ? "Photos saved on the phone. They appear below."
        : data.request?.opened_at ? "Order opened on the phone. Ready for photos." : "Order sent. Waiting for the phone to open it.";
      if (wasPaired !== Boolean(data.phone_email)) $("phone-pair-qr-section").open = !data.phone_email;
      document.querySelectorAll("[data-phone-camera]").forEach(button => {button.textContent = data.phone_email ? "Send to phone" : "Use my phone";});
    }
    async function refresh() {
      if (!visible || !sessionId || busy || polling || retryRequest) return;
      polling = true;
      const started = revision;
      try {
        const next = await rpc(config.getClient(), "read_order_phone_camera", {_session_id:sessionId,_phone:false});
        if (visible && started === revision) {
          paint(next);
          if (!retryRequest && $("phone-pair-status").classList.contains("is-error")) status("Keep the phone page open. Use Send to phone for each next order.");
        }
      }
      catch (error) {if (visible && started === revision) status(error.message || "Could not reach the phone. Retrying…", true);}
      finally {polling = false;}
    }
    function close() {
      visible = false; clearInterval(timer); stopPhotos?.(); stopPhotos = null; config.onClose();
    }
    async function send(lines) {
      if (busy || !lines.length || !config.getUserId()) return;
      visible = true; config.onOpen(); busy = true;
      revision++;
      $("retry-phone-send").disabled = true; $("disconnect-phone-camera").disabled = true;
      status("Sending order to your phone…");
      window.OGCompletionPhotos.renderOrderContext($("phone-pair-order"), lines, config.getCustomerName);
      $("phone-pair-progress").textContent = "Sending these order items…";
      stopPhotos?.(); stopPhotos = null;
      $("phone-pair-photos").textContent = "Waiting for the order to be sent…";
      const ids = [...new Set(lines.map(line => line.id).filter(Boolean))].sort();
      if (!retryRequest || JSON.stringify(ids) !== JSON.stringify(retryRequest.ids)) retryRequest = {id:crypto.randomUUID(),ids,lines};
      sessionId ||= stored() || crypto.randomUUID(); remember();
      try {
        let next;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {next = await rpc(config.getClient(), "send_order_to_phone", {_session_id:sessionId,_request_id:retryRequest.id,_line_ids:ids}); break;}
          catch (error) {
            if (error.code !== "P0002" || attempt) throw error;
            sessionId = crypto.randomUUID(); remember();
          }
        }
        paint(next); retryRequest = null;
        const url = new URL("pending-orders.html", location.href); url.hash = `phone-camera=${sessionId}`;
        $("phone-pair-link").value = url.href;
        $("phone-pair-qr").replaceChildren();
        status("Keep the phone page open. Use Send to phone for each next order.");
        qr(url.href).then(svg => {if (sessionId === next.id) $("phone-pair-qr").replaceChildren(svg);}).catch(error => status(error.message, true));
        stopPhotos?.();
        if (visible) stopPhotos = config.watchPhotos(next.request.lines, $("phone-pair-photos"));
      } catch (error) {status(`${error.message || "Could not send this order."} Use Retry to send the same request.`, true);}
      finally {
        busy = false; $("retry-phone-send").disabled = !retryRequest;
        $("disconnect-phone-camera").disabled = false;
        clearInterval(timer); if (visible) timer = setInterval(() => {if (!document.hidden) refresh();}, config.pollMs || 3000);
      }
    }
    $("retry-phone-send").addEventListener("click", () => {if (retryRequest) send(retryRequest.lines);});
    $("close-phone-camera-pair").addEventListener("click", close);
    $("done-phone-camera-pair").addEventListener("click", close);
    $("phone-camera-pair-modal").addEventListener("click", event => {if (event.target.id === "phone-camera-pair-modal") close();});
    $("copy-phone-pair-link").addEventListener("click", async () => {
      try {await navigator.clipboard.writeText($("phone-pair-link").value);status("Phone link copied.");}
      catch (_) {$("phone-pair-link").select();status("Select and copy the phone link shown below.");}
    });
    $("disconnect-phone-camera").addEventListener("click", async () => {
      if (busy || !sessionId) return;
      busy = true; $("disconnect-phone-camera").disabled = true;
      try {
        await rpc(config.getClient(), "disconnect_order_phone_camera", {_session_id:sessionId});
        sessionId = ""; data = null; retryRequest = null; remember(); close();
        document.querySelectorAll("[data-phone-camera]").forEach(button => {button.textContent = "Use my phone";});
      } catch (error) {status(error.message || "Could not disconnect. Try again.", true);}
      finally {busy = false; $("disconnect-phone-camera").disabled = false;}
    });
    document.addEventListener("visibilitychange", () => {if (!document.hidden) refresh();});
    return {send,close,get paired() {return Boolean(data?.phone_email);}};
  }

  function createReceiver(config) {
    const sessionId = config.sessionId;
    let active = null, next = null, photos, timer, stopped = false, refreshing = false, authenticated = false;
    const acknowledgements = new Map();
    function status(message, error = false) {$("phone-camera-status").textContent = message; $("phone-camera-status").classList.toggle("is-error", error);}
    function queueAck(id, value) {if (id) acknowledgements.set(id, value);}
    async function flushAcks() {
      for (const [id, value] of acknowledgements) {
        await rpc(config.getClient(), "mark_order_phone_camera_request", {_session_id:sessionId,_request_id:id,_status:value});
        if (acknowledgements.get(id) === value) acknowledgements.delete(id);
      }
    }
    function openRequest(request, camera = false) {
      if (!request?.lines?.length || photos.hasPending) return;
      active = request; next = null;
      $("phone-camera-next").classList.add("hidden");
      photos.open(request.lines, camera ? "camera" : "");
      queueAck(request.id, "opened");
      flushAcks().catch(() => {});
    }
    async function refresh() {
      if (stopped || !authenticated || refreshing) return;
      refreshing = true;
      try {
        const result = await rpc(config.getClient(), "read_order_phone_camera", {_session_id:sessionId,_phone:true});
        $("phone-camera-connected").textContent = `Connected to ${result.owner_email || "your computer"}`;
        status("Keep this page open. Photos you save appear on the computer automatically.");
        if (result.request?.id && result.request.id !== active?.id) {
          if (!active) openRequest(result.request);
          else {
            next = result.request;
            $("phone-camera-next-label").textContent = `Next: ${label(next.lines)}`;
            $("phone-camera-next").classList.remove("hidden");
          }
        }
        await flushAcks();
      } catch (error) {
        status(error.message || "Connection interrupted. Your photos stay here; we’ll retry.", true);
        if (error.code === "P0002" || error.code === "42501") {stopped = true;clearInterval(timer);$("phone-camera-next").classList.add("hidden");}
      } finally {refreshing = false;}
    }
    async function connect() {
      const {data, error} = await config.getClient().auth.getSession();
      if (error) {status(error.message, true);return;}
      if (!data?.session?.user) {$("phone-camera-login").classList.remove("hidden");status("Sign in to connect this phone to the order.");return;}
      config.onUser(data.session.user); authenticated = true;
      $("phone-camera-login").classList.add("hidden");
      $("phone-camera-account").textContent = `Signed in as ${data.session.user.email}`;
      photos ||= config.getPhotoController();
      await refresh();
      clearInterval(timer); if (!stopped) timer = setInterval(() => {if (!document.hidden) refresh();}, config.pollMs || 3000);
    }
    $("phone-camera-login").addEventListener("submit", async event => {
      event.preventDefault(); const button = $("phone-camera-login-submit"); button.disabled = true;
      try {
        const {error} = await config.getClient().auth.signInWithPassword({email:$("phone-camera-email").value.trim(),password:$("phone-camera-password").value});
        if (error) throw error;
        $("phone-camera-password").value = "";await connect();
      } catch (error) {status(error.message || "Could not sign in. Try again.", true);}
      finally {button.disabled = false;}
    });
    $("phone-camera-open-next").addEventListener("click", () => {
      if (stopped) return;
      if (photos?.hasPending) return status("Save or remove the current photos before opening the next order.", true);
      openRequest(next, true);
    });
    $("leave-phone-camera").addEventListener("click", () => {
      if (photos?.hasPending) return status("Save or remove the current photos before leaving.", true);
      stopped = true;clearInterval(timer);location.href = new URL("pending-orders.html", location.href).href;
    });
    document.addEventListener("visibilitychange", () => {if (!document.hidden) refresh();});
    return {
      connect,
      saved() {queueAck(active?.id,"saved");flushAcks().catch(() => {});},
    };
  }
  window.OGPhoneCamera = {sessionIdFromUrl,createDesktop,createReceiver};
  if (sessionIdFromUrl()) {
    document.body.classList.add("phone-camera-mode");
    $("phone-camera-home").classList.remove("hidden");
    $("completion-photos-modal").setAttribute("role", "region");
    $("completion-photos-modal").removeAttribute("aria-modal");
  }
})();
