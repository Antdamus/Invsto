param(
  [string]$WatchPath = "$env:USERPROFILE\Downloads",
  [string]$Filter = "OGJewelers_*.dymo",
  [string]$ArchivePath = "$env:USERPROFILE\Documents\OGJewelers\DymoPrintQueue\printed",
  [string]$OpenedPath = "$env:USERPROFILE\Documents\OGJewelers\DymoPrintQueue\opened",
  [string]$FailedPath = "$env:USERPROFILE\Documents\OGJewelers\DymoPrintQueue\failed",
  [string]$LogPath = "$env:USERPROFILE\Documents\OGJewelers\DymoPrintQueue\dymo-print-helper.log",
  [string]$ConfigPath = "$env:USERPROFILE\Documents\OGJewelers\DymoPrintQueue\dymo-print-helper.config.json",
  [string]$NodePath = "node",
  [string]$DymoWebServicePrintScriptPath = (Join-Path $PSScriptRoot "dymo-web-service-print.js"),
  [string]$PreferredPrinterName = "",
  [int]$PollSeconds = 1,
  [int]$PostPrintDelaySeconds = 6,
  [switch]$Once,
  [switch]$DryRun,
  [switch]$FallbackOpen,
  [switch]$PickFolder,
  [switch]$NoSaveConfig
)

$ErrorActionPreference = "Stop"

function Ensure-Directory {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function Write-HelperLog {
  param([string]$Message, [string]$Level = "INFO")
  Ensure-Directory -Path (Split-Path -Parent $LogPath)
  $line = "[{0}] [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
  Add-Content -LiteralPath $LogPath -Value $line
  Write-Host $line
}

function Read-HelperConfig {
  param([string]$Path)
  try {
    if (Test-Path -LiteralPath $Path) {
      return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    }
  } catch {
    Write-Host "Could not read helper config: $($_.Exception.Message)"
  }
  return $null
}

function Save-HelperConfig {
  param([string]$Path, [string]$SelectedWatchPath, [string]$SelectedFilter)
  try {
    Ensure-Directory -Path (Split-Path -Parent $Path)
    @{
      watchPath = $SelectedWatchPath
      filter = $SelectedFilter
      updatedAt = (Get-Date).ToString("o")
    } | ConvertTo-Json | Set-Content -LiteralPath $Path -Encoding UTF8
  } catch {
    Write-Host "Could not save helper config: $($_.Exception.Message)"
  }
}

function Select-WatchFolder {
  param([string]$InitialPath)
  try {
    $shell = New-Object -ComObject Shell.Application
    $folder = $shell.BrowseForFolder(
      0,
      "Select the folder where OG Jewelers DYMO labels download. The helper only prints OGJewelers_*.dymo labels.",
      0,
      $InitialPath
    )
    if ($null -eq $folder) {
      return $null
    }
    return $folder.Self.Path
  } catch {
    Write-Host "Folder picker could not open: $($_.Exception.Message)"
    return $null
  }
}

function Get-UniqueDestinationPath {
  param([string]$Directory, [string]$FileName)
  $candidate = Join-Path $Directory $FileName
  if (-not (Test-Path -LiteralPath $candidate)) {
    return $candidate
  }

  $base = [System.IO.Path]::GetFileNameWithoutExtension($FileName)
  $ext = [System.IO.Path]::GetExtension($FileName)
  $index = 1
  do {
    $candidate = Join-Path $Directory ("{0}_{1}{2}" -f $base, $index, $ext)
    $index++
  } while (Test-Path -LiteralPath $candidate)
  return $candidate
}

function Wait-ForStableFile {
  param([string]$Path)

  $lastLength = -1
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if (-not (Test-Path -LiteralPath $Path)) {
      Start-Sleep -Milliseconds 400
      continue
    }

    $item = Get-Item -LiteralPath $Path
    if ($item.Extension -ne ".dymo" -or $item.Name -like "*.crdownload") {
      Start-Sleep -Milliseconds 400
      continue
    }

    if ($item.Length -eq $lastLength -and $item.Length -gt 0) {
      try {
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
        $stream.Close()
        return $true
      } catch {
        Start-Sleep -Milliseconds 400
      }
    } else {
      $lastLength = $item.Length
      Start-Sleep -Milliseconds 400
    }
  }

  return $false
}

function Move-PrintedFile {
  param([string]$Path, [string]$DestinationDirectory)
  Ensure-Directory -Path $DestinationDirectory
  $destination = Get-UniqueDestinationPath -Directory $DestinationDirectory -FileName ([System.IO.Path]::GetFileName($Path))
  Move-Item -LiteralPath $Path -Destination $destination -Force
  return $destination
}

function Test-DymoPrintVerb {
  $paths = @(
    "HKCU:\Software\Classes\dymo.ext\shell\print\command",
    "HKLM:\Software\Classes\dymo.ext\shell\print\command"
  )

  foreach ($path in $paths) {
    if (Test-Path -LiteralPath $path) {
      $value = (Get-Item -LiteralPath $path).GetValue("")
      if (-not [string]::IsNullOrWhiteSpace($value)) {
        return $true
      }
    }
  }

  return $false
}

function Open-DymoLabel {
  param([string]$Path, [int]$Copies = 1, [string]$Reason = "")

  $copyNote = if ($Copies -gt 1) { " Print $Copies copies manually from DYMO Connect." } else { "" }
  $reasonText = if ($Reason) { " $Reason" } else { "" }
  Write-HelperLog "Opening label in DYMO Connect instead of silent printing.$reasonText$copyNote Path: $Path" "WARN"
  Start-Process -FilePath $Path -WindowStyle Minimized -ErrorAction Stop | Out-Null
  Start-Sleep -Seconds $PostPrintDelaySeconds
  return "opened"
}

function Invoke-DymoWebServicePrint {
  param([string]$Path, [int]$Copies = 1)

  if ([string]::IsNullOrWhiteSpace($NodePath)) {
    Write-HelperLog "DYMO web service print skipped because NodePath is empty." "WARN"
    return $false
  }

  if (-not (Test-Path -LiteralPath $DymoWebServicePrintScriptPath)) {
    Write-HelperLog "DYMO web service print script was not found: $DymoWebServicePrintScriptPath" "WARN"
    return $false
  }

  $nodeArgs = @(
    $DymoWebServicePrintScriptPath,
    "--file",
    $Path,
    "--copies",
    [string]$Copies
  )

  if (-not [string]::IsNullOrWhiteSpace($PreferredPrinterName)) {
    $nodeArgs += @("--printer", $PreferredPrinterName)
  }

  Write-HelperLog "Sending label through DYMO web service: $Path ($Copies copies)"

  try {
    $output = & $NodePath @nodeArgs 2>&1
    $exitCode = $LASTEXITCODE

    foreach ($line in $output) {
      if (-not [string]::IsNullOrWhiteSpace([string]$line)) {
        Write-HelperLog "DYMO web service: $line"
      }
    }

    if ($exitCode -eq 0) {
      return $true
    }

    Write-HelperLog "DYMO web service print returned exit code $exitCode." "WARN"
  } catch {
    Write-HelperLog "DYMO web service print could not run. $($_.Exception.Message)" "WARN"
  }

  return $false
}

function Invoke-DymoPrint {
  param([string]$Path, [int]$Copies = 1)

  if (-not (Wait-ForStableFile -Path $Path)) {
    throw "File was not ready for printing: $Path"
  }

  if ($Copies -lt 1) {
    $Copies = 1
  }
  if ($Copies -gt 100) {
    throw "Refusing to print more than 100 copies from one label file: $Copies"
  }

  if ($DryRun) {
    Write-HelperLog "DRY RUN: would print $Path ($Copies copies)"
    return "printed"
  }

  if (Invoke-DymoWebServicePrint -Path $Path -Copies $Copies) {
    Start-Sleep -Seconds $PostPrintDelaySeconds
    return "printed"
  }

  Write-HelperLog "DYMO web service print did not complete. Falling back to Windows print/open behavior." "WARN"

  if (-not (Test-DymoPrintVerb)) {
    return Open-DymoLabel -Path $Path -Copies $Copies -Reason "Windows has no Print action registered for .dymo files."
  }

  Write-HelperLog "Sending label to default DYMO print handler: $Path ($Copies copies)"
  for ($copy = 1; $copy -le $Copies; $copy++) {
    try {
      Start-Process -FilePath $Path -Verb Print -WindowStyle Minimized -ErrorAction Stop | Out-Null
    } catch {
      if (-not $FallbackOpen) {
        throw
      }

      return Open-DymoLabel -Path $Path -Copies $Copies -Reason "Print action failed: $($_.Exception.Message)"
    }

    if ($Copies -gt 1 -and $copy -lt $Copies) {
      Start-Sleep -Milliseconds 700
    }
  }

  Start-Sleep -Seconds $PostPrintDelaySeconds
  return "printed"
}

function Get-RequestedCopies {
  param([string]$FileName)

  $match = [regex]::Match($FileName, '(?i)(?:^|_)Copies_(\d+)(?:_|\.dymo$)')
  if (-not $match.Success) {
    return 1
  }

  $copies = [int]$match.Groups[1].Value
  if ($copies -lt 1) {
    return 1
  }
  return $copies
}

function Handle-Label {
  param([string]$Path)

  try {
    $copies = Get-RequestedCopies -FileName ([System.IO.Path]::GetFileName($Path))
    $result = Invoke-DymoPrint -Path $Path -Copies $copies
    if ($result -eq "opened") {
      $opened = Move-PrintedFile -Path $Path -DestinationDirectory $OpenedPath
      Write-HelperLog "Opened in DYMO Connect and archived for manual print: $opened" "WARN"
    } else {
      $archive = Move-PrintedFile -Path $Path -DestinationDirectory $ArchivePath
      Write-HelperLog "Printed and archived: $archive"
    }
  } catch {
    Write-HelperLog "Print failed for $Path. $($_.Exception.Message)" "ERROR"
    try {
      if (Test-Path -LiteralPath $Path) {
        $failed = Move-PrintedFile -Path $Path -DestinationDirectory $FailedPath
        Write-HelperLog "Moved failed label to: $failed" "WARN"
      }
    } catch {
      Write-HelperLog "Could not move failed label. $($_.Exception.Message)" "ERROR"
    }
  }
}

$config = Read-HelperConfig -Path $ConfigPath
if ($config -and $config.watchPath -and -not $PSBoundParameters.ContainsKey("WatchPath")) {
  $WatchPath = [string]$config.watchPath
}
if ($config -and $config.filter -and -not $PSBoundParameters.ContainsKey("Filter")) {
  $Filter = [string]$config.filter
}

if ($PickFolder) {
  $pickedPath = Select-WatchFolder -InitialPath $WatchPath
  if ($pickedPath) {
    $WatchPath = $pickedPath
  } else {
    Write-Host "No folder selected. Continuing with: $WatchPath"
  }
}

if (-not $NoSaveConfig) {
  Save-HelperConfig -Path $ConfigPath -SelectedWatchPath $WatchPath -SelectedFilter $Filter
}

Ensure-Directory -Path $WatchPath
Ensure-Directory -Path $ArchivePath
Ensure-Directory -Path $OpenedPath
Ensure-Directory -Path $FailedPath
Ensure-Directory -Path (Split-Path -Parent $LogPath)

Write-HelperLog "OG Jewelers DYMO print helper started."
Write-HelperLog "Watching: $WatchPath"
Write-HelperLog "Filter: $Filter plus OGJewelers_*.dymo and LiveSale_*.dymo compatibility patterns (other downloads in this folder are ignored)"
Write-HelperLog "Archive: $ArchivePath"
Write-HelperLog "Opened/manual print archive: $OpenedPath"
Write-HelperLog "Failed: $FailedPath"
Write-HelperLog "Config: $ConfigPath"
Write-HelperLog "DYMO web service bridge: $DymoWebServicePrintScriptPath"
if (-not [string]::IsNullOrWhiteSpace($PreferredPrinterName)) {
  Write-HelperLog "Preferred printer: $PreferredPrinterName"
}
if ($DryRun) {
  Write-HelperLog "Dry run is enabled. No labels will be sent to the printer." "WARN"
}

$seen = @{}

do {
  $filters = @($Filter, "OGJewelers_*.dymo", "LiveSale_*.dymo") | Select-Object -Unique
  foreach ($activeFilter in $filters) {
    Get-ChildItem -LiteralPath $WatchPath -Filter $activeFilter -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime |
      ForEach-Object {
        $key = "{0}|{1}|{2}" -f $_.FullName, $_.Length, $_.LastWriteTimeUtc.Ticks
        if ($seen.ContainsKey($key)) {
          return
        }
        $seen[$key] = $true
        Handle-Label -Path $_.FullName
      }
  }

  if ($Once) {
    break
  }

  Start-Sleep -Seconds $PollSeconds
} while ($true)

Write-HelperLog "OG Jewelers DYMO print helper stopped."
