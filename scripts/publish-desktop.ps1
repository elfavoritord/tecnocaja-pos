# =============================================================
# scripts/publish-desktop.ps1 -- Tecno Caja POS
# Build + publish cargando GH_TOKEN desde .env
# =============================================================

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

function Step { param($t) Write-Host "" ; Write-Host "  $t" -ForegroundColor Cyan }
function Ok   { param($t) Write-Host "      OK  $t" -ForegroundColor Green }
function Fail { param($t) Write-Host "" ; Write-Host "  ERROR: $t" -ForegroundColor Red ; exit 1 }
function Invoke-PublishPreflight {
  Step 'Validando archivos criticos antes de publicar...'
  $syntaxFiles = @(
    'electron/main.js',
    'electron/preload.js',
    'server.js',
    'js/app.js',
    'js/data.js',
    'js/actualizaciones.js',
    'server/routes/respaldos.routes.js'
  )
  foreach ($file in $syntaxFiles) {
    node --check $file
    if ($LASTEXITCODE -ne 0) { Fail "Error de sintaxis en $file" }
  }
  Ok 'Sintaxis JS valida'

  npm test -- --runInBand
  if ($LASTEXITCODE -ne 0) { Fail 'Pruebas automatizadas fallaron. No se publica la actualizacion.' }
  Ok 'Pruebas automatizadas pasaron'
}

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

Invoke-PublishPreflight

node scripts/prepare-mariadb-bundle.js --check-unlocked
if ($LASTEXITCODE -ne 0) { Fail "MariaDB empaquetado esta en uso. Cierra Tecno Caja o detén el PID indicado y vuelve a intentar" }

node scripts/prepare-mariadb-bundle.js
if ($LASTEXITCODE -ne 0) { Fail "prepare-mariadb-bundle.js fallo" }

npx electron-builder --win nsis --publish always
if ($LASTEXITCODE -ne 0) { Fail "electron-builder fallo (codigo $LASTEXITCODE)" }
