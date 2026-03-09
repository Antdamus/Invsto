/* =========================================================
   inquiry.mode.js - OG Jewelers temporary inquiry + favorites mode
   ========================================================= */

(function () {
  "use strict";

  const INQUIRY_MODE_ENABLED = true;
  const INQUIRY_TOAST_MS = 6200;
  const INQUIRY_MESSAGE =
    "Due to demand and availability, pieces are currently offered by inquiry through our contact page or during our live shows. Save pieces to your Favorites list to keep track of your interest.";

  let toastEl = null;
  let hideTimer = 0;

  const normalizeId = (value) => String(value == null ? "" : value).trim();

  const ensureToast = () => {
    if (toastEl && document.body.contains(toastEl)) return toastEl;

    toastEl = document.querySelector(".og-inquiry-toast");
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "og-inquiry-toast";
      toastEl.setAttribute("role", "status");
      toastEl.setAttribute("aria-live", "polite");
      toastEl.hidden = true;
      document.body.appendChild(toastEl);
    }

    return toastEl;
  };

  const showInquiryMessage = (opts = {}) => {
    if (!INQUIRY_MODE_ENABLED) return;

    const el = ensureToast();
    const message = typeof opts === "string" ? opts : (opts.message || INQUIRY_MESSAGE);
    const durationMs = Math.max(1800, Number((opts && opts.durationMs) || INQUIRY_TOAST_MS) || INQUIRY_TOAST_MS);

    el.textContent = message;
    el.hidden = false;

    requestAnimationFrame(() => {
      el.classList.add("is-visible");
    });

    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      el.classList.remove("is-visible");
      const hideDelay = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220;
      window.setTimeout(() => {
        el.hidden = true;
      }, hideDelay);
    }, durationMs);
  };

  const addToFavorites = (itemId) => {
    const id = normalizeId(itemId);
    if (!id) return { ok: false, state: "missing-id", id };

    const svc = window.ogFavService;
    if (!svc) return { ok: false, state: "service-unavailable", id };

    const canCheck = typeof svc.isFav === "function";
    const alreadyFav = canCheck ? !!svc.isFav(id) : false;
    if (alreadyFav) return { ok: true, state: "exists", id };

    if (typeof svc.add === "function") {
      svc.add(id);
      return { ok: true, state: "added", id };
    }

    if (typeof svc.toggle === "function") {
      svc.toggle(id);
      const nowFav = canCheck ? !!svc.isFav(id) : true;
      return { ok: true, state: nowFav ? "added" : "exists", id };
    }

    return { ok: false, state: "unsupported", id };
  };

  const handleFavoriteIntent = (itemId, opts = {}) => {
    const result = addToFavorites(itemId);

    if (typeof opts.onResult === "function") {
      try {
        opts.onResult(result);
      } catch (_) {}
    }

    if (opts.showMessage !== false) {
      showInquiryMessage({
        message: opts.message || INQUIRY_MESSAGE,
        durationMs: opts.durationMs
      });
    }

    return result;
  };

  const resolveContactHref = () => {
    const inCartDir = /\/StoreCart\//i.test(window.location.pathname);
    return inCartDir ? "../contact.html" : "contact.html";
  };

  window.ogInquiryMode = {
    enabled: INQUIRY_MODE_ENABLED,
    message: INQUIRY_MESSAGE,
    toastDurationMs: INQUIRY_TOAST_MS,
    contactHref: resolveContactHref(),
    showInquiryMessage,
    addToFavorites,
    handleFavoriteIntent
  };
})();
