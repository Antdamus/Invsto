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

// Print label via DYMO
function printLabel() {
  const qrBase64 = getCanvasBase64(qrCanvas);
  const barcodeBase64 = getCanvasBase64(barcodeCanvas);

  const labelXml = `
  <DieCutLabel Version="8.0" Units="twips">
    <PaperOrientation>Portrait</PaperOrientation>
    <Id>Address</Id>
    <PaperName>30252 Address</PaperName>
    <DrawCommands/>
    <ObjectInfo>
      <ImageObject>
        <Name>QR</Name>
        <ForeColor Alpha="255" Red="0" Green="0" Blue="0"/>
        <BackColor Alpha="0" Red="255" Green="255" Blue="255"/>
        <Image>base64:${qrBase64}</Image>
        <ScaleMode>Uniform</ScaleMode>
        <HorizontalAlignment>Center</HorizontalAlignment>
        <VerticalAlignment>Top</VerticalAlignment>
      </ImageObject>
      <Bounds X="0" Y="0" Width="3000" Height="3000"/>
    </ObjectInfo>
    <ObjectInfo>
      <ImageObject>
        <Name>Barcode</Name>
        <Image>base64:${barcodeBase64}</Image>
        <ScaleMode>Uniform</ScaleMode>
        <HorizontalAlignment>Center</HorizontalAlignment>
        <VerticalAlignment>Bottom</VerticalAlignment>
      </ImageObject>
      <Bounds X="0" Y="3000" Width="3000" Height="2000"/>
    </ObjectInfo>
  </DieCutLabel>
  `;

  const printers = dymo.label.framework.getPrinters();
  if (!printers.length) {
    alert("No DYMO printers found.");
    return;
  }

  const label = dymo.label.framework.openLabelXml(labelXml);
  label.print(printers[0].name);
}
