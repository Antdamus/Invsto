/* =========================================================
   favorites.shared.js — OG Jewelers
   Step 4: Shared favorites UI (delegation + paintStars)
   ========================================================= */

(function () {
  var repaintQueued = false;
  var repaintObserver = null;

  function hasService() {
    var svc = window.ogFavService;
    return (
      svc &&
      typeof svc.toggle === "function" &&
      typeof svc.isFav === "function"
    );
  }

  function paintStars() {
    if (!hasService()) return false;

    var svc = window.ogFavService;
    var stars = document.querySelectorAll('[data-action="toggle-fav"][data-id]');

    stars.forEach(function (el) {
      var id = (el.dataset && el.dataset.id ? el.dataset.id : "").trim();
      if (!id) return;

      var isFav = !!svc.isFav(id);
      el.classList.toggle("is-fav", isFav);
      el.setAttribute("aria-pressed", isFav ? "true" : "false");
    });

    return true;
  }

  function schedulePaint() {
    if (repaintQueued) return;
    repaintQueued = true;

    window.requestAnimationFrame(function () {
      repaintQueued = false;
      paintStars();
    });
  }

  function tryPaintUntilReady(attempt) {
    if (paintStars()) return;
    if (attempt >= 30) return;
    window.setTimeout(function () {
      tryPaintUntilReady(attempt + 1);
    }, 50);
  }

  function mutationNeedsRepaint(mutations) {
    for (var i = 0; i < mutations.length; i += 1) {
      var m = mutations[i];

      if (m.type === "attributes" && m.attributeName === "data-id") {
        return true;
      }

      if (m.type === "childList") {
        if (m.addedNodes && m.addedNodes.length) return true;
      }
    }
    return false;
  }

  function setupRepaintObserver() {
    if (repaintObserver || typeof MutationObserver !== "function") return;
    repaintObserver = new MutationObserver(function (mutations) {
      if (!mutationNeedsRepaint(mutations)) return;
      schedulePaint();
    });

    repaintObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-id"]
    });
  }

  document.addEventListener("click", function (e) {
    var target = e.target;
    if (!target || typeof target.closest !== "function") return;

    var el = target.closest('[data-action="toggle-fav"]');
    if (!el) return;

    var id = (el.dataset && el.dataset.id ? el.dataset.id : "").trim();
    if (!id) return;

    if (!hasService()) return;

    if (el.tagName === "A") {
      e.preventDefault();
    } else if (el.tagName === "BUTTON") {
      var typeAttr = (el.getAttribute("type") || "").toLowerCase();
      if (!typeAttr || typeAttr === "submit") {
        e.preventDefault();
      }
    }

    window.ogFavService.toggle(id);
  });

  document.addEventListener("DOMContentLoaded", function () {
    setupRepaintObserver();
    tryPaintUntilReady(0);
  });
  window.addEventListener("load", schedulePaint);
  window.addEventListener("og-favs-changed", schedulePaint);
})();
