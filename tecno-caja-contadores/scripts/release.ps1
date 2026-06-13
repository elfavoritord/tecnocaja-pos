# =============================================================
# tecno-caja-contadores/scripts/release.ps1
# Release independiente del Portal de Contadores Tecno Caja
# Publica en: github.com/elfavoritord/tecnocaja-contadores
#
# Uso:
#   npm run release             (patch: 1.0.0 -> 1.0.1)
#   npm run release:minor       (minor: 1.0.0 -> 1.1.0)
#   npm run release:major       (major: 1.0.0 -> 2.0.0)
# =============================================================

param(
  [ValidateSet('patch','minor','major')]
  [string]$Bump    = 'patch',
  [string]$Message = ''
)

$ErrorActionPreference = 'Stop'

# La app vive en tecno-caja-contadores/, el repo raiz es el padre
$appDir  = Split-Path $PSScriptRoot -Parent
$rootDir = Split-Path $appDir -Parent
Set-Location $rootDir

function Step { param($n,$t) Write-Host "" ; Write-Host "  [$n] $t" -ForegroundColor Cyan }
function Ok   { param($t)    Write-Host "      OK  $t" -ForegroundColor Green }
function Info { param($t)    Write-Host "      ... $t" -ForegroundColor DarkGray }
function Fail { param($t)    Write-Host "" ; Write-Host "  ERROR: $t" -ForegroundColor Red ; exit 1 }

Write-Host ""
Write-Host "  ============================================" -ForegroundColor Magenta
Write-Host "    Tecno Caja CONTADORES -- Release ($Bump)" -ForegroundColor Magenta
Write-Host "  ============================================" -ForegroundColor Magenta

# ── 0. Cargar GH_TOKEN desde .env ─────────────────────────────
Step '0/5' 'Cargando configuracion...'

if (-not $env:GH_TOKEN) {
  # Busca primero en tecno-caja-contadores/.env, luego en raiz
  $envFiles = @(
    (Join-Path $appDir '.env'),
    (Join-Path $rootDir '.env')
  )
  foreach ($envFile in $envFiles) {
    if (Test-Path $envFile) {
      Get-Content $envFile | ForEach-Object {
        if ($_ -match '^GH_TOKEN\s*=\s*(.+)') { $env:GH_TOKEN = $matches[1].Trim() }
      }
    }
    if ($env:GH_TOKEN) { break }
  }
}
if (-not $env:GH_TOKEN) {
  Fail "GH_TOKEN no encontrado. Agrega GH_TOKEN=ghp_... a tecno-caja-contadores/.env o al .env raiz."
}
Ok 'GH_TOKEN cargado'

# ── 1. Verificar sintaxis de archivos clave ────────────────────
Step '1/5' 'Validando sintaxis...'
$checkFiles = @(
  'tecno-caja-contadores/main.js',
  'tecno-caja-contadores/preload.js',
  'tecno-caja-contadores/server.js'
)
foreach ($file in $checkFiles) {
  node --check $file
  if ($LASTEXITCODE -ne 0) { Fail "Error de sintaxis en $file" }
}
Ok 'Sintaxis JS valida'

# ── 2. Bump de version ────────────────────────────────────────
Step '2/5' 'Actualizando version...'

$bumpResult = node tecno-caja-contadores/scripts/bump-version.js $Bump
if ($LASTEXITCODE -ne 0) { Fail "bump-version.js fallo" }

$parts  = $bumpResult -split '\|'
$oldVer = $parts[0].Trim()
$newVer = $parts[1].Trim()

Ok "Version: v$oldVer  ->  v$newVer"

if (-not $Message) { $Message = "chore(contadores): release v$newVer" }

# ── 3. Git: commit + push ─────────────────────────────────────
Step '3/5' 'Subiendo cambios a GitHub...'

$gitStatus = (git status --porcelain 2>&1)
if ($gitStatus) {
  git add tecno-caja-contadores/
  if ($LASTEXITCODE -ne 0) { Fail "git add fallo" }
  git commit -m $Message
  if ($LASTEXITCODE -ne 0) { Fail "git commit fallo" }
  Ok "Commit: $Message"
} else {
  Ok 'Sin cambios pendientes'
}

Info 'Subiendo a GitHub (master)...'
git push origin master
if ($LASTEXITCODE -ne 0) { Fail "git push fallo" }
Ok 'Codigo subido a GitHub'

# ── 4. Build + Publish ────────────────────────────────────────
Step '4/5' "Construyendo TecnoCajaContadores-Setup-$newVer.exe..."
Info 'Esto puede tardar 5-10 minutos...'
Write-Host ""

npx electron-builder --config tecno-caja-contadores/electron-builder.yml --win nsis --publish always
if ($LASTEXITCODE -ne 0) { Fail "electron-builder fallo" }

# ── 5. Resumen ────────────────────────────────────────────────
Step '5/5' 'Listo!'
Write-Host ""
Write-Host "  ------------------------------------------------------------------" -ForegroundColor Green
Write-Host "  Version   : v$newVer" -ForegroundColor Green
Write-Host "  Instalador: tecno-caja-contadores\dist\TecnoCajaContadores-Setup-$newVer.exe" -ForegroundColor Green
Write-Host "  GitHub    : github.com/elfavoritord/tecnocaja-contadores/releases" -ForegroundColor Green
Write-Host "  ------------------------------------------------------------------" -ForegroundColor Green
Write-Host ""
