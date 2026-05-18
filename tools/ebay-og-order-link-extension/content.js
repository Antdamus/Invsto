(function () {
  "use strict";

  const ORDER_LINK_SELECTOR = 'a[data-testid^="unique-order-id-link-"]';
  const ORDER_NUMBER_PATTERN = /\b\d{2}-\d{5}-\d{5}\b/;
  const STORAGE_KEY = "ogPendingOrdersUrl";
  const BUTTON_CLASS = "og-ebay-open-order";
  const FLOATING_ID = "og-ebay-open-all-orders";

  function normalizeOrderNumber(value) {
    const match = String(value || "").match(ORDER_NUMBER_PATTERN);
    return match ? match[0] : "";
  }

  function getOrderLinks() {
    return [...document.querySelectorAll(ORDER_LINK_SELECTOR)]
      .map((link) => ({
        link,
        orderNumber: normalizeOrderNumber(link.textContent || link.getAttribute("href") || link.dataset.testid),
      }))
      .filter((entry) => entry.orderNumber);
  }

  function uniqueOrderNumbers() {
    return [...new Set(getOrderLinks().map((entry) => entry.orderNumber))];
  }

  function normalizeAppUrl(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    try {
      const url = new URL(text);
      return url.toString();
    } catch (_) {
      return "";
    }
  }

  async function getConfiguredAppUrl() {
    const stored = await chrome.storage.sync.get(STORAGE_KEY);
    const saved = normalizeAppUrl(stored[STORAGE_KEY]);
    if (saved) return saved;

    const entered = window.prompt(
      "Paste your OG Pending Orders page URL. Example: https://your-site.com/pending-orders.html"
    );
    const normalized = normalizeAppUrl(entered);
    if (normalized) {
      await chrome.storage.sync.set({ [STORAGE_KEY]: normalized });
    }
    return normalized;
  }

  function buildOgUrl(appUrl, orderNumbers) {
    const url = new URL(appUrl);
    const unique = [...new Set(orderNumbers.map(normalizeOrderNumber).filter(Boolean))];
    url.searchParams.set("source", "ebay");
    if (unique.length === 1) {
      url.searchParams.set("orderId", unique[0]);
      url.searchParams.delete("orderIds");
    } else {
      url.searchParams.set("orderIds", unique.join(","));
      url.searchParams.delete("orderId");
    }
    return url.toString();
  }

  async function openInOg(orderNumbers) {
    const clean = [...new Set(orderNumbers.map(normalizeOrderNumber).filter(Boolean))];
    if (!clean.length) return;

    const appUrl = await getConfiguredAppUrl();
    if (!appUrl) {
      window.alert("OG Pending Orders URL was not set. Click the extension icon to set it.");
      return;
    }
    window.open(buildOgUrl(appUrl, clean), "_blank", "noopener,noreferrer");
  }

  function ensureStyles() {
    if (document.getElementById("og-ebay-order-link-styles")) return;
    const style = document.createElement("style");
    style.id = "og-ebay-order-link-styles";
    style.textContent = `
      .${BUTTON_CLASS} {
        margin-left: 8px;
        border: 1px solid #0b72e7;
        border-radius: 999px;
        background: #edf5ff;
        color: #0759b8;
        cursor: pointer;
        font: 700 12px Arial, sans-serif;
        line-height: 1;
        padding: 5px 8px;
      }

      .${BUTTON_CLASS}:hover {
        background: #dcebff;
      }

      #${FLOATING_ID} {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483647;
        border: 1px solid #9b6418;
        border-radius: 999px;
        background: #e7bd73;
        color: #17120b;
        box-shadow: 0 12px 28px rgba(0, 0, 0, .22);
        cursor: pointer;
        font: 800 14px Arial, sans-serif;
        padding: 12px 16px;
      }
    `;
    document.head.appendChild(style);
  }

  function injectRowButtons() {
    getOrderLinks().forEach(({ link, orderNumber }) => {
      const parent = link.parentElement;
      if (!parent || parent.querySelector(`.${BUTTON_CLASS}[data-og-order="${orderNumber}"]`)) return;

      const button = document.createElement("button");
      button.type = "button";
      button.className = BUTTON_CLASS;
      button.dataset.ogOrder = orderNumber;
      button.textContent = "Open in OG";
      button.title = `Open ${orderNumber} in OG Pending Orders`;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openInOg([orderNumber]);
      });

      link.insertAdjacentElement("afterend", button);
    });
  }

  function injectFloatingButton() {
    const orderNumbers = uniqueOrderNumbers();
    let button = document.getElementById(FLOATING_ID);

    if (!orderNumbers.length) {
      button?.remove();
      return;
    }

    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.id = FLOATING_ID;
      button.addEventListener("click", () => openInOg(uniqueOrderNumbers()));
      document.body.appendChild(button);
    }

    button.textContent = `Open ${orderNumbers.length} in OG`;
    button.title = "Open all visible eBay label orders in OG Pending Orders";
  }

  function injectOgControls() {
    ensureStyles();
    injectRowButtons();
    injectFloatingButton();
  }

  let scheduled = false;
  function scheduleInject() {
    if (scheduled) return;
    scheduled = true;
    window.setTimeout(() => {
      scheduled = false;
      injectOgControls();
    }, 250);
  }

  injectOgControls();
  new MutationObserver(scheduleInject).observe(document.body, {
    childList: true,
    subtree: true,
  });
})();
