# HanniPI + HanniGram - instalador unificado para Windows
# Un solo script: instalar / actualizar / desinstalar los dos juntos.
#
# Uso (doble clic en HANNI.bat, o directo):
#   powershell -ExecutionPolicy Bypass -File hanni-setup.ps1
#   powershell -ExecutionPolicy Bypass -File hanni-setup.ps1 -Action install -Yes
#   powershell -ExecutionPolicy Bypass -File hanni-setup.ps1 -Action uninstall
#
# Antes de instalar/actualizar/desinstalar se PARAN todos los procesos de Hanni:
# el binario de HanniPI (compilado con bun), el daemon HanniGram y cualquier
# bun/node/dotnet con "hanni" en su linea de comandos. Sin esto, Windows
# bloquea los ficheros y la instalacion/desinstalacion falla.

param(
    [ValidateSet("menu", "install", "update", "uninstall")]
    [string]$Action = "menu",
    [switch]$Yes,
    [switch]$SkipStop
)

$ErrorActionPreference = "Stop"

$Repo = "AlPeFe/HanniPI"
$Asset = "pi-windows-x64.zip"
$HgmAsset = "hannigram-windows-x64.zip"
$InstallDir = Join-Path $env:LOCALAPPDATA "HanniPI"
$HgmDir = Join-Path $InstallDir "hannigram"
$BinName = "hanni.exe"

function Write-Title($text) {
    Write-Host ""
    Write-Host "====================" -ForegroundColor Magenta
    Write-Host " $text" -ForegroundColor Magenta
    Write-Host "====================" -ForegroundColor Magenta
}
function Write-Ok($text) { Write-Host "  $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "  $text" -ForegroundColor Yellow }
function Write-Err($text) { Write-Host "  $text" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# Parar todos los procesos de Hanni (HanniPI bun + HanniGram) antes de tocar
# ficheros. Devuelve cuantos paro.
# ---------------------------------------------------------------------------
function Stop-HanniProcesses {
    if ($SkipStop) { Write-Warn "Stop-HanniProcesses omitido (-SkipStop)"; return 0 }
    Write-Host "Parando procesos de Hanni..." -ForegroundColor Cyan
    $installLiteral = [regex]::Escape($InstallDir)
    $stopped = 0
    try {
        $procs = Get-CimInstance Win32_Process -ErrorAction Stop
    } catch {
        Write-Warn "No pude enumerar procesos; continua bajo tu riesgo."
        return 0
    }
    foreach ($p in $procs) {
        $name = ""
        if ($p.Name) { $name = $p.Name.ToLowerInvariant() }
        $cmd = ""
        if ($p.CommandLine) { $cmd = $p.CommandLine }
        $path = ""
        if ($p.ExecutablePath) { $path = $p.ExecutablePath }
        $isTarget = $false
        if ($name -eq "hanni.exe" -or $name -eq "hannigram.exe" -or
            $name -eq "hannigram.server.exe" -or $name -eq "hannigram.cli.exe") {
            $isTarget = $true
        } elseif ($name -eq "pi.exe" -and $path -match $installLiteral) {
            $isTarget = $true
        } elseif (($name -eq "bun.exe" -or $name -eq "node.exe" -or $name -eq "dotnet.exe") -and
            ($cmd -match "(?i)(HanniPI|HanniGram|hanniorq)" -or $path -match $installLiteral)) {
            # Ojo: NO usar solo "hanni" a secas — el directorio de sesiones es
            # %USERPROFILE%\.hanni y se mataria el propio harness en marcha.
            $isTarget = $true
        }
        if (-not $isTarget) { continue }
        try {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
            Write-Host "  parado $($p.Name) (PID $($p.ProcessId))" -ForegroundColor DarkGray
            $stopped++
        } catch {
            Write-Warn "no pude parar $($p.Name) (PID $($p.ProcessId)); sigue en marcha"
        }
    }
    if ($stopped -eq 0) { Write-Ok "no habia procesos de Hanni en marcha" }
    else { Write-Ok "$stopped proceso(s) parado(s)" }
    # Deja un momento a Windows para liberar los bloqueos de fichero.
    Start-Sleep -Milliseconds 800
    return $stopped
}

# ---------------------------------------------------------------------------
# PATH de usuario (sin duplicar; quitando la entrada indicada al desinstalar).
# ---------------------------------------------------------------------------
function Add-UserPath($dir) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not $userPath) { $userPath = "" }
    $parts = $userPath -split ";" | Where-Object { $_ -and ($_ -ne $dir) }
    $newPath = (@($parts) + @($dir)) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    if ($env:Path -notlike "*$dir*") { $env:Path = "$env:Path;$dir" }
    Write-Ok "PATH: $dir"
}
function Remove-UserPath($dir) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not $userPath) { return }
    $newPath = (($userPath -split ";") | Where-Object { $_ -and ($_ -ne $dir) }) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
}
function Remove-UserPathLike($pattern) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not $userPath) { return }
    $newPath = (($userPath -split ";") | Where-Object { $_ -and ($_ -notlike $pattern) }) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
}

function Get-LatestRelease {
    Write-Host "Buscando la ultima release de $Repo ..." -ForegroundColor Cyan
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" `
        -Headers @{ "User-Agent" = "hanni-setup" }
    Write-Ok "release $($release.tag_name)"
    return $release
}

function Download-Asset($release, $assetName, $dest) {
    $url = "https://github.com/$Repo/releases/download/$($release.tag_name)/$assetName"
    Write-Host "Descargando $assetName ..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
    return $dest
}

function Get-ShaMap($release) {
    $sumsPath = Join-Path $env:TEMP "hanni-SHA256SUMS"
    $url = "https://github.com/$Repo/releases/download/$($release.tag_name)/SHA256SUMS"
    Invoke-WebRequest -Uri $url -OutFile $sumsPath -UseBasicParsing
    $map = @{}
    foreach ($line in Get-Content $sumsPath) {
        if (-not $line.Trim()) { continue }
        $parts = $line -split "\s+"
        if ($parts.Count -lt 2) { continue }
        $hash = $parts[0].ToLower()
        $file = $parts[1] -replace "^\*", ""
        if (-not $map.ContainsKey($file)) { $map[$file] = $hash }
    }
    return $map
}

function Get-Sha256($path) {
    # Get-FileHash no siempre esta disponible (module path roto); lo hacemos con .NET.
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($path)
        try { return (($sha.ComputeHash($stream) | ForEach-Object { $_.ToString("x2") }) -join "") }
        finally { $stream.Dispose() }
    } finally { $sha.Dispose() }
}

function Verify-Asset($path, $assetName, $shaMap) {
    if (-not $shaMap.ContainsKey($assetName)) {
        throw "La release no tiene checksum para $assetName"
    }
    $actual = Get-Sha256 $path
    if ($shaMap[$assetName] -ne $actual) {
        throw "Checksum no coincide para ${assetName}: esperado $($shaMap[$assetName]), obtenido $actual"
    }
    Write-Ok "checksum verificado ($assetName)"
}

function Expand-Flattened($zip, $dest) {
    # Expand-Archive puede faltar (module path roto); usamos System.IO.Compression.
    Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $dest)
    # Si el zip trae una unica carpeta raiz, aplana su contenido.
    $top = @(Get-ChildItem $dest -Directory)
    $files = @(Get-ChildItem $dest -File)
    if ($files.Count -eq 0 -and $top.Count -eq 1) {
        $inner = $top[0].FullName
        Get-ChildItem $inner | Move-Item -Destination $dest -Force
        Remove-Item $inner -Recurse -Force
    }
}

function Install-HanniPI($release, $shaMap) {
    $zip = Download-Asset $release $Asset (Join-Path $env:TEMP $Asset)
    Verify-Asset $zip $Asset $shaMap

    [void](Stop-HanniProcesses)

    if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
    Write-Host "Instalando HanniPI en $InstallDir ..." -ForegroundColor Cyan
    Expand-Flattened $zip $InstallDir

    if (Test-Path (Join-Path $InstallDir "pi.exe")) {
        Move-Item (Join-Path $InstallDir "pi.exe") (Join-Path $InstallDir $BinName) -Force
    }
    if (-not (Test-Path (Join-Path $InstallDir $BinName))) {
        throw "No encuentro $BinName tras extraer $Asset"
    }
    Add-UserPath $InstallDir
}

function Install-HanniGram($release, $shaMap) {
    if (-not $shaMap.ContainsKey($HgmAsset)) {
        Write-Warn "La release no trae $HgmAsset; me salto HanniGram (lo instalara HanniPI cuando pueda)."
        return $false
    }
    $zip = Download-Asset $release $HgmAsset (Join-Path $env:TEMP $HgmAsset)
    Verify-Asset $zip $HgmAsset $shaMap

    if (Test-Path $HgmDir) { Remove-Item $HgmDir -Recurse -Force }
    Write-Host "Instalando HanniGram en $HgmDir ..." -ForegroundColor Cyan
    Expand-Flattened $zip $HgmDir

    $server = Join-Path $HgmDir "HanniGram.Server.exe"
    if (-not (Test-Path $server)) { throw "No encuentro HanniGram.Server.exe en $HgmDir" }
    # HanniPI descubre el daemon por HANNIGRAM_DAEMON y el CLI por PATH.
    [Environment]::SetEnvironmentVariable("HANNIGRAM_DAEMON", $server, "User")
    $env:HANNIGRAM_DAEMON = $server
    Add-UserPath $HgmDir
    Write-Ok "HanniGram daemon: $server"
    return $true
}

function Install-All([bool]$isUpdate) {
    if ($isUpdate) { Write-Title "Actualizar HanniPI + HanniGram" }
    else { Write-Title "Instalar HanniPI + HanniGram" }

    $release = Get-LatestRelease
    $shaMap = Get-ShaMap $release

    Install-HanniPI $release $shaMap
    $hgmOk = Install-HanniGram $release $shaMap

    $ver = $null
    try { $ver = & (Join-Path $InstallDir $BinName) --version 2>$null } catch { }
    Write-Title "Listo"
    Write-Ok "HanniPI instalado: hanni --version = $ver"
    if ($hgmOk) {
        Write-Ok "HanniGram instalado en $HgmDir (daemon: HANNIGRAM_DAEMON)"
    } else {
        Write-Warn "HanniGram NO instalado (falta el asset en la release)"
    }
    Write-Host "  Abre una terminal NUEVA y escribe:  hanni" -ForegroundColor Magenta
}

function Uninstall-All {
    Write-Title "Desinstalar HanniPI + HanniGram"
    [void](Stop-HanniProcesses)

    if (Test-Path $InstallDir) {
        try {
            Remove-Item $InstallDir -Recurse -Force
            Write-Ok "borrado $InstallDir"
        } catch {
            Write-Err "no pude borrar $InstallDir : $($_.Exception.Message)"
            Write-Warn "cierra las terminales que usen hanni y reintenta"
        }
    } else {
        Write-Warn "no habia instalacion en $InstallDir"
    }

    Remove-UserPath $InstallDir
    Remove-UserPathLike "*\HanniPI\hannigram*"
    Remove-UserPath $HgmDir
    [Environment]::SetEnvironmentVariable("HANNIGRAM_DAEMON", $null, "User")
    if ($env:HANNIGRAM_DAEMON) { Remove-Item Env:\HANNIGRAM_DAEMON -ErrorAction SilentlyContinue }
    Write-Ok "PATH y HANNIGRAM_DAEMON limpiados"

    $dataDir = Join-Path $env:USERPROFILE ".hannigram"
    if (Test-Path $dataDir) {
        $deleteData = $false
        if ($Yes) {
            $deleteData = $false
        } else {
            $answer = Read-Host "¿Borrar tambien la base de datos de memoria ($dataDir)? [s/N]"
            if ($answer -match "^(s|si|sí|y)$") { $deleteData = $true }
        }
        if ($deleteData) {
            Remove-Item $dataDir -Recurse -Force
            Write-Ok "borrada la memoria $dataDir"
        } else {
            Write-Warn "memoria conservada en $dataDir"
        }
    }

    Write-Host "  Cierra y reabre la terminal para refrescar el PATH." -ForegroundColor Magenta
}

function Show-Menu {
    Write-Title "HanniPI + HanniGram"
    Write-Host " 1) Instalar"
    Write-Host " 2) Actualizar"
    Write-Host " 3) Desinstalar"
    Write-Host " 0) Salir"
    Write-Host ""
    $op = Read-Host "Elige una opcion"
    switch ($op) {
        "1" { Install-All $false }
        "2" { Install-All $true }
        "3" { Uninstall-All }
        "0" { return }
        default { Write-Warn "opcion no valida"; Show-Menu }
    }
}

# Aseguramos TLS 1.2 para GitHub.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

if ($Action -eq "menu") { Show-Menu }
elseif ($Action -eq "install") { Install-All $false }
elseif ($Action -eq "update") { Install-All $true }
elseif ($Action -eq "uninstall") { Uninstall-All }
