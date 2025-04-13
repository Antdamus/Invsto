// === AUTH PROTECTION ===
(async () => {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (!user || user.user_metadata.role !== 'admin') {
    alert('You must be an admin to access this page.');
    window.location.href = 'index.html';
  }
})();

// === GLOBAL ELEMENTS ===
const qrInput = document.getElementById('qr-code');
const qrCanvas = document.getElementById('qr-canvas');
const barcodeCanvas = document.getElementById('barcode-canvas');
const barcodeInput = document.getElementById('scanned-barcode');
let latestDymoXml = ""; // Will be filled when label is generated

// === SALE PRICE AUTO-CALCULATION ===
document.getElementById('cost')?.addEventListener('input', () => {
  const cost = parseFloat(document.getElementById('cost').value.replace(/,/g, ''));
  if (cost > 0) {
    const salePrice = Math.round(cost * 7.5);
    document.getElementById('sale-price').value = salePrice.toLocaleString("en-US");
  } else {
    document.getElementById('sale-price').value = '';
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

// === QR Live Update
qrInput?.addEventListener('input', () => {
  const url = qrInput.value.trim();
  if (url) renderQR(url);
});

// === Generate Barcode Button
document.getElementById('generate-barcode')?.addEventListener('click', () => {
  const code = 'OG' + Date.now();
  barcodeInput.value = code;
  renderBarcode(code);
});

// === QR TYPE SELECT
let typeqr = "";
const qrTypeSelect = document.getElementById("qr-type");
qrTypeSelect?.addEventListener("change", () => {
  typeqr = qrTypeSelect.value;
  if (typeqr === "website") {
    document.getElementById("qr-code").value = "https://ogjeweler.com/";
    renderQR("https://ogjeweler.com/");
  }
});

// === File Preview
document.getElementById("item-photo").addEventListener("change", (event) => {
  const file = event.target.files[0];
  const preview = document.getElementById("photo-preview");
  if (file) {
    const reader = new FileReader();
    reader.onload = function (e) {
      preview.src = e.target.result;
      preview.style.display = "block";
      preview.style.opacity = 0;
      setTimeout(() => (preview.style.opacity = 1), 50);
    };
    reader.readAsDataURL(file);
  } else {
    preview.style.display = "none";
    preview.src = "";
  }
});

// === DOWNLOAD DYMO & SAVE XML
document.getElementById("download-label").addEventListener("click", () => {
  const barcode = document.getElementById("scanned-barcode").value || "OG" + Date.now();
  const qr = document.getElementById("qr-code").value?.trim() || (
    typeqr === "website"
      ? "https://ogjeweler.com/"
      : "https://ogjewelry.store/auth?id=" + barcode
  );
  const price = document.getElementById("sale-price").value || "0.00";

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

  latestDymoXml = labelXml;

  // Offer file to user
  const blob = new Blob([labelXml], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "OGJewelryLabel.dymo";
  a.click();
});

// === FORM SUBMIT – Save Item Type to Supabase
document.getElementById('add-item-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();

  const title = document.getElementById("title").value.trim();
  const description = document.getElementById("description").value.trim();
  const weight = parseFloat(document.getElementById("weight").value);
  const category = document.getElementById("category").value;
  const cost = parseFloat(document.getElementById("cost").value.replace(/,/g, ''));
  const sale_price = parseFloat(document.getElementById("sale-price").value.replace(/,/g, ''));
  const distributor_name = document.getElementById("distributor-name").value.trim();
  const distributor_phone = document.getElementById("distributor-phone").value.trim();
  const distributor_notes = document.getElementById("distributor-notes").value.trim();
  const qr_type = typeqr;
  const qr_code = document.getElementById("qr-code").value.trim();
  const barcode = document.getElementById("scanned-barcode").value;
  let photo_url = null;
  let dymo_label_url = null;

  // === Upload photo
  const fileInput = document.getElementById("item-photo");
  const file = fileInput?.files[0];
  if (file) {
    const filePath = `item_photos/${Date.now()}_${file.name}`;
    const { error: uploadError } = await supabase.storage.from('photos').upload(filePath, file);
    if (uploadError) {
      alert("Failed to upload image: " + uploadError.message);
      return;
    }
    const { data: publicUrlData } = supabase.storage.from('photos').getPublicUrl(filePath);
    photo_url = publicUrlData.publicUrl;
  }

  // === Upload DYMO Label
  if (latestDymoXml) {
    const filePath = `labels/${Date.now()}_${title.replace(/\s+/g, "_")}.dymo`;
    const labelBlob = new Blob([latestDymoXml], { type: 'application/octet-stream' });
    const { error: labelUploadError } = await supabase.storage.from('dymo-labels').upload(filePath, labelBlob);
    if (labelUploadError) {
      alert("Failed to upload DYMO file: " + labelUploadError.message);
      return;
    }
    const { data: labelUrlData } = supabase.storage.from('dymo-labels').getPublicUrl(filePath);
    dymo_label_url = labelUrlData.publicUrl;
  }

  // === Insert into DB
  const { error } = await supabase.from('item_types').insert({
    title,
    description,
    weight,
    category,
    cost,
    sale_price,
    distributor_name,
    distributor_phone,
    distributor_notes,
    qr_type,
    qr_code,
    barcode,
    photo_url,
    dymo_label_url
  });

  if (error) {
    alert("Failed to save item: " + error.message);
  } else {
    alert("Item type successfully added!");
    document.getElementById("add-item-form").reset();
    document.getElementById("photo-preview").style.display = "none";
    latestDymoXml = "";
  }
});
