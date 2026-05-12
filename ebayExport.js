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
  type: "C:Type"
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
  const indexes = getHeaderIndexes(headers);
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

    const row = new Array(headers.length).fill("");
    setRowValue(row, indexes, "action", "Add");
    setRowValue(row, indexes, "sku", item.barcode || "");
    setRowValue(row, indexes, "categoryId", profile.categoryId);
    setRowValue(row, indexes, "categoryName", profile.categoryName);
    setRowValue(row, indexes, "title", item.title || "");
    setRowValue(row, indexes, "startPrice", item.sale_price || 0);
    setRowValue(row, indexes, "quantity", totalQty);
    setRowValue(row, indexes, "photoUrl", await getPublicImageUrls(item));
    setRowValue(row, indexes, "condition", profile.condition);
    setRowValue(row, indexes, "description", item.description || "");
    setRowValue(row, indexes, "format", "FixedPrice");
    setRowValue(row, indexes, "duration", "GTC");
    setRowValue(row, indexes, "location", "Miami, FL");
    setRowValue(row, indexes, "shippingProfile", profile.shippingProfile);
    setRowValue(row, indexes, "returnProfile", profile.returnProfile);
    setRowValue(row, indexes, "paymentProfile", profile.paymentProfile);
    setRowValue(row, indexes, "brand", "Unbranded");
    setRowValue(row, indexes, "stone", "Unknown");
    setRowValue(row, indexes, "metal", "Fine Silver");
    setRowValue(row, indexes, "purity", "925");
    setRowValue(row, indexes, "style", profile.style);
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
  reportProgress(options, {
    title: "Loading eBay template",
    detail: `Opening ${profile.templateUrl}...`,
    processed: 0,
    total: items.length,
    percent: 8,
    visible: true
  });
  const workbook = await loadEbayTemplateWorkbook(profile.templateUrl);
  const sheet = workbook.Sheets[LISTINGS_SHEET_NAME];

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
