# HanniGram packer for HanniPI releases.
#
# Builds the HanniGram daemon + CLI as a self-contained win-x64 single-file
# publish (no .NET runtime needed on the target machine) and packages them as
# `hannigram-windows-x64.zip`, the asset that `hanni-setup.ps1` installs next to
# HanniPI. HanniPI without HanniGram has no project memory, so this asset is a
# required part of every HanniPI release.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pack-hannigram.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pack-hannigram.ps1 -InstallLocal
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pack-hannigram.ps1 -RepoDir C:\src\HanniGram -Ref main
#
# Output: <OutDir>\hannigram-windows-x64.zip (+ .sha256) with the layout:
#   HanniGram.Server.exe  (daemon HTTP, 127.0.0.1:8765)
#   hannigram.exe         (CLI standalone)
#   appsettings.json
#   LEEME.txt
#   README-HanniGram.md
param(
    # Local checkout of AlPeFe/HanniGram. Defaults to a fresh shallow clone in %TEMP%.
    [string]$RepoDir,
    [string]$Repo = "AlPeFe/HanniGram",
    [string]$Ref = "main",
    [string]$OutDir = (Join-Path $env:USERPROFILE "release-staging\hannigram"),
    [string]$AssetName = "hannigram-windows-x64.zip",
    [string]$Runtime = "win-x64",
    # HanniGram only needs nuget.org; pinning the source keeps the build working
    # even when the machine has a private feed with a broken certificate.
    [string]$NuGetSource = "https://api.nuget.org/v3/index.json",
    # Copy the result into %LOCALAPPDATA%\HanniPI\hannigram (dev/repair shortcut).
    [switch]$InstallLocal,
    # Start the packaged daemon and check /health before declaring success.
    [switch]$SkipSmokeTest
)

$ErrorActionPreference = "Stop"

function Write-Step($text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "  $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "  $text" -ForegroundColor Yellow }

function Get-Sha256($path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($path)
        try { return (($sha.ComputeHash($stream) | ForEach-Object { $_.ToString("x2") }) -join "") }
        finally { $stream.Dispose() }
    } finally { $sha.Dispose() }
}

function Invoke-Dotnet($arguments) {
    & dotnet @arguments
    if ($LASTEXITCODE -ne 0) { throw "dotnet fallo (exit $LASTEXITCODE): dotnet $($arguments -join ' ')" }
}

$workRoot = Join-Path $env:TEMP "hannigram-pack"
$publishRoot = Join-Path $workRoot "publish"
$stageDir = Join-Path $workRoot "stage"

if (Test-Path $workRoot) { Remove-Item $workRoot -Recurse -Force }
New-Item -ItemType Directory -Path $publishRoot, $stageDir -Force | Out-Null

# ---------------------------------------------------------------------------
# 1. Source
# ---------------------------------------------------------------------------
if (-not $RepoDir) {
    $RepoDir = Join-Path $workRoot "src"
    Write-Step "Clonando https://github.com/$Repo ($Ref)"
    & git clone --depth 1 --branch $Ref "https://github.com/$Repo.git" $RepoDir
    if ($LASTEXITCODE -ne 0) { throw "git clone fallo (exit $LASTEXITCODE) para $Repo@$Ref" }
    Write-Ok "clonado en $RepoDir"
} else {
    Write-Step "Usando el checkout local $RepoDir"
}
if (-not (Test-Path (Join-Path $RepoDir "HanniGram.slnx"))) {
    throw "No encuentro HanniGram.slnx en $RepoDir; no parece un checkout de $Repo"
}

# ---------------------------------------------------------------------------
# 2. Publish self-contained single-file win-x64 (Server = daemon, Cli = hannigram)
# ---------------------------------------------------------------------------
$publishArgs = @(
    "publish",
    "-c", "Release",
    "-r", $Runtime,
    "--self-contained", "true",
    "-p:PublishSingleFile=true",
    "-p:IncludeNativeLibrariesForSelfExtract=true",
    "-p:DebugType=none",
    "--source", $NuGetSource,
    "--nologo"
)

$serverOut = Join-Path $publishRoot "server"
$cliOut = Join-Path $publishRoot "cli"

Write-Step "Publicando HanniGram.Server ($Runtime)"
Invoke-Dotnet ($publishArgs + @((Join-Path $RepoDir "src\HanniGram.Server\HanniGram.Server.csproj"), "-o", $serverOut))
Write-Step "Publicando HanniGram.Cli ($Runtime)"
Invoke-Dotnet ($publishArgs + @((Join-Path $RepoDir "src\HanniGram.Cli\HanniGram.Cli.csproj"), "-o", $cliOut))

$serverExe = Join-Path $serverOut "HanniGram.Server.exe"
$cliExe = Join-Path $cliOut "HanniGram.Cli.exe"
$appSettings = Join-Path $serverOut "appsettings.json"
foreach ($file in @($serverExe, $cliExe, $appSettings)) {
    if (-not (Test-Path $file)) { throw "La publicacion no produjo $file" }
}

# ---------------------------------------------------------------------------
# 3. Staging (exact layout the installer expects)
# ---------------------------------------------------------------------------
Write-Step "Preparando el paquete"
Copy-Item $serverExe (Join-Path $stageDir "HanniGram.Server.exe")
Copy-Item $cliExe (Join-Path $stageDir "hannigram.exe")
Copy-Item $appSettings (Join-Path $stageDir "appsettings.json")
if (Test-Path (Join-Path $RepoDir "README.md")) {
    Copy-Item (Join-Path $RepoDir "README.md") (Join-Path $stageDir "README-HanniGram.md")
}
$leeme = @(
    "HanniGram: memoria persistente por proyecto para HanniPI.",
    "",
    "- HanniGram.Server.exe  -> daemon HTTP (127.0.0.1:8765). Lo arranca HanniPI solo.",
    "- hannigram.exe         -> CLI (init/save/search/list/topics/...).",
    "",
    "BD en %USERPROFILE%\.hannigram\hannigram.db"
) -join "`r`n"
Set-Content -Path (Join-Path $stageDir "LEEME.txt") -Value ($leeme + "`r`n") -Encoding ascii -NoNewline

# ---------------------------------------------------------------------------
# 4. Smoke test: the daemon must answer /health on its own
# ---------------------------------------------------------------------------
function Test-DaemonHealth($exe, $url) {
    # The server reads HANNIGRAM_URLS (--urls is ignored by the current build), and
    # the child inherits the env var, so a stray daemon on the default port cannot
    # make this smoke test pass by accident.
    $previousUrls = $env:HANNIGRAM_URLS
    $env:HANNIGRAM_URLS = $url
    $process = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden
    try {
        $deadline = (Get-Date).AddSeconds(60)
        while ((Get-Date) -lt $deadline) {
            try {
                $health = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 3
                if ($health.status -eq "ok") { return $health }
            } catch { }
            Start-Sleep -Milliseconds 500
        }
        return $null
    } finally {
        $env:HANNIGRAM_URLS = $previousUrls
        if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    }
}

if (-not $SkipSmokeTest) {
    Write-Step "Smoke test del daemon empaquetado"
    $smokeUrl = "http://127.0.0.1:8799"
    $health = Test-DaemonHealth (Join-Path $stageDir "HanniGram.Server.exe") $smokeUrl
    if (-not $health) { throw "El daemon empaquetado no respondio /health en $smokeUrl" }
    Write-Ok "daemon OK en $smokeUrl (db: $($health.db))"
} else {
    Write-Warn "smoke test omitido (-SkipSmokeTest)"
}

# ---------------------------------------------------------------------------
# 5. Zip + checksum
# ---------------------------------------------------------------------------
Write-Step "Empaquetando $AssetName"
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$zip = Join-Path $OutDir $AssetName
if (Test-Path $zip) { Remove-Item $zip -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
[System.IO.Compression.ZipFile]::CreateFromDirectory($stageDir, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

$sha = Get-Sha256 $zip
Set-Content -Path "$zip.sha256" -Value "$sha *$AssetName" -Encoding ascii
Write-Ok "$zip"
Write-Ok "sha256 $sha"
Get-ChildItem $stageDir | ForEach-Object { Write-Host "    $($_.Name) ($([math]::Round($_.Length / 1MB, 1)) MB)" }

# ---------------------------------------------------------------------------
# 6. Optional local install
# ---------------------------------------------------------------------------
if ($InstallLocal) {
    Write-Step "Instalando en %LOCALAPPDATA%\HanniPI\hannigram"
    $hgDir = Join-Path $env:LOCALAPPDATA "HanniPI\hannigram"
    if (Test-Path $hgDir) { Remove-Item $hgDir -Recurse -Force }
    New-Item -ItemType Directory -Path $hgDir -Force | Out-Null
    Get-ChildItem $stageDir | Copy-Item -Destination $hgDir -Force
    $server = Join-Path $hgDir "HanniGram.Server.exe"
    [Environment]::SetEnvironmentVariable("HANNIGRAM_DAEMON", $server, "User")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (($userPath -split ";") -notcontains $hgDir) {
        [Environment]::SetEnvironmentVariable("Path", (@(($userPath -split ";" | Where-Object { $_ }) + @($hgDir)) -join ";"), "User")
    }
    Write-Ok "HanniGram instalado en $hgDir (HANNIGRAM_DAEMON + PATH)"
}

Write-Step "Listo"
Write-Ok "asset: $zip"
