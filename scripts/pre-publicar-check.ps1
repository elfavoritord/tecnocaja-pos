param(
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'

function Run-Step {
  param(
    [string]$Name,
    [scriptblock]$Command
  )
  Write-Host ""
  Write-Host "== $Name ==" -ForegroundColor Cyan
  & $Command
}

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

Run-Step "Estado de Git" {
  git status --short
}

Run-Step "Sintaxis JavaScript critica" {
  node --check server.js
  node --check js/actualizaciones.js
  node --check js/system-health.js
}

if (-not $SkipTests) {
  Run-Step "Pruebas automaticas" {
    npm test -- --runInBand
  }
}

Run-Step "Diagnostico de entorno local" {
  if (Test-Path "scripts\diagnostico-entorno.ps1") {
    powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\diagnostico-entorno.ps1"
  } else {
    Write-Host "scripts\diagnostico-entorno.ps1 no existe; omitiendo." -ForegroundColor Yellow
  }
}

Write-Host ""
Write-Host "Checklist pre-publicacion completado." -ForegroundColor Green
