#!/usr/bin/env pwsh
# resend-e310000000002.ps1
# Reenvía E310000000002 (cerveza/ISC) después del fix de ImpuestosAdicionales.
# Requisito: reiniciar la app primero (npm run desktop) para cargar el nuevo XML generator.

$BASE = "http://127.0.0.1:3399"
$HEADERS = @{ "Content-Type" = "application/json" }

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host " RESEND E310000000002 — ISC Fix" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan

# Verify server
$status = Invoke-RestMethod -Method GET -Uri "$BASE/api/ecf/status" -Headers $HEADERS -ErrorAction SilentlyContinue
if (-not $status) {
    Write-Host "FATAL: servidor no responde. Reinicia la app primero." -ForegroundColor Red
    exit 1
}
Write-Host "Servidor: $($status.environment)" -ForegroundColor Green

# Run certification sequence (E310000000002 is the only firmado doc)
Write-Host "`nEnviando E310000000002..." -ForegroundColor Yellow
$seqResp = Invoke-RestMethod -Method POST -Uri "$BASE/api/ecf/certification/run-sequential" `
  -Headers $HEADERS `
  -Body '{"limit":3,"actorUserId":8}' `
  -ErrorAction Stop

Write-Host "totalProcessed: $($seqResp.totalProcessed)" -ForegroundColor $(if ($seqResp.totalProcessed -gt 0) { "Green" } else { "Red" })
$seqResp.results | ForEach-Object {
    $icon = if ($_.ok) { "✓" } else { "✗" }
    $color = if ($_.ok) { "Green" } else { "Red" }
    Write-Host "  $icon $($_.encf): $($_.estado ?? $_.message ?? $_.status)" -ForegroundColor $color
}

if ($seqResp.totalProcessed -eq 0) {
    Write-Host "No se encontraron docs en 'firmado'. Verifica el estado." -ForegroundColor Red
    exit 1
}

# Poll after 20 seconds
Write-Host "`nEsperando 20 s y consultando DGII..." -ForegroundColor Yellow
Start-Sleep -Seconds 20

$pollResp = Invoke-RestMethod -Method POST -Uri "$BASE/api/ecf/certification/poll-statuses" `
  -Headers $HEADERS `
  -Body '{"actorUserId":8}' `
  -ErrorAction Stop

$pollResp.results | ForEach-Object {
    $icon = switch ($_.estado) { "aceptado" { "✓" } "rechazado" { "✗" } default { "?" } }
    $color = switch ($_.estado) { "aceptado" { "Green" } "rechazado" { "Red" } default { "Yellow" } }
    $msg = if ($_.mensaje) { " — $($_.mensaje.Substring(0,[Math]::Min(120,$_.mensaje.Length)))" } else { "" }
    Write-Host "  $icon $($_.encf): $($_.estado)$msg" -ForegroundColor $color
}

$accepted = ($pollResp.results | Where-Object { $_.estado -in @("aceptado","aceptado_condicional") }).Count
Write-Host "`nAceptados en este poll: $accepted" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
