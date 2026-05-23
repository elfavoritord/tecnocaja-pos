# scripts\start-with-tunnel.ps1
# Inicia el backend de Tecno Caja y el Cloudflare Tunnel en paralelo.
#
# Uso:
#   .\scripts\start-with-tunnel.ps1              # Quick Tunnel (URL temporal)
#   .\scripts\start-with-tunnel.ps1 -Tunnel permanente  # Túnel con nombre fijo
#   .\scripts\start-with-tunnel.ps1 -SkipBackend       # Solo el túnel
#
# Requisito previo: cloudflared instalado
#   winget install --id Cloudflare.cloudflared -e

param(
    [string]$Tunnel    = 'quick',     # 'quick' o nombre del tunel permanente
    [int]   $Port      = 3399,
    [int]   $WaitSecs  = 5,
    [switch]$SkipBackend
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot | Split-Path -Parent

# ── Verificar cloudflared ─────────────────────────────────────────────────────
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "[ERROR] cloudflared no está instalado." -ForegroundColor Red
    Write-Host "        Instala con: winget install --id Cloudflare.cloudflared -e" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "═══════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Tecno Caja — Inicio con Cloudflare Tunnel" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# ── Arrancar backend ──────────────────────────────────────────────────────────
$backendJob = $null
if (-not $SkipBackend) {
    Write-Host "[1/3] Iniciando backend Tecno Caja (puerto $Port)..." -ForegroundColor Green
    $backendJob = Start-Job -ScriptBlock {
        param($root)
        Set-Location $root
        & npm run desktop 2>&1
    } -ArgumentList $projectRoot

    Write-Host "      Backend iniciado (Job ID: $($backendJob.Id))"
    Write-Host "      Esperando $WaitSecs segundos antes de abrir el túnel..." -ForegroundColor Gray
    Start-Sleep -Seconds $WaitSecs
} else {
    Write-Host "[1/3] Omitiendo backend (-SkipBackend)" -ForegroundColor Yellow
}

# ── Construir comando cloudflared ─────────────────────────────────────────────
Write-Host ""
Write-Host "[2/3] Iniciando Cloudflare Tunnel..." -ForegroundColor Green

$localUrl = "http://localhost:$Port"

if ($Tunnel -eq 'quick') {
    Write-Host "      Modo: Quick Tunnel (URL temporal — cambia al reiniciar)" -ForegroundColor Yellow
    Write-Host "      Apuntando a: $localUrl"
    Write-Host ""
    Write-Host "[3/3] La URL pública aparecerá abajo. Copia el enlace .trycloudflare.com" -ForegroundColor Cyan
    Write-Host "      y actualiza POS_PUBLIC_BASE_URL y DGII_PUBLIC_BASE_URL en tu .env" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "──────────────────────────────────────────────────" -ForegroundColor DarkGray

    # Ejecuta cloudflared en primer plano para que la URL sea visible
    cloudflared tunnel --url $localUrl

} else {
    Write-Host "      Modo: Túnel permanente '$Tunnel'" -ForegroundColor Green
    Write-Host "      Apuntando a: $localUrl"
    Write-Host ""
    Write-Host "[3/3] Iniciando túnel permanente..." -ForegroundColor Cyan
    Write-Host "──────────────────────────────────────────────────" -ForegroundColor DarkGray

    cloudflared tunnel run $Tunnel
}

# ── Limpieza al salir (Ctrl+C) ────────────────────────────────────────────────
if ($backendJob) {
    Write-Host ""
    Write-Host "Deteniendo backend..." -ForegroundColor Yellow
    Stop-Job  -Job $backendJob -ErrorAction SilentlyContinue
    Remove-Job -Job $backendJob -ErrorAction SilentlyContinue
}
Write-Host "Tecno Caja detenido." -ForegroundColor Gray
