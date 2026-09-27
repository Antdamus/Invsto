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
  $lockPath = Join-Path $stationHome 'agent.lock'
  if (Test-Path -LiteralPath $lockPath) {
    Write-Host 'Waiting for the existing helper to finish its current job and stop...'
    Set-Content -LiteralPath (Join-Path $stationHome 'stop.request') -Value 'stop'
    for ($attempt=0; $attempt -lt 60 -and (Test-Path -LiteralPath $lockPath); $attempt++) {
      $lockInfo = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
      if (-not (Get-Process -Id $lockInfo.pid -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Seconds 2
    }
    if ((Test-Path -LiteralPath $lockPath) -and (Get-Process -Id $lockInfo.pid -ErrorAction SilentlyContinue)) { throw 'The current print job is still running. Let it finish, then run setup again.' }
  }
  foreach ($file in @('print-station-agent.cjs','dymo-web-service-print.js','station-public-config.json')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $stationHome $file) -Force
  }
  & $nodeExe $agentPath --setup
  if ($LASTEXITCODE -ne 0) { throw 'Pairing did not finish. Check DYMO Connect and the pairing code, then run setup again.' }
  $shell = New-Object -ComObject WScript.Shell
  $vbsPath = Join-Path $stationHome 'Start Print Station.vbs'
  $command = '"' + $nodeExe + '" "' + $agentPath + '" --run'
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
  & $nodeExe $agentPath --background
  Write-Host ''
  Write-Host 'Setup complete. The helper is running in the background.' -ForegroundColor Green
  Write-Host 'Your station should show Online in Invsto shortly. Keep this computer awake and the printer connected.'
  Write-Host ('Logs and configuration: ' + $stationHome)
  Read-Host 'Press Enter to close setup'
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
