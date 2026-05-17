# OG Jewelers DYMO Print Helper

This helper makes the live-sale flow print labels with almost no seller friction.

## What It Does

The app downloads labels named like:

```text
OGJewelers_LiveSale_Friday_May_16_2026_8_30_PM_eBay_Auction_102_LIVE-20260516-0001.dymo
OGJewelers_ItemLabel_OG1750_Copies_2_20260516223015.dymo
```

The helper watches the folder you select for `OGJewelers_*.dymo`, sends matching files directly to DYMO Connect's local web service, then moves them to:

```text
Documents\OGJewelers\DymoPrintQueue\printed
```

If printing fails, the file is moved to:

```text
Documents\OGJewelers\DymoPrintQueue\failed
```

If the DYMO web service is not available and Windows does not have a silent `.dymo` print action registered, the helper opens the label in DYMO Connect and moves it to:

```text
Documents\OGJewelers\DymoPrintQueue\opened
```

In that case, click print inside DYMO Connect. This is not as fast as silent printing, but it keeps the label from being treated as a failed/unknown file.

## One-Time Setup

1. Install DYMO Connect on the seller computer.
2. Open one `.dymo` file manually and make sure it prints correctly.
3. Make the DYMO printer the default printer in Windows.
4. Know which folder the browser uses for downloads. It can be Downloads or a dedicated label folder.
5. Keep DYMO Connect open so its local web service is running.
6. Make sure Node.js is available on the computer, because the helper uses a tiny local Node bridge to call DYMO's web service.

## Start The Helper

Double-click:

```text
tools\start-dymo-print-helper.bat
```

The helper will ask which folder to scan. Choose the folder where the browser downloads the live-sale labels.

Leave that window open during the live show.

The helper only prints files matching:

```text
OGJewelers_*.dymo
```

Other downloads in the same folder are ignored.

It also still accepts the older `LiveSale_*.dymo` names so prior live-sale labels keep working.

The selected folder is remembered here:

```text
Documents\OGJewelers\DymoPrintQueue\dymo-print-helper.config.json
```

## Test Without Printing

Run this from PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\dymo-print-helper.ps1 -DryRun -Once
```

To confirm the DYMO local web service and printer can be reached without printing a label:

```powershell
node .\tools\dymo-web-service-print.js --probe
```

To test a specific folder without printing:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\dymo-print-helper.ps1 -PickFolder -DryRun -Once
```

## Custom Watch Folder

If the browser is configured to download labels to a dedicated queue folder:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\dymo-print-helper.ps1 -WatchPath "$env:USERPROFILE\Documents\OGJewelers\DymoPrintQueue\incoming"
```

## Multiple Copies

When the app needs more than one copy, it writes the quantity into the filename:

```text
OGJewelers_InventoryLabel_OG1750_Copies_4_20260516223015.dymo
```

The helper reads `Copies_4` and sends the same DYMO label to print four times.

## Important

The helper first tries DYMO Connect's local web service from the local computer. This avoids the browser security block that prevents the deployed GitHub Pages app from talking directly to `localhost`.

If that local DYMO service fails, the helper tries Windows' `Print` shell verb for `.dymo` files. If DYMO Connect does not register that print action on the computer, the helper opens the label in DYMO Connect and writes the reason to:

```text
Documents\OGJewelers\DymoPrintQueue\dymo-print-helper.log
```

That means the local listener is working, but direct printing is not available on that Windows machine.
