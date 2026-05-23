# fix-installed-app.ps1
# Copia el main.js corregido y los modulos faltantes al app instalado.
# Ejecutar DESPUES de: npm install
#
# Uso: Click derecho → "Ejecutar con PowerShell"  (o desde terminal como admin)

$devFolder   = Split-Path -Parent $PSScriptRoot
$installBase = "$env:LOCALAPPDATA\Programs\TecnoCaja\resources\app"

if (-not (Test-Path $installBase)) {
    Write-Host "Tecno Caja no esta instalado en $installBase" -ForegroundColor Yellow
    Write-Host "Usa 'npm run desktop' desde la carpeta de desarrollo en vez del instalador." -ForegroundColor Cyan
    pause
    exit 0
}

Write-Host "Reparando Tecno Caja instalado en:" -ForegroundColor Cyan
Write-Host "  $installBase" -ForegroundColor White

# 1. Copiar electron/main.js corregido
$src  = Join-Path $devFolder "electron\main.js"
$dest = Join-Path $installBase "electron\main.js"
Copy-Item -Path $src -Destination $dest -Force
Write-Host "[OK] electron/main.js actualizado" -ForegroundColor Green

# 2. Copiar server/routes/fiscal.routes.js
$src  = Join-Path $devFolder "server\routes\fiscal.routes.js"
$dest = Join-Path $installBase "server\routes\fiscal.routes.js"
New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
Copy-Item -Path $src -Destination $dest -Force
Write-Host "[OK] server/routes/fiscal.routes.js actualizado" -ForegroundColor Green

# 3. Copiar modulos faltantes desde node_modules del dev folder
$modulesToCopy = @("formidable", "node-forge", "xmlbuilder")

foreach ($mod in $modulesToCopy) {
    $srcMod  = Join-Path $devFolder "node_modules\$mod"
    $destMod = Join-Path $installBase "node_modules\$mod"

    if (-not (Test-Path $srcMod)) {
        Write-Host "[AVISO] $mod no encontrado en node_modules — ejecuta 'npm install' primero" -ForegroundColor Yellow
        continue
    }

    if (Test-Path $destMod) {
        Remove-Item -Recurse -Force $destMod
    }
    Copy-Item -Recurse -Path $srcMod -Destination $destMod -Force
    Write-Host "[OK] node_modules/$mod copiado" -ForegroundColor Green
}

Write-Host ""
Write-Host "Listo. Abre Tecno Caja normalmente." -ForegroundColor Green
pause
