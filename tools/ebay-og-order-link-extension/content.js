(function () {
  "use strict";

  const ORDER_LINK_SELECTOR = 'a[data-testid^="unique-order-id-link-"]';
  const ORDER_NUMBER_PATTERN = /\b\d{2}-\d{5}-\d{5}\b/;
  const STORAGE_KEY = "ogPendingOrdersUrl";
  const BUTTON_CLASS = "og-ebay-open-order";
  const FLOATING_ID = "og-ebay-open-all-orders";
  const SINGLE_ORDER_ID = "og-ebay-open-single-order";

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

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function getText(selector, root = document) {
    return cleanText(root.querySelector(selector)?.textContent || root.querySelector(selector)?.innerText || "");
  }

  function getTextLines(selector, root = document) {
    const element = root.querySelector(selector);
    return String(element?.innerText || element?.textContent || "")
      .split(/\n+/)
      .map(cleanText)
      .filter(Boolean);
  }

  function getValueByHeading(label) {
    const expected = String(label || "").trim().toLowerCase();
    const headings = [...document.querySelectorAll('[data-testid="order-page"] h3')];
    const heading = headings.find((entry) => cleanText(entry.textContent).toLowerCase() === expected);
    const container = heading?.parentElement;
    if (!container) return "";

    const clone = container.cloneNode(true);
    clone.querySelector("h3")?.remove();
    clone.querySelectorAll("button, svg, .infotip, .infotip__overlay").forEach((element) => element.remove());
    return cleanText(clone.textContent || clone.innerText || "");
  }

  function encodeBase64UrlJson(value) {
    try {
      const json = JSON.stringify(value);
      const bytes = new TextEncoder().encode(json);
      let binary = "";
      bytes.forEach((byte) => {
        binary += String.fromCharCode(byte);
      });
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    } catch (error) {
      console.warn("Could not encode eBay order snapshot:", error);
      return "";
    }
  }

  function getSingleLabelOrderNumber() {
    const fromPath = normalizeOrderNumber(window.location.pathname);
    if (fromPath) return fromPath;

    const packingSlip = document.querySelector('[data-testid="packingslip-new-tab-link"]');
    const fromPackingSlip = normalizeOrderNumber(packingSlip?.getAttribute("href"));
    if (fromPackingSlip) return fromPackingSlip;

    const surveyLink = document.querySelector('a[href*="ctx_order_id="]');
    const fromSurvey = normalizeOrderNumber(surveyLink?.getAttribute("href"));
    if (fromSurvey) return fromSurvey;

    return "";
  }

  function isSingleLabelPage() {
    return Boolean(
      getSingleLabelOrderNumber()
      && document.querySelector('[data-testid="order-page"]')
      && document.querySelector('[data-testid="ship-to-address"]')
    );
  }

  function getSelectedServiceSnapshot() {
    const row = document.querySelector('input[name="service"]:checked')?.closest('[data-testid="service"]');
    if (!row) return {};
    return {
      name: getText('[data-testid="service-title"]', row),
      price: getText('[data-testid="service-price"]', row),
      estimatedDelivery: getText('[data-testid="service-estimated-delivery-date"]', row),
      includedCoverage: getText('[data-testid="included-compensation-amount"]', row),
      qrCode: getText('[data-testid="service-qr-code-availability"]', row),
    };
  }

  function getPackageSnapshot() {
    return {
      weightPounds: document.querySelector('input[aria-label="Package weight in pounds"]')?.value || "",
      weightOunces: document.querySelector('input[aria-label="Package weight in ounces"]')?.value || "",
      lengthInches: document.querySelector('input[aria-label="Package length in inches"]')?.value || "",
      widthInches: document.querySelector('input[aria-label="Package width in inches"]')?.value || "",
      heightInches: document.querySelector('input[aria-label="Package height in inches"]')?.value || "",
    };
  }

  function getSingleLabelOrderSnapshot(orderNumber) {
    const orderSection = document.querySelector('section[aria-label="Order information"]');
    const moneyMatches = String(orderSection?.innerText || "").match(/\$\d[\d,]*(?:\.\d{2})?/g) || [];
    const shipToAddressLines = getTextLines("#shipToAddress");
    const shipFromAddressLines = getTextLines('[data-testid="ship-from-address"] [data-testid="address-info"]');
    const totalCost = document.querySelector('[data-testid="total-cost"] span:last-child')?.textContent;

    return {
      source: "ebay-single-label-page",
      capturedAt: new Date().toISOString(),
      orderNumber,
      buyerUsername: cleanText(document.querySelector('a[href*="/usr/"]')?.textContent),
      itemCount: cleanText(orderSection?.querySelector("button.fake-link")?.textContent),
      itemSubtotal: moneyMatches[0] || "",
      orderValue: getValueByHeading("Order value"),
      shippingPaid: getValueByHeading("Shipping paid"),
      selectedShipping: getValueByHeading("Selected"),
      expectedDelivery: getValueByHeading("Expected"),
      shipToAddressLines,
      shipToName: shipToAddressLines[0] || "",
      shipToCityStateZip: shipToAddressLines[shipToAddressLines.length - 1] || "",
      shipFromAddressLines,
      packingSlipUrl: document.querySelector('[data-testid="packingslip-new-tab-link"]')?.href || "",
      productImageUrl: document.querySelector('[data-testid="product-image-wrapper"] img')?.src || "",
      authenticGuarantee: Boolean(document.querySelector('[data-testid="auth-guaranteed-badge"]')),
      selectedService: getSelectedServiceSnapshot(),
      package: getPackageSnapshot(),
      labelTotalCost: cleanText(totalCost),
    };
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

  function buildOgUrl(appUrl, orderNumbers, orderSnapshot = null) {
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
    if (orderSnapshot) {
      const encoded = encodeBase64UrlJson(orderSnapshot);
      if (encoded) {
        url.searchParams.set("ebayOrderPage", "single");
        url.searchParams.set("ebayOrderSnapshot", encoded);
      }
    } else {
      url.searchParams.delete("ebayOrderPage");
      url.searchParams.delete("ebayOrderSnapshot");
    }
    return url.toString();
  }

  async function openInOg(orderNumbers, orderSnapshot = null) {
    const clean = [...new Set(orderNumbers.map(normalizeOrderNumber).filter(Boolean))];
    if (!clean.length) return;

    const appUrl = await getConfiguredAppUrl();
    if (!appUrl) {
      window.alert("OG Pending Orders URL was not set. Click the extension icon to set it.");
      return;
    }
    window.open(buildOgUrl(appUrl, clean, orderSnapshot), "_blank", "noopener,noreferrer");
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

      #${FLOATING_ID},
      #${SINGLE_ORDER_ID} {
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

      #${SINGLE_ORDER_ID} {
        border-color: #0b72e7;
        background: #edf5ff;
        color: #0759b8;
      }

      #${SINGLE_ORDER_ID}:hover {
        background: #dcebff;
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

  function injectSingleOrderButton() {
    const orderNumber = getSingleLabelOrderNumber();
    let button = document.getElementById(SINGLE_ORDER_ID);

    if (!isSingleLabelPage()) {
      button?.remove();
      return;
    }

    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.id = SINGLE_ORDER_ID;
      button.addEventListener("click", () => {
        const currentOrderNumber = getSingleLabelOrderNumber();
        const snapshot = getSingleLabelOrderSnapshot(currentOrderNumber);
        openInOg([currentOrderNumber], snapshot);
      });
      document.body.appendChild(button);
    }

    button.textContent = "Open order in OG";
    button.title = `Extract ${orderNumber} from this eBay label page and open it in OG Pending Orders`;
  }

  function injectOgControls() {
    ensureStyles();
    injectRowButtons();
    injectFloatingButton();
    injectSingleOrderButton();
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
