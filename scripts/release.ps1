# =============================================================
# scripts/release.ps1 -- Tecno Caja POS
# Release automatizado: version bump -> git -> build -> publish
# =============================================================
# Uso:
#   npm run release           (patch automatico)
#   npm run release:minor
#   npm run release:major
#   npm run release -- -Bump patch -Message "fix: descripcion"
# =============================================================

param(
  [ValidateSet('patch','minor','major','')]
  [string]$Bump    = 'patch',
  [string]$Message = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

function Step  { param($n,$t) Write-Host "" ; Write-Host "  [$n] $t" -ForegroundColor Cyan }
function Ok    { param($t)    Write-Host "      OK  $t" -ForegroundColor Green }
function Info  { param($t)    Write-Host "      ... $t" -ForegroundColor DarkGray }
function Warn  { param($t)    Write-Host "      **  $t" -ForegroundColor Yellow }
function Fail  { param($t)    Write-Host "" ; Write-Host "  ERROR: $t" -ForegroundColor Red ; exit 1 }

Write-Host ""
Write-Host "  ==========================================" -ForegroundColor Magenta
Write-Host "    Tecno Caja POS -- Auto Release ($Bump)" -ForegroundColor Magenta
Write-Host "  ==========================================" -ForegroundColor Magenta

# ── 0. Cargar GH_TOKEN ────────────────────────────────────────
Step '0/5' 'Cargando configuracion...'

if (-not $env:GH_TOKEN) {
  $envFile = Join-Path $root '.env'
  if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
      if ($_ -match '^GH_TOKEN\s*=\s*(.+)') { $env:GH_TOKEN = $matches[1].Trim() }
    }
  }
}
if (-not $env:GH_TOKEN) {
  Fail "GH_TOKEN no encontrado. Agrega GH_TOKEN=ghp_... a tu archivo .env"
}
Ok 'GH_TOKEN cargado'

# ── 1. Calcular nueva version ─────────────────────────────────
Step '1/5' 'Calculando version...'

$pkgPath  = Join-Path $root 'package.json'
$pkgRaw   = Get-Content $pkgPath -Raw
$pkg      = $pkgRaw | ConvertFrom-Json
$oldVer   = $pkg.version
$parts    = $oldVer -split '\.'
[int]$maj = $parts[0]
[int]$min = $parts[1]
[int]$pat = $parts[2]

switch ($Bump) {
  'patch' { $pat++;             $newVer = "$maj.$min.$pat" }
  'minor' { $min++; $pat = 0;  $newVer = "$maj.$min.$pat" }
  'major' { $maj++; $min = 0; $pat = 0; $newVer = "$maj.$min.$pat" }
}

Ok "Version: v$oldVer  ->  v$newVer  (tipo: $Bump)"

if (-not $Message) { $Message = "chore: release v$newVer" }

# ── 2. Actualizar archivos de version ─────────────────────────
Step '2/5' 'Actualizando package.json y update-manifest.json...'

# package.json
$pkgRaw = $pkgRaw -replace '"version"\s*:\s*"[^"]*"', "`"version`": `"$newVer`""
[System.IO.File]::WriteAllText($pkgPath, $pkgRaw, [System.Text.Encoding]::UTF8)
Ok "package.json -> v$newVer"

# update-manifest.json
$manifestPath = Join-Path $root 'update-manifest.json'
if (Test-Path $manifestPath) {
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  $manifest.version       = $newVer
  $manifest.stableVersion = $newVer
  $manifest.date          = (Get-Date -Format 'dd/MM/yyyy')
  $json = $manifest | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText($manifestPath, $json, [System.Text.Encoding]::UTF8)
  Ok "update-manifest.json -> v$newVer  (fecha: $(Get-Date -Format 'dd/MM/yyyy'))"
} else {
  Warn 'update-manifest.json no encontrado, omitiendo'
}

# ── 3. Git: commit + push ─────────────────────────────────────
Step '3/5' 'Guardando cambios en Git...'

$gitStatus = (git status --porcelain 2>&1)
if ($gitStatus) {
  git add .
  if ($LASTEXITCODE -ne 0) { Fail "git add fallo (codigo $LASTEXITCODE)" }

  git commit -m $Message
  if ($LASTEXITCODE -ne 0) { Fail "git commit fallo (codigo $LASTEXITCODE)" }
  Ok "Commit creado: $Message"
} else {
  Ok 'Sin cambios nuevos -- repositorio limpio'
}

Info 'Subiendo a GitHub...'
git push origin master
if ($LASTEXITCODE -ne 0) { Fail "git push fallo (codigo $LASTEXITCODE)" }
Ok 'Codigo subido -> github.com/elfavoritord/tecnocaja-pos'

# ── 4. Build + Publish ────────────────────────────────────────
Step '4/5' "Construyendo TecnoCaja-Setup-$newVer.exe..."
Info 'Esto puede tardar 5-10 minutos...'
Write-Host ""

node scripts/prepare-mariadb-bundle.js
if ($LASTEXITCODE -ne 0) { Fail "prepare-mariadb-bundle.js fallo" }

npx electron-builder --win nsis --publish always
if ($LASTEXITCODE -ne 0) { Fail "electron-builder fallo (codigo $LASTEXITCODE)" }

# ── 5. Resumen ────────────────────────────────────────────────
Step '5/5' 'Release completado!'
Write-Host ""
Write-Host "  ----------------------------------------------------------" -ForegroundColor Green
Write-Host "  Version publicada : v$newVer" -ForegroundColor Green
Write-Host "  Instalador        : dist\TecnoCaja-Setup-$newVer.exe" -ForegroundColor Green
Write-Host "  Repositorio       : github.com/elfavoritord/tecnocaja-pos" -ForegroundColor Green
Write-Host "  Release en GitHub : /releases/tag/v$newVer" -ForegroundColor Green
Write-Host "  ----------------------------------------------------------" -ForegroundColor Green
Write-Host ""
