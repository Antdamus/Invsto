# Barcode decoders

`zxing-wasm-reader-3.1.4.js` and `zxing-reader-3.1.4.wasm` are unmodified copies
of `zxing-wasm@3.1.4`'s `dist/iife/reader/index.js` and
`dist/reader/zxing_reader.wasm`. The scanner lazy-loads both from this directory;
its explicit `locateFile` override prevents the library's default CDN fetch.
Camera frames and selected photos stay on the device.

Upstream: https://github.com/Sec-ant/zxing-wasm (MIT)
ZXing-C++ source revision: `0b2d9a8fc81f420f369928c24331091ff0525976`
https://github.com/zxing-cpp/zxing-cpp (Apache 2.0)
The corresponding licenses are preserved beside the binaries.

The older `zxing-browser-0.1.5.min.js` UMD build is retained for test QR fixtures
and older cached clients. Its browser/library, ts-custom-error, and optional
text-encoding license files are preserved. Current scanning uses ZXing-C++.

To update, change the exact npm version and lockfile, copy the reader build,
WASM binary and licenses, then run `npm run test:barcode` and `npm run test:add-item`.
Verify the deployed `.wasm` binary's SHA-256 as well as the JavaScript after publishing.
