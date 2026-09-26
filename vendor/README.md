# Barcode decoder

`zxing-browser-0.1.5.min.js` is the unmodified UMD build from the pinned
`@zxing/browser@0.1.5` npm package (`umd/zxing-browser.min.js`). It is loaded only
when a user opens the camera scanner. No image or camera data is uploaded.

Upstream: https://github.com/zxing-js/browser

The bundle contains ZXing browser/library code and ts-custom-error. The adjacent
LICENSE files preserve their notices, including the underlying ZXing Apache 2.0
notice in the library license. The optional text-encoding package license is
also included. To update, change the exact npm version and lockfile, copy the UMD
build and licenses, then run `npm run test:barcode` and `npm run test:add-item`.
