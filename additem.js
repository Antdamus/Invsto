

async function waitForSupabaseInit() {
  return new Promise((resolve) => {
    if (window.supabase) return resolve(); // already available
    document.addEventListener("supabase-ready", resolve); // wait if not yet ready
  });
}


console.log("Loaded JS")
// === GLOBALS ===
let latestDymoXml = "";
let typeqr = "";




// === DOM ELEMENTS ===
const qrInput = document.getElementById('qr-code');
const qrCanvas = document.getElementById('qr-canvas');
const barcodeCanvas = document.getElementById('barcode-canvas');
const barcodeInput = document.getElementById('scanned-barcode');
const qrTypeSelect = document.getElementById("qr-type");
const previewContainer = document.getElementById("carousel-preview");
const photoInput = document.getElementById("item-photo");
const pendingStockAssignments = {}; // { barcode: { location_name, quantity, location_id } }


let uploadedImages = [];

// === utility to show toast ===
function showToast(message) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;

  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4000);
}

// === AUTO-CALCULATE SALE PRICE ===
document.getElementById('cost')?.addEventListener('input', () => {
  const cost = parseFloat(document.getElementById('cost').value.replace(/,/g, ''));
  if (cost > 0) {
    const salePrice = Math.round(cost * 7.5);
    document.getElementById('sale-price').value = salePrice.toLocaleString("en-US");
  } else {
    document.getElementById('sale-price').value = '';
  }
});

async function fetchUniqueCategories() {
  const { data, error } = await supabase
    .from("item_types")
    .select("category")
    .neq("category", null);

  if (error) {
    console.error("❌ Failed to fetch categories:", error);
    return [];
  }

  const unique = [...new Set(data.map(row => row.category).filter(Boolean))];
  return unique.sort((a, b) => a.localeCompare(b));
}

// === utility to get the unique location ===
async function fetchUniqueLocationNames() {
  const { data, error } = await supabase
    .from("locations")
    .select("location_name")
    .neq("location_name", null);

  if (error) {
    console.error("❌ Error fetching locations:", error.message);
    return [];
  }

  const unique = [...new Set(data.map(loc => loc.location_name).filter(Boolean))];
  return unique.sort((a, b) => a.localeCompare(b));
}


/** Function that will create the html block for the drop down, insert search bar, attach listener
 * Renders a searchable dropdown and lets the caller define behavior
 * for selecting existing options or creating new ones.
 * @param {Object} config
 * @param {string} config.menuId - ID of the DOM container
 * @param {Array<string>} config.options - Array of string values to display
 * @param {string} [config.searchId="category-search"] - Search input ID
 * @param {string} [config.placeholder="Search..."] - Input placeholder text
 * @param {string} [config.optionClass="dropdown-option"] - Class for each option div
 * @param {string} [config.dataAttribute="cat"] - The data-* attribute key (e.g. "cat", "qr")
 * @param {string} [config.optionsContainerClass="dropdown-options-container"]
 * @param {Function} config.onClick - What to do when any option is clicked (new or existing)
 */
  function renderDropdownOptionsCustom({
  menuId,
  toggleButtonId,
  hiddenInputId,
  options = [],
  placeholder = "Search...",
  dataAttribute = "value",
  optionClass = "dropdown-option",
  optionsContainerClass = "dropdown-options-container",
  searchId = `${menuId}-search`,
  onClick = () => {},
  showHTMLInjected = false
}) {
  const menu = document.getElementById(menuId);
  const toggleBtn = document.getElementById(toggleButtonId);
  const hiddenInput = document.getElementById(hiddenInputId);
  if (!menu || !toggleBtn || !hiddenInput) return;

  const searchHTML = `
    <div class="dropdown-search-container">
      <input type="text" id="${searchId}" class="dropdown-search" placeholder="${placeholder}">
    </div>
  `;

  const buildOptionsHTML = (filteredOpts, searchTerm) => {
    let html = filteredOpts.map(opt => `
      <div class="${optionClass}" data-${dataAttribute}="${opt}" data-value="${opt}">
        ${opt}
      </div>
    `).join("");

    const exactMatch = options.some(opt => opt.toLowerCase() === searchTerm.toLowerCase());
    if (searchTerm && !exactMatch) {
      html += `
        <div class="${optionClass} new-entry" data-${dataAttribute}="${searchTerm}" data-value="${searchTerm}" data-new="true">
          ➕ Create "${searchTerm}"
        </div>
      `;
    }
    return html;
  };

  const fullHTML = `
    ${searchHTML}
    <div class="${optionsContainerClass}">
      ${buildOptionsHTML(options, "")}
    </div>
  `;

  if (showHTMLInjected) {
    console.log("💡 Injected dropdown HTML for", menuId);
    console.log(fullHTML);
  }

  menu.innerHTML = fullHTML;

  const input = menu.querySelector(`#${searchId}`);
  const container = menu.querySelector(`.${optionsContainerClass}`);

  const attachClickHandlers = () => {
    container.querySelectorAll(`.${optionClass}[data-${dataAttribute}]`).forEach(optionEl => {
      optionEl.addEventListener("click", () => {
        const value = optionEl.dataset.value;
        const isNew = optionEl.dataset.new === "true";

        hiddenInput.value = value;
        toggleBtn.innerText = value;

        onClick(value, isNew, optionEl);

        menu.classList.remove("show");
      });
    });
  };

  attachClickHandlers();

  input?.addEventListener("input", (e) => {
    const searchTerm = e.target.value.toLowerCase();
    container.innerHTML = buildOptionsHTML(options, searchTerm);
    requestAnimationFrame(() => attachClickHandlers());
  });
}

// === modal to add stock and location ===
function showAdminLocationStockModal(itemId) {
  const modal = document.getElementById("modal-admin-assign-location");
  document.getElementById("admin-stock-quantity").value = "";
  document.getElementById("admin-location-name").value = "";
  document.getElementById("admin-location-dropdown-toggle").innerText = "Select Location";
  modal.dataset.itemId = itemId;
  modal.classList.remove("hidden");

  populateAdminLocationDropdown();
}

function setupAdminLocationModalListeners() {
  const confirmBtn = document.getElementById("btn-confirm-admin-stock");
  const cancelBtn = document.getElementById("btn-cancel-admin-stock");

  cancelBtn.onclick = () => {
    document.getElementById("modal-admin-assign-location").classList.add("hidden");
  };

  confirmBtn.onclick = async () => {
    const barcode = document.getElementById("scanned-barcode")?.value || "temp-barcode";
    const locationName = document.getElementById("admin-location-name").value.trim();
    const quantity = parseInt(document.getElementById("admin-stock-quantity").value.trim(), 10);

    if (!locationName || isNaN(quantity)) {
      showToast("❌ Please select a location and enter quantity.");
      return;
    }

    const { data: loc, error } = await supabase
      .from("locations")
      .select("id")
      .eq("location_name", locationName)
      .single();

    if (error || !loc) {
      showToast("❌ Location not found.");
      return;
    }

    // Save for later use
    pendingStockAssignments[barcode] = {
      location_name: locationName,
      quantity,
      location_id: loc.id
    };

    showToast(`📦 Will assign ${quantity} to ${locationName} after item is saved`);
    document.getElementById("modal-admin-assign-location").classList.add("hidden");
  };

}

document.getElementById("btn-open-admin-stock")?.addEventListener("click", () => {
  // Since the item isn't saved yet, we’ll pass a placeholder ID like -1
  // You can later update this to real ID post-insert if needed
  showAdminLocationStockModal("-1");
});

async function populateAdminLocationDropdown() {
  const menu = document.getElementById("admin-location-dropdown-menu");
  const button = document.getElementById("admin-location-dropdown-toggle");
  const options = await fetchUniqueLocationNames();

  renderDropdownOptionsCustom({
    menuId: "admin-location-dropdown-menu",
    toggleButtonId: "admin-location-dropdown-toggle",
    hiddenInputId: "admin-location-name",
    options,
    placeholder: "Search or create location...",
    dataAttribute: "location",
    optionClass: "dropdown-option",
    optionsContainerClass: "dropdown-options-container",
    searchId: "admin-location-dropdown-search",
    onClick: (value, isNew, el) => {
      document.getElementById("admin-location-name").value = value;
      button.innerText = value;
    }
  });
}


document.addEventListener("click", (e) => {
  if (e.target.id === "admin-location-dropdown-toggle") {
    const menu = document.getElementById("admin-location-dropdown-menu");
    menu.classList.toggle("show");
  }
});


// === QR Code Rendering
function renderQR(url) {
  QRCode.toCanvas(qrCanvas, url, {
    errorCorrectionLevel: 'H',
    color: { dark: "#ffffff", light: "#2c2c2e" },
    width: 180
  }, err => { if (err) console.error("QR error:", err); });
}

// === Barcode Rendering
function renderBarcode(code) {
  const ctx = barcodeCanvas.getContext('2d');
  ctx.clearRect(0, 0, barcodeCanvas.width, barcodeCanvas.height);
  JsBarcode(barcodeCanvas, code, {
    format: "CODE128",
    lineColor: "#ffffff",
    background: "#2c2c2e",
    displayValue: true,
    fontOptions: "bold",
    fontSize: 16,
    height: 60,
    margin: 10
  });
}

// === QR TYPE SELECTION
qrTypeSelect?.addEventListener("change", () => {
  typeqr = qrTypeSelect.value;
  if (typeqr === "website") {
    document.getElementById("qr-code").value = "https://ogjeweler.com/";
    renderQR("https://ogjeweler.com/");
  }
});

qrInput?.addEventListener('input', () => {
  const url = qrInput.value.trim();
  if (url) renderQR(url);
});

document.getElementById('generate-barcode')?.addEventListener('click', () => {
  const code = 'OG' + Date.now();
  barcodeInput.value = code;
  renderBarcode(code);
});

// === dropdownoption=== //
document.addEventListener("click", async (e) => {
  if (e.target.id !== "category-dropdown-toggle") return;

  const menu = document.getElementById("category-dropdown-menu");

  if (!menu.dataset.populated) {
    const categories = await fetchUniqueCategories();

    renderDropdownOptionsCustom({
      menuId: "category-dropdown-menu",
      toggleButtonId: "category-dropdown-toggle",
      hiddenInputId: "category",
      options: categories,
      placeholder: "Search or create category...",
      dataAttribute: "cat",
      optionClass: "dropdown-option",
      optionsContainerClass: "category-options-container",
      searchId: "category-dropdown-search",
      onClick: (value, isNew) => {
        if (isNew) {
          showToast(`➕ Created new category: ${value}`);
        } else {
          showToast(`🏷️ Selected category: ${value}`);
        }
      }
    });

    menu.dataset.populated = "true";
  }

  menu.classList.toggle("show");
});


// === MULTI-IMAGE PREVIEW & UPLOAD ===
photoInput.addEventListener('change', () => {
  previewContainer.innerHTML = "";
  uploadedImages = [];

  [...photoInput.files].forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = document.createElement("img");
      img.src = e.target.result;
      previewContainer.appendChild(img);
    };
    reader.readAsDataURL(file);
  });
});

// === GENERATE DYMO LABEL ===
document.getElementById("generate-dymo-label").addEventListener("click", async () => {
  const barcode = barcodeInput.value || "OG" + Date.now();
  const qr = qrInput.value.trim() || (
    typeqr === "website"
      ? "https://ogjeweler.com/"
      : "https://ogjewelry.store/auth?id=" + barcode
  );
  const price = document.getElementById("sale-price").value?.replace(/,/g, '') || "0.00";

  // Replace this template block with your own XML generator
  const templateXml = `<?xml version="1.0" encoding="utf-8"?>
<DesktopLabel Version="1">
  <DYMOLabel Version="4">
    <Description>DYMO Label</Description>
    <Orientation>Portrait</Orientation>
    <LabelName>Jewelry30299</LabelName>
    <InitialLength>0</InitialLength>
    <BorderStyle>SolidLine</BorderStyle>
    <DYMORect>
      <DYMOPoint>
        <X>0.040000137</X>
        <Y>0.060000002</Y>
      </DYMOPoint>
      <Size>
        <Width>2.0433333</Width>
        <Height>0.75666666</Height>
      </Size>
    </DYMORect>
    <BorderColor>
      <SolidColorBrush>
        <Color A="1" R="0" G="0" B="0"></Color>
      </SolidColorBrush>
    </BorderColor>
    <BorderThickness>1</BorderThickness>
    <Show_Border>False</Show_Border>
    <HasFixedLength>False</HasFixedLength>
    <FixedLengthValue>0</FixedLengthValue>
    <DynamicLayoutManager>
      <RotationBehavior>ClearObjects</RotationBehavior>
      <LabelObjects>
        <QRCodeObject>
          <Name>QRCodeObject0</Name>
          <Brushes>
            <BackgroundBrush>
              <SolidColorBrush>
                <Color A="1" R="1" G="1" B="1"></Color>
              </SolidColorBrush>
            </BackgroundBrush>
            <BorderBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </BorderBrush>
            <StrokeBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </StrokeBrush>
            <FillBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </FillBrush>
          </Brushes>
          <Rotation>Rotation0</Rotation>
          <OutlineThickness>1</OutlineThickness>
          <IsOutlined>False</IsOutlined>
          <BorderStyle>SolidLine</BorderStyle>
          <Margin>
            <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
          </Margin>
          <BarcodeFormat>QRCode</BarcodeFormat>
          <Data>
            <DataString>${qr}</DataString>
          </Data>
          <HorizontalAlignment>Center</HorizontalAlignment>
          <VerticalAlignment>Middle</VerticalAlignment>
          <Size>AutoFit</Size>
          <EQRCodeType>QRCodeText</EQRCodeType>
          <TextDataHolder>
            <Value>${qr}</Value>
          </TextDataHolder>
          <ObjectLayout>
            <DYMOPoint>
              <X>1.5044161</X>
              <Y>0.06538457</Y>
            </DYMOPoint>
            <Size>
              <Width>0.28525865</Width>
              <Height>0.32408708</Height>
            </Size>
          </ObjectLayout>
        </QRCodeObject>
        <QRCodeObject>
          <Name>QRCodeObject1</Name>
          <Brushes>
            <BackgroundBrush>
              <SolidColorBrush>
                <Color A="1" R="1" G="1" B="1"></Color>
              </SolidColorBrush>
            </BackgroundBrush>
            <BorderBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </BorderBrush>
            <StrokeBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </StrokeBrush>
            <FillBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </FillBrush>
          </Brushes>
          <Rotation>Rotation0</Rotation>
          <OutlineThickness>1</OutlineThickness>
          <IsOutlined>False</IsOutlined>
          <BorderStyle>SolidLine</BorderStyle>
          <Margin>
            <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
          </Margin>
          <BarcodeFormat>QRCode</BarcodeFormat>
          <Data>
            <DataString>${qr}</DataString>
          </Data>
          <HorizontalAlignment>Center</HorizontalAlignment>
          <VerticalAlignment>Middle</VerticalAlignment>
          <Size>AutoFit</Size>
          <EQRCodeType>QRCodeText</EQRCodeType>
          <TextDataHolder>
            <Value>${qr}</Value>
          </TextDataHolder>
          <ObjectLayout>
            <DYMOPoint>
              <X>1.5044161</X>
              <Y>0.47906214</Y>
            </DYMOPoint>
            <Size>
              <Width>0.3110023</Width>
              <Height>0.29687557</Height>
            </Size>
          </ObjectLayout>
        </QRCodeObject>
        <TextObject>
          <Name>TextObject0</Name>
          <Brushes>
            <BackgroundBrush>
              <SolidColorBrush>
                <Color A="0" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </BackgroundBrush>
            <BorderBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </BorderBrush>
            <StrokeBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </StrokeBrush>
            <FillBrush>
              <SolidColorBrush>
                <Color A="0" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </FillBrush>
          </Brushes>
          <Rotation>Rotation90</Rotation>
          <OutlineThickness>1</OutlineThickness>
          <IsOutlined>False</IsOutlined>
          <BorderStyle>SolidLine</BorderStyle>
          <Margin>
            <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
          </Margin>
          <HorizontalAlignment>Center</HorizontalAlignment>
          <VerticalAlignment>Bottom</VerticalAlignment>
          <FitMode>None</FitMode>
          <IsVertical>False</IsVertical>
          <FormattedText>
            <FitMode>None</FitMode>
            <HorizontalAlignment>Center</HorizontalAlignment>
            <VerticalAlignment>Bottom</VerticalAlignment>
            <IsVertical>False</IsVertical>
            <LineTextSpan>
              <TextSpan>
                <Text>$${price}</Text>
                <FontInfo>
                  <FontName>Segoe UI</FontName>
                  <FontSize>6</FontSize>
                  <IsBold>False</IsBold>
                  <IsItalic>False</IsItalic>
                  <IsUnderline>False</IsUnderline>
                  <FontBrush>
                    <SolidColorBrush>
                      <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                  </FontBrush>
                </FontInfo>
              </TextSpan>
            </LineTextSpan>
          </FormattedText>
          <ObjectLayout>
            <DYMOPoint>
              <X>1.8935279</X>
              <Y>0.06538457</Y>
            </DYMOPoint>
            <Size>
              <Width>0.125</Width>
              <Height>0.36014307</Height>
            </Size>
          </ObjectLayout>
        </TextObject>
        <TextObject>
          <Name>TextObject1</Name>
          <Brushes>
            <BackgroundBrush>
              <SolidColorBrush>
                <Color A="0" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </BackgroundBrush>
            <BorderBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </BorderBrush>
            <StrokeBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </StrokeBrush>
            <FillBrush>
              <SolidColorBrush>
                <Color A="0" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </FillBrush>
          </Brushes>
          <Rotation>Rotation90</Rotation>
          <OutlineThickness>1</OutlineThickness>
          <IsOutlined>False</IsOutlined>
          <BorderStyle>SolidLine</BorderStyle>
          <Margin>
            <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
          </Margin>
          <HorizontalAlignment>Center</HorizontalAlignment>
          <VerticalAlignment>Bottom</VerticalAlignment>
          <FitMode>None</FitMode>
          <IsVertical>False</IsVertical>
          <FormattedText>
            <FitMode>None</FitMode>
            <HorizontalAlignment>Center</HorizontalAlignment>
            <VerticalAlignment>Bottom</VerticalAlignment>
            <IsVertical>False</IsVertical>
            <LineTextSpan>
              <TextSpan>
                <Text>$${price}</Text>
                <FontInfo>
                  <FontName>Segoe UI</FontName>
                  <FontSize>6</FontSize>
                  <IsBold>False</IsBold>
                  <IsItalic>False</IsItalic>
                  <IsUnderline>False</IsUnderline>
                  <FontBrush>
                    <SolidColorBrush>
                      <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                  </FontBrush>
                </FontInfo>
              </TextSpan>
            </LineTextSpan>
          </FormattedText>
          <ObjectLayout>
            <DYMOPoint>
              <X>1.9046868</X>
              <Y>0.43833333</Y>
            </DYMOPoint>
            <Size>
              <Width>0.125</Width>
              <Height>0.3783332</Height>
            </Size>
          </ObjectLayout>
        </TextObject>
        <TextObject>
          <Name>TextObject2</Name>
          <Brushes>
            <BackgroundBrush>
              <SolidColorBrush>
                <Color A="0" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </BackgroundBrush>
            <BorderBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </BorderBrush>
            <StrokeBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </StrokeBrush>
            <FillBrush>
              <SolidColorBrush>
                <Color A="0" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </FillBrush>
          </Brushes>
          <Rotation>Rotation90</Rotation>
          <OutlineThickness>1</OutlineThickness>
          <IsOutlined>False</IsOutlined>
          <BorderStyle>SolidLine</BorderStyle>
          <Margin>
            <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
          </Margin>
          <HorizontalAlignment>Center</HorizontalAlignment>
          <VerticalAlignment>Bottom</VerticalAlignment>
          <FitMode>None</FitMode>
          <IsVertical>False</IsVertical>
          <FormattedText>
            <FitMode>None</FitMode>
            <HorizontalAlignment>Center</HorizontalAlignment>
            <VerticalAlignment>Bottom</VerticalAlignment>
            <IsVertical>False</IsVertical>
            <LineTextSpan>
              <TextSpan>
                <Text>${typeqr}</Text>
                <FontInfo>
                  <FontName>Segoe UI</FontName>
                  <FontSize>4</FontSize>
                  <IsBold>False</IsBold>
                  <IsItalic>False</IsItalic>
                  <IsUnderline>False</IsUnderline>
                  <FontBrush>
                    <SolidColorBrush>
                      <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                  </FontBrush>
                </FontInfo>
              </TextSpan>
            </LineTextSpan>
          </FormattedText>
          <ObjectLayout>
            <DYMOPoint>
              <X>1.4095135</X>
              <Y>0.059999704</Y>
            </DYMOPoint>
            <Size>
              <Width>0.12500004</Width>
              <Height>0.3783333</Height>
            </Size>
          </ObjectLayout>
        </TextObject>
        <TextObject>
          <Name>TextObject3</Name>
          <Brushes>
            <BackgroundBrush>
              <SolidColorBrush>
                <Color A="0" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </BackgroundBrush>
            <BorderBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </BorderBrush>
            <StrokeBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </StrokeBrush>
            <FillBrush>
              <SolidColorBrush>
                <Color A="0" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </FillBrush>
          </Brushes>
          <Rotation>Rotation90</Rotation>
          <OutlineThickness>1</OutlineThickness>
          <IsOutlined>False</IsOutlined>
          <BorderStyle>SolidLine</BorderStyle>
          <Margin>
            <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
          </Margin>
          <HorizontalAlignment>Center</HorizontalAlignment>
          <VerticalAlignment>Bottom</VerticalAlignment>
          <FitMode>None</FitMode>
          <IsVertical>False</IsVertical>
          <FormattedText>
            <FitMode>None</FitMode>
            <HorizontalAlignment>Center</HorizontalAlignment>
            <VerticalAlignment>Bottom</VerticalAlignment>
            <IsVertical>False</IsVertical>
            <LineTextSpan>
              <TextSpan>
                <Text>${typeqr}</Text>
                <FontInfo>
                  <FontName>Segoe UI</FontName>
                  <FontSize>4</FontSize>
                  <IsBold>False</IsBold>
                  <IsItalic>False</IsItalic>
                  <IsUnderline>False</IsUnderline>
                  <FontBrush>
                    <SolidColorBrush>
                      <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                  </FontBrush>
                </FontInfo>
              </TextSpan>
            </LineTextSpan>
          </FormattedText>
          <ObjectLayout>
            <DYMOPoint>
              <X>1.4095135</X>
              <Y>0.43833333</Y>
            </DYMOPoint>
            <Size>
              <Width>0.125</Width>
              <Height>0.3783333</Height>
            </Size>
          </ObjectLayout>
        </TextObject>
        <QRCodeObject>
          <Name>QRCodeObject2</Name>
          <Brushes>
            <BackgroundBrush>
              <SolidColorBrush>
                <Color A="1" R="1" G="1" B="1"></Color>
              </SolidColorBrush>
            </BackgroundBrush>
            <BorderBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </BorderBrush>
            <StrokeBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </StrokeBrush>
            <FillBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </FillBrush>
          </Brushes>
          <Rotation>Rotation0</Rotation>
          <OutlineThickness>1</OutlineThickness>
          <IsOutlined>False</IsOutlined>
          <BorderStyle>SolidLine</BorderStyle>
          <Margin>
            <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
          </Margin>
          <BarcodeFormat>QRCode</BarcodeFormat>
          <Data>
            <DataString>${barcode}</DataString>
          </Data>
          <HorizontalAlignment>Center</HorizontalAlignment>
          <VerticalAlignment>Middle</VerticalAlignment>
          <Size>AutoFit</Size>
          <EQRCodeType>QRCodeText</EQRCodeType>
          <TextDataHolder>
            <Value>${barcode}</Value>
          </TextDataHolder>
          <ObjectLayout>
            <DYMOPoint>
              <X>0.26554355</X>
              <Y>0.47743064</Y>
            </DYMOPoint>
            <Size>
              <Width>0.30536497</Width>
              <Height>0.30013865</Height>
            </Size>
          </ObjectLayout>
        </QRCodeObject>
        <QRCodeObject>
          <Name>QRCodeObject3</Name>
          <Brushes>
            <BackgroundBrush>
              <SolidColorBrush>
                <Color A="1" R="1" G="1" B="1"></Color>
              </SolidColorBrush>
            </BackgroundBrush>
            <BorderBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </BorderBrush>
            <StrokeBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </StrokeBrush>
            <FillBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </FillBrush>
          </Brushes>
          <Rotation>Rotation0</Rotation>
          <OutlineThickness>1</OutlineThickness>
          <IsOutlined>False</IsOutlined>
          <BorderStyle>SolidLine</BorderStyle>
          <Margin>
            <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
          </Margin>
          <BarcodeFormat>QRCode</BarcodeFormat>
          <Data>
            <DataString>${barcode}</DataString>
          </Data>
          <HorizontalAlignment>Center</HorizontalAlignment>
          <VerticalAlignment>Middle</VerticalAlignment>
          <Size>AutoFit</Size>
          <EQRCodeType>QRCodeText</EQRCodeType>
          <TextDataHolder>
            <Value>${barcode}</Value>
          </TextDataHolder>
          <ObjectLayout>
            <DYMOPoint>
              <X>0.2628106</X>
              <Y>0.09862068</Y>
            </DYMOPoint>
            <Size>
              <Width>0.308098</Width>
              <Height>0.290851</Height>
            </Size>
          </ObjectLayout>
        </QRCodeObject>
        <TextObject>
          <Name>TextObject4</Name>
          <Brushes>
            <BackgroundBrush>
              <SolidColorBrush>
                <Color A="0" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </BackgroundBrush>
            <BorderBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </BorderBrush>
            <StrokeBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </StrokeBrush>
            <FillBrush>
              <SolidColorBrush>
                <Color A="0" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </FillBrush>
          </Brushes>
          <Rotation>Rotation90</Rotation>
          <OutlineThickness>1</OutlineThickness>
          <IsOutlined>False</IsOutlined>
          <BorderStyle>SolidLine</BorderStyle>
          <Margin>
            <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
          </Margin>
          <HorizontalAlignment>Center</HorizontalAlignment>
          <VerticalAlignment>Bottom</VerticalAlignment>
          <FitMode>None</FitMode>
          <IsVertical>False</IsVertical>
          <FormattedText>
            <FitMode>None</FitMode>
            <HorizontalAlignment>Center</HorizontalAlignment>
            <VerticalAlignment>Bottom</VerticalAlignment>
            <IsVertical>False</IsVertical>
            <LineTextSpan>
              <TextSpan>
                <Text>barcode</Text>
                <FontInfo>
                  <FontName>Segoe UI</FontName>
                  <FontSize>4</FontSize>
                  <IsBold>False</IsBold>
                  <IsItalic>False</IsItalic>
                  <IsUnderline>False</IsUnderline>
                  <FontBrush>
                    <SolidColorBrush>
                      <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                  </FontBrush>
                </FontInfo>
              </TextSpan>
            </LineTextSpan>
          </FormattedText>
          <ObjectLayout>
            <DYMOPoint>
              <X>0.13781057</X>
              <Y>0.05999986</Y>
            </DYMOPoint>
            <Size>
              <Width>0.12500001</Width>
              <Height>0.3783335</Height>
            </Size>
          </ObjectLayout>
        </TextObject>
        <TextObject>
          <Name>TextObject5</Name>
          <Brushes>
            <BackgroundBrush>
              <SolidColorBrush>
                <Color A="0" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </BackgroundBrush>
            <BorderBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </BorderBrush>
            <StrokeBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </StrokeBrush>
            <FillBrush>
              <SolidColorBrush>
                <Color A="0" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </FillBrush>
          </Brushes>
          <Rotation>Rotation90</Rotation>
          <OutlineThickness>1</OutlineThickness>
          <IsOutlined>False</IsOutlined>
          <BorderStyle>SolidLine</BorderStyle>
          <Margin>
            <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
          </Margin>
          <HorizontalAlignment>Center</HorizontalAlignment>
          <VerticalAlignment>Bottom</VerticalAlignment>
          <FitMode>None</FitMode>
          <IsVertical>False</IsVertical>
          <FormattedText>
            <FitMode>None</FitMode>
            <HorizontalAlignment>Center</HorizontalAlignment>
            <VerticalAlignment>Bottom</VerticalAlignment>
            <IsVertical>False</IsVertical>
            <LineTextSpan>
              <TextSpan>
                <Text>barcode</Text>
                <FontInfo>
                  <FontName>Segoe UI</FontName>
                  <FontSize>4</FontSize>
                  <IsBold>False</IsBold>
                  <IsItalic>False</IsItalic>
                  <IsUnderline>False</IsUnderline>
                  <FontBrush>
                    <SolidColorBrush>
                      <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                  </FontBrush>
                </FontInfo>
              </TextSpan>
            </LineTextSpan>
          </FormattedText>
          <ObjectLayout>
            <DYMOPoint>
              <X>0.13781057</X>
              <Y>0.43833315</Y>
            </DYMOPoint>
            <Size>
              <Width>0.12500001</Width>
              <Height>0.378334</Height>
            </Size>
          </ObjectLayout>
        </TextObject>
      </LabelObjects>
    </DynamicLayoutManager>
  </DYMOLabel>
  <LabelApplication>Blank</LabelApplication>
  <DataTable>
    <Columns></Columns>
    <Rows></Rows>
  </DataTable>
</DesktopLabel>`;

  latestDymoXml = templateXml;

// Download
const blob = new Blob([templateXml], { type: "application/octet-stream" });
const url = URL.createObjectURL(blob);
const a = document.createElement("a");
a.href = url;
a.download = "OGJewelryLabel.dymo";
document.body.appendChild(a);
a.click();
document.body.removeChild(a);
URL.revokeObjectURL(url);

// Upload
const labelPath = `labels/${Date.now()}_OGJewelryLabel.dymo`; // ✅ add folder prefix
// Upload to Supabase
const { error: uploadError } = await supabase
  .storage
  .from("dymo-labels")
  .upload(labelPath, blob, {
    upsert: true,
    contentType: "application/octet-stream"
  });

if (uploadError) {
  console.error("❌ Failed to upload DYMO label:", uploadError.message);
  alert("Failed to upload DYMO label.");
  return;
}

const { data } = await supabase.auth.getUser();
console.log("🧾 JWT Payload:", data?.user?.user_metadata);

// ✅ Store the path only — not the signed URL
window.latestDymoUrl = labelPath;

document.getElementById("dymo-status").innerText =
  "✅ DYMO label uploaded & path saved.";

});

//== run the add location modal only if the user is an admin
if (window.currentUser && window.currentUser.user_metadata?.role === "admin") {
  setupAdminLocationModalListeners();
}

// === FORM SUBMIT ===
document.getElementById("add-item-form")?.addEventListener("submit", async (e) => {
e.preventDefault();

const title = document.getElementById("title").value.trim();
const description = document.getElementById("description").value.trim();
const weight = parseFloat(document.getElementById("weight").value);
// force sync dropdown selection into hidden input if user typed or skipped selection
const categoryButton = document.getElementById("category-dropdown-toggle");
const categoryHiddenInput = document.getElementById("category");
if (!categoryHiddenInput.value && categoryButton.innerText !== "Select or Create Category") {
  categoryHiddenInput.value = categoryButton.innerText.trim();
}
const categoryInput = document.getElementById("category").value.trim();
const categories = categoryInput ? [categoryInput] : [];
const cost = parseFloat(document.getElementById("cost").value.replace(/,/g, ''));
const sale_price = parseFloat(document.getElementById("sale-price").value.replace(/,/g, ''));
const distributor_name = document.getElementById("distributor-name").value.trim();
const distributor_phone = document.getElementById("distributor-phone").value.trim();
const distributor_notes = document.getElementById("distributor-notes").value.trim();
const qr_code = document.getElementById("qr-code").value.trim();
const barcode = barcodeInput.value;

const photoFiles = photoInput.files;
const photoUrls = [];
const photoStatus = document.getElementById("photo-status");
photoStatus.innerHTML = ""; // Clear previous messages

for (const file of photoFiles) {
  const path = `item_photos/${Date.now()}_${file.name}`;

  const { error: uploadError } = await supabase
    .storage
    .from('photos')
    .upload(path, file, { upsert: true });

  if (uploadError) {
    console.error(`Upload photo failed for ${file.name}:`, uploadError.message);
    photoStatus.innerHTML += `❌ Failed to upload <strong>${file.name}</strong>: ${uploadError.message}<br>`;
    continue;
  }

  // ✅ Store only the path, not signed URL
  photoUrls.push(path);
  photoStatus.innerHTML += `✅ Uploaded <strong>${file.name}</strong><br>`;
}



const { data: insertedItems, error } = await supabase
  .from("item_types")
  .insert({
    title,
    description,
    weight,
    categories,
    cost,
    sale_price,
    distributor_name,
    distributor_phone,
    distributor_notes,
    qr_type: typeqr,
    qr_code,
    barcode,
    photos: photoUrls,
    dymo_label_url: window.latestDymoUrl || ""
  })
  .select()
  .limit(1);

if (error || !insertedItems || insertedItems.length === 0) {
  alert("Failed to save item: " + (error?.message || "Unknown error"));
  return;
}

const newItem = insertedItems[0];
const stockInfo = pendingStockAssignments[newItem.barcode];

if (stockInfo) {
  const stockInsert = await supabase.from("item_stock_locations").insert({
    item_id: newItem.id,
    location_id: stockInfo.location_id,
    quantity: stockInfo.quantity,
    added_by: currentUser.id,
    confirmation_email: currentUser.email,
    confirmed_at: new Date().toISOString()
  });

  const stockLog = await supabase.from("stock_transactions").insert({
    item_id: newItem.id,
    location_id: stockInfo.location_id,
    quantity: stockInfo.quantity,
    action_type: "add",
    user_id: currentUser.id,
    timestamp: new Date().toISOString()
  });

  if (stockInsert.error || stockLog.error) {
    console.warn("⚠️ Stock added but not logged properly:", stockInsert.error, stockLog.error);
    showToast("⚠️ Stock saved, but transaction log might be missing.");
  } else {
    showToast(`✅ Saved ${stockInfo.quantity} units to ${stockInfo.location_name}`);
  }

  // Clean up
  delete pendingStockAssignments[newItem.barcode];
}

alert("✅ Item successfully added!");
document.getElementById("add-item-form").reset();
previewContainer.innerHTML = "";
uploadedImages = [];
latestDymoXml = "";
});


// === DOM Loader ===
document.addEventListener("DOMContentLoaded", async () => {
  await waitForSupabaseInit(); // ✅ Supabase is initialized

  try {
    const { data, error } = await supabase.auth.getUser();
    const user = data?.user;

    if (!user || user.user_metadata?.role !== "admin") {
      alert("You must be an admin to access this page.");
      window.location.href = "index.html";
      return;
    }

    window.currentUser = user;
    document.getElementById("btn-open-admin-stock")?.classList.remove("hidden");
    setupAdminLocationModalListeners();
  } catch (err) {
    alert("Authentication error. Please try logging in again.");
    console.error("❌ Auth error:", err);
    window.location.href = "index.html";
  }
});
