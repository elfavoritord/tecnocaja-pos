# scripts\mcp-service.ps1
# Mantiene vivo el servidor MCP de Tecno Caja + su Cloudflare/Tailscale Funnel.
# Pensado para correr en segundo plano (Tarea Programada al iniciar sesión).
#
# - Asegura que Tailscale Funnel exponga el puerto del MCP (idempotente).
# - Arranca el puente MCP y lo reinicia solo si se cae.
# - NO arranca el POS: eso lo abres tú con `npm run desktop`. El puente tolera
#   que el POS no esté todavía y se reconecta solo en la primera consulta.

param(
    [int]$Port = 3400
)

$ErrorActionPreference = 'SilentlyContinue'
$root   = Split-Path -Parent $PSScriptRoot
$mcpDir = Join-Path $root 'mcp-server'
$logDir = Join-Path $mcpDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ('mcp-service-{0}.log' -f (Get-Date -Format 'yyyyMMdd'))

function Log($msg) {
    $line = ('{0}  {1}' -f (Get-Date -Format 'HH:mm:ss'), $msg)
    Add-Content -Path $log -Value $line
}

# ── Resolver ejecutables ─────────────────────────────────────────────────────
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }

$tailscale = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $tailscale) { $tailscale = 'C:\Program Files\Tailscale\tailscale.exe' }

# ── 1. Asegurar el Funnel ───────────────────────────────────────────────────
if (Test-Path $tailscale) {
    Log "Asegurando Tailscale Funnel en el puerto $Port"
    & $tailscale funnel --bg $Port *>> $log
} else {
    Log "AVISO: tailscale no encontrado; omito el Funnel (¿está instalado?)"
}

# ── 2. Mantener vivo el puente MCP ──────────────────────────────────────────
Log "Iniciando bucle del puente MCP ($mcpDir)"
while ($true) {
    Push-Location $mcpDir
    try {
        & $node 'src/index.js' *>> $log
    } catch {
        Log ("Excepcion: {0}" -f $_.Exception.Message)
    }
    Pop-Location
    Log "El puente MCP terminó. Reintento en 5 s."
    Start-Sleep -Seconds 5
}
