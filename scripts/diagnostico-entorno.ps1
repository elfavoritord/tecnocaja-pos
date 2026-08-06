# =============================================================
# scripts/diagnostico-entorno.ps1 -- Tecno Caja POS
# Compara el entorno de Windows entre distintas PCs (tu PC principal vs.
# la de un cliente) para encontrar diferencias reales que expliquen por
# que algo falla en una y no en la otra.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File scripts\diagnostico-entorno.ps1
#
# Corre esto en tu PC y guarda el resultado. Despues corre lo mismo en la
# PC del cliente y compara los dos archivos linea por linea.
# =============================================================

$ErrorActionPreference = 'SilentlyContinue'
$out = @()
function Line { param($t) $script:out += $t; Write-Host $t }
function Section { param($t) Line ""; Line "== $t =="  }

Line "Diagnostico de entorno -- Tecno Caja POS"
Line "PC: $env:COMPUTERNAME | Usuario: $env:USERNAME | Fecha: $(Get-Date -Format 'yyyy-MM-dd HH:mm')"

# ── Windows ────────────────────────────────────────────────────────────────
Section "Windows"
$os = Get-CimInstance Win32_OperatingSystem
Line "Version   : $($os.Caption) (build $($os.BuildNumber))"
Line "Arquitectura: $($os.OSArchitecture)"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Line "Corriendo como administrador: $isAdmin"

# ── PowerShell / .NET ────────────────────────────────────────────────────────
Section "PowerShell y .NET"
Line "PowerShell version: $($PSVersionTable.PSVersion)"
Line "Politica de ejecucion (CurrentUser): $(Get-ExecutionPolicy -Scope CurrentUser)"
Line "Politica de ejecucion (LocalMachine): $(Get-ExecutionPolicy -Scope LocalMachine)"
try {
  $netVersions = Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP' -Recurse |
    Get-ItemProperty -Name Version, Release -ErrorAction SilentlyContinue |
    Where-Object { $_.PSChildName -match '^(?!S)\p{L}' } |
    Select-Object -ExpandProperty Version -Unique
  Line ".NET Framework instalado: $($netVersions -join ', ')"
} catch { Line ".NET Framework: no se pudo leer" }

# ── Antivirus ────────────────────────────────────────────────────────────────
Section "Antivirus / Seguridad"
try {
  $avList = Get-CimInstance -Namespace "root\SecurityCenter2" -ClassName AntivirusProduct
  if ($avList) {
    foreach ($av in $avList) {
      Line "Antivirus: $($av.displayName) (estado: $($av.productState))"
    }
  } else {
    Line "Antivirus: no se detecto ninguno via SecurityCenter2"
  }
} catch { Line "Antivirus: no se pudo consultar SecurityCenter2" }

try {
  $mp = Get-MpComputerStatus -ErrorAction Stop
  Line "Windows Defender - Proteccion en tiempo real: $($mp.RealTimeProtectionEnabled)"
  Line "Windows Defender - Antivirus habilitado: $($mp.AntivirusEnabled)"
  Line "Windows Defender - Ultima actualizacion firmas: $($mp.AntivirusSignatureLastUpdated)"
} catch { Line "Windows Defender: Get-MpComputerStatus no disponible (puede haber otro antivirus activo)" }

# ── Tecno Caja instalado ──────────────────────────────────────────────────────
Section "Tecno Caja"
$installDir = "$env:LOCALAPPDATA\Programs\Tecno Caja"
if (Test-Path $installDir) {
  $exe = Join-Path $installDir "Tecno Caja.exe"
  if (Test-Path $exe) {
    $ver = (Get-Item $exe).VersionInfo.FileVersion
    Line "Instalado en: $installDir"
    Line "Version del ejecutable: $ver"
  }
} else {
  Line "No se encontro instalacion en $installDir (revisa si se instalo en otra ruta)"
}

# terminal-config.json (multicaja) -- misma ruta que usa TERMINAL_CONFIG_PATH en server.js
$userDataCandidates = @(
  "$env:APPDATA\pos-system\config\terminal-config.json",
  "$env:APPDATA\Tecno Caja\config\terminal-config.json"
)
$tcFound = $false
foreach ($p in $userDataCandidates) {
  if (Test-Path $p) {
    $tcFound = $true
    Line "terminal-config.json encontrado en: $p"
    Get-Content $p | ForEach-Object { Line "  $_" }
  }
}
if (-not $tcFound) { Line "terminal-config.json: no existe (esta PC nunca activo modo multicaja/multisucursal)" }

# Cache del compilador de impresion RAW
$rawDll = "$env:LOCALAPPDATA\Tecno Caja\rawprint.dll"
if (Test-Path $rawDll) {
  $item = Get-Item $rawDll
  Line "rawprint.dll (cache de impresion): existe, compilado el $($item.LastWriteTime)"
} else {
  Line "rawprint.dll (cache de impresion): no existe todavia (no se ha impreso nada aun, o se borro)"
}

# ── Impresoras ─────────────────────────────────────────────────────────────
Section "Impresoras instaladas"
try {
  Get-CimInstance Win32_Printer | ForEach-Object {
    Line "$($_.Name) | Driver: $($_.DriverName) | Puerto: $($_.PortName) | Predeterminada: $($_.Default) | Estado: $($_.PrinterStatus)"
  }
} catch { Line "No se pudieron listar las impresoras" }

# ── Guardar a archivo ──────────────────────────────────────────────────────
$outFile = Join-Path $env:TEMP "tecnocaja-diagnostico-$env:COMPUTERNAME.txt"
$out | Out-File -FilePath $outFile -Encoding UTF8
Write-Host ""
Write-Host "Guardado en: $outFile" -ForegroundColor Green
Write-Host "Mandame este archivo (o el contenido) para comparar con otra PC." -ForegroundColor Green
