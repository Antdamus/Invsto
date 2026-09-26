import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { test, before, after } from "node:test";
import { chromium, webkit } from "@playwright/test";

const root = new URL("../", import.meta.url);
let server, browser, origin;
const coinMetadata = JSON.parse(await readFile(new URL("fixtures/coin-ebay-metadata.json", import.meta.url), "utf8"));

// Exercise the real page and save handler without touching inventory or hardware.
const mockServices = () => {
  window.testWrites = [];
  window.testGeneration = [];window.testUploads=[];window.testPrints=[];window.testLabelPrepares=[];window.testStockWrites=[];window.testLabelPreferences=[];
  window.alert = () => {};
  window.QRCode = { toCanvas: (_canvas, _url, _options, callback) => callback?.() };
  window.testBarcodeRenders = [];
  window.JsBarcode = (_canvas, code) => window.testBarcodeRenders.push(code);
  window.addItemBulkModule = { setupBulkModalOpeners() {},saveRegistryForItem:async()=>({skipped:true}) };
  window.dymoModule = {
    setupGenerateDymoButtonListener() {},
    barcodeExists: async code => !!window.testExistingItem && window.testExistingItem.barcode===code,
    prepareSavedItemLabel:async item=>{window.testLabelPrepares.push(item.barcode);if(window.testLabelFailure)throw new Error('Printer preparation unavailable');return {templateXml:`<label>${item.barcode}</label>`,labelPath:`labels/${item.id}.dymo`};},
    printDymoLabelXml:async(xml,options)=>{window.testPrints.push({xml,...options});return {mode:'queued-download'};},
    generateDymoLabelFromForm: async () => {
      window.latestDymoXml = "<label/>";
      window.latestDymoUrl = "labels/test.dymo";
      window.latestDymoBarcode = document.getElementById("scanned-barcode").value;
    },
    clearPendingDymoLabel() {},
  };
  const user = { id: "test-user", email: "test@example.invalid" };
  window.supabase = {
    auth: { getUser: async () => ({ data: { user } }), getSession: async () => ({ data: { session: { user } } }), signInWithPassword:async()=>({data:{user}}) },
    functions: { invoke: async (name, options) => {
      if (name === "ebay-inventory-sync") {
        if (window.testCoinMetadataFailure) return { error: { message: "Metadata offline. Try again." } };
        if (options.body.action === "coinCategories") return { data: { ok:true, categories:Object.values(window.testCoinMetadata).map(data => data.category) } };
        if (options.body.action === "coinRequirements") {
          if (window.testCoinMetadataHold === options.body.categoryId) await new Promise(resolve => { window.testReleaseCoinMetadata=resolve; });
          return { data: window.testCoinMetadata[options.body.categoryId] };
        }
      }
      if(name==='process-inventory-image'){
        window.testUploads.push(options.body);
        if(window.testFailUploadAt===window.testUploads.length)return {error:{message:'Photo upload offline'}};
        return {data:{ok:true,path:`uploaded-${window.testUploads.length}.jpg`,name:'Photo',bucket:'InventoryUpload',previewUrl:`${location.origin}/test-photo.svg`,mimeType:'image/jpeg'}};
      }
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
    rpc:async(name,payload)=>{if(name==='set_item_label_print_preference')window.testLabelPreferences.push(payload);return {data:[]};},
    storage: { from: () => ({
      upload:async()=>window.testCopyFailure?{error:{message:'Storage offline'}}:{data:{}},
      download:async()=>({data:new Blob(['photo'])}),
      list: async () => ({ data: [] }),
      createSignedUrl: async () => ({ data: { signedUrl: `${location.origin}/test-photo.svg` } }),
    }) },
    from(table) {
      let operation = "select", payload, single = false, filters={};
      const query = {
        select() { return query; }, eq(key,value) { filters[key]=value;return query; }, neq() { return query; }, order() { return query; },
        limit() { return query; }, in() { return query; }, not() { return query; },
        single() { single = true; return query; }, maybeSingle() { single = true; return query; },
        insert(data) { operation = "insert"; payload = data; return query; },
        update(data){operation="update";payload=data;return query;},
        upsert(data) { operation = "upsert"; payload = data; return query; },
        delete() { operation = "delete"; return query; },
        then(resolve, reject) {
          let result = { data: single ? null : [] };
          if (table === 'locations') result.data=window.testLocations || [];
          if (table === "employees") result.data = { role: "admin", active: true };
          if (table === "item_types" && operation === "select") result.data = filters.barcode ? (window.testExistingItem?.barcode===filters.barcode?window.testExistingItem:null) : (window.testCategories || []).map(category => ({ categories: [category] }));
          if(table==='item_stock_locations' && operation==='insert'){window.testStockWrites.push(payload);if(window.testStockFailure)result.error={message:'Stock failed'};}
          if (table === "add_item_drafts") {
            if (operation === "upsert") localStorage.setItem("test-draft", JSON.stringify(payload));
            if (operation === "delete") localStorage.removeItem("test-draft");
            if (operation === "select") result.data = JSON.parse(localStorage.getItem("test-draft") || "null");
          }
          if (table === "item_types" && operation === "insert") {
            window.testWrites.push(payload);
            // Stop here: the payload is inspected, never sent to a real database.
            result = window.testSaveSuccess ? {data:[{...payload,id:`item-${window.testWrites.length}`}]} : { data: null, error: { message: "Test save intercepted" } };
          }
          if(table==='add_item_drafts' && operation==='select' && window.testDraftHold) {
            return new Promise(release=>{window.testReleaseDraft=release;}).then(()=>result).then(resolve,reject);
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
          ["admin-nav.js", "additem-layout.js", "additem-wizard.js", "additem.js", "additem-assisted.js", "additem-intake.js", "barcode-scanner.js"].includes(src.split("?")[0]) ? tag : "");
        content = content.replace("<head>", `<head><script>(${mockServices.toString()})();window.testCoinMetadata=${JSON.stringify(coinMetadata)};</script>`);
      }
      res.setHeader("Content-Type", name.endsWith("css") ? "text/css" : name.endsWith("js") ? "text/javascript" : "text/html");
      res.end(content);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await (process.env.INVSTO_ITEM_BROWSER === "webkit" ? webkit : chromium).launch({ headless: true });
});
after(async () => { server?.closeAllConnections(); await browser?.close(); await new Promise((resolve) => server?.close(resolve)); });

async function pageFor(t, viewport = { width: 1365, height: 1000 }) {
  const page = await browser.newPage({ viewport, isMobile: viewport.width <= 900, hasTouch: viewport.width <= 900 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.goto(`${origin}/add-item.html`);
  await page.waitForFunction(() => window.coinEbayForm && window.addItemAssistedModule && document.body.classList.contains("admin-unified-nav"));
  await page.waitForFunction(() => window.addItemIntake && document.getElementById("assisted-material").value);
  page.on("dialog",dialog=>dialog.dismiss());
  await page.locator("#item-auto-copy").uncheck();
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

async function prepareWatch(page,{auto=false}={}) {
 await page.locator('[name="item-kind"][value="watch"]').check();
 await page.locator('#item-auto-copy').setChecked(auto);
 await page.locator('#watch-brand').fill('Rolex');await page.locator('#watch-model').fill('126233');
 await next(page);await next(page);
 await page.locator('#cost').fill('4100');await page.locator('#minimum-sale-price').fill('4700');await page.locator('#sale-price').fill('6500');
 await next(page);
}
async function seed(page,{kind='coin',details={},main={},photos=[],step='information',assignStock=false}={}) {
 await page.evaluate(data=>localStorage.setItem('test-draft',JSON.stringify({payload:{activeWorkflow:'assisted',wizard:{version:2,step:data.step,furthest:6,itemKind:data.kind,autoCopy:false,assignStock:data.assignStock,coinDetails:{name:'Morgan dollar',year:'1881',metal:'Silver',fineness:'900',gradingStatus:'ungraded',...data.details},watchDetails:data.kind==='watch'?{brand:'Rolex',model:'126233',...data.details}:{}},mainFields:{category:data.kind==='watch'?'Watches':'Coins',title:'Collector item',description:'Known item details.',cost:'40',salePrice:'90',minimumSalePrice:'55',ebaySyncEnabled:false,...data.main},assistedFields:{material:'Silver',purity:'925'},recentUploadedImages:data.photos,saveSelectedUploadedImagePaths:data.photos.map(p=>p.path),aiSelectedUploadedImagePath:data.photos[0]?.path || ''}})),{kind,details,main,photos,step,assignStock});
 await page.reload();await page.waitForFunction(()=>window.addItemIntake && window.addItemAssistedModule && document.getElementById('cost').value==='40');
}
const twoPhotos=[{path:'front.jpg',storageBucket:'photos',name:'Front',mimeType:'image/jpeg'},{path:'back.jpg',storageBucket:'photos',name:'Back',mimeType:'image/jpeg'}];
const photoFile=name=>({name,mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')});

test('normal jewelry intake has four steps, editable review, and distinct minimum and retail prices',async t=>{
 const page=await pageFor(t);
 assert.match(await page.locator('#item-step-status').innerText(),/of 4/i);
 await next(page);assert.equal(await step(page),'information');
 await page.locator('#weight').fill('12.5');await category(page,'Bracelets');await next(page);
 assert.equal(await step(page),'photos');await next(page);assert.equal(await step(page),'pricing');
 await page.locator('#sale-price').fill('300');await page.locator('#minimum-sale-price').fill('400');await next(page);assert.equal(await step(page),'pricing');
 await page.locator('#minimum-sale-price').fill('150');await next(page);assert.equal(await step(page),'review');
 assert.match(await page.locator('#title').inputValue(),/Silver Bracelets/);
 await page.getByRole('button',{name:'Edit Retail',exact:true}).click();assert.equal(await step(page),'pricing');
 await page.locator('#cost').fill('100');assert.equal(await page.locator('#sale-price').inputValue(),'300');await next(page);assert.equal(await step(page),'review');
 await page.getByRole('button',{name:'Save item',exact:true}).click();await page.waitForFunction(()=>window.testWrites.length===1);
 const saved=await page.evaluate(()=>window.testWrites[0]);assert.equal(saved.minimum_sale_price,150);assert.equal(saved.sale_price,300);assert.equal(saved.ebay_sync_enabled,false);assert.equal(saved.dymo_label_url,'');
});

test('watch brand and reference are entered once, category is automatic and optional steps adapt',async t=>{
 const page=await pageFor(t);await prepareWatch(page);
 assert.equal(await step(page),'review');assert.equal(await page.locator('#title').inputValue(),'Rolex 126233');
 assert.equal(await page.evaluate(()=>window.addItemWizard.getWatchDetails().name),'Rolex');
 await page.getByRole('button',{name:'Edit Item',exact:true}).click();
 await page.locator('#item-prepare-ebay').check();await page.locator('#item-assign-stock').check();assert.match(await page.locator('#item-step-status').innerText(),/of 6/i);
 await page.locator('#item-prepare-ebay').uncheck();await page.locator('#item-assign-stock').uncheck();assert.match(await page.locator('#item-step-status').innerText(),/of 4/i);
 await next(page);assert.equal(await step(page),'review');
 await page.getByRole('button',{name:'Save item',exact:true}).click();await page.waitForFunction(()=>window.testWrites.length===1);
 const saved=await page.evaluate(()=>window.testWrites[0]);assert.equal(saved.watch_details.brand,'Rolex');assert.equal(saved.sale_price,6500);assert.equal(saved.minimum_sale_price,4700);
});

test('automatic reference drafting runs while continuing, preserves manual edits and exposes sources',async t=>{
 const page=await pageFor(t);await page.evaluate(()=>window.testGenerationHold=true);
 await prepareWatch(page,{auto:true});await page.waitForFunction(()=>window.testReleaseGeneration);
 await page.locator('#title').fill('My custom title');await page.locator('#description').fill('My verified description.');
 await page.evaluate(()=>window.testReleaseGeneration());await page.waitForFunction(()=>document.getElementById('watch-reference-results').querySelector('a'));
 assert.equal(await page.locator('#title').inputValue(),'My custom title');assert.equal(await page.locator('#description').inputValue(),'My verified description.');
 assert.equal(await page.locator('#assisted-apply-copy').isVisible(),true);
 await page.locator('#assisted-apply-copy').click();assert.equal(await page.locator('#description').inputValue(),'Reviewed watch copy');
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('test-draft'))?.payload?.assistedFields?.watchReference?.status==='found');
 await page.reload();await page.waitForFunction(()=>window.addItemWizard?.getWatchDetails()?.referenceLookup?.status==='found');
 assert.equal(await page.locator('#description').inputValue(),'Reviewed watch copy');
});

test('automatic drafting applies to the one visible editor and ignores obsolete reference responses',async t=>{
 const page=await pageFor(t);await page.evaluate(()=>window.testGenerationHold=true);
 await prepareWatch(page,{auto:true});await page.waitForFunction(()=>window.testReleaseGeneration);
 await page.getByRole('button',{name:'Edit Item',exact:true}).click();await page.locator('#watch-model').fill('NEW-REF');
 await page.evaluate(()=>{window.testGenerationHold=false;window.testReleaseGeneration();});
 await next(page);await page.waitForFunction(()=>window.testGeneration.length===2 && document.getElementById('description').value==='Reviewed watch copy');
 assert.equal(await page.evaluate(()=>window.addItemWizard.getWatchDetails().referenceLookup.matchedReference),'NEW-REF');
 assert.equal(await page.locator('#assisted-generated-description').isVisible(),false);
});

test('multiple phone photos are included automatically, cover stays stable and removals update review',async t=>{
 const page=await pageFor(t,{width:390,height:844});await page.locator('[name="item-kind"][value="coin"]').check();await page.locator('#coin-name').fill('Morgan dollar');await next(page);
 await page.locator('#assisted-local-image-upload').setInputFiles([photoFile('Front.png'),photoFile('Back.png')]);
 await page.waitForFunction(()=>window.addItemAssistedModule.getSelectedUploadedImagesForSave().length===2 && !window.addItemAssistedModule.isPhotoBusy());
 assert.equal(await page.evaluate(()=>window.addItemAssistedModule.getAISelectedUploadedImagePath()),'uploaded-1.jpg');
 assert.equal(await page.locator('#item-camera-photo').getAttribute('capture'),'environment');assert.equal(await page.locator('#item-coin-photo-guide').isVisible(),true);
 await page.locator('[data-assisted-ai-select="uploaded-2.jpg"]').click();assert.equal(await page.evaluate(()=>window.addItemAssistedModule.getAISelectedUploadedImagePath()),'uploaded-2.jpg');
 assert.equal(await page.evaluate(()=>window.addItemAssistedModule.getSelectedUploadedImagesForSave()[0].path),'uploaded-2.jpg');
 await page.locator('[data-assisted-save-toggle="uploaded-2.jpg"]').click();assert.equal(await page.evaluate(()=>window.addItemAssistedModule.getSelectedUploadedImagesForSave().length),1);
 assert.equal(await page.evaluate(()=>window.addItemAssistedModule.getAISelectedUploadedImagePath()),'uploaded-1.jpg');
 await page.locator('[data-assisted-ai-select="uploaded-2.jpg"]').click();
 assert.equal(await page.evaluate(()=>window.addItemAssistedModule.getSelectedUploadedImagesForSave()[0].path),'uploaded-2.jpg');
 assert.equal(await page.evaluate(()=>window.addItemAssistedModule.getSelectedUploadedImagesForSave().length),2);
});

test('partial photo upload failure retains successful photos and reports which photo to retry',async t=>{
 const page=await pageFor(t);await page.locator('[name="item-kind"][value="coin"]').check();await page.locator('#coin-name').fill('Coin');await next(page);await page.evaluate(()=>window.testFailUploadAt=2);
 await page.locator('#assisted-local-image-upload').setInputFiles([photoFile('Front.png'),photoFile('Back.png')]);
 await page.waitForFunction(()=>!window.addItemAssistedModule.isPhotoBusy());
 assert.match(await page.locator('#assisted-image-status').innerText(),/Back.png/);assert.equal(await page.evaluate(()=>window.addItemAssistedModule.getSelectedUploadedImagesForSave().length),1);
});

test('scanning an existing barcode offers quantity entry early without changing the barcode',async t=>{
 const page=await pageFor(t);await page.evaluate(()=>window.testExistingItem={id:'existing',title:'Existing Morgan',barcode:'COIN123'});
 await page.locator('#item-barcode-options > summary').click();await page.locator('#scanned-barcode').fill('COIN123');await page.waitForFunction(()=>window.addItemBarcodeMatch);
 assert.match(await page.locator('#item-barcode-result').innerText(),/Existing Morgan/);
 assert.match(await page.locator('#item-barcode-result a').getAttribute('href'),/add-inventory.html\?mode=quick-add&barcode=COIN123/);
 assert.equal(await page.locator('#scanned-barcode').inputValue(),'COIN123');
 await page.getByRole('button',{name:'Create a different item',exact:true}).click();assert.notEqual(await page.locator('#scanned-barcode').inputValue(),'COIN123');assert.equal(await page.evaluate(()=>window.addItemBarcodeMatch),null);
});

test('saving works with unavailable labels, and print retry never inserts another item',async t=>{
 const page=await pageFor(t);await page.evaluate(()=>{window.testSaveSuccess=true;window.testLabelFailure=true;});await prepareWatch(page);
 await page.getByRole('button',{name:'Save item',exact:true}).click();await page.locator('#item-save-success-modal').waitFor({state:'visible'});
 assert.equal(await page.evaluate(()=>window.testWrites.length),1);assert.equal(await page.evaluate(()=>window.testLabelPrepares.length),0);
 await page.locator('#item-label-print-one').click();await page.waitForFunction(()=>document.getElementById('item-label-print-status').textContent.includes('Printer preparation unavailable'));
 assert.equal(await page.evaluate(()=>window.testWrites.length),1);
 await page.locator('#item-save-success-continue').click();assert.equal(await step(page),'information');assert.equal(await page.locator('[name="item-kind"][value="jewelry"]').isChecked(),true);
});

test('Save and add similar retains selected shared fields, clears unique facts, and saves a fresh draft',async t=>{
 const page=await pageFor(t);await seed(page,{kind:'coin',step:'review',details:{gradingStatus:'certified',grade:'MS 65',gradingService:'PCGS',certNumber:'000123',mint:'S',condition:'Cleaned',notes:'Scratch'},photos:twoPhotos,main:{distributorName:'Supplier A',distributorPhone:'555-0100'}});
 await page.evaluate(()=>window.testSaveSuccess=true);const originalBarcode=await page.locator('#scanned-barcode').inputValue();await page.locator('#item-keep-prices').check();
 await page.getByRole('button',{name:'Save & add similar',exact:true}).click();await page.waitForFunction(()=>window.testWrites.length===1 && document.getElementById('coin-name').value==='Morgan dollar' && !document.getElementById('add-item-form').dataset.savedItemId);
 assert.equal(await step(page),'information');assert.equal(await page.locator('#coin-year').inputValue(),'');assert.equal(await page.locator('#coin-grade').inputValue(),'');assert.equal(await page.locator('#coin-certNumber').inputValue(),'');assert.equal(await page.locator('#coin-condition').inputValue(),'');
 assert.equal(await page.locator('#distributor-name').inputValue(),'Supplier A');assert.equal(await page.locator('#sale-price').inputValue(),'90');assert.equal(await page.locator('#minimum-sale-price').inputValue(),'55');
 assert.notEqual(await page.locator('#scanned-barcode').inputValue(),originalBarcode);assert.equal(await page.evaluate(()=>window.addItemAssistedModule.getSelectedUploadedImagesForSave().length),0);
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('test-draft'))?.payload?.wizard?.coinDetails?.year==='');
 await page.reload();await page.waitForFunction(()=>window.addItemWizard?.isCoin() && document.getElementById('coin-name').value==='Morgan dollar');assert.equal(await page.locator('#coin-certNumber').inputValue(),'');
});

test('batch printing uses saved item snapshots while the next item is edited',async t=>{
 const page=await pageFor(t);await page.evaluate(()=>window.testSaveSuccess=true);await prepareWatch(page);
 await page.getByRole('button',{name:'Save & add similar',exact:true}).click();await page.waitForFunction(()=>window.testWrites.length===1 && !document.getElementById('add-item-form').dataset.savedItemId);
 await next(page);await next(page);await page.locator('#cost').fill('4000');await page.locator('#sale-price').fill('6000');await next(page);
 await page.getByRole('button',{name:'Save & add similar',exact:true}).click();await page.waitForFunction(()=>window.testWrites.length===2 && !document.getElementById('add-item-form').dataset.savedItemId);
 const codes=await page.evaluate(()=>window.testWrites.map(item=>item.barcode));await page.locator('#watch-model').fill('UNSAVED-REF');
 await page.locator('#item-print-session').click();await page.waitForFunction(()=>window.testPrints.length===2);
 await page.waitForFunction(()=>window.testLabelPreferences.filter(p=>p._strategy==='individual_batch').length===2);
 assert.deepEqual(await page.evaluate(()=>window.testLabelPreferences.filter(p=>p._strategy==='individual_batch').map(p=>p._item_id)),['item-1','item-2']);
 assert.deepEqual(await page.evaluate(()=>window.testPrints.map(item=>item.barcode)),codes);assert.match(await page.locator('#item-print-session').innerText(),/\(0\)/);
});

test('selected photo copy failure blocks insertion and retains the draft',async t=>{
 const page=await pageFor(t);await seed(page,{step:'review',photos:[{...twoPhotos[0],storageBucket:'InventoryUpload'}]});await page.evaluate(()=>{window.testCopyFailure=true;window.testSaveSuccess=true;});
 await page.getByRole('button',{name:'Save item',exact:true}).click();await page.waitForFunction(()=>!document.getElementById('add-item-form').dataset.saving);
 assert.equal(await page.evaluate(()=>window.testWrites.length),0);assert.equal(await page.evaluate(()=>window.addItemAssistedModule.getSelectedUploadedImagesForSave().length),1);
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
  await page.locator('#watch-brand').fill('Test watch');
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



async function coinMarketplacePage(t, details={}) {
 const page=await pageFor(t,{width:390,height:844});
 await seed(page,{details,photos:twoPhotos,step:'marketplace',main:{ebaySyncEnabled:true}});
 await page.waitForFunction(()=>window.coinEbayForm && document.querySelector('[data-coin-ebay-category]').options.length>1);
 await page.locator('#coin-ebay-add input[type=search]').fill('');
 return page;
}

test('coin eBay category, raw condition and photo confirmation survive drafts and save with retail',async(t)=>{
  const page=await coinMarketplacePage(t);
  await page.locator('#coin-ebay-add input[type=search]').fill('Morgan');
  await page.locator('[data-coin-ebay-category]').selectOption('39464');
  await page.waitForFunction(()=>window.coinEbayForm.getMetadata()?.category.id==='39464');
  await page.locator('#ebay-sync-enabled').check();
  await page.locator('[data-coin-descriptor="2"]').selectOption('9');
  await page.locator('[data-coin-ebay-photos]').check();
  assert.equal(await page.locator('[data-coin-aspect="Fineness"]').inputValue(),'0.9');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.locator('[data-coin-descriptor="2"]').scrollIntoViewIfNeeded();
  await page.screenshot({path:new URL('test-results/coin-ebay-mobile.png',root).pathname.replace(/^\/(\w:)/,'$1')});
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('test-draft'))?.payload?.wizard?.coinDetails?.ebay?.photosConfirmed===true);
  await page.reload();
  await page.waitForFunction(()=>window.coinEbayForm?.getMetadata()?.category.id==='39464');
  assert.equal(await page.locator('#ebay-sync-enabled').isChecked(),true);
  assert.equal(await page.locator('[data-coin-descriptor="2"]').inputValue(),'9');
  assert.equal(await page.locator('[data-coin-ebay-photos]').isChecked(),true);
  await next(page); assert.equal(await step(page),'review');
  await page.getByRole('button',{name:'Save item',exact:true}).click();
  await page.waitForFunction(()=>window.testWrites.length===1);
  const saved=await page.evaluate(()=>window.testWrites[0]);
  assert.equal(saved.ebay_sync_enabled,true);assert.equal(saved.ebay_category_id,'39464');assert.equal(saved.ebay_condition,'USED_VERY_GOOD');
  assert.deepEqual(saved.coin_details.ebay.descriptors['2'],{values:['9']});assert.equal(saved.sale_price,90);assert.equal(saved.minimum_sale_price,55);assert.equal(saved.photos.length,2);
});
test('certified coin controls use live dependent grades and track changes to the entered grade',async(t)=>{
  const page=await coinMarketplacePage(t,{gradingStatus:'certified',grade:'MS 65',gradingService:'PCGS',certNumber:'00012345'});
  await page.locator('[data-coin-ebay-category]').selectOption('39464');
  await page.waitForFunction(()=>window.coinEbayForm.getMetadata()?.category.id==='39464');
  assert.equal(await page.locator('[data-coin-descriptor="1"]').inputValue(),'14');
  assert.equal(await page.locator('[data-coin-descriptor="4"]').inputValue(),'55');
  assert.equal(await page.locator('[data-coin-descriptor="5"]').inputValue(),'00012345');
  await page.locator('[data-coin-descriptor="3"]').selectOption('19');
  assert.equal(await page.locator('[data-coin-descriptor="4"]').inputValue(),'');
  assert.equal(await page.locator('[data-coin-descriptor="4"] option[value="55"]').count(),0);
  await page.locator('[data-coin-descriptor="4"]').selectOption('27');
  assert.equal(await page.locator('#coin-grade').inputValue(),'AU 58');
  await page.locator('[data-item-step-target="information"]').click();
  await page.locator('#coin-grade').evaluate(el=>{el.value='MS64';el.dispatchEvent(new Event('change',{bubbles:true}));});
  assert.equal(await page.locator('[data-coin-descriptor="4"]').inputValue(),'56');
});
test('coin metadata loading keeps the latest category when responses arrive out of order',async(t)=>{
  const page=await coinMarketplacePage(t);
  await page.evaluate(()=>window.testCoinMetadataHold='39464');
  await page.locator('[data-coin-ebay-category]').selectOption('39464');
  await page.waitForFunction(()=>window.testReleaseCoinMetadata);
  await page.locator('[data-coin-ebay-category]').selectOption('177652');
  await page.waitForFunction(()=>window.coinEbayForm.getMetadata()?.category.id==='177652');
  await page.evaluate(()=>window.testReleaseCoinMetadata());
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(()=>window.coinEbayForm.getMetadata()?.category.id),'177652');
  assert.equal(await page.locator('[data-coin-aspect="Certification"]').inputValue(),'Uncertified');
  assert.equal(await page.locator('[data-coin-descriptor]').count(),0);
});

test('Stock coin editor prepares older coins without automatically opting them into eBay',async(t)=>{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  t.after(()=>page.close());
  await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
  await page.goto(`${origin}/stock.html`);
  await page.waitForFunction(()=>window.coinEbayStock);
  await page.evaluate(()=>{
    window.coinEbayStock.open({coin_details:{name:'Morgan dollar',year:'1881',metal:'Silver',gradingStatus:'ungraded'},ebay_sync_enabled:false},true);
    document.getElementById('editItemModal').classList.remove('hidden');
    document.getElementById('editItemModal').classList.add('show');
  });
  await page.waitForFunction(()=>document.querySelector('[data-coin-ebay-category]').options.length>1);
  assert.equal(await page.locator('#edit-coin-ebay-enabled').isChecked(),false);
  await page.locator('[data-coin-ebay-category]').selectOption('39464');
  await page.locator('[data-coin-descriptor="2"]').selectOption('8');
  await page.locator('#edit-coin-ebay-enabled').check();
  const details=await page.evaluate(()=>window.coinEbayStock.getDetails());
  assert.equal(details.year,'1881');assert.equal(details.ebay.categoryId,'39464');assert.equal(details.ebay.conditionId,'4000');
  assert.deepEqual(details.ebay.descriptors['2'],{values:['8']});
  await page.evaluate(()=>window.coinEbayStock.open({coin_details:{name:'Coin'},ebay_sync_enabled:false},false));
  assert.equal(await page.locator('#edit-coin-details').isVisible(),false);
});


test('all adaptive steps fit small phones, portrait and landscape',async t=>{
 await mkdir(new URL('test-results/',root),{recursive:true});
 for(const [kind,viewport] of [['jewelry',{width:320,height:568}],['watch',{width:390,height:844}],['coin',{width:844,height:390}]]){
  const page=await pageFor(t,viewport);await seed(page,{kind,photos:twoPhotos,main:{ebaySyncEnabled:false}});
  if(kind==='jewelry')await page.locator('#weight').fill('10');
  await assertPhoneLayout(page,kind+': Identify');
  await next(page);await assertPhoneLayout(page,kind+': Photos');
  await page.getByText('Crop, background and recent station photos',{exact:true}).click();
  await assertPhoneLayout(page,kind+': Photo tools');
  await page.locator('#assisted-open-image-editor').click();await page.locator('.assisted-editor-dialog').waitFor({state:'visible'});
  await page.locator('#assisted-editor-save').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#assisted-editor-save').evaluate(button=>{const r=button.getBoundingClientRect();return button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true);
  await page.locator('#assisted-editor-close').click();
  await page.screenshot({path:new URL(`test-results/fast-intake-${kind}-photos.png`,root).pathname.replace(/^\/(\w:)/,'$1'),fullPage:true});
  await next(page);await assertPhoneLayout(page,kind+': Pricing');await next(page);await assertPhoneLayout(page,kind+': Review');
  await page.getByRole('button',{name:'Edit Stock',exact:true}).click();await assertPhoneLayout(page,kind+': Stock');
  await next(page);assert.equal(await step(page),'stock','Unsigned stock cannot pass');
  await page.locator('[data-item-step-target="information"]').click();await page.locator('#item-assign-stock').uncheck();
  await page.locator('[data-item-step-target="review"]').click();await page.getByRole('button',{name:'Edit eBay',exact:true}).click();await assertPhoneLayout(page,kind+': eBay');
  await page.locator('#ebay-sync-enabled').uncheck();await page.locator('[data-item-step-target="review"]').click();
  await page.getByRole('button',{name:'Save item',exact:true}).scrollIntoViewIfNeeded();
  assert.equal(await page.getByRole('button',{name:'Save item',exact:true}).evaluate(button=>{const r=button.getBoundingClientRect();return button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true);
  await page.screenshot({path:new URL(`test-results/fast-intake-${kind}-review.png`,root).pathname.replace(/^\/(\w:)/,'$1'),fullPage:true});
 }
});

test('new facts clear old automatic copy, manual edits remain, and late results cannot change the next item',async t=>{
 const page=await pageFor(t);await prepareWatch(page,{auto:true});await page.waitForFunction(()=>document.getElementById('description').value==='Reviewed watch copy');
 await page.locator('#title').fill('My watch');await page.getByRole('button',{name:'Edit Item',exact:true}).click();await page.locator('#watch-model').fill('NEXT');
 assert.equal(await page.locator('#description').inputValue(),'');assert.equal(await page.locator('#title').inputValue(),'My watch');
 await page.evaluate(()=>window.testGenerationHold=true);await next(page);await page.waitForFunction(()=>window.testReleaseGeneration);
 await page.locator('#description').fill('My verified current description.');await page.evaluate(()=>window.testSaveSuccess=true);
 await page.getByRole('button',{name:'Save & add similar',exact:true}).click();await page.waitForFunction(()=>window.testWrites.length===1 && !document.getElementById('add-item-form').dataset.savedItemId);
 await page.evaluate(()=>window.testReleaseGeneration());
 assert.equal(await page.locator('#description').inputValue(),'');assert.equal(await page.locator('#assisted-generate-copy').isDisabled(),false);
 assert.equal(await page.locator('#sale-price').inputValue(),'');assert.equal(await page.locator('#minimum-sale-price').inputValue(),'');
});

test('signed stock is saved once and similar entry only suggests the location, never copies its signature',async t=>{
 const page=await pageFor(t);await seed(page,{kind:'watch',assignStock:true,step:'stock'});
 await page.evaluate(()=>{
  window.testSaveSuccess=true;
  pendingStockAssignments[document.getElementById('scanned-barcode').value]={location_id:'tray-1',location_name:'Tray one',quantity:2,placement_type:'tray',signed_by_email:'test@example.invalid',signed_at:new Date().toISOString(),confirmation_method:'password_stock_placement'};
  document.getElementById('assignment-preview-box').classList.remove('hidden');
 });
 await next(page);await page.getByRole('button',{name:'Save & add similar',exact:true}).click();
 await page.waitForFunction(()=>window.testWrites.length===1 && !document.getElementById('add-item-form').dataset.savedItemId);
 assert.equal(await page.evaluate(()=>window.testStockWrites.length),1);assert.equal(await page.evaluate(()=>window.testStockWrites[0].quantity),2);
 assert.equal(await page.evaluate(()=>window.addItemLocationHint.location_id),'tray-1');assert.deepEqual(await page.evaluate(()=>Object.keys(pendingStockAssignments)),[]);
 await next(page);await next(page);await page.locator('#cost').fill('40');await page.locator('#sale-price').fill('90');await next(page);
 assert.equal(await step(page),'stock');await next(page);assert.equal(await step(page),'stock');assert.match(await page.locator('#item-step-error').innerText(),/confirm a location/);
});

test('stock failure keeps the item saved, explains missing quantity, and cannot repeat the item insert',async t=>{
 const page=await pageFor(t);await seed(page,{kind:'watch',assignStock:true,step:'stock'});
 await page.evaluate(()=>{
  window.testSaveSuccess=true;window.testStockFailure=true;
  pendingStockAssignments[document.getElementById('scanned-barcode').value]={location_id:'tray-1',location_name:'Tray one',quantity:2};
  document.getElementById('assignment-preview-box').classList.remove('hidden');
 });
 await next(page);await page.getByRole('button',{name:'Save item',exact:true}).click();await page.locator('#item-save-success-modal').waitFor({state:'visible'});
 assert.match(await page.locator('#item-save-success-copy').innerText(),/Stock quantity was not assigned/);
 assert.equal(await page.locator('#item-save-success-stock').innerText(),'No stock quantity assigned');
 await page.evaluate(()=>document.getElementById('add-item-form').requestSubmit());assert.equal(await page.evaluate(()=>window.testWrites.length),1);
});

test('similar location hint opens the actual placement dialog but requires a fresh password confirmation',async t=>{
 const page=await pageFor(t,{width:390,height:844});await seed(page,{kind:'watch',assignStock:true,step:'stock'});
 await page.evaluate(()=>{
  window.testLocations=[{id:'tray-1',location_name:'Tray one',location_code:'TRAY-1',type:'tray',is_tray:true,active:true}];
  window.addItemLocationHint={location_id:'tray-1',placement_type:'tray'};
 });
 await page.locator('#btn-open-admin-stock').click();await page.waitForFunction(()=>document.getElementById('admin-location-id').value==='tray-1');
 assert.deepEqual(await page.evaluate(()=>Object.keys(pendingStockAssignments)),[]);
 await page.locator('#admin-stock-quantity').fill('3');await page.locator('#btn-confirm-admin-stock').click();
 await page.locator('#stock-placement-signature-modal').waitFor({state:'visible'});
 assert.deepEqual(await page.evaluate(()=>Object.keys(pendingStockAssignments)),[]);
 await page.locator('#stock-placement-password').fill('test-password');await page.locator('#stock-placement-password-confirm').click();
 await page.waitForFunction(()=>Object.keys(pendingStockAssignments).length===1);
 const pending=await page.evaluate(()=>Object.values(pendingStockAssignments)[0]);assert.equal(pending.quantity,3);assert.equal(pending.confirmation_method,'password_stock_placement');assert.ok(pending.signed_at);
 await next(page);assert.equal(await step(page),'review');
});


test('slow draft restore keeps the visible watch category valid through navigation and saving',async t=>{
 const page=await pageFor(t,{width:390,height:844});
 await page.evaluate(()=>localStorage.setItem('test-draft',JSON.stringify({payload:{
  wizard:{version:2,step:'information',itemKind:'watch',autoCopy:false,watchDetails:{brand:'Rolex',model:'126233'}},
  mainFields:{category:'',title:'My watch',cost:'40',salePrice:'90',ebaySyncEnabled:false},assistedFields:{}
 }})));
 await page.addInitScript(()=>{window.testDraftHold=true;});
 await page.reload();await page.waitForFunction(()=>window.testReleaseDraft && window.addItemAssistedModule);
 await page.locator('[name="item-kind"][value="watch"]').check();
 assert.equal(await page.locator('#category-dropdown-toggle').innerText(),'Watches');
 await page.evaluate(()=>window.testReleaseDraft());await page.waitForFunction(()=>document.getElementById('cost').value==='40');
 assert.equal(await page.locator('#category-dropdown-toggle').innerText(),'Watches');
 await next(page);assert.equal(await step(page),'photos');
 assert.equal(await page.locator('#category').inputValue(),'Watches');
 await next(page);await next(page);await page.getByRole('button',{name:'Save item',exact:true}).click();
 await page.waitForFunction(()=>window.testWrites.length===1);assert.deepEqual(await page.evaluate(()=>window.testWrites[0].categories),['Watches']);
});

test('missing categories on restored coin drafts use Coins and explicit custom categories stay unchanged',async t=>{
 const page=await pageFor(t);await seed(page,{main:{category:''}});
 assert.equal(await page.locator('#category-dropdown-toggle').innerText(),'Coins');
 await next(page);assert.equal(await step(page),'photos');
 await seed(page,{main:{category:'Rare <collector> coins'}});
 assert.equal(await page.locator('#category-dropdown-toggle').innerText(),'Rare <collector> coins');
 assert.equal(await page.locator('#category').inputValue(),'Rare <collector> coins');
 await next(page);assert.equal(await step(page),'photos');
});

test('category validation recovers a displayed selection but never accepts the placeholder',async t=>{
 const page=await pageFor(t);await page.locator('#weight').fill('10');
 await category(page,'Custom bracelets');
 await page.evaluate(()=>{document.getElementById('category').value='';});
 await next(page);assert.equal(await step(page),'photos');
 assert.equal(await page.locator('#category').inputValue(),'Custom bracelets');
 await page.evaluate(()=>window.resetForNextIntake());
 assert.equal(await page.locator('#category-dropdown-toggle').innerText(),'Select or Create Category');
 await page.locator('#weight').fill('10');await next(page);assert.equal(await step(page),'information');
 assert.match(await page.locator('#item-step-error').innerText(),/Select or create an item category/);
});
