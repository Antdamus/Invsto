const qrInput = document.getElementById('qr-code');
const qrCanvas = document.getElementById('qr-canvas');
const barcodeCanvas = document.getElementById('barcode-canvas');
const barcodeInput = document.getElementById('scanned-barcode');

// Auto-calculate price
document.getElementById('cost')?.addEventListener('input', () => {
  const cost = parseFloat(document.getElementById('cost').value);
  document.getElementById('sale-price').value = cost > 0 ? (cost * 7.5).toFixed(2) : '';
});

// Render QR
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

// Render barcode
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

// Listen to QR input
qrInput?.addEventListener('input', () => {
  const url = qrInput.value.trim();
  if (url) renderQR(url);
});

// Generate barcode
document.getElementById('generate-barcode')?.addEventListener('click', () => {
  const code = 'OG' + Date.now();
  barcodeInput.value = code;
  renderBarcode(code);
});

// Convert canvas to base64
function getCanvasBase64(canvas) {
  return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}

function printLabel() {
  const qrBase64 = getCanvasBase64(qrCanvas);
  const barcodeBase64 = getCanvasBase64(barcodeCanvas);

  // This XML is copied directly from the .label file
  const labelXml = `<?xml version="1.0" encoding="utf-8"?>
<DieCutLabel Version="8.0" Units="twips" xmlns="http://www.dymo.com">
  <PaperOrientation>Portrait</PaperOrientation>
  <Id>Custom</Id>
  <PaperName>Custom Label</PaperName>
  <DrawCommands/>
  <ObjectInfo>
    <ImageObject>
      <Name>QR</Name>
      <ForeColor Alpha="255" Red="0" Green="0" Blue="0"/>
      <BackColor Alpha="0" Red="255" Green="255" Blue="255"/>
      <Image>base64:</Image>
      <ScaleMode>Uniform</ScaleMode>
      <HorizontalAlignment>Center</HorizontalAlignment>
      <VerticalAlignment>Top</VerticalAlignment>
    </ImageObject>
    <Bounds X="100" Y="100" Width="3000" Height="3000"/>
  </ObjectInfo>
  <ObjectInfo>
    <ImageObject>
      <Name>Barcode</Name>
      <ForeColor Alpha="255" Red="0" Green="0" Blue="0"/>
      <BackColor Alpha="0" Red="255" Green="255" Blue="255"/>
      <Image>base64:</Image>
      <ScaleMode>Uniform</ScaleMode>
      <HorizontalAlignment>Center</HorizontalAlignment>
      <VerticalAlignment>Bottom</VerticalAlignment>
    </ImageObject>
    <Bounds X="100" Y="3200" Width="3000" Height="1500"/>
  </ObjectInfo>
</DieCutLabel>`;

  const label = dymo.label.framework.openLabelXml(labelXml);
  label.setObjectData('QR', qrBase64);
  label.setObjectData('Barcode', barcodeBase64);


  const printers = dymo.label.framework.getPrinters();
  if (!printers.length) {
    alert("No DYMO printers found.");
    return;
  }

  label.print(printers[0].name);
}
