# HanniGram asset provider for HanniPI releases.
#
# HanniGram (github.com/AlPeFe/HanniGram) builds and publishes its own release
# asset `hannigram-windows-x64.zip` (daemon + CLI + pi-extension, self-contained
# win-x64). HanniPI copies that exact artifact into its own release, pinned by
# tag + sha256 in `hannigram-version.json`, so installing HanniPI + memory stays
# a single verified download.
#
# Usage:
#   # fetch the pinned asset into ~/release-staging/hannigram (release flow)
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pack-hannigram.ps1
#
#   # has HanniGram moved on since the pin? (exit 1 when stale; release gate)
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pack-hannigram.ps1 -Check
#
#   # adopt a new HanniGram release as the pin (writes hannigram-version.json)
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pack-hannigram.ps1 -Tag v0.2.0 -WritePin
#
#   # build from source instead (HanniGram changes not released yet, offline dev)
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pack-hannigram.ps1 -Build -InstallLocal
param(
    # HanniGram release tag. Defaults to the tag recorded in the pin file.
    [string]$Tag,
    [string]$PinFile = (Join-Path $PSScriptRoot "..\hannigram-version.json"),
    [string]$Repo = "AlPeFe/HanniGram",
    [string]$OutDir = (Join-Path $env:USERPROFILE "release-staging\hannigram"),
    [string]$AssetName = "hannigram-windows-x64.zip",
    # CI/API overrides (also used by the local verification harness).
    [string]$ApiBase = "https://api.github.com",
    # Read the release assets from a local directory instead of GitHub.
    [string]$MirrorDir,
    # Build from source instead of downloading a HanniGram release.
    [switch]$Build,
    # Compare the pin against the latest HanniGram release and exit 1 if stale.
    [switch]$Check,
    # Record the resolved tag + sha256 + commit in the pin file.
    [switch]$WritePin,
    # Load the staged asset into %LOCALAPPDATA%\HanniPI (dev/repair shortcut).
    [switch]$InstallLocal,
    # -Build options.
    [string]$RepoDir,
    [string]$Ref = "main",
    [string]$Runtime = "win-x64",
    [string]$NuGetSource = "https://api.nuget.org/v3/index.json",
    [switch]$SkipSmokeTest,
    [switch]$KeepWork
)

$ErrorActionPreference = "Stop"
$script:rootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

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

function Get-ShaMapFromText($text) {
    $map = @{}
    foreach ($line in ($text -split "`n")) {
        if (-not $line.Trim()) { continue }
        $parts = $line.Trim() -split "\s+"
        if ($parts.Count -lt 2) { continue }
        $map[($parts[1] -replace "^\*", "")] = $parts[0].ToLower()
    }
    return $map
}

function Read-Pin {
    if (-not (Test-Path $PinFile)) { return $null }
    return (Get-Content $PinFile -Raw | ConvertFrom-Json)
}

function Read-VersionInfo($text) {
    $info = @{ version = ""; commit = ""; builtAt = "" }
    foreach ($line in ($text -split "`n")) {
        $parts = $line.Trim() -split "=", 2
        if ($parts.Count -eq 2 -and $info.ContainsKey($parts[0])) { $info[$parts[0]] = $parts[1].Trim() }
    }
    return $info
}

# ---------------------------------------------------------------------------
# Release metadata (GitHub API or a local mirror used by the test harness)
# ---------------------------------------------------------------------------
function Get-HanniGramRelease($tag) {
    if ($MirrorDir) {
        $sumsPath = Join-Path $MirrorDir "SHA256SUMS"
        $versionPath = Join-Path $MirrorDir "VERSION.txt"
        if (-not (Test-Path $sumsPath)) { throw "El mirror $MirrorDir no tiene SHA256SUMS" }
        $info = if (Test-Path $versionPath) { Read-VersionInfo (Get-Content $versionPath -Raw) } else { @{ version = ""; commit = "" } }
        return @{
            tag = if ($tag) { $tag } elseif ($info.version) { $info.version } else { "local" }
            sums = Get-ShaMapFromText (Get-Content $sumsPath -Raw)
            dir = $MirrorDir
            versionInfo = $info
        }
    }

    $url = if ($tag) { "$ApiBase/repos/$Repo/releases/tags/$tag" } else { "$ApiBase/repos/$Repo/releases/latest" }
    try {
        $release = Invoke-RestMethod -Uri $url -Headers @{ "User-Agent" = "hannipi-pack-hannigram" }
    } catch {
        throw "No pude leer la release de $Repo en $url : $($_.Exception.Message)"
    }
    $assets = @{}
    foreach ($asset in $release.assets) { $assets[$asset.name] = $asset.browser_download_url }
    return @{
        tag = $release.tag_name
        sums = $null
        assets = $assets
        versionInfo = $null
    }
}

# Ruta local (mirror) o URL del asset. Se resuelve aqui, no en una clausura: un scriptblock
# de PowerShell no conserva las variables locales de la funcion que lo creo.
function Get-ReleaseAssetSource($release, $name) {
    if ($release.dir) { return (Join-Path $release.dir $name) }
    return $release.assets[$name]
}

function Get-ReleaseAssetBytes($release, $name) {
    $source = Get-ReleaseAssetSource $release $name
    if (-not $source) { throw "La release $($release.tag) no trae $name" }
    if ($MirrorDir) { return (Get-Content -Path $source -Raw) }
    $content = (Invoke-WebRequest -Uri $source -UseBasicParsing -Headers @{ "User-Agent" = "hannipi-pack-hannigram" }).Content
    if ($content -is [byte[]]) { return [System.Text.Encoding]::UTF8.GetString($content) }
    return [string]$content
}

function Save-ReleaseAsset($release, $name, $dest) {
    $source = Get-ReleaseAssetSource $release $name
    if (-not $source) { throw "La release $($release.tag) no trae $name" }
    if ($MirrorDir) {
        Copy-Item $source $dest -Force
    } else {
        Invoke-WebRequest -Uri $source -OutFile $dest -UseBasicParsing -Headers @{ "User-Agent" = "hannipi-pack-hannigram" }
    }
    return $dest
}

# ---------------------------------------------------------------------------
# Drift check: pin vs newest HanniGram release
# ---------------------------------------------------------------------------
if ($Check) {
    $pin = Read-Pin
    if (-not $pin) { throw "No existe el pin $PinFile" }
    Write-Step "Pin actual de HanniGram"
    Write-Ok "$($pin.tag) ($($pin.sha256)) commit $($pin.commit)"
    $latest = Get-HanniGramRelease $null
    $latestSource = Get-ReleaseAssetSource $latest $AssetName
    if (-not $latestSource) { throw "La ultima release de $Repo no trae $AssetName" }
    if ($latest.tag -eq $pin.tag) {
        Write-Ok "al dia: la ultima release de HanniGram es $($latest.tag)"
        return
    }
    Write-Warn "DESFASADO: la ultima release de HanniGram es $($latest.tag) y el pin es $($pin.tag)"
    Write-Warn "adopta la nueva con: scripts/pack-hannigram.ps1 -Tag $($latest.tag) -WritePin"
    exit 1
}

# ---------------------------------------------------------------------------
# Build from source (fallback: HanniGram changes not released yet)
# ---------------------------------------------------------------------------
if ($Build) {
    if ($WritePin) { throw "-WritePin solo vale con la release de HanniGram; construir desde fuente no fija el pin" }

    $workRoot = Join-Path $env:TEMP "hannigram-pack"
    $publishRoot = Join-Path $workRoot "publish"
    $stageDir = Join-Path $workRoot "stage"
    if (Test-Path $workRoot) { Remove-Item $workRoot -Recurse -Force }
    New-Item -ItemType Directory -Path $publishRoot, $stageDir -Force | Out-Null

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
    & dotnet @($publishArgs + @((Join-Path $RepoDir "src\HanniGram.Server\HanniGram.Server.csproj"), "-o", $serverOut))
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish fallo para HanniGram.Server" }
    Write-Step "Publicando HanniGram.Cli ($Runtime)"
    & dotnet @($publishArgs + @((Join-Path $RepoDir "src\HanniGram.Cli\HanniGram.Cli.csproj"), "-o", $cliOut))
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish fallo para HanniGram.Cli" }

    $serverExe = Join-Path $serverOut "HanniGram.Server.exe"
    $cliExe = Join-Path $cliOut "HanniGram.Cli.exe"
    $appSettings = Join-Path $serverOut "appsettings.json"
    foreach ($file in @($serverExe, $cliExe, $appSettings)) {
        if (-not (Test-Path $file)) { throw "La publicacion no produjo $file" }
    }

    Write-Step "Preparando el paquete"
    Copy-Item $serverExe (Join-Path $stageDir "HanniGram.Server.exe")
    Copy-Item $cliExe (Join-Path $stageDir "hannigram.exe")
    Copy-Item $appSettings (Join-Path $stageDir "appsettings.json")
    if (Test-Path (Join-Path $RepoDir "README.md")) { Copy-Item (Join-Path $RepoDir "README.md") (Join-Path $stageDir "README-HanniGram.md") }
    $extensionSource = Join-Path $RepoDir "pi-extension"
    if (Test-Path $extensionSource) {
        $extensionStage = Join-Path $stageDir "pi-extension"
        New-Item -ItemType Directory -Path $extensionStage -Force | Out-Null
        foreach ($name in @("index.ts", "package.json")) {
            if (Test-Path (Join-Path $extensionSource $name)) { Copy-Item (Join-Path $extensionSource $name) (Join-Path $extensionStage $name) }
        }
    }
    $commit = (& git -C $RepoDir rev-parse HEAD).Trim()
    $leeme = @(
        "HanniGram: memoria persistente por proyecto para HanniPI.",
        "",
        "- HanniGram.Server.exe  -> daemon HTTP (127.0.0.1:8765). Lo arranca HanniPI solo.",
        "- hannigram.exe         -> CLI (init/save/search/list/topics/...).",
        "- pi-extension/         -> extension del harness (tools mem_*).",
        "",
        "BD en %USERPROFILE%\.hannigram\hannigram.db",
        "Version: local-$($commit.Substring(0, 7))"
    ) -join "`r`n"
    Set-Content -Path (Join-Path $stageDir "LEEME.txt") -Value ($leeme + "`r`n") -Encoding ascii -NoNewline

    if (-not $SkipSmokeTest) {
        Write-Step "Smoke test del daemon empaquetado"
        $smokeUrl = "http://127.0.0.1:8799"
        $previousUrls = $env:HANNIGRAM_URLS
        $env:HANNIGRAM_URLS = $smokeUrl
        $process = Start-Process -FilePath (Join-Path $stageDir "HanniGram.Server.exe") -PassThru -WindowStyle Hidden
        try {
            $deadline = (Get-Date).AddSeconds(60)
            $healthy = $null
            while ((Get-Date) -lt $deadline) {
                try {
                    $healthy = Invoke-RestMethod -Uri "$smokeUrl/health" -TimeoutSec 3
                    if ($healthy.status -eq "ok") { break }
                    $healthy = $null
                } catch { }
                Start-Sleep -Milliseconds 500
            }
            if (-not $healthy) { throw "El daemon empaquetado no respondio /health en $smokeUrl" }
            Write-Ok "daemon OK en $smokeUrl (db: $($healthy.db))"
        } finally {
            $env:HANNIGRAM_URLS = $previousUrls
            if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
        }
    } else {
        Write-Warn "smoke test omitido (-SkipSmokeTest)"
    }

    Write-Step "Empaquetando $AssetName"
    if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
    $zip = Join-Path $OutDir $AssetName
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
    [System.IO.Compression.ZipFile]::CreateFromDirectory($stageDir, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
    $sha = Get-Sha256 $zip
    Set-Content -Path "$zip.sha256" -Value "$sha *$AssetName" -Encoding ascii
    Write-Ok "$zip"
    Write-Ok "sha256 $sha (build local; no reproducible desde la release de HanniGram)"
    $stageForInstall = $stageDir
} else {
    # -----------------------------------------------------------------------
    # Pinned release mode: HanniPI ships the exact HanniGram artifact
    # -----------------------------------------------------------------------
    $pin = Read-Pin
    $tag = if ($Tag) { $Tag } else { $pin.tag }
    if (-not $tag) { throw "No hay tag: pasa -Tag vX.Y.Z o crea $PinFile" }

    Write-Step "HanniGram $tag"
    $release = Get-HanniGramRelease $tag
    Write-Ok "release $($release.tag)"

    if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
    $zip = Join-Path $OutDir $AssetName
    Save-ReleaseAsset $release $AssetName $zip | Out-Null

    # Checksums: los del release de HanniGram y, si el tag coincide, tambien el pin.
    $sumsText = if ($release.sums) { $null } else { Get-ReleaseAssetBytes $release "SHA256SUMS" }
    $shaMap = if ($release.sums) { $release.sums } else { Get-ShaMapFromText $sumsText }
    if (-not $shaMap.ContainsKey($AssetName)) { throw "La release $($release.tag) no tiene checksum para $AssetName" }
    $sha = Get-Sha256 $zip
    if ($shaMap[$AssetName] -ne $sha) {
        throw "Checksum no coincide para ${AssetName}: release $($shaMap[$AssetName]), descargado $sha"
    }
    Write-Ok "checksum verificado contra la release de HanniGram"
    if ($pin -and $pin.tag -eq $release.tag -and $pin.sha256 -ne $sha) {
        throw "El asset de $($release.tag) tiene sha $sha pero el pin dice $($pin.sha256); revisa el pin"
    }
    Set-Content -Path "$zip.sha256" -Value "$sha *$AssetName" -Encoding ascii

    $versionInfo = if ($release.versionInfo) { $release.versionInfo } else { Read-VersionInfo (Get-ReleaseAssetBytes $release "VERSION.txt") }
    Write-Ok "commit $($versionInfo.commit) (built $($versionInfo.builtAt))"
    Write-Ok "sha256 $sha"

    $workRoot = Join-Path $env:TEMP "hannigram-pack"
    $stageForInstall = Join-Path $workRoot "stage"
    if (Test-Path $workRoot) { Remove-Item $workRoot -Recurse -Force }
    New-Item -ItemType Directory -Path $stageForInstall -Force | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $stageForInstall)
    if (-not (Test-Path (Join-Path $stageForInstall "HanniGram.Server.exe"))) { throw "El asset no trae HanniGram.Server.exe" }

    if (-not $SkipSmokeTest) {
        Write-Step "Smoke test del daemon del asset"
        $smokeUrl = "http://127.0.0.1:8799"
        $previousUrls = $env:HANNIGRAM_URLS
        $env:HANNIGRAM_URLS = $smokeUrl
        $process = Start-Process -FilePath (Join-Path $stageForInstall "HanniGram.Server.exe") -PassThru -WindowStyle Hidden
        try {
            $deadline = (Get-Date).AddSeconds(60)
            $healthy = $null
            while ((Get-Date) -lt $deadline) {
                try {
                    $healthy = Invoke-RestMethod -Uri "$smokeUrl/health" -TimeoutSec 3
                    if ($healthy.status -eq "ok") { break }
                    $healthy = $null
                } catch { }
                Start-Sleep -Milliseconds 500
            }
            if (-not $healthy) { throw "El daemon del asset no respondio /health en $smokeUrl" }
            Write-Ok "daemon OK en $smokeUrl (db: $($healthy.db))"
        } finally {
            $env:HANNIGRAM_URLS = $previousUrls
            if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
        }
    } else {
        Write-Warn "smoke test omitido (-SkipSmokeTest)"
    }

    if ($WritePin) {
        $json = @"
{
  "repo": "$Repo",
  "tag": "$($release.tag)",
  "sha256": "$sha",
  "commit": "$($versionInfo.commit)",
  "builtAt": "$($versionInfo.builtAt)"
}
"@
        Set-Content -Path $PinFile -Value $json -Encoding ascii -NoNewline
        Write-Step "Pin actualizado"
        Write-Ok "$PinFile -> $($release.tag) ($sha)"
    }
}

# ---------------------------------------------------------------------------
# Optional local install (daemon + pi-extension)
# ---------------------------------------------------------------------------
if ($InstallLocal) {
    Write-Step "Instalando en %LOCALAPPDATA%\HanniPI"
    $hgDir = Join-Path $env:LOCALAPPDATA "HanniPI\hannigram"
    if (Test-Path $hgDir) { Remove-Item $hgDir -Recurse -Force }
    New-Item -ItemType Directory -Path $hgDir -Force | Out-Null
    Get-ChildItem $stageForInstall -Force | Copy-Item -Destination $hgDir -Recurse -Force
    $server = Join-Path $hgDir "HanniGram.Server.exe"
    [Environment]::SetEnvironmentVariable("HANNIGRAM_DAEMON", $server, "User")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (($userPath -split ";") -notcontains $hgDir) {
        [Environment]::SetEnvironmentVariable("Path", (@(($userPath -split ";" | Where-Object { $_ }) + @($hgDir)) -join ";"), "User")
    }
    Write-Ok "HanniGram en $hgDir (HANNIGRAM_DAEMON + PATH)"
}

if (-not $KeepWork -and $workRoot -and (Test-Path $workRoot)) {
    Remove-Item $workRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Step "Listo"
if ($zip) { Write-Ok "asset: $zip" }
