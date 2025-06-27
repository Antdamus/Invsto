// ebayExport.js - Load, Modify, and Save Existing Excel Template
// Requires SheetJS + FileSaver.js loaded via CDN

const requiredHeaders = {
  action: "*Action(SiteID=US|Country=US|Currency=USD|Version=1193)",
  category: "Category name",
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

async function getPublicImageUrl(privatePath) {
  if (!privatePath) return "";

  const filename = privatePath.split("/").pop();
  const sourcePath = privatePath.includes("item_photos/")
    ? privatePath
    : `item_photos/${filename}`; // path inside 'photos' bucket

  try {
    // ✅ Check if file already exists in the separate public bucket
    const { data: existingFiles, error: listError } = await supabase.storage
      .from("public-ebay-photos")
      .list("", { search: filename });

    if (listError) {
      console.warn("Error checking public-ebay-photos bucket:", listError.message);
    }

    const alreadyExists = existingFiles?.some(file => file.name === filename);
    if (!alreadyExists) {
      // ✅ This copies the file from one bucket to another
      const { error: moveError } = await supabase.storage
        .from("photos")
        .move(sourcePath, `../public-ebay-photos/${filename}`); // <- THIS is invalid and the cause before

      // ❌ That .move path does NOT allow cross-bucket moves. Instead:
      // You need to use download + upload for cross-bucket logic like this:
      const { data: fileData, error: downloadError } = await supabase
        .storage
        .from("photos")
        .download(sourcePath);

      if (downloadError) {
        console.error("Failed to download image from 'photos':", downloadError.message);
        return "";
      }

      const upload = await supabase.storage
        .from("public-ebay-photos")
        .upload(filename, fileData, {
          upsert: true,
          contentType: "image/jpeg"
        });

      if (upload.error) {
        console.error("❌ Upload to public-ebay-photos failed:", upload.error.message);
        return "";
      }

      console.log(`✅ Uploaded ${filename} to public-ebay-photos`);
    } else {
      console.log(`⚠️ ${filename} already exists in public-ebay-photos`);
    }

    return `https://byhytmarmigalvawkedi.supabase.co/storage/v1/object/public/public-ebay-photos/${filename}`;
  } catch (err) {
    console.error("Unhandled error in getPublicImageUrl:", err);
    return "";
  }
}


window.exportToEbayXLSX = async function (items) {
  const input = document.getElementById("base-ebay-template");
  if (!input?.files?.length) {
    alert("Please upload the base eBay template first.");
    return;
  }

  const file = input.files[0];
  const reader = new FileReader();
  reader.onload = async (e) => {
    const data = new Uint8Array(e.target.result);
    const workbook = XLSX.read(data, { type: "array" });
    const sheet = workbook.Sheets["Listings"]; // assuming it's called Listings
    const json = XLSX.utils.sheet_to_json(sheet, { header: 1, range: 3 }); // start from row 4 (0-based index)

    const headers = json[0];
    const output = [headers];

    for (const item of items) {
      const row = new Array(headers.length).fill("");

      const photoPath = (item.photoPaths || item.photos || [])[0] || null;
      const imageUrl = await getPublicImageUrl(photoPath);

      row[headers.indexOf(requiredHeaders.action)] = "Add";
      row[headers.indexOf(requiredHeaders.category)] = "/Jewelry & Watches/Fine Jewelry/Necklaces & Pendants";
      row[headers.indexOf(requiredHeaders.title)] = item.title || "";
      row[headers.indexOf(requiredHeaders.startPrice)] = item.sale_price || 0;
      row[headers.indexOf(requiredHeaders.quantity)] = item.total_quantity || 1;
      row[headers.indexOf(requiredHeaders.photoUrl)] = imageUrl;
      row[headers.indexOf(requiredHeaders.condition)] = "1000-New with tags";
      row[headers.indexOf(requiredHeaders.description)] = item.description || "";
      row[headers.indexOf(requiredHeaders.format)] = "FixedPrice";
      row[headers.indexOf(requiredHeaders.duration)] = "GTC";
      row[headers.indexOf(requiredHeaders.location)] = "Miami, FL";
      row[headers.indexOf(requiredHeaders.shippingProfile)] = "ShippingPolicySmall - (ID: 238665669025)";
      row[headers.indexOf(requiredHeaders.returnProfile)] = "ReturnedItemsPolicy - (ID: 238665578025)";
      row[headers.indexOf(requiredHeaders.paymentProfile)] = "CostumerPaymentPolicy - (ID: 238665517025)";
      row[headers.indexOf(requiredHeaders.brand)] = "Unbranded";
      row[headers.indexOf(requiredHeaders.stone)] = "Unknown";
      row[headers.indexOf(requiredHeaders.metal)] = "Fine Silver";
      row[headers.indexOf(requiredHeaders.purity)] = "925";
      row[headers.indexOf(requiredHeaders.style)] = "Pendant";
      row[headers.indexOf(requiredHeaders.type)] = "Pendant";

      output.push(row);
    }

    const newSheet = XLSX.utils.aoa_to_sheet(output);
    const newWb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(newWb, newSheet, "eBayExport");

    const wbout = XLSX.write(newWb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([wbout], { type: "application/octet-stream" });
    saveAs(blob, "PendantListing-filled.xlsx");
  };

  reader.readAsArrayBuffer(file);
};
