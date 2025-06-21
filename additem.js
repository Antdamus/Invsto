console.log("Loaded JS")
// === GLOBALS ===
let latestDymoXml = "";
let typeqr = "";

// === AUTH CHECK ===
(async () => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.user_metadata.role !== "admin") {
    alert("You must be an admin to access this page.");
    window.location.href = "index.html";
  }
})();



// === DOM ELEMENTS ===
const qrInput = document.getElementById('qr-code');
const qrCanvas = document.getElementById('qr-canvas');
const barcodeCanvas = document.getElementById('barcode-canvas');
const barcodeInput = document.getElementById('scanned-barcode');
const qrTypeSelect = document.getElementById("qr-type");
const previewContainer = document.getElementById("carousel-preview");
const photoInput = document.getElementById("item-photo");

let uploadedImages = [];

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
        <BarcodeObject>
          <Name>BarcodeObject0</Name>
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
          <BarcodeFormat>Code128Auto</BarcodeFormat>
          <Data>
            <MultiDataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString>${barcode}</DataString>
            </MultiDataString>
          </Data>
          <HorizontalAlignment>Center</HorizontalAlignment>
          <VerticalAlignment>Middle</VerticalAlignment>
          <Size>AutoFit</Size>
          <TextPosition>Bottom</TextPosition>
          <FontInfo>
            <FontName>Arial</FontName>
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
          <ObjectLayout>
            <DYMOPoint>
              <X>0.040000137</X>
              <Y>0.06538457</Y>
            </DYMOPoint>
            <Size>
              <Width>0.65579975</Width>
              <Height>0.3084905</Height>
            </Size>
          </ObjectLayout>
        </BarcodeObject>
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
              <X>1.5987518</X>
              <Y>0.065384574</Y>
            </DYMOPoint>
            <Size>
              <Width>0.28525865</Width>
              <Height>0.32408708</Height>
            </Size>
          </ObjectLayout>
        </QRCodeObject>
        <BarcodeObject>
          <Name>BarcodeObject1</Name>
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
          <BarcodeFormat>Code128Auto</BarcodeFormat>
          <Data>
            <MultiDataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString></DataString>
              <DataString>${barcode}</DataString>
            </MultiDataString>
          </Data>
          <HorizontalAlignment>Center</HorizontalAlignment>
          <VerticalAlignment>Middle</VerticalAlignment>
          <Size>AutoFit</Size>
          <TextPosition>Bottom</TextPosition>
          <FontInfo>
            <FontName>Arial</FontName>
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
          <ObjectLayout>
            <DYMOPoint>
              <X>0.040000137</X>
              <Y>0.4655448</Y>
            </DYMOPoint>
            <Size>
              <Width>0.65077937</Width>
              <Height>0.30863044</Height>
            </Size>
          </ObjectLayout>
        </BarcodeObject>
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
              <Y>0.46554482</Y>
            </DYMOPoint>
            <Size>
              <Width>0.47392973</Width>
              <Height>0.2968756</Height>
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



const { error } = await supabase.from("item_types").insert({
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
  photos: photoUrls, // assuming 'photos' is a JSONB[] column
  dymo_label_url: window.latestDymoUrl || ""
});

if (error) {
  alert("Failed to save item: " + error.message);
} else {
  alert("✅ Item successfully added!");
  document.getElementById("add-item-form").reset();
  previewContainer.innerHTML = "";
  uploadedImages = [];
  latestDymoXml = "";
}
});