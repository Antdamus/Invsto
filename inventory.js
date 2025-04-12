// === Auto-calculate sale price ===
document.getElementById('cost')?.addEventListener('input', () => {
  const cost = parseFloat(document.getElementById('cost').value);
  document.getElementById('sale-price').value = cost > 0 ? (cost * 7.5).toFixed(2) : '';
});

// === Generate barcode ===
document.getElementById('generate-barcode')?.addEventListener('click', () => {
  const code = 'OG' + Date.now();
  const canvas = document.getElementById('barcode-preview');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  JsBarcode(canvas, code, {
    format: "CODE128",
    lineColor: "#ffffff",
    background: "#2c2c2e",
    displayValue: true,
    fontOptions: "bold",
    fontSize: 16,
    height: 60,
    margin: 10
  });

  document.getElementById('scanned-barcode').value = code;
});

// === Live QR Code Preview ===
const qrInput = document.getElementById('qr-code');
const qrPreviewContainer = document.getElementById('qr-preview');

qrInput?.addEventListener('input', () => {
  const url = qrInput.value.trim();
  qrPreviewContainer.innerHTML = "";
  if (!url) return;

  QRCode.toCanvas(document.createElement('canvas'), url, {
    errorCorrectionLevel: 'H',
    color: {
      dark: "#ffffff",
      light: "#2c2c2e"
    },
    width: 180
  }, (err, canvas) => {
    if (err) {
      console.error('QR code generation failed', err);
      return;
    }
    qrPreviewContainer.appendChild(canvas);
  });
});
