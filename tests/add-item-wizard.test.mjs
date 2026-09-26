import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { test, before, after } from "node:test";
import { chromium, webkit } from "@playwright/test";

const root = new URL("../", import.meta.url);
let server, browser, origin;

// Exercise the real page and save handler without touching inventory or hardware.
const mockServices = () => {
  window.testWrites = [];
  window.testGeneration = [];
  window.alert = () => {};
  window.QRCode = { toCanvas: (_canvas, _url, _options, callback) => callback?.() };
  window.testBarcodeRenders = [];
  window.JsBarcode = (_canvas, code) => window.testBarcodeRenders.push(code);
  window.addItemBulkModule = { setupBulkModalOpeners() {} };
  window.dymoModule = {
    setupGenerateDymoButtonListener() {},
    barcodeExists: async () => false,
    generateDymoLabelFromForm: async () => {
      window.latestDymoXml = "<label/>";
      window.latestDymoUrl = "labels/test.dymo";
      window.latestDymoBarcode = document.getElementById("scanned-barcode").value;
    },
    clearPendingDymoLabel() {},
  };
  const user = { id: "test-user", email: "test@example.invalid" };
  window.supabase = {
    auth: { getUser: async () => ({ data: { user } }), getSession: async () => ({ data: { session: { user } } }) },
    functions: { invoke: async (name, options) => {
      if (name === "generate-inventory-copy") {
        window.testGeneration.push(options.body);
        if (window.testGenerationHold) await new Promise((resolve) => { window.testReleaseGeneration = resolve; });
        return { data: { mode: "openai", generatedTitle: "Watch copy", generatedDescription: "Reviewed watch copy", watchReference: {
          status: "found", matchedName: "Rolex Datejust", matchedReference: options.body.watchDetails?.model,
          facts: [{ label: "Case diameter", value: "36 mm", sourceUrl: "https://www.rolex.com/watches/datejust", sourceTitle: "Rolex specifications" }],
          warnings: ["Confirm the dial and bracelet variant."],
        } } };
      }
      return { data: { images: [] } };
    } },
    storage: { from: () => ({
      list: async () => ({ data: [] }),
      createSignedUrl: async () => ({ data: { signedUrl: `${location.origin}/test-photo.svg` } }),
    }) },
    from(table) {
      let operation = "select", payload, single = false;
      const query = {
        select() { return query; }, eq() { return query; }, neq() { return query; }, order() { return query; },
        limit() { return query; }, in() { return query; }, not() { return query; },
        single() { single = true; return query; }, maybeSingle() { single = true; return query; },
        insert(data) { operation = "insert"; payload = data; return query; },
        upsert(data) { operation = "upsert"; payload = data; return query; },
        delete() { operation = "delete"; return query; },
        then(resolve, reject) {
          let result = { data: single ? null : [] };
          if (table === "employees") result.data = { role: "admin", active: true };
          if (table === "item_types" && operation === "select") result.data = (window.testCategories || []).map(category => ({ categories: [category] }));
          if (table === "add_item_drafts") {
            if (operation === "upsert") localStorage.setItem("test-draft", JSON.stringify(payload));
            if (operation === "delete") localStorage.removeItem("test-draft");
            if (operation === "select") result.data = JSON.parse(localStorage.getItem("test-draft") || "null");
          }
          if (table === "item_types" && operation === "insert") {
            window.testWrites.push(payload);
            // Stop here: the payload is inspected, never sent to a real database.
            result = { data: null, error: { message: "Test save intercepted" } };
          }
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return query;
    },
  };
};

before(async () => {
  server = createServer(async (req, res) => {
    const name = req.url.split("?")[0].slice(1) || "add-item.html";
    if (!/^[a-z0-9.-]+$/i.test(name)) { res.writeHead(404).end(); return; }
    if (name === "test-photo.svg") {
      res.setHeader("Content-Type", "image/svg+xml");
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="silver"/></svg>');
      return;
    }
    try {
      let content = await readFile(new URL(name, root), "utf8");
      if (name.endsWith("html")) {
        content = content.replace(/<script src="([^"]+)"(?: defer)?><\/script>/g, (tag, src) =>
          ["admin-nav.js", "additem-wizard.js", "additem.js", "additem-assisted.js", "barcode-scanner.js"].includes(src.split("?")[0]) ? tag : "");
        content = content.replace("<head>", `<head><script>(${mockServices.toString()})();</script>`);
      }
      res.setHeader("Content-Type", name.endsWith("css") ? "text/css" : name.endsWith("js") ? "text/javascript" : "text/html");
      res.end(content);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await (process.env.INVSTO_ITEM_BROWSER === "webkit" ? webkit : chromium).launch({ headless: true });
});
after(async () => { await browser?.close(); await new Promise((resolve) => server?.close(resolve)); });

async function pageFor(t, viewport = { width: 1365, height: 1000 }) {
  const page = await browser.newPage({ viewport, isMobile: viewport.width <= 900, hasTouch: viewport.width <= 900 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.goto(`${origin}/add-item.html`);
  await page.waitForFunction(() => window.addItemAssistedModule && document.body.classList.contains("admin-unified-nav"));
  await page.waitForFunction(() => document.getElementById("assisted-generate-status").textContent.includes("Choose an AI image"));
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  return page;
}
const step = (page) => page.locator("[data-item-step]:visible").getAttribute("data-item-step");
const next = (page) => page.locator("#item-step-next").click();
async function category(page, text) {
  await page.locator("#category-dropdown-toggle").click();
  await page.locator("#category-dropdown-search").fill(text);
  await page.locator("#category-dropdown-menu .new-entry").click();
}

test("jewelry progresses one block at a time, keeps edits, and validates before saving", async (t) => {
  const page = await pageFor(t);
  assert.equal(await step(page), "information");
  await next(page);
  assert.equal(await step(page), "information");
  await page.locator("#weight").fill("12.5");
  await category(page, "Bracelets");
  await next(page);
  assert.equal(await step(page), "photos");
  await page.locator("#workflow-tab-manual").click();
  await next(page);
  assert.equal(await step(page), "description");
  assert.equal(await page.locator("#item-ai-copy").isVisible(), false);
  await page.locator("#title").fill("Silver bracelet");
  await page.locator("#description").fill("Sterling silver bracelet.");
  await page.locator("#item-step-back").click();
  await next(page);
  assert.equal(await page.locator("#title").inputValue(), "Silver bracelet");
  await next(page);
  assert.equal(await step(page), "pricing");
  assert.equal(await page.locator("#cost").inputValue(), "87.50");
  for (let i = 0; i < 4; i++) await next(page);
  assert.equal(await step(page), "review");
  assert.equal(await page.locator("[data-item-step]:visible").count(), 1);
  await page.locator('[data-item-step-target="description"]').click();
  await page.locator("#title").fill("");
  await page.locator('[data-item-step-target="review"]').click();
  assert.equal(await step(page), "description");
  assert.equal(await page.evaluate(() => window.testWrites.length), 0);
  await page.locator("#title").fill("Silver bracelet");
  await page.locator('[data-item-step-target="review"]').click();
  await page.evaluate(() => { document.getElementById("weight").value = ""; });
  await page.locator('#item-step-review button[type="submit"]').click();
  assert.equal(await step(page), "information");
  assert.equal(await page.evaluate(() => window.testWrites.length), 0);
});

test("watch details survive back, refresh, price changes and reach the save payload", async (t) => {
  const page = await pageFor(t);
  await page.locator('[name="item-kind"][value="watch"]').check();
  await page.locator("#watch-name").fill("Rolex Datejust");
  await page.locator("#watch-brand").fill("Rolex");
  await page.locator("#watch-department").selectOption("Unisex Adults");
  await page.locator("#watch-condition").selectOption("USED_EXCELLENT");
  await page.locator("#watch-model").fill("126233");
  await page.locator("#watch-materials").fill("Steel case; 18K gold bezel; steel and gold bracelet");
  await page.locator("#watch-modifications").fill("Aftermarket diamond bezel");
  await category(page, "Watches");
  await next(page);
  await next(page);
  assert.equal(await page.locator("#title").inputValue(), "Rolex Datejust 126233");
  await next(page);
  assert.equal(await page.locator("#auto-cost-checkbox").isChecked(), false);
  assert.equal(await page.locator("#auto-cost-checkbox").isDisabled(), true);
  await page.locator("#cost").fill("4000");
  await page.locator("#sale-price").fill("6500");
  await page.locator("#minimum-sale-price").fill("4700");
  await page.locator("#cost").fill("4100");
  assert.equal(await page.locator("#sale-price").inputValue(), "6500");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("test-draft") || "null")?.payload?.mainFields?.cost === "4100");
  await page.reload();
  await page.waitForFunction(() => window.addItemWizard?.isWatch());
  assert.equal(await step(page), "pricing");
  assert.equal(await page.locator("#watch-modifications").inputValue(), "Aftermarket diamond bezel");
  assert.equal(await page.locator("#sale-price").inputValue(), "6500");
  for (let i = 0; i < 4; i++) await next(page);
  assert.equal(await step(page), "review");
  assert.match(await page.locator("#item-review-summary").innerText(), /Aftermarket diamond bezel/);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForFunction(() => window.testWrites.length === 1);
  const saved = await page.evaluate(() => window.testWrites[0]);
  assert.equal(saved.watch_details.name, "Rolex Datejust");
  assert.equal(saved.watch_details.model, "126233");
  assert.equal(saved.watch_details.modifications, "Aftermarket diamond bezel");
  assert.match(saved.description, /Steel case; 18K gold bezel/);
  assert.equal(saved.metal, null);
  assert.equal(saved.purity_basis_points, null);
  assert.equal(saved.price_per_weight, null);
  assert.equal(saved.weight, null);
  assert.equal(saved.sale_price, 6500);
  assert.equal(saved.minimum_sale_price, 4700);
  assert.equal(saved.ebay_condition, "USED_EXCELLENT");
  assert.deepEqual(saved.ebay_aspects.Brand, ["Rolex"]);
  assert.deepEqual(saved.ebay_aspects.Department, ["Unisex Adults"]);
  assert.deepEqual(saved.ebay_aspects["Reference Number"], ["126233"]);
  assert.equal(saved.ebay_category_id, "31387");
  assert.equal(saved.ebay_aspects.Metal, undefined);
  await page.evaluate(() => { document.getElementById("add-item-form").reset(); document.dispatchEvent(new Event("add-item-form:reset")); });
  assert.equal(await step(page), "information");
  assert.equal(await page.locator("#watch-name").inputValue(), "");
  assert.equal(await page.locator('[name="item-kind"][value="jewelry"]').isChecked(), true);
});

test("watch mode can switch back without losing details or leaking them into jewelry", async (t) => {
  const page = await pageFor(t);
  await page.locator('[name="item-kind"][value="watch"]').check();
  await page.locator("#watch-name").fill("Custom watch");
  await category(page, "Watches");
  await next(page);
  await page.locator("#item-step-back").click();
  await page.locator("#watch-model").fill("M2");
  await next(page);
  assert.equal(await page.locator("#title").inputValue(), "Custom watch M2");
  await page.locator("#item-step-back").click();
  await page.locator('[name="item-kind"][value="jewelry"]').check();
  assert.equal(await page.evaluate(() => window.addItemWizard.getWatchDetails()), null);
  assert.equal(await page.locator("#auto-cost-checkbox").isChecked(), true);
  await page.locator('[name="item-kind"][value="watch"]').check();
  assert.equal(await page.locator("#watch-name").inputValue(), "Custom watch");
});

test("mobile watch form has one active step, no horizontal overflow and usable navigation", async (t) => {
  const page = await pageFor(t, { width: 390, height: 844 });
  await page.locator('[name="item-kind"][value="watch"]').check();
  await page.locator("#watch-name").fill("Custom watch");
  assert.equal(await page.locator("[data-item-step]:visible").count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.equal(await page.evaluate(() => {
    const navigation = document.querySelector(".item-step-navigation");
    const section = document.querySelector("[data-item-step]:not([hidden])");
    return navigation.getBoundingClientRect().top >= section.getBoundingClientRect().bottom;
  }), true, "Navigation follows the form instead of covering fields");
  await category(page, "Watches");
  await next(page);
  assert.equal(await step(page), "photos");
  await mkdir(new URL("test-results/", root), { recursive: true });
  await page.screenshot({ path: new URL("test-results/add-item-mobile.png", root).pathname.replace(/^\/(\w:)/, "$1"), fullPage: true });
  await page.setViewportSize({ width: 1365, height: 1000 });
  await page.screenshot({ path: new URL("test-results/add-item-desktop.png", root).pathname.replace(/^\/(\w:)/, "$1"), fullPage: true });
});

test("photo selection survives navigation and watch facts reach assisted generation", async (t) => {
  const page = await pageFor(t, { width: 390, height: 744 });
  await page.evaluate(() => localStorage.setItem("test-draft", JSON.stringify({ payload: {
    activeWorkflow: "assisted",
    wizard: { step: "photos", furthest: 1, itemKind: "watch", watchDetails: { name: "Custom watch", model: "M1", materials: "Steel case, leather strap", modifications: "Replacement dial" } },
    mainFields: { category: "Watches", title: "Custom watch", ebaySyncEnabled: false },
    assistedFields: {},
    recentUploadedImages: [{ path: "test.jpg", storageBucket: "InventoryUpload", name: "Watch photo", mimeType: "image/jpeg" }],
    aiSelectedUploadedImagePath: "test.jpg", saveSelectedUploadedImagePaths: ["test.jpg"],
  } })));
  await page.reload();
  await page.waitForFunction(() => window.addItemAssistedModule?.getAISelectedUploadedImagePath() === "test.jpg");
  assert.equal(await step(page), "photos");
  assert.equal(await page.locator("#assisted-selected-image-preview").isVisible(), true);
  await assertPhoneLayout(page, 'selected photo on phone');
  await page.getByText('Edit selected photo', { exact: true }).click();
  await assertPhoneLayout(page, 'expanded photo tools on phone');
  await page.locator('#assisted-open-image-editor').click();
  await page.waitForFunction(() => !document.querySelector('#assisted-image-editor-modal').classList.contains('hidden'));
  const editorBounds = await page.locator('.assisted-editor-dialog').boundingBox();
  assert.ok(editorBounds.x >= 0 && editorBounds.x + editorBounds.width <= 390);
  await page.locator('#assisted-editor-save').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => {
    const button = document.querySelector('#assisted-editor-save'), r = button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  }), true, 'crop action can be reached on phone');
  await page.locator('#assisted-editor-close').click();
  await page.screenshot({ path: new URL("test-results/add-item-photos.png", root).pathname.replace(/^\/(\w:)/, "$1"), fullPage: true });
  await next(page);
  await page.locator("#item-step-back").click();
  assert.equal(await page.evaluate(() => window.addItemAssistedModule.getSelectedUploadedImagesForSave().length), 1);
  await next(page);
  await page.locator("#item-ai-copy > summary").click();
  await page.locator("#assisted-generate-copy").click();
  await page.waitForFunction(() => window.testGeneration.length === 1);
  const payload = await page.evaluate(() => window.testGeneration[0]);
  assert.equal(payload.imagePath, "test.jpg");
  assert.equal(payload.watchDetails.modifications, "Replacement dial");
  assert.equal(payload.watchDetails.materials, "Steel case, leather strap");
  assert.equal(payload.material, "");
  assert.equal(payload.purity, "");
  assert.equal(payload.weight, null);
  await page.locator("#assisted-apply-copy").click();
  assert.equal(await page.locator("#title").inputValue(), "Watch copy");
  assert.equal(await page.locator("#description").inputValue(), "Reviewed watch copy");
  await page.evaluate(() => {
    const draft = JSON.parse(localStorage.getItem("test-draft"));
    draft.payload.wizard.step = "review";
    draft.payload.wizard.furthest = 7;
    localStorage.setItem("test-draft", JSON.stringify(draft));
  });
  await page.reload();
  await page.waitForFunction(() => window.addItemAssistedModule?.getAISelectedUploadedImagePath() === "test.jpg");
  assert.equal(await step(page), "review");
  assert.match(await page.locator("#item-review-summary").innerText(), /1 selected/);
});

test("watch reference lookup needs no photo, survives draft restore, saves sources and invalidates changed details", async (t) => {
  const page = await pageFor(t);
  await page.locator('[name="item-kind"][value="watch"]').check();
  await page.locator("#watch-name").fill("Rolex");
  await page.locator("#watch-model").fill("126233");
  await page.locator("#watch-modifications").fill("Aftermarket diamond bezel");
  await category(page, "Watches");
  await next(page);
  await page.locator("#workflow-tab-manual").click();
  await next(page);
  assert.equal(await page.locator("#item-ai-copy").isVisible(), true);
  await page.locator("#item-ai-copy > summary").click();
  await page.locator("#assisted-generate-copy").click();
  await page.waitForFunction(() => document.querySelector("#watch-reference-results a"));
  assert.equal(await page.locator("#watch-reference-results a").getAttribute("href"), "https://www.rolex.com/watches/datejust");
  assert.match(await page.locator("#watch-reference-results").innerText(), /Confirm the dial/);
  assert.equal(await page.evaluate(() => window.testGeneration[0].imagePath), "");
  await page.locator("#assisted-apply-copy").click();
  assert.equal(await page.locator("#description").inputValue(), "Reviewed watch copy");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("test-draft") || "null")?.payload?.assistedFields?.watchReference?.status === "found");
  await page.reload();
  await page.waitForFunction(() => window.addItemWizard?.getWatchDetails()?.referenceLookup?.status === "found");
  await page.locator("#item-ai-copy > summary").click();
  assert.equal(await page.locator("#assisted-apply-copy").isDisabled(), false);
  assert.equal(await page.locator("#watch-reference-results a").count(), 1);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: new URL("test-results/watch-reference-mobile.png", root).pathname.replace(/^\/(\w:)/, "$1"), fullPage: true });
  await next(page);
  await page.locator("#cost").fill("4000");
  await page.locator("#sale-price").fill("6500");
  for (let i = 0; i < 4; i++) await next(page);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForFunction(() => window.testWrites.length === 1);
  assert.equal(await page.evaluate(() => window.testWrites[0].watch_details.referenceLookup.facts[0].value), "36 mm");
  await page.locator('[data-item-step-target="information"]').click();
  await page.locator("#watch-model").fill("126234");
  assert.equal(await page.evaluate(() => window.addItemWizard.getWatchDetails().referenceLookup), undefined);
  await page.locator('[data-item-step-target="description"]').click();
  assert.equal(await page.locator("#assisted-apply-copy").isDisabled(), true);
  assert.equal(await page.locator("#watch-reference-results").isVisible(), false);
});

test("changing watch information during a lookup discards the outdated response", async (t) => {
  const page = await pageFor(t);
  await page.locator('[name="item-kind"][value="watch"]').check();
  await page.locator("#watch-name").fill("Rolex");
  await page.locator("#watch-model").fill("126233");
  await category(page, "Watches");
  await next(page);
  await next(page);
  await page.locator("#item-ai-copy > summary").click();
  await page.evaluate(() => { window.testGenerationHold = true; });
  await page.locator("#assisted-generate-copy").click();
  await page.waitForFunction(() => window.testReleaseGeneration);
  await page.locator('[data-item-step-target="information"]').click();
  await page.locator("#watch-modifications").fill("New replacement strap");
  await page.evaluate(() => window.testReleaseGeneration());
  await page.waitForFunction(() => !document.getElementById("assisted-generate-copy").disabled);
  assert.equal(await page.locator("#assisted-generated-description").inputValue(), "");
  assert.equal(await page.evaluate(() => window.addItemWizard.getWatchDetails().referenceLookup), undefined);
  assert.match(await page.locator("#assisted-generate-status").textContent(), /Details changed during generation/);
  await page.locator('[data-item-step-target="description"]').click();
  await page.locator("#assisted-generate-copy").click();
  await page.waitForFunction(() => window.testGeneration.length === 2);
  await page.evaluate(() => {
    document.getElementById("add-item-form").reset();
    document.dispatchEvent(new Event("add-item-form:reset"));
    window.testReleaseGeneration();
  });
  assert.equal(await page.locator("#assisted-generate-copy").isDisabled(), false);
  assert.equal(await page.locator("#assisted-generated-description").inputValue(), "");
});

test("coin intake survives refresh and saves year, condition and fineness with direct pricing", async (t) => {
  const page = await pageFor(t);
  await page.locator('[name="item-kind"][value="coin"]').check();
  await page.locator("#coin-name").fill("Morgan dollar");
  await page.locator("#coin-year").fill("1881");
  await page.locator("#coin-country").fill("United States");
  await page.locator("#coin-denomination").fill("$1");
  await page.locator("#coin-mint").fill("S");
  await page.locator("#coin-metal").selectOption("Silver");
  await page.locator("#coin-fineness").fill("900");
  await page.locator("#coin-condition").fill("Circulated; light scratches");
  await category(page, "Collector coins");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: new URL("test-results/add-item-coin-mobile.png", root).pathname.replace(/^\/(\w:)/, "$1"), fullPage: true });
  await page.setViewportSize({ width: 1365, height: 1000 });
  await next(page);
  await page.locator("#workflow-tab-manual").click();
  await next(page);
  assert.equal(await page.locator("#title").inputValue(), "1881 Morgan dollar S");
  await page.locator("#item-ai-copy > summary").click();
  await page.locator("#assisted-generate-copy").click();
  await page.waitForFunction(() => window.testGeneration.length === 1);
  const payload = await page.evaluate(() => window.testGeneration[0]);
  assert.equal(payload.itemKind, "coin");
  assert.equal(payload.imagePath, "");
  assert.equal(payload.purity, "900");
  assert.equal(payload.coinDetails.condition, "Circulated; light scratches");
  assert.equal(payload.watchDetails, null);
  assert.equal(await page.locator("#watch-reference-results").isVisible(), false);
  await next(page);
  await page.locator("#cost").fill("40");
  await page.locator("#sale-price").fill("90");
  await page.locator("#minimum-sale-price").fill("55");
  await page.locator("#cost").fill("45");
  assert.equal(await page.locator("#sale-price").inputValue(), "90");
  assert.equal(await page.locator("#auto-cost-checkbox").isDisabled(), true);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("test-draft") || "null")?.payload?.mainFields?.cost === "45");
  await page.reload();
  await page.waitForFunction(() => window.addItemWizard?.isCoin());
  assert.equal(await page.locator("#coin-condition").inputValue(), "Circulated; light scratches");
  assert.equal(await step(page), "pricing");
  for (let i = 0; i < 4; i++) await next(page);
  assert.match(await page.locator("#item-review-summary").innerText(), /Coin details:[\s\S]*1881[\s\S]*900[\s\S]*Circulated/);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForFunction(() => window.testWrites.length === 1);
  const saved = await page.evaluate(() => window.testWrites[0]);
  assert.equal(saved.coin_details.name, "Morgan dollar");
  assert.equal(saved.coin_details.year, "1881");
  assert.equal(saved.metal, "silver");
  assert.equal(saved.purity_basis_points, 9000);
  assert.equal(saved.weight, null);
  assert.equal(saved.price_per_weight, null);
  assert.equal(saved.sale_price, 90);
  assert.equal(saved.minimum_sale_price, 55);
  assert.equal(saved.stone_type, null);
  assert.equal(saved.ebay_sync_enabled, false);
  assert.equal(saved.ebay_condition, null);
  assert.equal(saved.ebay_category_id, null);
  assert.deepEqual(saved.ebay_aspects, {});
  assert.equal(saved.watch_details, undefined);
});

test("coin grading, unknown purity, mode switches and reset keep unrelated data separate", async (t) => {
  const page = await pageFor(t);
  await page.locator('[name="item-kind"][value="coin"]').check();
  await page.locator("#coin-name").fill("Gold collector coin");
  await category(page, "Coins");
  await page.locator("#coin-metal").selectOption("Gold");
  await page.locator("#coin-fineness").fill("1001");
  await next(page);
  assert.equal(await step(page), "information");
  await page.locator("#coin-fineness").fill("916.7");
  await page.locator("#coin-fields details").first().locator("summary").click();
  await page.locator("#coin-gradingStatus").selectOption("certified");
  await page.locator("#coin-grade").fill("MS 65");
  await next(page);
  assert.equal(await step(page), "information");
  await page.locator("#coin-gradingService").fill("NGC");
  await page.locator("#coin-certNumber").fill("001234-001");
  await next(page);
  await next(page);
  assert.match(await page.locator("#title").inputValue(), /NGC MS 65/);
  assert.match(await page.evaluate(() => window.addItemWizard.descriptionForSave()), /001234-001/);
  await page.locator('[data-item-step-target="information"]').click();
  await page.locator("#coin-gradingStatus").selectOption("self-assessed");
  assert.equal(await page.locator("#coin-gradingService").isDisabled(), true);
  assert.doesNotMatch(await page.evaluate(() => window.addItemWizard.descriptionForSave()), /NGC|001234/);
  await page.locator("#coin-metal").selectOption("Plated / clad");
  assert.equal(await page.evaluate(() => window.addItemWizard.getCoinDetails().fineness), "");
  await page.locator('[name="item-kind"][value="watch"]').check();
  assert.equal(await page.evaluate(() => window.addItemWizard.getCoinDetails()), null);
  await page.locator("#watch-name").fill("Test watch");
  await next(page);
  assert.equal(await page.locator("#title").inputValue(), "Test watch");
  await page.locator('[data-item-step-target="information"]').click();
  await page.locator('[name="item-kind"][value="jewelry"]').check();
  assert.equal(await page.locator("#auto-cost-checkbox").isDisabled(), false);
  await page.locator('[name="item-kind"][value="coin"]').check();
  assert.equal(await page.locator("#coin-year").inputValue(), "");
  assert.equal(await page.locator("#coin-grade").inputValue(), "MS 65");
  await page.locator("#coin-gradingStatus").selectOption("ungraded");
  assert.equal(await page.evaluate(() => window.addItemWizard.getCoinDetails().grade), "");
  await page.evaluate(() => { document.getElementById("add-item-form").reset(); document.dispatchEvent(new Event("add-item-form:reset")); });
  assert.equal(await page.locator("#coin-name").inputValue(), "");
  assert.equal(await page.locator("#coin-grade").isDisabled(), true);
  assert.equal(await page.locator("#coin-gradingService").evaluate((input) => input.required), false);
});

test("camera barcode updates the new item label and saved barcode on mobile", async t => {
  const page = await pageFor(t, { width: 390, height: 844 });
  await page.locator('[name="item-kind"][value="coin"]').check();
  await page.locator('#coin-name').fill('Collector coin');
  await category(page, 'Coins');
  await next(page);
  await page.locator('#workflow-tab-manual').click();
  await next(page);
  await next(page);
  await page.locator('#cost').fill('40');
  await page.locator('#sale-price').fill('80');
  await next(page);
  assert.equal(await step(page), 'labels');
  await page.evaluate(() => {
    pendingStockAssignments[document.getElementById('scanned-barcode').value] = { location_id: 'test-tray', quantity: 3 };
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100;
      canvas.getContext('2d').fillRect(0, 0, 100, 100);
      const stream = canvas.captureStream(15);
      setInterval(() => stream.getVideoTracks()[0].requestFrame(), 60);
      return stream;
    };
    navigator.mediaDevices.enumerateDevices = async () => [];
    window.ZXingWASM = {
      prepareZXingModule: async () => {},
      readBarcodes: () => new Promise(resolve => {
        window.testScan = code => resolve([{ text: code, isValid: true, error: '' }]);
      }),
    };
  });
  await page.locator('[data-scan-target="scanned-barcode"]').click();
  await page.waitForFunction(() => window.testScan);
  await page.evaluate(() => window.testScan('000-COIN-27'));
  await page.locator('[data-camera="use"]').click();
  assert.equal(await page.locator('#scanned-barcode').inputValue(), '000-COIN-27');
  assert.equal(await page.evaluate(() => window.testBarcodeRenders.at(-1)), '000-COIN-27');
  assert.deepEqual(await page.evaluate(() => pendingStockAssignments['000-COIN-27']), { location_id: 'test-tray', quantity: 3 });
  await page.waitForFunction(() => window.latestDymoBarcode === '000-COIN-27');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: new URL('test-results/add-item-camera-labels-mobile.png', root).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
  await next(page);
  await next(page);
  await next(page);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForFunction(() => window.testWrites.length === 1);
  assert.equal(await page.evaluate(() => window.testWrites[0].barcode), '000-COIN-27');
});


async function assertPhoneLayout(page, label) {
  const problems = await page.evaluate(() => {
    const width = window.innerWidth;
    const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
    const outside = [...document.querySelectorAll('.header-actions, .item-progress button, [data-item-step]:not([hidden]) input:not([type=hidden]), [data-item-step]:not([hidden]) select, [data-item-step]:not([hidden]) textarea, [data-item-step]:not([hidden]) button')]
      .filter(visible).filter(element => { const r = element.getBoundingClientRect(); return r.left < -1 || r.right > width + 1; })
      .map(element => element.id || element.className);
    const smallText = [...document.querySelectorAll('[data-item-step]:not([hidden]) input:not([type=checkbox]):not([type=radio]), [data-item-step]:not([hidden]) select, [data-item-step]:not([hidden]) textarea')]
      .filter(visible).filter(element => parseFloat(getComputedStyle(element).fontSize) < 16).map(element => element.id);
    return { overflow: document.documentElement.scrollWidth > width, outside, smallText };
  });
  assert.deepEqual(problems, { overflow: false, outside: [], smallText: [] }, label);
}

test('phone category menu stays above navigation, scrolls every option, filters, and creates categories', async t => {
  const page = await pageFor(t, { width: 390, height: 744 });
  await page.locator('[name="item-kind"][value="watch"]').check();
  await page.locator('#watch-name').fill('Test watch');
  await page.evaluate(() => { window.testCategories = ['bracelets', 'chains', 'necklace', 'pendants', 'testcard', ...Array.from({ length: 25 }, (_, i) => `Watch category ${String(i).padStart(2, '0')}`)]; });
  await page.locator('#category-dropdown-toggle').click();
  const menu = page.locator('#category-dropdown-menu');
  await page.waitForFunction(() => document.querySelector('#category-dropdown-menu').classList.contains('show'));
  assert.equal(await page.locator('#category-dropdown-toggle').getAttribute('aria-expanded'), 'true');
  const bounds = await menu.boundingBox(), nav = await page.locator('.item-step-navigation').boundingBox();
  assert.ok(bounds.y + bounds.height <= nav.y, 'menu pushes footer down');
  const last = menu.locator('.dropdown-option').last();
  await last.scrollIntoViewIfNeeded();
  await mkdir(new URL('test-results/', root), { recursive: true });
  await page.screenshot({ path: new URL('test-results/add-item-category-phone.png', root).pathname.replace(/^\/(\w:)/, '$1') });
  await last.click();
  assert.equal(await page.locator('#category').inputValue(), 'Watch category 24');
  await page.locator('#category-dropdown-toggle').click();
  await page.locator('#category-dropdown-search').fill('chains');
  assert.equal(await menu.locator('.dropdown-option').count(), 1);
  await menu.locator('.dropdown-option').click();
  assert.equal(await page.locator('#category').inputValue(), 'chains');
  await page.locator('#category-dropdown-toggle').click();
  await page.locator('#category-dropdown-search').fill('Custom <watch> category');
  await menu.locator('.new-entry').click();
  assert.equal(await page.locator('#category').inputValue(), 'Custom <watch> category');
  assert.equal(await menu.locator('watch').count(), 0, 'category names stay text');
  await page.locator('#category-dropdown-toggle').click();
  await page.locator('#category-dropdown-search').press('Escape');
  assert.equal(await menu.isVisible(), false);
  await next(page);
  assert.equal(await step(page), 'photos');
  await page.locator('#item-step-back').click();
  assert.equal(await page.locator('#category').inputValue(), 'Custom <watch> category');
});

test('all eight add-item steps fit small phones, portrait and landscape with jewelry, watches and coins', async t => {
  for (const [mode, viewport] of [['jewelry', { width: 320, height: 568 }], ['watch', { width: 390, height: 744 }], ['coin', { width: 844, height: 390 }]]) {
    const page = await pageFor(t, viewport);
    await page.locator(`[name="item-kind"][value="${mode}"]`).check();
    if (mode === 'watch') await page.locator('#watch-name').fill('Mobile watch');
    if (mode === 'coin') await page.locator('#coin-name').fill('Mobile collector coin');
    if (mode === 'jewelry') await page.locator('#weight').fill('10');
    await category(page, 'Mobile category');
    await assertPhoneLayout(page, `${mode}: information`);
    await next(page);
    await assertPhoneLayout(page, `${mode}: photos`);
    await next(page);
    await page.locator('#title').fill('Mobile inventory item');
    await page.locator('#description').fill('Phone entry');
    await assertPhoneLayout(page, `${mode}: description`);
    await next(page);
    if (mode !== 'jewelry') { await page.locator('#cost').fill('50'); await page.locator('#sale-price').fill('100'); }
    await assertPhoneLayout(page, `${mode}: pricing`);
    for (const name of ['labels', 'stock', 'marketplace', 'review']) {
      await next(page);
      assert.equal(await step(page), name);
      await assertPhoneLayout(page, `${mode}: ${name}`);
      if (name === 'marketplace') await page.locator('#ebay-sync-enabled').uncheck();
    }
    await page.locator('#item-step-review button[type=submit]').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => {
      const button = document.querySelector('#item-step-review button[type=submit]'), r = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }), true, 'save button is unobstructed');
    await page.screenshot({ path: new URL(`test-results/add-item-${mode}-phone-review.png`, root).pathname.replace(/^\/(\w:)/, '$1') });
  }
});

test('phone dialogs and dropdowns adapt to a keyboard-sized visible viewport', async t => {
  const page = await pageFor(t, { width: 390, height: 744 });
  await page.evaluate(() => {
    // Model Safari's visual viewport shrinking while its layout viewport stays tall.
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 340 });
    window.visualViewport.dispatchEvent(new Event('resize'));
    setupAddLocationModalListeners();
    document.querySelector('#modal-add-location').classList.remove('hidden');
    document.body.classList.add('modal-open');
  });
  await page.locator('#location-type-dropdown-toggle').click();
  const menu = page.locator('#location-type-dropdown-menu');
  await page.waitForFunction(() => document.querySelector('#location-type-dropdown-menu').classList.contains('show'));
  assert.ok((await menu.boundingBox()).height <= 188, 'list respects visible height');
  const dialog = page.locator('.modal-content-addlocation');
  assert.ok((await dialog.boundingBox()).height <= 316, 'dialog respects keyboard space');
  await page.locator('#location-notes').fill('Visible with the keyboard open');
  await page.locator('#btn-submit-location').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => {
    const button = document.querySelector('#btn-submit-location'), r = button.getBoundingClientRect();
    return r.bottom <= 340 && button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  }), true, 'entire dialog can scroll to its action buttons');
});


test("jewelry minimum and editable retail stay distinct, validate and restore from draft", async (t) => {
  const page = await pageFor(t);
  await page.locator("#weight").fill("10");
  await category(page, "Bracelets");
  await next(page); await next(page);
  await page.locator("#title").fill("Silver bracelet");
  await page.locator("#description").fill("Sterling bracelet");
  await next(page);
  await page.locator("#sale-price").fill("300");
  await page.locator("#minimum-sale-price").fill("400");
  await next(page);
  assert.equal(await step(page), "pricing");
  assert.match(await page.locator("#item-step-error").innerText(), /no|between/);
  await page.locator("#minimum-sale-price").fill("150");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#minimum-sale-price").scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: new URL("test-results/add-item-prices-mobile.png", root).pathname.replace(/^\/(\w:)/, "$1") });
  await page.setViewportSize({ width: 1365, height: 1000 });
  await page.locator("#cost").fill("100");
  assert.equal(await page.locator("#sale-price").inputValue(), "300");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("test-draft") || "null")?.payload?.mainFields?.minimumSalePrice === "150");
  await page.reload();
  await page.waitForFunction(() => document.getElementById("minimum-sale-price").value === "150");
  await page.locator("#cost").fill("110");
  assert.equal(await page.locator("#sale-price").inputValue(), "300");
  for (let i=0; i<4; i++) await next(page);
  assert.match(await page.locator("#item-review-summary").innerText(), /Minimum sale.*[\s\S]*150/);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForFunction(() => window.testWrites.length === 1);
  assert.equal(await page.evaluate(() => window.testWrites[0].minimum_sale_price), 150);
  assert.equal(await page.evaluate(() => window.testWrites[0].sale_price), 300);
});
