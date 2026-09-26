// ebayExport.js - Fill the eBay Listings template rows from selected stock items.
// Requires SheetJS + FileSaver.js loaded via CDN.

const LISTINGS_SHEET_NAME = "Listings";
const LISTINGS_HEADER_ROW_INDEX = 3; // Excel row 4, zero-based for SheetJS.
const STOCK_QUANTITY_CHUNK_SIZE = 50;
const STOCK_QUANTITY_TIMEOUT_MS = 30000;

const requiredHeaders = {
  action: "*Action(SiteID=US|Country=US|Currency=USD|Version=1193)",
  sku: "Custom label (SKU)",
  categoryId: "Category ID",
  categoryName: "Category name",
  title: "Title",
  startPrice: "Start price",
  quantity: "Quantity",
  photoUrl: "Item photo URL",
  condition: "Condition ID",
  description: "Description",
  format: "Format",
  duration: "Duration",
  location: "Location",
  shippingProfile: "Shipping profile name",
  returnProfile: "Return profile name",
  paymentProfile: "Payment profile name",
  brand: "C:Brand",
  stone: "C:Main Stone",
  metal: "C:Metal",
  purity: "C:Metal Purity",
  style: "C:Style",
  type: "C:Type",
  department: "C:Department",
  reference: "C:Reference Number"
};

const EBAY_EXPORT_PROFILES = {
  pendant: {
    label: "Pendant",
    slug: "pendants",
    templateUrl: "PendantListing.xlsx",
    categoryId: "261993",
    categoryName: "/Jewelry & Watches/Fine Jewelry/Necklaces & Pendants",
    condition: "1000-New with packaging",
    shippingProfile: "ShippingPolicySmall Copy - (ID: 248716566025)",
    returnProfile: "30 days money back (243300228025) - (ID: 243300228025)",
    paymentProfile: "EBAY LIVE - (ID: 239405079025)",
    style: "Pendant",
    type: "Pendant"
  },
  bracelet: {
    label: "Bracelet",
    slug: "bracelets",
    templateUrl: "BraceletListing.xlsx",
    categoryId: "261988",
    categoryName: "/Jewelry & Watches/Fine Jewelry/Bracelets & Charms",
    condition: "1000-New with packaging",
    shippingProfile: "ShippingPolicySmall Copy - (ID: 248716566025)",
    returnProfile: "30 days money back (243300228025) - (ID: 243300228025)",
    paymentProfile: "EBAY LIVE - (ID: 239405079025)",
    style: "Tennis",
    type: "Bracelet"
  }
};

EBAY_EXPORT_PROFILES.watch = {
  ...EBAY_EXPORT_PROFILES.pendant, label: "Watch", slug: "watches", type: "Wristwatch",
  categoryId: "31387", categoryName: "/Jewelry & Watches/Watches, Parts & Accessories/Watches/Wristwatches",
};
EBAY_EXPORT_PROFILES.coin = { ...EBAY_EXPORT_PROFILES.pendant, label: "Coin", slug: "coins", type: "Coin", categoryId: "", categoryName: "" };
const WATCH_EXPORT_CONDITIONS = { NEW: "1000", NEW_OTHER: "1500", NEW_WITH_DEFECTS: "1750", SELLER_REFURBISHED: "2500", PRE_OWNED_EXCELLENT: "2990", USED_EXCELLENT: "3000", PRE_OWNED_FAIR: "3010", FOR_PARTS_OR_NOT_WORKING: "7000" };
function validateEbayExportItems(items, profile, requirements) {
  for (const item of items) {
    const watch = item.watch_details;
    const name = item.title || item.barcode || "Selected item";
    if (!Number.isFinite(Number(item.sale_price)) || Number(item.sale_price) <= 0) throw new Error(`${name}: enter a retail price before exporting.`);
    if (item.coin_details && profile.type !== "Coin") throw new Error(`${name}: choose the Coin export category.`);
    if (profile.type === "Coin" && !item.coin_details?.ebay?.categoryId) throw new Error(`${name}: complete the coin eBay category and grading details in Edit Item.`);
    if (profile.type !== "Wristwatch" && (watch || item.ebay_category_id === "31387")) throw new Error(`${name}: choose the Watch export category.`);
    if (profile.type === "Wristwatch") {
      if (!watch) throw new Error(`${name}: select only items entered in Watch mode.`);
      for (const key of ["brand", "department", "condition"]) if (!watch[key]) throw new Error(`${name}: enter watch ${key} in Edit Item before exporting.`);
      const conditionId = WATCH_EXPORT_CONDITIONS[watch.condition];
      if (!conditionId) throw new Error(`${name}: choose a supported watch condition.`);
      if (requirements) {
        const aspects = { Brand: watch.brand, Department: watch.department, Type: "Wristwatch", "Reference Number": watch.model };
        for (const field of requirements.requiredAspects) if (!aspects[field]) throw new Error(`${name}: eBay requires ${field}. Complete the watch details first.`);
        if (!requirements.conditions.some(condition => String(condition.id) === conditionId)) throw new Error(`${name}: condition is not supported for watches on eBay.`);
        if (!requirements.departments.includes(watch.department)) throw new Error(`${name}: department is not supported for watches on eBay.`);
      }
    }
  }
}
window.EBAY_EXPORT_PROFILES = EBAY_EXPORT_PROFILES;

function getSelectedExportProfile(exportType = "pendant") {
  return EBAY_EXPORT_PROFILES[exportType] || EBAY_EXPORT_PROFILES.pendant;
}

function getHeaderIndexes(headers) {
  return Object.fromEntries(
    Object.entries(requiredHeaders).map(([key, header]) => [key, headers.indexOf(header)])
  );
}

function setRowValue(row, indexes, key, value) {
  const index = indexes[key];
  if (index !== -1) row[index] = value;
}

function reportProgress(options, progress) {
  if (typeof options?.onProgress === "function") {
    options.onProgress(progress);
  }
}

function withTimeout(promise, ms, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function getItemPhotoPaths(item) {
  const photoPaths = Array.isArray(item.photoPaths) ? item.photoPaths : [];
  const photos = Array.isArray(item.photos) ? item.photos : [];
  return [...photoPaths, ...photos].filter(Boolean).slice(0, 12);
}

function getContentTypeFromFilename(filename) {
  const extension = filename.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  return "image/jpeg";
}

async function getPublicImageUrl(privatePath) {
  if (!privatePath) return "";
  if (/^https?:\/\//i.test(privatePath) && privatePath.includes("/public-ebay-photos/")) {
    return privatePath;
  }

  const pathWithoutQuery = privatePath.split("?")[0];
  const filename = pathWithoutQuery.split("/").pop();
  if (!filename) return "";

  const itemPhotoIndex = pathWithoutQuery.indexOf("item_photos/");
  const sourcePath = itemPhotoIndex !== -1
    ? pathWithoutQuery.slice(itemPhotoIndex)
    : `item_photos/${filename}`;

  try {
    const { data: existingFiles, error: listError } = await supabase.storage
      .from("public-ebay-photos")
      .list("", { search: filename });

    if (listError) {
      console.warn("Error checking public-ebay-photos bucket:", listError.message);
    }

    const alreadyExists = existingFiles?.some(file => file.name === filename);
    if (!alreadyExists) {
      const { data: fileData, error: downloadError } = await supabase.storage
        .from("photos")
        .download(sourcePath);

      if (downloadError) {
        console.error("Failed to download image from photos:", downloadError.message);
        return "";
      }

      const { error: uploadError } = await supabase.storage
        .from("public-ebay-photos")
        .upload(filename, fileData, {
          upsert: true,
          contentType: getContentTypeFromFilename(filename)
        });

      if (uploadError) {
        console.error("Upload to public-ebay-photos failed:", uploadError.message);
        return "";
      }
    }

    return `https://byhytmarmigalvawkedi.supabase.co/storage/v1/object/public/public-ebay-photos/${encodeURIComponent(filename)}`;
  } catch (err) {
    console.error("Unhandled error in getPublicImageUrl:", err);
    return "";
  }
}

async function getPublicImageUrls(item) {
  const urls = [];
  for (const photoPath of getItemPhotoPaths(item)) {
    const url = await getPublicImageUrl(photoPath);
    if (url) urls.push(url);
  }
  return urls.join("|");
}

async function loadEbayTemplateWorkbook(templateUrl) {
  const response = await fetch(templateUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not load ${templateUrl} (${response.status}).`);
  }

  const data = await response.arrayBuffer();
  return XLSX.read(new Uint8Array(data), { type: "array", cellStyles: true });
}

function readListingHeaders(sheet) {
  const ref = XLSX.utils.decode_range(sheet["!ref"]);
  const headers = [];

  for (let col = ref.s.c; col <= ref.e.c; col++) {
    const cellAddress = XLSX.utils.encode_cell({ r: LISTINGS_HEADER_ROW_INDEX, c: col });
    headers.push(String(sheet[cellAddress]?.v || "").trim());
  }

  return headers;
}

function clearExistingListingRows(sheet) {
  const ref = XLSX.utils.decode_range(sheet["!ref"]);

  for (const key of Object.keys(sheet)) {
    if (!/^[A-Z]+\d+$/.test(key)) continue;
    const cell = XLSX.utils.decode_cell(key);
    if (cell.r > LISTINGS_HEADER_ROW_INDEX) delete sheet[key];
  }

  sheet["!ref"] = XLSX.utils.encode_range({
    s: ref.s,
    e: { r: LISTINGS_HEADER_ROW_INDEX, c: ref.e.c }
  });
}

async function getQuantitiesByItemId(items, options = {}) {
  const itemIds = [...new Set(items.map(item => item.id).filter(Boolean))];
  if (!itemIds.length) return {};

  reportProgress(options, {
    title: "Reading stock quantities",
    detail: `Checking available stock for ${itemIds.length} selected item${itemIds.length === 1 ? "" : "s"} in batches...`,
    processed: 0,
    total: items.length,
    percent: 20,
    visible: true
  });

  const allStockRows = [];

  for (let start = 0; start < itemIds.length; start += STOCK_QUANTITY_CHUNK_SIZE) {
    const chunk = itemIds.slice(start, start + STOCK_QUANTITY_CHUNK_SIZE);
    const checkedCount = Math.min(start + chunk.length, itemIds.length);

    reportProgress(options, {
      title: "Reading stock quantities",
      detail: `Checking stock quantities ${start + 1}-${checkedCount} of ${itemIds.length}...`,
      processed: checkedCount,
      total: itemIds.length,
      percent: 20 + Math.round((checkedCount / itemIds.length) * 18),
      visible: true
    });

    const { data: stockRows, error: stockError } = await withTimeout(
      supabase
        .from("item_stock_locations")
        .select("item_id, quantity")
        .in("item_id", chunk),
      STOCK_QUANTITY_TIMEOUT_MS,
      `Timed out while fetching stock quantities ${start + 1}-${checkedCount}.`
    );

    if (stockError) {
      console.error("Error fetching item_stock_locations:", stockError.message);
      throw new Error(`Failed to fetch item quantities: ${stockError.message}`);
    }

    allStockRows.push(...(stockRows || []));
  }

  return allStockRows.reduce((acc, row) => {
    acc[row.item_id] = (acc[row.item_id] || 0) + (row.quantity || 0);
    return acc;
  }, {});
}

async function buildListingRows(items, headers, profile, options = {}) {
  validateEbayExportItems(items, profile);
  const indexes = getHeaderIndexes(headers);
  const coinListings = new Map();
  if (profile.type === "Coin") for (const item of items) {
    const listing = window.CoinEbay.buildCoinListing(item, options.coinMetadataMap?.get(item.coin_details.ebay.categoryId));
    if (listing.reasons.length) throw new Error(`${item.title || item.barcode}: ${listing.reasons.join("; ")}`);
    coinListings.set(item.id, listing);
  }
  const quantitiesByItemId = await getQuantitiesByItemId(items, options);
  const outputRows = [];
  let processed = 0;

  for (const item of items) {
    processed += 1;
    if (!item.id) {
      console.warn("Skipping item without ID:", item);
      reportProgress(options, {
        title: "Processing selected items",
        detail: `Skipped item ${processed} of ${items.length}: missing item ID.`,
        processed,
        total: items.length,
        percent: 25 + Math.round((processed / items.length) * 55),
        visible: true
      });
      continue;
    }

    const totalQty = quantitiesByItemId[item.id];
    if (totalQty === undefined) {
      console.warn(`Skipping item with ID ${item.id}: no quantity found in item_stock_locations.`);
      reportProgress(options, {
        title: "Processing selected items",
        detail: `Skipped ${item.title || item.barcode || item.id}: no stock quantity found.`,
        processed,
        total: items.length,
        percent: 25 + Math.round((processed / items.length) * 55),
        visible: true
      });
      continue;
    }

    if (totalQty <= 0) {
      console.warn(`Skipping item with ID ${item.id}: quantity is ${totalQty}.`);
      reportProgress(options, {
        title: "Processing selected items",
        detail: `Skipped ${item.title || item.barcode || item.id}: stock quantity is ${totalQty}.`,
        processed,
        total: items.length,
        percent: 25 + Math.round((processed / items.length) * 55),
        visible: true
      });
      continue;
    }

    const coinListing = coinListings.get(item.id);
    const row = new Array(headers.length).fill("");
    setRowValue(row, indexes, "action", "Add");
    setRowValue(row, indexes, "sku", item.barcode || "");
    setRowValue(row, indexes, "categoryId", coinListing?.categoryId || profile.categoryId);
    setRowValue(row, indexes, "categoryName", coinListing ? `/Coins & Paper Money/${coinListing.categoryLabel.replaceAll(" > ", "/")}` : profile.categoryName);
    setRowValue(row, indexes, "title", item.title || "");
    setRowValue(row, indexes, "startPrice", item.sale_price || 0);
    setRowValue(row, indexes, "quantity", totalQty);
    const photoUrls = await getPublicImageUrls(item);
    if (coinListing && new Set(photoUrls.split("|").filter(Boolean)).size < 2) throw new Error(`${item.title || item.barcode}: both front and back photos must be available before exporting.`);
    setRowValue(row, indexes, "photoUrl", photoUrls);
    setRowValue(row, indexes, "condition", coinListing ? coinListing.conditionId : profile.type === "Wristwatch" ? WATCH_EXPORT_CONDITIONS[item.watch_details.condition] : profile.condition);
    const watchLabels = { name: "Name", brand: "Brand", model: "Model / reference", department: "Department", materials: "Materials by component", modifications: "Modifications / customizations" };
    const description = profile.type === "Wristwatch" ? [
      String(item.description || "").replace(/\n*Watch details:\n[\s\S]*$/, "").trim(),
      "Watch details:\n" + Object.entries(watchLabels).filter(([key]) => item.watch_details[key]).map(([key, label]) => `${label}: ${item.watch_details[key]}`).join("\n"),
    ].filter(Boolean).join("\n\n") : item.description || "";
    setRowValue(row, indexes, "description", coinListing?.description || description);
    setRowValue(row, indexes, "format", "FixedPrice");
    setRowValue(row, indexes, "duration", "GTC");
    setRowValue(row, indexes, "location", "Miami, FL");
    setRowValue(row, indexes, "shippingProfile", profile.shippingProfile);
    setRowValue(row, indexes, "returnProfile", profile.returnProfile);
    setRowValue(row, indexes, "paymentProfile", profile.paymentProfile);
    if (coinListing) {
      for (const [name, values] of Object.entries(coinListing.aspects)) {
        const index = headers.indexOf(`C:${name}`);
        if (index >= 0) row[index] = values.join("|");
      }
      for (const descriptor of coinListing.conditionDescriptors) {
        const index = headers.findIndex(header => header.startsWith(descriptor.additionalInfo !== undefined ? "CDA:" : "CD:") && header.endsWith(`(ID: ${descriptor.name})`));
        if (index >= 0) row[index] = descriptor.additionalInfo ?? descriptor.values.join("|");
      }
    } else if (profile.type === "Wristwatch") {
      setRowValue(row, indexes, "brand", item.watch_details.brand);
      setRowValue(row, indexes, "department", item.watch_details.department);
      setRowValue(row, indexes, "reference", item.watch_details.model || "");
    } else {
      setRowValue(row, indexes, "brand", "Unbranded");
      setRowValue(row, indexes, "stone", "Unknown");
      setRowValue(row, indexes, "metal", "Fine Silver");
      setRowValue(row, indexes, "purity", "925");
      setRowValue(row, indexes, "style", profile.style);
    }
    setRowValue(row, indexes, "type", profile.type);
    outputRows.push(row);
    reportProgress(options, {
      title: "Processing selected items",
      detail: `Exported ${outputRows.length} item${outputRows.length === 1 ? "" : "s"} so far. Latest: ${item.title || item.barcode || item.id}`,
      processed,
      total: items.length,
      percent: 25 + Math.round((processed / items.length) * 55),
      visible: true
    });
  }

  return outputRows;
}

window.exportToEbayXLSX = async function (items, options = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("No items selected for export.");
  }

  const exportType = typeof options === "string" ? options : options.exportType;
  const profile = getSelectedExportProfile(exportType);
  validateEbayExportItems(items, profile);
  if (profile.type === "Wristwatch") {
    const { data, error } = await supabase.functions.invoke("ebay-inventory-sync", { body: { action: "watchRequirements" } });
    if (error || !data?.ok) throw new Error("Could not verify eBay watch requirements. Try again before exporting.");
    validateEbayExportItems(items, profile, data);
  }
  if (profile.type === "Coin") {
    const coinMetadataMap = new Map();
    for (const id of new Set(items.map(item => item.coin_details.ebay.categoryId))) coinMetadataMap.set(id, await window.loadCoinEbayRequirements(id));
    options = { ...options, coinMetadataMap };
  }
  reportProgress(options, {
    title: "Loading eBay template",
    detail: `Opening ${profile.templateUrl}...`,
    processed: 0,
    total: items.length,
    percent: 8,
    visible: true
  });
  const workbook = await loadEbayTemplateWorkbook(profile.templateUrl);
  const coinHeaders = Object.entries(requiredHeaders).filter(([, header]) => !header.startsWith("C:")).map(([, header]) => header);
  if (profile.type === "Coin") for (const metadata of options.coinMetadataMap.values()) {
    for (const aspect of metadata.aspects) coinHeaders.push(`C:${aspect.localizedAspectName}`);
    for (const condition of metadata.policy.itemConditions || []) for (const descriptor of condition.conditionDescriptors || []) {
      const prefix = descriptor.conditionDescriptorConstraint?.mode === "FREE_TEXT" ? "CDA" : "CD";
      const name = descriptor.conditionDescriptorName.replace(/\s*\(optional\)/i, "");
      coinHeaders.push(`${prefix}:${name} - (ID: ${descriptor.conditionDescriptorId})`);
    }
  }
  const sheet = profile.type === "Coin" ? XLSX.utils.aoa_to_sheet([[], [], [], [...new Set(coinHeaders)]]) : profile.type === "Wristwatch"
    ? XLSX.utils.aoa_to_sheet([[], [], [], Object.entries(requiredHeaders).filter(([key]) => !["stone", "metal", "purity", "style"].includes(key)).map(([, header]) => header)])
    : workbook.Sheets[LISTINGS_SHEET_NAME];

  if (!sheet) {
    throw new Error(`The template is missing a ${LISTINGS_SHEET_NAME} sheet.`);
  }

  const headers = readListingHeaders(sheet);
  reportProgress(options, {
    title: "Preparing workbook",
    detail: "Reading the Listings headers from the eBay template...",
    processed: 0,
    total: items.length,
    percent: 15,
    visible: true
  });
  const rows = await buildListingRows(items, headers, profile, options);

  if (!rows.length) {
    throw new Error("No selected items had exportable stock quantities.");
  }

  reportProgress(options, {
    title: "Writing workbook",
    detail: `Adding ${rows.length} item row${rows.length === 1 ? "" : "s"} to the Listings sheet...`,
    processed: items.length,
    total: items.length,
    percent: 88,
    visible: true
  });
  clearExistingListingRows(sheet);
  XLSX.utils.sheet_add_aoa(sheet, rows, { origin: `A${LISTINGS_HEADER_ROW_INDEX + 2}` });

  reportProgress(options, {
    title: "Creating CSV file",
    detail: "Packaging the completed eBay upload file for download...",
    processed: items.length,
    total: items.length,
    percent: 94,
    visible: true
  });
  const csv = XLSX.utils.sheet_to_csv(sheet, {
    FS: ",",
    RS: "\r\n",
    blankrows: false
  });
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const today = new Date().toISOString().slice(0, 10);
  saveAs(blob, `ebay-${profile.slug}-export-${today}.csv`);
  reportProgress(options, {
    title: "Download ready",
    detail: `Generated ${rows.length} eBay listing row${rows.length === 1 ? "" : "s"} as a CSV upload file.`,
    processed: items.length,
    total: items.length,
    percent: 100,
    visible: true
  });
};
