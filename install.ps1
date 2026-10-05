# HanniPI installer for Windows
# Installs the HanniPI binary as `hanni` so it never collides with a
# pre-existing `pi` (the upstream earendil-works binary). Run `hanni` to start.
# Usage: powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/AlPeFe/HanniPI/main/install.ps1 | iex"
$ErrorActionPreference = "Stop"

$Repo = "AlPeFe/HanniPI"
$Asset = "pi-windows-x64.zip"
$InstallDir = Join-Path $env:LOCALAPPDATA "HanniPI"
$BinName = "hanni.exe"   # installed as `hanni`, not `pi`, to avoid clashing with upstream pi

Write-Host "HanniPI installer" -ForegroundColor Magenta
Write-Host "==================" -ForegroundColor Magenta

# Resolve latest release
Write-Host "Resolving latest release of $Repo ..."
$Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "hannipi-installer" }
$Version = $Release.tag_name
Write-Host "Found release $Version" -ForegroundColor Green

$DownloadUrl = "https://github.com/$Repo/releases/download/$Version/$Asset"
$ShasUrl = "https://github.com/$Repo/releases/download/$Version/SHA256SUMS"
$ZipPath = Join-Path $env:TEMP $Asset
$ShasPath = Join-Path $env:TEMP "SHA256SUMS"

Write-Host "Downloading $Asset ..."
Invoke-WebRequest -Uri $DownloadUrl -OutFile $ZipPath -UseBasicParsing
Invoke-WebRequest -Uri $ShasUrl -OutFile $ShasPath -UseBasicParsing

# Verify checksum
$Expected = (Get-Content $ShasPath | Where-Object { $_ -like "*$Asset*" } | ForEach-Object { ($_ -split "\s+")[0] })
$Actual = (Get-FileHash $ZipPath -Algorithm SHA256).Hash.ToLower()
if ($Expected -ne $Actual) {
    Write-Host "Checksum mismatch. Expected $Expected, got $Actual" -ForegroundColor Red
    Remove-Item $ZipPath -Force
    exit 1
}
Write-Host "Checksum verified" -ForegroundColor Green

# Extract. The zip holds pi.exe at root alongside its asset dirs
# (docs/, examples/, theme/, ...) — the standalone binary resolves them
# relative to its own location, so keep the layout intact.
Write-Host "Installing to $InstallDir ..."
if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Expand-Archive -Path $ZipPath -DestinationPath $InstallDir -Force

# Rename the binary to `hanni.exe` so it doesn't shadow a pre-installed `pi`.
if (Test-Path (Join-Path $InstallDir "pi.exe")) {
    Move-Item (Join-Path $InstallDir "pi.exe") (Join-Path $InstallDir $BinName) -Force
}

# If the zip had a single top-level folder, flatten it (only for the
# asset dirs; pi.exe must stay next to them).
$TopLevel = Get-ChildItem $InstallDir -Directory
if ($TopLevel.Count -eq 1 -and -not (Test-Path (Join-Path $InstallDir "pi.exe"))) {
    $Inner = $TopLevel[0].FullName
    Get-ChildItem $Inner | Move-Item -Destination $InstallDir -Force
    Remove-Item $Inner -Recurse -Force
}

# Add to user PATH if missing
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    Write-Host "Added $InstallDir to user PATH (new terminals will pick it up)." -ForegroundColor Green
} else {
    Write-Host "$InstallDir already in PATH." -ForegroundColor Green
}
$env:Path = "$env:Path;$InstallDir"

Remove-Item $ZipPath -Force

# Verify
$Ver = & (Join-Path $InstallDir $BinName) --version 2>$null
Write-Host ""
Write-Host "HanniPI installed: hanni --version = $Ver" -ForegroundColor Magenta
Write-Host "Run 'hanni' to start (not 'pi' — that stays as the upstream pi if you have it)." -ForegroundColor Magenta
Write-Host "Re-run this installer to update." -ForegroundColor Magenta
