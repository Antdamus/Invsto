// ebayExport.js
// Requires: SheetJS (xlsx), FileSaver, Supabase client loaded globally

const SUPABASE_PROJECT_URL = "https://byhytmarmigalvawkedi.supabase.co";
const PUBLIC_BUCKET = "public-ebay-photos";
const PRIVATE_BUCKET = "item-photos";

async function getPublicImageUrl(privatePath) {
  if (!privatePath) return "";
  const filename = privatePath.split("/").pop();

  // Step 1: Check if file already exists in public bucket
  try {
    const { data: existingFiles, error: listError } = await supabase.storage
      .from(PUBLIC_BUCKET)
      .list("", { search: filename });

    const alreadyExists = existingFiles?.some(file => file.name === filename);

    if (!alreadyExists) {
      // Step 2: Copy it from private bucket
      const { error: copyError } = await supabase.storage
        .from(PRIVATE_BUCKET)
        .copy(privatePath, `${PUBLIC_BUCKET}/${filename}`);

      if (copyError && !copyError.message.includes("already exists")) {
        console.warn("⚠️ Copy to public bucket failed:", copyError);
      }
    }
  } catch (err) {
    console.warn("🚫 Error checking/copying to public bucket:", err);
  }

  return `${SUPABASE_PROJECT_URL}/storage/v1/object/public/${PUBLIC_BUCKET}/${filename}`;
}

async function exportToEbayXLSX(items) {
  if (!Array.isArray(items) || items.length === 0) {
    alert("No items selected for eBay export.");
    return;
  }

  const headers = [
    "*Action(SiteID=US|Country=US|Currency=USD|Version=1193)",
    "Category name",
    "Title",
    "Start price",
    "Quantity",
    "Item photo URL",
    "Condition ID",
    "Description",
    "Format",
    "Duration",
    "Location",
    "Shipping profile name",
    "Return profile name",
    "Payment profile name",
    "C:Brand",
    "C:Main Stone",
    "C:Metal",
    "C:Metal Purity",
    "C:Style",
    "C:Type"
  ];

  const dataRows = await Promise.all(
    items.map(async (item) => {
      const photoPath = (item.photoPaths || item.photos || [])[0] || null;
      const publicImageUrl = await getPublicImageUrl(photoPath);

      return [
        "Add",
        "/Jewelry & Watches/Fine Jewelry/Necklaces & Pendants",
        item.title || "Untitled",
        item.sale_price || 0,
        item.total_quantity || 1,
        publicImageUrl || "https://placehold.co/300x300?text=No+Image",
        "1000-New with tags",
        item.description || "Handcrafted pendant jewelry.",
        "FixedPrice",
        "GTC",
        "Miami, FL",
        "ShippingPolicySmall - (ID: 238665669025)",
        "ReturnedItemsPolicy - (ID: 238665578025)",
        "CostumerPaymentPolicy - (ID: 238665517025)",
        "Unbranded",
        "Unknown",
        "Fine Silver",
        "925",
        "Pendant",
        "Pendant"
      ];
    })
  );

  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "eBayExport");

  const wbout = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
  const blob = new Blob([wbout], { type: "application/octet-stream" });
  saveAs(blob, "PendantListing.xlsx");
}

// Attach to global for triggering
window.exportToEbayXLSX = exportToEbayXLSX;
