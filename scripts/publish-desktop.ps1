# =============================================================
# scripts/publish-desktop.ps1 -- Tecno Caja POS
# Build + publish cargando GH_TOKEN desde .env
# =============================================================

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

function Fail { param($t) Write-Host "" ; Write-Host "  ERROR: $t" -ForegroundColor Red ; exit 1 }

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

node scripts/prepare-mariadb-bundle.js
if ($LASTEXITCODE -ne 0) { Fail "prepare-mariadb-bundle.js fallo" }

npx electron-builder --win nsis --publish always
if ($LASTEXITCODE -ne 0) { Fail "electron-builder fallo (codigo $LASTEXITCODE)" }
