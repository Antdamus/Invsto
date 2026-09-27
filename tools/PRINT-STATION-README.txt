INVSTO PRINT STATION 1.1.0 - WINDOWS

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

In Invsto, choose the station when printing. "Sent to printer" means DYMO accepted
the request. Check the physical printer. An interrupted or ambiguous result needs
review before you explicitly send a new print request; the helper does not replay it.

This package handles Invsto DYMO label files. PDF/general document printing is not
included. Disconnect a station from Invsto to revoke its access and cancel queued jobs.

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
Invsto shows the station online, refresh the page and send one test label.

To intentionally replace an existing pairing, run install-print-station.ps1 with
-PairAgain. Normal updates keep the current pairing and any unacknowledged journal.
