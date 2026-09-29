INVSTO PRINT STATION 1.2.0 - WINDOWS

1. Install DYMO Connect and confirm your LabelWriter appears there.
2. Extract all files from this ZIP into a folder.
3. In Invsto on your phone, open Print stations and create a station named for this computer.
4. On the printing computer, double-click Install-Print-Station.cmd.
5. Choose the printer and enter the pairing code from your phone.

The helper runs in the background and starts when this Windows user signs in.
No administrator account is needed for the helper. Its Node.js runtime, if needed,
is downloaded directly from nodejs.org and verified against its official checksum.
DYMO's driver installation may require your computer administrator.

Keep the computer awake, online, and signed in. Labels sent to an offline station wait
for that station; they never switch to another computer. Use the desktop shortcuts
to start or stop the helper. Stop finishes its current job before exiting.

Configuration and logs: %LOCALAPPDATA%\InvstoPrintStation
The pairing credential is protected with Windows DPAPI for this Windows user.

In Invsto, choose the station when printing. "Sent to printer" means the printer software accepted
the request. Check the physical printer. An interrupted or ambiguous result needs
review before you explicitly send a new print request; the helper does not replay it.

This package handles Invsto DYMO labels and saved eBay 4 x 6 shipping PDFs on a 5XL. Disconnect a station from Invsto to revoke its access and cancel queued jobs.

UPDATING AN EXISTING STATION
Extract the new ZIP and run Install-Print-Station.cmd again. The installer waits
for the current job to finish, keeps your pairing, updates and restarts the helper.
No new code is needed. Do not disconnect your station just to update it.

TWIN TURBO ROLLS
In Invsto, open Print Stations > Roll settings to name the labels on Left and Right
and optionally choose a default. You can change the roll in every Print labels
window. Left/right mean as you face the front of the printer. Load matching label
stock on that side. Jobs and reprints keep the chosen roll even after defaults change.

Older helpers cannot accept a roll-specific job. After this update, wait until
Invsto shows the station online and refresh the page. If no label is already
queued, send one test label.

DYMO CONNECTED IN THE APP, BUT DISCONNECTED IN INVSTO
This update discovers DYMO's supported ports 41951 through 41960 automatically.
Leave DYMO's "Use single port" setting as it is. The helper keeps your exact
paired printer name and does not substitute another printer or a "Copy 1" entry.
Your existing queued labels can print automatically when the connection returns.
Do not send duplicate requests while troubleshooting.

If it still says disconnected, double-click Diagnose Invsto Printer on the desktop,
or Diagnose-Print-Station.cmd in this download after installing the update.
It shows the saved printer name and every DYMO service's printer connection status.
The diagnostic does not print, claim jobs, or display pairing credentials.
Send a photo of that window for troubleshooting. Do not send station.json.

To intentionally replace an existing pairing, run install-print-station.ps1 with
-PairAgain. Normal updates keep the current pairing and any unacknowledged journal.

TWO PRINTERS ON THE SAME COMPUTER
Keep the existing pairing. In Invsto > Print stations, create another station named
for the second printer, for example "Sandra - shipping 5XL". In the extracted ZIP,
run Add-Printer.cmd, choose the 5XL and enter the new pairing code. Each printer has
its own protected credential, queue, journal and log. Start/Stop desktop shortcuts
control all paired printers. Startup starts all of them after Windows sign-in.

SHIPPING PDFs
In Pending Orders or Order History, use Print shipping label beside Preview/Open
Label. Extra shipping labels have their own Print extra label button. Select the
5XL station, pages, and copies. For a bulk PDF, preview it first to identify this
order's pages; page selection is required. Load matching 4 x 6 shipping labels.
Letter/A4 PDFs are rejected; attach eBay's 4 x 6 thermal layout instead. No automatic
cropping or resizing from letter-size sheets is performed.

The installer downloads SumatraPDF portable 3.6.1 from its official website, checks
the pinned ZIP and executable SHA256, and saves it in the helper's pdf-engine folder.
It does not change your default PDF app. Source/license: https://www.sumatrapdfreader.org/
The PDF helper checks the exact Windows printer queue, independently of DYMO's web
service. It never uses the Windows default printer or another connected printer.
"Sent to printer" does not confirm physical output. Check the printer, especially
before requesting another copy after an interruption.
