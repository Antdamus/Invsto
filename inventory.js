const qrInput = document.getElementById('qr-code');
const qrCanvas = document.getElementById('qr-canvas');
const barcodeCanvas = document.getElementById('barcode-canvas');
const barcodeInput = document.getElementById('scanned-barcode');

// === Auto-calculate sale price ===
document.getElementById('cost')?.addEventListener('input', () => {
  const cost = parseFloat(document.getElementById('cost').value);
  document.getElementById('sale-price').value = cost > 0 ? (cost * 7.5).toFixed(2) : '';
});

// === QR Code Rendering
function renderQR(url) {
  QRCode.toCanvas(qrCanvas, url, {
    errorCorrectionLevel: 'H',
    color: {
      dark: "#ffffff",
      light: "#2c2c2e"
    },
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

// === Live QR Update
qrInput?.addEventListener('input', () => {
  const url = qrInput.value.trim();
  if (url) renderQR(url);
});

// === Generate Barcode
document.getElementById('generate-barcode')?.addEventListener('click', () => {
  const code = 'OG' + Date.now();
  barcodeInput.value = code;
  renderBarcode(code);
});

// === Helper to get canvas base64
function getCanvasBase64(canvas) {
  return canvas.toDataURL("image/png").split(",")[1];
}


// === Hook up export button
document.getElementById("download-label").addEventListener("click", () => {
  const barcode = document.getElementById("scanned-barcode").value || "OG" + Date.now();
  const qr = document.getElementById("qr-code").value || "https://ogjewelry.store/auth?id=" + barcode;
  const price = document.getElementById("sale-price").value || "0.00";

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
            <DataString>293349329ewrew-</DataString>
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
            <Value>293349329ewrew-</Value>
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
      </LabelObjects>
    </DynamicLayoutManager>
  </DYMOLabel>
  <LabelApplication>Blank</LabelApplication>
  <DataTable>
    <Columns></Columns>
    <Rows></Rows>
  </DataTable>
</DesktopLabel>`;

  const blob = new Blob([templateXml], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "OGJewelryLabel.dymo";
  a.click();
});

