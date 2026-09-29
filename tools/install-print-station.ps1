param([switch]$PairAgain, [switch]$AddPrinter)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$stationHome = Join-Path $env:LOCALAPPDATA 'InvstoPrintStation'
New-Item -ItemType Directory -Path $stationHome -Force | Out-Null
try {
  Write-Host 'Installing the Invsto print station for your Windows account...'
  $nodeExe = $null
  $installedNode = Get-Command node -ErrorAction SilentlyContinue
  if ($installedNode) {
    $versionText = & $installedNode.Source --version
    if ([int](($versionText -replace '^v','').Split('.')[0]) -ge 20) { $nodeExe = $installedNode.Source }
  }
  if (-not $nodeExe) {
    $architecture = if (($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') -or ($env:PROCESSOR_ARCHITEW6432 -eq 'ARM64')) { 'arm64' } else { 'x64' }
    $runtimeDir = Join-Path $stationHome 'runtime'
    $cachedNode = Get-ChildItem -LiteralPath $runtimeDir -Filter node.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cachedNode) { $nodeExe = $cachedNode.FullName }
    else {
      Write-Host 'Downloading the Node.js runtime from nodejs.org. No administrator installation is needed.'
      $checksums = (Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt').Content
      $match = [regex]::Match($checksums, "(?m)^([a-f0-9]{64})\s+(node-(v24\.\d+\.\d+)-win-$architecture\.zip)\s*$")
      if (-not $match.Success) { throw 'Could not verify the official Windows runtime download.' }
      $runtimeZip = Join-Path $stationHome $match.Groups[2].Value
      Invoke-WebRequest -UseBasicParsing -Uri ("https://nodejs.org/dist/{0}/{1}" -f $match.Groups[3].Value,$match.Groups[2].Value) -OutFile $runtimeZip
      if ((Get-FileHash -LiteralPath $runtimeZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $match.Groups[1].Value) { throw 'The runtime download did not pass its checksum. Run setup again.' }
      Expand-Archive -LiteralPath $runtimeZip -DestinationPath $runtimeDir -Force
      $nodeExe = (Get-ChildItem -LiteralPath $runtimeDir -Filter node.exe -Recurse | Select-Object -First 1).FullName
      if (-not $nodeExe) { throw 'The Node.js runtime was not extracted.' }
    }
  }
  $agentPath = Join-Path $stationHome 'print-station-agent.cjs'
  $profileDirs = @($stationHome)
  $profilesPath = Join-Path $stationHome 'profiles'
  if (Test-Path -LiteralPath $profilesPath) {
    $profileDirs += @(Get-ChildItem -LiteralPath $profilesPath -Directory | Where-Object { $_.Name -match '^[a-f0-9-]{36}$' } | ForEach-Object { $_.FullName })
  }
  foreach ($profileDir in $profileDirs) { Set-Content -LiteralPath (Join-Path $profileDir 'stop.request') -Value 'stop' }
  foreach ($profileDir in $profileDirs) {
    $lockPath = Join-Path $profileDir 'agent.lock'
    if (Test-Path -LiteralPath $lockPath) {
      Write-Host 'Waiting for the existing helper to finish its current job and stop...'
      for ($attempt=0; $attempt -lt 60 -and (Test-Path -LiteralPath $lockPath); $attempt++) {
        $lockInfo = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
        if (-not (Get-Process -Id $lockInfo.pid -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Seconds 2
      }
      if ((Test-Path -LiteralPath $lockPath) -and (Get-Process -Id $lockInfo.pid -ErrorAction SilentlyContinue)) { throw 'A print job is still running. Let it finish, then run setup again.' }
    }
  }
  foreach ($file in @('print-station-agent.cjs','dymo-web-service-print.js','station-public-config.json','shipping-pdf.js','shipping-pdf-print.cjs','pdf-engine.json')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $stationHome $file) -Force
  }
  $vendorPath = Join-Path $stationHome 'vendor\pdf-lib'
  New-Item -ItemType Directory -Path $vendorPath -Force | Out-Null
  foreach ($file in @('pdf-lib.min.js','LICENSE.md')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('vendor\pdf-lib\' + $file)) -Destination (Join-Path $vendorPath $file) -Force
  }
  $engineDir = Join-Path $stationHome 'pdf-engine'
  New-Item -ItemType Directory -Path $engineDir -Force | Out-Null
  $engineManifest = Get-Content -LiteralPath (Join-Path $stationHome 'pdf-engine.json') -Raw | ConvertFrom-Json
  $engineArchitecture = if (($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') -or ($env:PROCESSOR_ARCHITEW6432 -eq 'ARM64')) { 'arm64' } else { 'x64' }
  $engineSpec = $engineManifest.$engineArchitecture
  $engineExe = Join-Path $engineDir 'SumatraPDF.exe'
  if (-not (Test-Path -LiteralPath $engineExe) -or (Get-FileHash -LiteralPath $engineExe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $engineSpec.exeSha256) {
    Write-Host 'Downloading the verified portable PDF print engine from sumatrapdfreader.org...'
    $engineZip = Join-Path $engineDir 'SumatraPDF.zip'
    Invoke-WebRequest -UseBasicParsing -Uri $engineSpec.url -OutFile $engineZip
    if ((Get-FileHash -LiteralPath $engineZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $engineSpec.zipSha256) { throw 'PDF engine download failed verification. Run setup again.' }
    Expand-Archive -LiteralPath $engineZip -DestinationPath $engineDir -Force
    $extractedEngine = Join-Path $engineDir $engineSpec.exeName
    if ((Get-FileHash -LiteralPath $extractedEngine -Algorithm SHA256).Hash.ToLowerInvariant() -ne $engineSpec.exeSha256) { throw 'PDF engine failed verification. Run setup again.' }
    Copy-Item -LiteralPath $extractedEngine -Destination $engineExe -Force
  }
  if ($AddPrinter) {
    Write-Host 'Adding another printer. Existing printer pairings are being kept.'
    & $nodeExe $agentPath --add-printer
    if ($LASTEXITCODE -ne 0) { throw 'Additional printer pairing did not finish. Run Add-Printer.cmd again.' }
  } elseif ((Test-Path -LiteralPath (Join-Path $stationHome 'station.json')) -and -not $PairAgain) {
    Write-Host 'Updating the helper. All existing station and printer pairings are being kept.'
  } else {
    & $nodeExe $agentPath --setup
    if ($LASTEXITCODE -ne 0) { throw 'Pairing did not finish. Check DYMO Connect and the pairing code, then run setup again.' }
  }
  $shell = New-Object -ComObject WScript.Shell
  $vbsPath = Join-Path $stationHome 'Start Print Station.vbs'
  $command = '"' + $nodeExe + '" "' + $agentPath + '" --run-all'
  $vbs = 'CreateObject("WScript.Shell").Run "' + $command.Replace('"','""') + '", 0, False'
  Set-Content -LiteralPath $vbsPath -Value $vbs -Encoding Unicode
  $startupShortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'Invsto Print Station.lnk'))
  $startupShortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $startupShortcut.Arguments = '"' + $vbsPath + '"'
  $startupShortcut.WorkingDirectory = $stationHome
  $startupShortcut.Save()
  $desktop = [Environment]::GetFolderPath('Desktop')
  $startShortcut = $shell.CreateShortcut((Join-Path $desktop 'Start Invsto Printer.lnk'))
  $startShortcut.TargetPath = $startupShortcut.TargetPath;$startShortcut.Arguments = $startupShortcut.Arguments;$startShortcut.Save()
  $stopShortcut = $shell.CreateShortcut((Join-Path $desktop 'Stop Invsto Printer.lnk'))
  $stopShortcut.TargetPath = $nodeExe;$stopShortcut.Arguments = '"' + $agentPath + '" --stop';$stopShortcut.WindowStyle = 7;$stopShortcut.Save()
  $diagnosePath = Join-Path $stationHome 'Diagnose Print Station.ps1'
  $diagnoseScript = @(
    '$ErrorActionPreference = ''Stop'''
    'try {'
    ("  & '{0}' '{1}' --diagnose" -f $nodeExe.Replace("'","''"),$agentPath.Replace("'","''"))
    '} catch { Write-Host $_.Exception.Message -ForegroundColor Red }'
    'Read-Host ''Press Enter to close diagnostic'''
  )
  Set-Content -LiteralPath $diagnosePath -Value $diagnoseScript -Encoding UTF8
  $diagnoseShortcut = $shell.CreateShortcut((Join-Path $desktop 'Diagnose Invsto Printer.lnk'))
  $diagnoseShortcut.TargetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $diagnoseShortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $diagnosePath + '"'
  $diagnoseShortcut.WorkingDirectory = $stationHome
  $diagnoseShortcut.Save()
  & $nodeExe $agentPath --background
  Write-Host ''
  Write-Host 'Setup complete. The helper is running in the background.' -ForegroundColor Green
  Write-Host 'Your stations should show Online in Invsto shortly. Keep this computer awake and the printer connected.'
  Write-Host 'To pair a second printer on this computer, run Add-Printer.cmd from the extracted download.'
  Write-Host 'If DYMO can print but Invsto cannot, open the Diagnose Invsto Printer desktop shortcut.'
  Write-Host ('Logs and configuration: ' + $stationHome)
  Read-Host 'Press Enter to close setup'
} catch {
  if ($nodeExe -and $agentPath -and (Test-Path -LiteralPath $agentPath)) { & $nodeExe $agentPath --background }
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
