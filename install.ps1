# HanniPI installer for Windows (one-liner compatibility entry point).
#
# Install HanniPI + HanniGram (standalone binary + memory daemon/CLI).
# This script only bootstraps the unified installer `hanni-setup.ps1`, which
# holds the actual logic (install / update / uninstall + stop Hanni processes).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/AlPeFe/HanniPI/main/install.ps1 | iex"
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Action uninstall
param(
    [ValidateSet("install", "update", "uninstall", "menu")]
    [string]$Action = "install"
)
$ErrorActionPreference = "Stop"
$Repo = "AlPeFe/HanniPI"

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$SetupPath = Join-Path $env:TEMP "hanni-setup.ps1"
$releaseUrl = "https://github.com/$Repo/releases/latest/download/hanni-setup.ps1"
$mainUrl = "https://raw.githubusercontent.com/$Repo/main/hanni-setup.ps1"
try {
    Invoke-WebRequest -Uri $releaseUrl -OutFile $SetupPath -UseBasicParsing
} catch {
    Invoke-WebRequest -Uri $mainUrl -OutFile $SetupPath -UseBasicParsing
}

& powershell -NoProfile -ExecutionPolicy Bypass -File $SetupPath -Action $Action
