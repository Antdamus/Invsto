/* =========================================================
   favorites.shared.js — OG Jewelers
   Shared favorites UI (delegation + paint + heart icon/labels)
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

  function getItemName(btn) {
    if (!btn) return "item";

    var explicit = btn.getAttribute("data-fav-name");
    if (explicit && explicit.trim()) return explicit.trim();

    var root =
      btn.closest(".card") ||
      btn.closest(".product-card") ||
      btn.closest(".item-wrap") ||
      document;

    var labelEl =
      root.querySelector(".card-title") ||
      root.querySelector(".product-title") ||
      root.querySelector('[data-ui="item-title"]') ||
      root.querySelector("h1,h2,h3");

    var text = labelEl && labelEl.textContent ? labelEl.textContent.trim() : "";
    return text || "item";
  }

  function ensureIcon(btn) {
    if (!btn) return null;

    var icon = btn.querySelector(".fav-toggle-icon");
    if (icon) return icon;

    icon = document.createElement("span");
    icon.className = "fav-toggle-icon";
    icon.setAttribute("aria-hidden", "true");
    btn.textContent = "";
    btn.appendChild(icon);
    return icon;
  }

  function paintButton(btn, isFav) {
    if (!btn) return;

    var icon = ensureIcon(btn);
    if (icon) icon.textContent = isFav ? "♥" : "♡";

    btn.classList.toggle("is-fav", !!isFav);
    btn.setAttribute("aria-pressed", isFav ? "true" : "false");

    var name = getItemName(btn);
    btn.setAttribute(
      "aria-label",
      isFav
        ? "Remove " + name + " from favorites"
        : "Add " + name + " to favorites"
    );
    btn.setAttribute("title", isFav ? "Remove from favorites" : "Add to favorites");
  }

  function paintFavorites() {
    var toggles = document.querySelectorAll('[data-action="toggle-fav"]');

    if (!toggles.length) return hasService();

    if (!hasService()) {
      toggles.forEach(function (el) {
        paintButton(el, el.getAttribute("aria-pressed") === "true");
      });
      return false;
    }

    var svc = window.ogFavService;

    toggles.forEach(function (el) {
      var id = (el.dataset && el.dataset.id ? el.dataset.id : "").trim();
      var isFav = id ? !!svc.isFav(id) : el.getAttribute("aria-pressed") === "true";
      paintButton(el, isFav);
    });

    return true;
  }

  function schedulePaint() {
    if (repaintQueued) return;
    repaintQueued = true;

    window.requestAnimationFrame(function () {
      repaintQueued = false;
      paintFavorites();
    });
  }

  function tryPaintUntilReady(attempt) {
    if (paintFavorites()) return;
    if (attempt >= 30) return;
    window.setTimeout(function () {
      tryPaintUntilReady(attempt + 1);
    }, 50);
  }

  function mutationNeedsRepaint(mutations) {
    for (var i = 0; i < mutations.length; i += 1) {
      var m = mutations[i];

      if (m.type === "attributes") {
        if (m.attributeName === "data-id") return true;
        if (m.attributeName === "aria-pressed") return true;
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
      attributeFilter: ["data-id", "aria-pressed"]
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
      if (!typeAttr || typeAttr === "submit") e.preventDefault();
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
