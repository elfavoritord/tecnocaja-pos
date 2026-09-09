# scripts\start-mcp-with-tunnel.ps1
# Arranca el servidor MCP de Tecno Caja y un Cloudflare Tunnel que lo expone a
# internet (para conectarlo desde ChatGPT o Claude web/móvil).
#
# El POS (server.js) debe estar corriendo aparte: npm run desktop
#
# Uso:
#   .\scripts\start-mcp-with-tunnel.ps1 -Tunnel mcp-tecnocaja   # Túnel con nombre fijo (RECOMENDADO)
#   .\scripts\start-mcp-with-tunnel.ps1                         # Quick Tunnel (URL temporal, solo pruebas)
#   .\scripts\start-mcp-with-tunnel.ps1 -SkipServer            # Solo el túnel
#
# IMPORTANTE para OAuth: el conector de ChatGPT/Claude necesita una URL pública
# ESTABLE. Usa un túnel con nombre fijo y pon esa URL https en mcp-server\.env
# como MCP_PUBLIC_URL. El Quick Tunnel cambia de URL en cada reinicio y rompe
# el conector OAuth ya autorizado.
#
# Requisito: cloudflared instalado  ->  winget install --id Cloudflare.cloudflared -e

param(
    [string]$Tunnel   = 'quick',
    [int]   $Port     = 3400,
    [int]   $WaitSecs = 4,
    [switch]$SkipServer
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot | Split-Path -Parent
$mcpDir      = Join-Path $projectRoot 'mcp-server'

if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] cloudflared no está instalado. winget install --id Cloudflare.cloudflared -e" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path (Join-Path $mcpDir '.env'))) {
    Write-Host "[ERROR] Falta mcp-server\.env . Copia mcp-server\.env.example y rellénalo." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "═══════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Tecno Caja — Servidor MCP + Cloudflare Tunnel"   -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

$serverJob = $null
if (-not $SkipServer) {
    Write-Host "[1/3] Iniciando servidor MCP (puerto $Port)..." -ForegroundColor Green
    $serverJob = Start-Job -ScriptBlock {
        param($dir)
        Set-Location $dir
        & npm start 2>&1
    } -ArgumentList $mcpDir
    Write-Host "      Job ID: $($serverJob.Id). Esperando $WaitSecs s..." -ForegroundColor Gray
    Start-Sleep -Seconds $WaitSecs
} else {
    Write-Host "[1/3] Omitiendo servidor MCP (-SkipServer)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "[2/3] Iniciando Cloudflare Tunnel..." -ForegroundColor Green
$localUrl = "http://localhost:$Port"

if ($Tunnel -eq 'quick') {
    Write-Host "      Modo: Quick Tunnel (URL temporal — cambia al reiniciar)" -ForegroundColor Yellow
    Write-Host "      [OJO] Solo para pruebas: rompe el conector OAuth al reiniciar." -ForegroundColor Yellow
    Write-Host "      La URL .trycloudflare.com aparece abajo; ponla en MCP_PUBLIC_URL" -ForegroundColor Cyan
    Write-Host "      y reinicia el MCP para probar. En ChatGPT/Claude usa .../mcp" -ForegroundColor Cyan
    Write-Host "──────────────────────────────────────────────────" -ForegroundColor DarkGray
    cloudflared tunnel --url $localUrl
} else {
    Write-Host "      Modo: Túnel permanente '$Tunnel'  ->  $localUrl" -ForegroundColor Green
    Write-Host "      Asegúrate que MCP_PUBLIC_URL en mcp-server\.env sea el hostname de este túnel." -ForegroundColor Gray
    Write-Host "──────────────────────────────────────────────────" -ForegroundColor DarkGray
    cloudflared tunnel run $Tunnel
}

if ($serverJob) {
    Write-Host ""
    Write-Host "Deteniendo servidor MCP..." -ForegroundColor Yellow
    Stop-Job  -Job $serverJob -ErrorAction SilentlyContinue
    Remove-Job -Job $serverJob -ErrorAction SilentlyContinue
}
Write-Host "Servidor MCP detenido." -ForegroundColor Gray
