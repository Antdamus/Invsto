param(
  [string]$WatchPath = "$env:USERPROFILE\Downloads",
  [string]$Filter = "LiveSale_*.dymo",
  [string]$ArchivePath = "$env:USERPROFILE\Documents\OGJewelers\DymoPrintQueue\printed",
  [string]$FailedPath = "$env:USERPROFILE\Documents\OGJewelers\DymoPrintQueue\failed",
  [string]$LogPath = "$env:USERPROFILE\Documents\OGJewelers\DymoPrintQueue\dymo-print-helper.log",
  [string]$ConfigPath = "$env:USERPROFILE\Documents\OGJewelers\DymoPrintQueue\dymo-print-helper.config.json",
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
      "Select the folder where live-sale DYMO labels download. The helper only prints files named $Filter.",
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

function Invoke-DymoPrint {
  param([string]$Path)

  if (-not (Wait-ForStableFile -Path $Path)) {
    throw "File was not ready for printing: $Path"
  }

  if ($DryRun) {
    Write-HelperLog "DRY RUN: would print $Path"
    return
  }

  Write-HelperLog "Sending label to default DYMO print handler: $Path"
  try {
    Start-Process -FilePath $Path -Verb Print -WindowStyle Minimized -ErrorAction Stop | Out-Null
  } catch {
    if (-not $FallbackOpen) {
      throw
    }

    Write-HelperLog "Print verb failed; opening label instead because -FallbackOpen was enabled. $($_.Exception.Message)" "WARN"
    Start-Process -FilePath $Path -WindowStyle Minimized -ErrorAction Stop | Out-Null
  }

  Start-Sleep -Seconds $PostPrintDelaySeconds
}

function Handle-Label {
  param([string]$Path)

  try {
    Invoke-DymoPrint -Path $Path
    $archive = Move-PrintedFile -Path $Path -DestinationDirectory $ArchivePath
    Write-HelperLog "Printed and archived: $archive"
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
Ensure-Directory -Path $FailedPath
Ensure-Directory -Path (Split-Path -Parent $LogPath)

Write-HelperLog "OG Jewelers DYMO print helper started."
Write-HelperLog "Watching: $WatchPath"
Write-HelperLog "Filter: $Filter (other downloads in this folder are ignored)"
Write-HelperLog "Archive: $ArchivePath"
Write-HelperLog "Failed: $FailedPath"
Write-HelperLog "Config: $ConfigPath"
if ($DryRun) {
  Write-HelperLog "Dry run is enabled. No labels will be sent to the printer." "WARN"
}

$seen = @{}

do {
  Get-ChildItem -LiteralPath $WatchPath -Filter $Filter -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime |
    ForEach-Object {
      $key = "{0}|{1}|{2}" -f $_.FullName, $_.Length, $_.LastWriteTimeUtc.Ticks
      if ($seen.ContainsKey($key)) {
        return
      }
      $seen[$key] = $true
      Handle-Label -Path $_.FullName
    }

  if ($Once) {
    break
  }

  Start-Sleep -Seconds $PollSeconds
} while ($true)

Write-HelperLog "OG Jewelers DYMO print helper stopped."
