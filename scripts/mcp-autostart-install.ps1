# scripts\mcp-autostart-install.ps1
# Deja el conector MCP disponible para ChatGPT/Claude sin pasos manuales:
#   1. Tarea Programada 'TecnoCajaMCP' -> arranca el puente MCP + Tailscale Funnel
#      al iniciar sesión, y lo revive si se cae.
#   2. Acceso en la carpeta Inicio -> abre el POS instalado MINIMIZADO al iniciar
#      sesión, para que el backend (127.0.0.1:3399) esté siempre disponible.
#
# Instalar:    powershell -ExecutionPolicy Bypass -File scripts\mcp-autostart-install.ps1
# Desinstalar: powershell -ExecutionPolicy Bypass -File scripts\mcp-autostart-install.ps1 -Uninstall
#
# No requiere admin (todo es del usuario actual).

param(
    [switch]$Uninstall,
    [string]$TaskName = 'TecnoCajaMCP',
    [string]$PosExe   = "$env:LOCALAPPDATA\Programs\Tecno Caja\Tecno Caja.exe"
)

$ErrorActionPreference = 'Stop'
$svc       = Join-Path $PSScriptRoot 'mcp-service.ps1'
$startup   = [Environment]::GetFolderPath('Startup')
$posLnk    = Join-Path $startup 'Tecno Caja (auto).lnk'

function Install-PosStartupShortcut {
    if (-not (Test-Path $PosExe)) {
        Write-Host "[i] No encuentro el POS instalado en:`n    $PosExe" -ForegroundColor Yellow
        Write-Host "    Ajusta -PosExe o crea el acceso a mano (propiedades -> Ejecutar: Minimizada)."
        return
    }
    $w = New-Object -ComObject WScript.Shell
    $s = $w.CreateShortcut($posLnk)
    $s.TargetPath        = $PosExe
    $s.WorkingDirectory  = (Split-Path $PosExe)
    $s.WindowStyle       = 7   # minimizada
    $s.Description        = 'Tecno Caja POS - arranque automatico para el conector MCP'
    $s.Save()
    Write-Host "[OK] POS se abrirá minimizado al iniciar sesión ($posLnk)" -ForegroundColor Green
}

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "[OK] Tarea '$TaskName' eliminada. El MCP ya no arranca solo." -ForegroundColor Green
        Write-Host "     (Si está corriendo ahora, ciérralo desde el Administrador de tareas o reinicia.)"
    } else {
        Write-Host "[i] No existe la tarea '$TaskName'. Nada que hacer." -ForegroundColor Yellow
    }
    if (Test-Path $posLnk) {
        Remove-Item $posLnk -Force
        Write-Host "[OK] Quitado el auto-arranque del POS." -ForegroundColor Green
    }
    return
}

if (-not (Test-Path $svc)) { throw "No encuentro $svc" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $svc)

$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Description 'Servidor MCP de Tecno Caja (para ChatGPT/Claude) + Tailscale Funnel' `
    -Force | Out-Null

Write-Host "[OK] Tarea '$TaskName' registrada." -ForegroundColor Green

Install-PosStartupShortcut

Write-Host ""
Write-Host "  Al iniciar sesión en Windows arrancan solos:  POS (minimizado) + puente MCP + Funnel."
Write-Host "  No tienes que abrir nada a mano."
Write-Host ""
Write-Host "  Arrancar el MCP YA sin reiniciar:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "  Parar el MCP:                       Stop-ScheduledTask  -TaskName $TaskName"
Write-Host "  Ver que corre:                      Get-ScheduledTask   -TaskName $TaskName"
Write-Host "  Logs:                              mcp-server\logs\mcp-service-*.log"
