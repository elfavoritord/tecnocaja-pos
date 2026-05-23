# =============================================================
# scripts/release.ps1 -- Tecno Caja POS
# Release automatizado: version bump -> git -> build -> publish
# El bump de version lo hace Node.js para evitar problemas de encoding
# =============================================================
# Uso:
#   npm run release           (patch automatico)
#   npm run release:minor
#   npm run release:major
#   npm run release -- -Bump patch -Message "fix: descripcion"
# =============================================================

param(
  [ValidateSet('patch','minor','major')]
  [string]$Bump    = 'patch',
  [string]$Message = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

function Step { param($n,$t) Write-Host "" ; Write-Host "  [$n] $t" -ForegroundColor Cyan }
function Ok   { param($t)    Write-Host "      OK  $t" -ForegroundColor Green }
function Info { param($t)    Write-Host "      ... $t" -ForegroundColor DarkGray }
function Fail { param($t)    Write-Host "" ; Write-Host "  ERROR: $t" -ForegroundColor Red ; exit 1 }

Write-Host ""
Write-Host "  ==========================================" -ForegroundColor Magenta
Write-Host "    Tecno Caja POS -- Auto Release ($Bump)" -ForegroundColor Magenta
Write-Host "  ==========================================" -ForegroundColor Magenta

# ── 0. Cargar GH_TOKEN desde .env ────────────────────────────
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

# ── 1. Bump de version (Node.js maneja el JSON sin corromper) ─
Step '1/5' 'Calculando y actualizando version...'

$bumpResult = node scripts/bump-version.js $Bump
if ($LASTEXITCODE -ne 0) { Fail "bump-version.js fallo (codigo $LASTEXITCODE)" }

$parts  = $bumpResult -split '\|'
$oldVer = $parts[0].Trim()
$newVer = $parts[1].Trim()

Ok "Version: v$oldVer  ->  v$newVer  (tipo: $Bump)"
Ok "package.json y update-manifest.json actualizados"

if (-not $Message) { $Message = "chore: release v$newVer" }

# ── 2. Git: commit + push ─────────────────────────────────────
Step '2/5' 'Guardando cambios en Git...'

$gitStatus = (git status --porcelain 2>&1)
if ($gitStatus) {
  git add .
  if ($LASTEXITCODE -ne 0) { Fail "git add fallo (codigo $LASTEXITCODE)" }
  git commit -m $Message
  if ($LASTEXITCODE -ne 0) { Fail "git commit fallo (codigo $LASTEXITCODE)" }
  Ok "Commit: $Message"
} else {
  Ok 'Sin cambios -- repositorio limpio'
}

Info 'Subiendo a GitHub...'
git push origin master
if ($LASTEXITCODE -ne 0) { Fail "git push fallo (codigo $LASTEXITCODE)" }
Ok "Codigo subido -> github.com/elfavoritord/tecnocaja-pos"

# ── 3. Build + Publish ────────────────────────────────────────
Step '3/5' "Construyendo TecnoCaja-Setup-$newVer.exe..."
Info 'Esto puede tardar 5-10 minutos...'
Write-Host ""

node scripts/prepare-mariadb-bundle.js
if ($LASTEXITCODE -ne 0) { Fail "prepare-mariadb-bundle.js fallo" }

npx electron-builder --win nsis --publish always
if ($LASTEXITCODE -ne 0) { Fail "electron-builder fallo (codigo $LASTEXITCODE)" }

# ── 4. Resumen ────────────────────────────────────────────────
Step '4/5' 'Publicando en GitHub Releases...'
Ok "Release v$newVer publicada"

Step '5/5' 'Listo!'
Write-Host ""
Write-Host "  ----------------------------------------------------------" -ForegroundColor Green
Write-Host "  Version   : v$newVer" -ForegroundColor Green
Write-Host "  Instalador: dist\TecnoCaja-Setup-$newVer.exe" -ForegroundColor Green
Write-Host "  GitHub    : github.com/elfavoritord/tecnocaja-pos/releases" -ForegroundColor Green
Write-Host "  ----------------------------------------------------------" -ForegroundColor Green
Write-Host ""
