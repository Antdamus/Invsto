INVSTO PRINT STATION - WINDOWS

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
