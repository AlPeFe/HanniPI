# HanniPI + HanniGram - instalador unificado para Windows
# Un solo script: instalar / actualizar / desinstalar los dos juntos.
#
# Uso (doble clic en HANNI.bat, o directo):
#   powershell -ExecutionPolicy Bypass -File hanni-setup.ps1
#   powershell -ExecutionPolicy Bypass -File hanni-setup.ps1 -Action install -Yes
#   powershell -ExecutionPolicy Bypass -File hanni-setup.ps1 -Action update -HannigramSource latest
#   powershell -ExecutionPolicy Bypass -File hanni-setup.ps1 -Action fonts
#   powershell -ExecutionPolicy Bypass -File hanni-setup.ps1 -Action uninstall
#
# Ademas de HanniPI y HanniGram, la instalacion deja lista la tipografia del
# harness: instala la familia 'Rysana Mono' (viene en el zip, en
# assets/fonts/rysana) para el usuario actual y fija esa fuente como fuente por
# defecto de Windows Terminal. Con -SkipFonts se omite todo esto.
#
# Antes de instalar/actualizar/desinstalar se PARA el daemon de memoria
# (HanniGram) y los procesos auxiliares de bun/node/dotnet que salen de la
# instalacion. El harness (hanni.exe) NO se mata: la instalacion se hace por
# renombrado (ver Install-Staged), asi que una sesion abierta no bloquea la
# actualizacion, no se pierde trabajo, y `hanni update` no se mata a si mismo
# (ese era el fallo: el script moria justo antes de instalar y la version
# nueva nunca se aplicaba). La version nueva entra en vigor al reiniciar el
# harness.
#
# HanniGram (la memoria) es obligatorio: la release TIENE que traer
# hannigram-windows-x64.zip. Si falta, el script aborta antes de tocar nada.
# El asset incluye el daemon, el CLI y la extension de las tools mem_*; con
# -HannigramSource latest se toma el asset de la ultima release de AlPeFe/HanniGram
# en vez del pinneado en la release de HanniPI.

param(
    [ValidateSet("menu", "install", "update", "uninstall", "fonts")]
    [string]$Action = "menu",
    [switch]$Yes,
    [switch]$SkipStop,
    # No instala la tipografia Rysana ni toca la configuracion de Windows Terminal.
    [switch]$SkipFonts,
    # pinned = daemon pinneado en la release de HanniPI (una sola descarga
    # atomica, recomendado); latest = ultima release de AlPeFe/HanniGram.
    [ValidateSet("pinned", "latest")]
    [string]$HannigramSource = "pinned"
)

$ErrorActionPreference = "Stop"

$Repo = "AlPeFe/HanniPI"
$HgmRepo = "AlPeFe/HanniGram"
$Asset = "pi-windows-x64.zip"
$HgmAsset = "hannigram-windows-x64.zip"
$InstallDir = Join-Path $env:LOCALAPPDATA "HanniPI"
$HgmDir = Join-Path $InstallDir "hannigram"
$BinName = "hanni.exe"
# Tipografia del harness: los TTF viajan en el zip (assets/fonts/rysana) y se
# instalan en las fuentes del usuario; Windows Terminal pasa a usarlos.
$FontsSourceDir = Join-Path $InstallDir "assets\fonts\rysana\ttf"
$UserFontsDir = Join-Path $env:LOCALAPPDATA "Microsoft\Windows\Fonts"
$FontsRegPath = "HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Fonts"
$FontFace = "Rysana Mono"
# El harness descubre extensiones en <agentDir>/extensions (por defecto ~/.pi/agent).
$AgentDir = $env:HANNI_CODING_AGENT_DIR
if (-not $AgentDir) { $AgentDir = Join-Path $env:USERPROFILE ".pi\agent" }
$ExtDir = Join-Path $AgentDir "extensions\hannigram"

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
# Procesos protegidos: este script (powershell) y toda su cadena de padres.
# `hanni update` lanza este script, asi que en esa cadena estan el propio
# `hanni update` y la terminal/sesion del harness que lo invoco: matarlos
# abortaba la actualizacion y se llevaba por delante la sesion del usuario.
# ---------------------------------------------------------------------------
function Get-ProtectedProcessIds {
    $protected = @{}
    $protected[[int]$PID] = $true
    try {
        $parents = @{}
        foreach ($p in Get-CimInstance Win32_Process -ErrorAction Stop) {
            $parents[[int]$p.ProcessId] = [int]$p.ParentProcessId
        }
        $current = [int]$PID
        $guard = 0
        while ($parents.ContainsKey($current) -and $guard -lt 64) {
            $parent = $parents[$current]
            if ($parent -le 0 -or $protected.ContainsKey($parent)) { break }
            $protected[$parent] = $true
            $current = $parent
            $guard++
        }
    } catch { }
    return $protected
}

# ---------------------------------------------------------------------------
# Parar el daemon de memoria y los procesos auxiliares antes de tocar ficheros.
# El harness (hanni.exe) se deja en paz a proposito: no bloquea la instalacion
# (se aparta por renombrado) y matarlo perderia el trabajo de la sesion.
# Devuelve cuantos proceso paro.
# ---------------------------------------------------------------------------
function Stop-HanniProcesses {
    if ($SkipStop) { Write-Warn "Stop-HanniProcesses omitido (-SkipStop)"; return 0 }
    Write-Host "Parando el daemon de memoria y procesos auxiliares..." -ForegroundColor Cyan
    $installLiteral = [regex]::Escape($InstallDir)
    $protected = Get-ProtectedProcessIds
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
        if ($name -eq "hannigram.exe" -or $name -eq "hannigram.server.exe" -or
            $name -eq "hannigram.cli.exe" -or $name -eq "hannigram-mcp.exe") {
            # El daemon se reinicia despues con Test-HanniGramDaemon.
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
        if ($protected.ContainsKey([int]$p.ProcessId)) {
            Write-Host "  en uso, no lo toco: $($p.Name) (PID $($p.ProcessId))" -ForegroundColor DarkGray
            continue
        }
        try {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
            Write-Host "  parado $($p.Name) (PID $($p.ProcessId))" -ForegroundColor DarkGray
            $stopped++
        } catch {
            Write-Warn "no pude parar $($p.Name) (PID $($p.ProcessId)); sigue en marcha"
        }
    }
    if ($stopped -eq 0) { Write-Ok "no habia nada que parar" }
    else { Write-Ok "$stopped proceso(s) parado(s)" }
    # Deja un momento a Windows para liberar los bloqueos de fichero.
    Start-Sleep -Milliseconds 800
    return $stopped
}

# Devuelve cuantos harness (hanni.exe) siguen abiertos; se usan para avisar de
# que la version nueva entra en vigor al reiniciarlos.
function Get-RunningHarnessCount {
    try {
        return @(Get-CimInstance Win32_Process -Filter "Name='hanni.exe'" -ErrorAction Stop).Count
    } catch {
        return 0
    }
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
    $release = $null
    for ($i = 1; $i -le 3; $i++) {
        try {
            $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" `
                -Headers @{ "User-Agent" = "hanni-setup" } -ErrorAction Stop
            break
        } catch {
            if ($i -eq 3) { throw "No pude consultar la ultima release de $Repo : $($_.Exception.Message)" }
            Write-Warn "consulta de la release fallida (intento $i de 3): $($_.Exception.Message)"
            Start-Sleep -Seconds 2
        }
    }
    Write-Ok "release $($release.tag_name)"
    return $release
}

# Las descargas son grandes (~55 MB el harness, ~115 MB la memoria) y fallan a
# la primera con mas frecuencia de la cuenta; sin reintento la actualizacion se
# quedaba a medias.
function Invoke-DownloadWithRetry($url, $dest, $label) {
    for ($i = 1; $i -le 3; $i++) {
        try {
            Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -ErrorAction Stop
            return
        } catch {
            if ($i -eq 3) { throw "No pude descargar $label ($url): $($_.Exception.Message)" }
            Write-Warn "descarga de $label fallida (intento $i de 3): $($_.Exception.Message)"
            Start-Sleep -Seconds 2
        }
    }
}

function Download-Asset($release, $assetName, $dest) {
    $url = "https://github.com/$Repo/releases/download/$($release.tag_name)/$assetName"
    Write-Host "Descargando $assetName ..." -ForegroundColor Cyan
    Invoke-DownloadWithRetry $url $dest $assetName
    return $dest
}

function Get-ShaMap($release) {
    $sumsPath = Join-Path $env:TEMP "hanni-SHA256SUMS"
    $url = "https://github.com/$Repo/releases/download/$($release.tag_name)/SHA256SUMS"
    Invoke-DownloadWithRetry $url $sumsPath "SHA256SUMS"
    return Get-ShaMapFromPath $sumsPath
}

function Get-ShaMapFromPath($sumsPath) {
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

# Descarga, verifica el checksum y extrae un asset en un directorio de staging.
function Stage-Asset($release, $shaMap, $assetName, $destDir) {
    $zip = Download-Asset $release $assetName (Join-Path $env:TEMP $assetName)
    Verify-Asset $zip $assetName $shaMap
    Expand-Flattened $zip $destDir
    return $destDir
}

# Windows no deja borrar ni sobrescribir un .exe en marcha ("Acceso denegado"),
# pero SI deja renombrar la carpeta que lo contiene. La instalacion se hace asi:
#   1) la instalacion actual se aparta como <dest>.old-<marca> (instantaneo)
#   2) el contenido ya verificado se coloca en <dest>
#   3) el <dest>.old-<marca> se borra; si algun proceso viejo lo mantiene
#      bloqueado, se borra en la proxima instalacion (Remove-RetiredInstalls)
# Con esto no hay que matar nada: la version nueva entra en vigor al reiniciar
# el harness que estuviera abierto.
function Move-Aside($dest) {
    if (-not (Test-Path $dest)) { return $null }
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $retired = "$dest.old-$stamp"
    $n = 1
    while (Test-Path $retired) {
        $retired = "$dest.old-$stamp-$n"
        $n++
    }
    try {
        Move-Item $dest $retired -Force -ErrorAction Stop
    } catch {
        throw "No pude apartar la instalacion actual ($dest): $($_.Exception.Message). Cierra las terminales que esten dentro de esa carpeta y reintenta."
    }
    return $retired
}

# Restos de una actualizacion anterior: el proceso viejo ya no existe, asi que
# ahora si se pueden borrar.
function Remove-RetiredInstalls {
    $parent = Split-Path $InstallDir -Parent
    $leaf = Split-Path $InstallDir -Leaf
    if (-not (Test-Path $parent)) { return }
    foreach ($dir in @(Get-ChildItem $parent -Directory -Filter "$leaf.old-*" -ErrorAction SilentlyContinue)) {
        try {
            Remove-Item $dir.FullName -Recurse -Force -ErrorAction Stop
            Write-Host "  limpiado resto de la version anterior: $($dir.Name)" -ForegroundColor DarkGray
        } catch {
            Write-Warn "no pude borrar $($dir.Name) (sigue en uso); se intentara en la proxima actualizacion"
        }
    }
}

# Reemplaza $dest por el contenido ya validado de $source.
function Install-Staged($source, $dest) {
    $retired = Move-Aside $dest
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    try {
        Get-ChildItem $source -Force | Move-Item -Destination $dest -Force -ErrorAction Stop
    } catch {
        $failure = $_
        if ($retired) {
            try {
                Remove-Item $dest -Recurse -Force -ErrorAction Stop
                Move-Item $retired $dest -Force -ErrorAction Stop
                Write-Warn "instalacion anterior restaurada en $dest"
            } catch {
                Write-Err "no pude restaurar la instalacion anterior; esta en $retired, muevela a mano a $dest"
            }
        }
        throw $failure
    }
    Remove-Item $source -Recurse -Force
    if ($retired) {
        try {
            Remove-Item $retired -Recurse -Force -ErrorAction Stop
        } catch {
            Write-Warn "la version anterior sigue en $retired (en uso); se borrara en la proxima actualizacion"
        }
    }
}

# Los zips y el staging de %TEMP% no se reutilizan entre ejecuciones.
function Remove-TempArtifacts {
    foreach ($name in @($Asset, $HgmAsset, "hanni-SHA256SUMS", "hannigram-SHA256SUMS")) {
        $path = Join-Path $env:TEMP $name
        if (Test-Path $path) { Remove-Item $path -Force -ErrorAction SilentlyContinue }
    }
    foreach ($name in @("hanni-pi-staging", "hannigram-staging")) {
        $path = Join-Path $env:TEMP $name
        if (Test-Path $path) { Remove-Item $path -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

# Arranca el daemon si no responde ya y espera a /health. Devuelve $true/$false.
function Test-HanniGramDaemon($server, $timeoutSeconds = 45) {
    $url = $env:HANNIGRAM_URLS
    if (-not $url) { $url = "http://127.0.0.1:8765" }
    try {
        $health = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 3
        if ($health.status -eq "ok") { return $true }
    } catch { }
    try { Start-Process -FilePath $server -WindowStyle Hidden | Out-Null } catch { return $false }
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 3
            if ($health.status -eq "ok") { return $true }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

# Stage del asset de HanniGram: o el pinneado en la release de HanniPI, o la
# ultima release de HanniGram (daemon + CLI + extension). Devuelve el staging.
function Stage-HanniGram($release, $shaMap) {
    if ($HannigramSource -eq "latest") {
        Write-Host "Buscando la ultima release de $HgmRepo (HannigramSource=latest) ..." -ForegroundColor Cyan
        $hgmRelease = Invoke-RestMethod -Uri "https://api.github.com/repos/$HgmRepo/releases/latest" `
            -Headers @{ "User-Agent" = "hanni-setup" }
        Write-Ok "release $($hgmRelease.tag_name)"
        $sumsPath = Join-Path $env:TEMP "hannigram-SHA256SUMS"
        Invoke-DownloadWithRetry "https://github.com/$HgmRepo/releases/download/$($hgmRelease.tag_name)/SHA256SUMS" $sumsPath "SHA256SUMS"
        $zip = Join-Path $env:TEMP $HgmAsset
        Invoke-DownloadWithRetry "https://github.com/$HgmRepo/releases/download/$($hgmRelease.tag_name)/$HgmAsset" $zip $HgmAsset
        Verify-Asset $zip $HgmAsset (Get-ShaMapFromPath $sumsPath)
    } else {
        $zip = Download-Asset $release $HgmAsset (Join-Path $env:TEMP $HgmAsset)
        Verify-Asset $zip $HgmAsset $shaMap
    }

    $stage = Join-Path $env:TEMP "hannigram-staging"
    Expand-Flattened $zip $stage
    if (-not (Test-Path (Join-Path $stage "HanniGram.Server.exe"))) {
        throw "No encuentro HanniGram.Server.exe tras extraer $HgmAsset"
    }
    return $stage
}

# Las tools mem_* llegan como extension del harness dentro del asset; el harness
# las descubre sola en <agentDir>/extensions.
function Install-HanniGramExtension($hgmSource) {
    $source = Join-Path $hgmSource "pi-extension"
    if (-not (Test-Path (Join-Path $source "package.json"))) {
        Write-Warn "El asset de HanniGram no trae pi-extension; las tools mem_* quedan sin instalar (la memoria sigue funcionando)."
        return $false
    }
    if (Test-Path $ExtDir) {
        try { Remove-Item $ExtDir -Recurse -Force -ErrorAction Stop }
        catch { Write-Warn "no pude limpiar $ExtDir (en uso); copio encima" }
    }
    New-Item -ItemType Directory -Path $ExtDir -Force | Out-Null
    Get-ChildItem $source -Force | Copy-Item -Destination $ExtDir -Recurse -Force
    Write-Ok "extension mem_* instalada en $ExtDir"
    return $true
}

# ---------------------------------------------------------------------------
# Tipografia Rysana Mono: se instala por usuario (sin admin) y Windows Terminal
# pasa a usarla como fuente por defecto.
# ---------------------------------------------------------------------------
function Install-RysanaFonts {
    if (-not (Test-Path $FontsSourceDir)) {
        Write-Warn "no encuentro las fuentes en $FontsSourceDir; instala antes con -Action install"
        return $false
    }
    New-Item -ItemType Directory -Force -Path $UserFontsDir | Out-Null
    if (-not (Test-Path $FontsRegPath)) { New-Item -Path $FontsRegPath -Force | Out-Null }
    $files = @(Get-ChildItem -Path $FontsSourceDir -Filter "*.ttf")
    $count = 0
    foreach ($file in $files) {
        $target = Join-Path $UserFontsDir $file.Name
        # Reinstalar sobrescribiendo un fichero ya cargado por Windows falla con
        # "en uso": si ya esta ahi con el mismo tamano, se da por instalado.
        if (-not ((Test-Path $target) -and ((Get-Item $target).Length -eq $file.Length))) {
            try {
                Copy-Item $file.FullName $target -Force -ErrorAction Stop
            } catch {
                Write-Warn "no pude copiar $($file.Name) (en uso); cierra Windows Terminal y reintenta"
                continue
            }
        }
        # -creplace: -replace ignora mayusculas y partiria 'Italic' en 'I ta li c'.
        $name = "$FontFace $($file.BaseName -creplace '^RysanaMono-', '' -creplace '([a-z])([A-Z])', '$1 $2')"
        New-ItemProperty -Path $FontsRegPath -Name "$name (TrueType)" -Value $target -PropertyType String -Force | Out-Null
        $count++
    }
    Write-Ok "$count ficheros de la familia '$FontFace' instalados en $UserFontsDir"
    # AddFontResource + WM_FONTCHANGE: las apps abiertas ven la fuente sin reiniciar Windows.
    try {
        Add-Type -Namespace HanniFonts -Name Notify -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("gdi32.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto)]
public static extern int AddFontResource(string lpFileName);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint msg, System.UIntPtr wParam, System.IntPtr lParam, uint flags, uint timeout, out System.UIntPtr result);
"@
        foreach ($file in $files) {
            [void][HanniFonts.Notify]::AddFontResource((Join-Path $UserFontsDir $file.Name))
        }
        $result = [System.UIntPtr]::Zero
        [void][HanniFonts.Notify]::SendMessageTimeout([System.IntPtr]0xffff, 0x001D, [System.UIntPtr]::Zero, [System.IntPtr]::Zero, 0x0002, 1000, [ref]$result)
    } catch {
        Write-Warn "las terminales ya abiertas pueden necesitar reinicio para pintar la fuente"
    }
    return $true
}

# ficheros settings.json de Windows Terminal (Store, Preview y sin empaquetar).
function Get-TerminalSettingsPaths {
    $paths = @()
    foreach ($pkg in @("Microsoft.WindowsTerminal_8wekyb3d8bbwe", "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe")) {
        $paths += (Join-Path $env:LOCALAPPDATA "Packages\$pkg\LocalState\settings.json")
    }
    $paths += (Join-Path $env:LOCALAPPDATA "Microsoft\Windows Terminal\settings.json")
    return $paths
}

function Set-RysanaTerminalFont {
    $applied = 0
    foreach ($settings in Get-TerminalSettingsPaths) {
        if (-not (Test-Path $settings)) { continue }
        $config = $null
        try { $config = Get-Content $settings -Raw | ConvertFrom-Json } catch { }
        if (-not $config -or -not $config.profiles) {
            Write-Warn "$settings no se puede leer como JSON (comentarios o formato); pon '$FontFace' a mano"
            continue
        }
        if ($null -eq $config.profiles.defaults) {
            $config.profiles | Add-Member -NotePropertyName "defaults" -NotePropertyValue (New-Object psobject) -Force
        }
        $defaults = $config.profiles.defaults
        $current = $null
        if ($defaults.font -and $defaults.font.face) { $current = [string]$defaults.font.face }
        if ($current -eq $FontFace) { Write-Ok "Windows Terminal ya usa $FontFace"; continue }
        if ($current) {
            Write-Warn "Windows Terminal usa '$current'; no la cambio. Ponla a mano si quieres '$FontFace'"
            continue
        }
        if (-not (Test-Path "$settings.hanni-bak")) { Copy-Item $settings "$settings.hanni-bak" -Force }
        if (-not $defaults.font) {
            $defaults | Add-Member -NotePropertyName "font" -NotePropertyValue (New-Object psobject) -Force
        }
        $defaults.font | Add-Member -NotePropertyName "face" -NotePropertyValue $FontFace -Force
        $text = $config | ConvertTo-Json -Depth 32
        [System.IO.File]::WriteAllText($settings, $text, (New-Object System.Text.UTF8Encoding($false)))
        Write-Ok "Windows Terminal: fuente por defecto = $FontFace (copia de seguridad: $settings.hanni-bak)"
        $applied++
    }
    if ($applied -eq 0 -and -not (Test-Path (Join-Path $env:LOCALAPPDATA "Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json"))) {
        Write-Warn "Windows Terminal no detectado; la fuente queda instalada para las apps que la elijan"
    }
}

function Install-Fonts {
    Write-Title "Tipografia Rysana Mono"
    if (-not (Install-RysanaFonts)) { return }
    Set-RysanaTerminalFont
    Write-Host "  Abre una pestana nueva (o Windows Terminal) para verla." -ForegroundColor Magenta
}

function Install-All([bool]$isUpdate) {
    if ($isUpdate) { Write-Title "Actualizar HanniPI + HanniGram" }
    else { Write-Title "Instalar HanniPI + HanniGram" }
    try {
        Install-AllCore $isUpdate
    } finally {
        Remove-TempArtifacts
    }
}

function Install-AllCore([bool]$isUpdate) {
    # Restos de la ejecucion anterior, si los dejo un proceso viejo.
    Remove-RetiredInstalls

    $release = Get-LatestRelease
    $shaMap = Get-ShaMap $release

    # HanniPI sin HanniGram no tiene memoria, asi que el daemon es obligatorio. Se
    # descarga y valida TODO antes de tocar la instalacion actual: si falta el asset
    # o un checksum no cuadra, no se borra nada de lo que ya funcionaba.
    if ($HannigramSource -eq "pinned" -and -not $shaMap.ContainsKey($HgmAsset)) {
        throw "La release $($release.tag_name) no incluye $HgmAsset, asi que no puedo instalar HanniGram. HanniPI sin memoria no sirve: arregla la release (scripts/pack-hannigram.ps1) o instala con -HannigramSource latest."
    }

    $piStage = Join-Path $env:TEMP "hanni-pi-staging"
    Stage-Asset $release $shaMap $Asset $piStage
    if (Test-Path (Join-Path $piStage "pi.exe")) {
        Move-Item (Join-Path $piStage "pi.exe") (Join-Path $piStage $BinName) -Force
    }
    if (-not (Test-Path (Join-Path $piStage $BinName))) {
        throw "No encuentro $BinName tras extraer $Asset"
    }

    $hgmStage = Stage-HanniGram $release $shaMap

    [void](Stop-HanniProcesses)

    Write-Host "Instalando HanniPI en $InstallDir ..." -ForegroundColor Cyan
    Install-Staged $piStage $InstallDir
    Write-Host "Instalando HanniGram en $HgmDir ..." -ForegroundColor Cyan
    Install-Staged $hgmStage $HgmDir

    # HanniPI descubre el daemon por HANNIGRAM_DAEMON y el CLI por PATH.
    $server = Join-Path $HgmDir "HanniGram.Server.exe"
    [Environment]::SetEnvironmentVariable("HANNIGRAM_DAEMON", $server, "User")
    $env:HANNIGRAM_DAEMON = $server
    Add-UserPath $InstallDir
    Add-UserPath $HgmDir
    [void](Install-HanniGramExtension $HgmDir)
    if ($SkipFonts) {
        Write-Warn "tipografia Rysana omitida (-SkipFonts)"
    } elseif (Install-RysanaFonts) {
        Set-RysanaTerminalFont
    }

    $ver = $null
    try { $ver = & (Join-Path $InstallDir $BinName) --version 2>$null } catch { }
    Write-Title "Listo"
    Write-Ok "HanniPI instalado: hanni --version = $ver"
    Write-Ok "HanniGram instalado en $HgmDir (daemon: HANNIGRAM_DAEMON)"
    if (Test-HanniGramDaemon $server) {
        Write-Ok "daemon de memoria respondiendo en /health"
    } else {
        Write-Warn "el daemon no respondio /health; HanniPI lo arrancara cuando lo use"
    }
    if ((Get-RunningHarnessCount) -gt 0) {
        Write-Warn "hay sesiones de hanni abiertas con la version anterior: reinicialas para usar $ver (no se han cerrado para no perder tu trabajo)"
    }
    Write-Host "  Abre una terminal NUEVA y escribe:  hanni" -ForegroundColor Magenta
}

function Uninstall-All {
    Write-Title "Desinstalar HanniPI + HanniGram"
    [void](Stop-HanniProcesses)

    if (Test-Path $InstallDir) {
        # Igual que al instalar: se aparta por renombrado (un hanni.exe abierto
        # impide borrar, pero no renombrar) y se borra al final si se puede.
        try {
            $retired = Move-Aside $InstallDir
            Write-Ok "instalacion apartada: $retired"
            try {
                Remove-Item $retired -Recurse -Force -ErrorAction Stop
                Write-Ok "borrado $InstallDir"
            } catch {
                Write-Warn "queda en $retired (hay un hanni abierto usandola); borrala cuando cierres las sesiones"
            }
        } catch {
            Write-Err "no pude apartar $InstallDir : $($_.Exception.Message)"
            Write-Warn "cierra las terminales que usen hanni y reintenta"
        }
    } else {
        Write-Warn "no habia instalacion en $InstallDir"
    }

    Remove-UserPath $InstallDir
    Remove-UserPathLike "*\HanniPI\hannigram*"
    Remove-UserPath $HgmDir
    if (Test-Path $ExtDir) {
        try {
            Remove-Item $ExtDir -Recurse -Force
            Write-Ok "borrada la extension mem_* $ExtDir"
        } catch {
            Write-Warn "no pude borrar $ExtDir : $($_.Exception.Message)"
        }
    }
    [Environment]::SetEnvironmentVariable("HANNIGRAM_DAEMON", $null, "User")
    if ($env:HANNIGRAM_DAEMON) { Remove-Item Env:\HANNIGRAM_DAEMON -ErrorAction SilentlyContinue }
    Write-Ok "PATH y HANNIGRAM_DAEMON limpiados"
    Write-Warn "las fuentes Rysana ($UserFontsDir) y la fuente de Windows Terminal quedan instaladas; quitalas a mano si no las quieres"

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

    Remove-TempArtifacts
    Write-Host "  Cierra y reabre la terminal para refrescar el PATH." -ForegroundColor Magenta
}

function Show-Menu {
    Write-Title "HanniPI + HanniGram"
    Write-Host " 1) Instalar"
    Write-Host " 2) Actualizar"
    Write-Host " 3) Desinstalar"
    Write-Host " 4) Instalar la tipografia Rysana (fuente de la terminal)"
    Write-Host " 0) Salir"
    Write-Host ""
    $op = Read-Host "Elige una opcion"
    switch ($op) {
        "1" { Install-All $false }
        "2" { Install-All $true }
        "3" { Uninstall-All }
        "4" { Install-Fonts }
        "0" { return }
        default { Write-Warn "opcion no valida"; Show-Menu }
    }
}

# Aseguramos TLS 1.2 para GitHub.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

# Un fallo no puede acabar en un "exited with code 1" mudo: el usuario que
# actualiza necesita saber que ha pasado y que NO se ha quedado a medias.
try {
    if ($Action -eq "menu") { Show-Menu }
    elseif ($Action -eq "install") { Install-All $false }
    elseif ($Action -eq "update") { Install-All $true }
    elseif ($Action -eq "fonts") { Install-Fonts }
    elseif ($Action -eq "uninstall") { Uninstall-All }
} catch {
    Write-Host ""
    Write-Err "Fallo: $($_.Exception.Message)"
    Write-Warn "La instalacion anterior no se ha tocado (o se ha restaurado sola). Reintenta; si persiste, cierra las terminales con hanni abiertas."
    exit 1
}