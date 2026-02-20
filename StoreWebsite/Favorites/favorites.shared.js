/* =========================================================
   favorites.shared.js — OG Jewelers
   Step 4: Shared favorites UI (delegation + paintStars)
   ========================================================= */

(function () {
  function hasService() {
    var svc = window.ogFavService;
    return (
      svc &&
      typeof svc.toggle === "function" &&
      typeof svc.isFav === "function"
    );
  }

  function paintStars() {
    if (!hasService()) return;

    var svc = window.ogFavService;
    var stars = document.querySelectorAll('[data-action="toggle-fav"][data-id]');

    stars.forEach(function (el) {
      var id = (el.dataset && el.dataset.id ? el.dataset.id : "").trim();
      if (!id) return;

      var isFav = !!svc.isFav(id);
      el.classList.toggle("is-fav", isFav);
      el.setAttribute("aria-pressed", isFav ? "true" : "false");
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

  document.addEventListener("DOMContentLoaded", paintStars);
  window.addEventListener("og-favs-changed", paintStars);
})();
