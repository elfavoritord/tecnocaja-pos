#!/usr/bin/env pwsh
# ─────────────────────────────────────────────────────────────────────────────
# cert-fix-and-retry.ps1
# Secuencia completa para corregir y reenviar los 20 docs rechazados DGII.
#
# REQUISITO: la app debe estar corriendo (npm run desktop) con el código nuevo.
#            Reinicia la app ANTES de ejecutar este script.
#
# SECUENCIA:
#   1. Verificar rawRow NombreComercial (diagnóstico)
#   2. Diagnosticar NombreComercial sin modificar el dataset
#   3. Fijar E310000000002: MontoGravadoI1/MontoGravadoTotal 3230→3961.31
#   4. Resetear solo envíos pendientes/en proceso sin rotar eNCF
#   5. Resetear docs rechazados → firmado
#   6. Correr secuencia de certificación
#   7. Esperar y hacer poll de estados
# ─────────────────────────────────────────────────────────────────────────────

$BASE = "http://127.0.0.1:3399/api/ecf"
$HEADERS = @{ "Content-Type" = "application/json" }

function Invoke-Ecf {
    param([string]$Method, [string]$Path, [object]$Body = $null)
    $uri = "$BASE$Path"
    try {
        if ($Body) {
            $json = $Body | ConvertTo-Json -Depth 10
            $resp = Invoke-RestMethod -Method $Method -Uri $uri -Headers $HEADERS -Body $json -ErrorAction Stop
        } else {
            $resp = Invoke-RestMethod -Method $Method -Uri $uri -Headers $HEADERS -ErrorAction Stop
        }
        return $resp
    } catch {
        $errBody = $null
        try { $errBody = $_.ErrorDetails.Message | ConvertFrom-Json } catch {}
        Write-Host "  ERROR: $($_.Exception.Message)" -ForegroundColor Red
        if ($errBody) { Write-Host "  DGII: $($errBody.error)" -ForegroundColor Red }
        return $null
    }
}

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host " CERT-FIX-AND-RETRY: Corrección + Reenvío" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan

# ─── Paso 0: Verificar que el servidor está corriendo ───────────────────────
Write-Host "`n[0/7] Verificando servidor..." -ForegroundColor Yellow
$status = Invoke-Ecf -Method GET -Path "/status"
if (-not $status) {
    Write-Host "  FATAL: El servidor no responde. Reinicia la app primero." -ForegroundColor Red
    exit 1
}
Write-Host "  OK — Servidor activo ($($status.environment ?? 'unknown'))" -ForegroundColor Green

# ─── Paso 1: Verificar rawRow NombreComercial ────────────────────────────────
Write-Host "`n[1/7] Verificando NombreComercial en rawRow..." -ForegroundColor Yellow
$diag = Invoke-Ecf -Method GET -Path "/diag/cert-original-xml"
if ($diag -and $diag.cases) {
    $diag.cases | ForEach-Object {
        $nc = $_.sampleFields.NombreComercial
        $nc_display = if ($null -eq $nc) { "<ABSENT>" } elseif ($nc -eq "") { "<EMPTY>" } else { $nc }
        $color = if ($null -eq $nc -or $nc -eq "") { "Green" } else { "Yellow" }
        Write-Host "  $($_.encf): NombreComercial=$nc_display" -ForegroundColor $color
    }
}

# ─── Paso 2: No modificar NombreComercial del dataset ───────────────────────
Write-Host "`n[2/7] NombreComercial: sin cambios automáticos." -ForegroundColor Yellow
Write-Host "  El código usa el valor exacto del dataset y solo omite el caso manual E32 <250Mil al generar XML para el portal." -ForegroundColor Gray

# ─── Paso 3: Fijar E310000000002 MontoGravadoI1 ─────────────────────────────
Write-Host "`n[3/7] Fijando E310000000002 MontoGravadoI1/MontoGravadoTotal 3230→3961.31..." -ForegroundColor Yellow
# Para alcohol (E31 con ISC): MontoGravadoI1 debe incluir ISC en la base gravable.
# 3961.31 × 18% = 713.04 = TotalITBIS1 actual ✓  Y  3961.31 + 713.04 = 4674.35 = MontoTotal ✓
$fixResult = Invoke-Ecf -Method POST -Path "/certification/fix-rawrow" -Body @{
    encf = "E310000000002"
    fields = @{
        MontoGravadoTotal = "3961.31"
        MontoGravadoI1    = "3961.31"
    }
}
if ($fixResult -and $fixResult.ok) {
    Write-Host "  ✓ E310000000002 MontoGravadoI1: $($fixResult.oldValues.MontoGravadoI1) → $($fixResult.newValues.MontoGravadoI1)" -ForegroundColor Green
    Write-Host "  ✓ E310000000002 MontoGravadoTotal: $($fixResult.oldValues.MontoGravadoTotal) → $($fixResult.newValues.MontoGravadoTotal)" -ForegroundColor Green
} else {
    Write-Host "  ✗ Fallo al actualizar E310000000002" -ForegroundColor Red
}

# ─── Paso 4: Resetear envíos pendientes/en proceso sin rotar eNCF ───────────
Write-Host "`n[4/7] Reseteando envíos pendientes/en proceso sin rotar eNCF..." -ForegroundColor Yellow
$rotateResult = Invoke-Ecf -Method POST -Path "/certification/reset-sent" -Body @{}
if ($rotateResult -and $rotateResult.ok) {
    Write-Host "  ✓ Reseteados: $($rotateResult.reset)" -ForegroundColor Green
    Write-Host "  Detalle: $($rotateResult.message)" -ForegroundColor Gray
} else {
    Write-Host "  ✗ Fallo en reset de pendientes/en proceso" -ForegroundColor Red
}

# ─── Paso 5: Resetear rechazados → firmado ──────────────────────────────────
Write-Host "`n[5/7] Reseteando docs rechazados → firmado..." -ForegroundColor Yellow
$resetResult = Invoke-Ecf -Method POST -Path "/certification/reset-rejected" -Body @{}
if ($resetResult -and $resetResult.ok) {
    Write-Host "  ✓ $($resetResult.reset) doc(s) reseteados a 'firmado'" -ForegroundColor Green
} else {
    Write-Host "  ✗ Fallo en reset de rechazados" -ForegroundColor Red
}

# ─── Paso 6: Correr secuencia de certificación ──────────────────────────────
Write-Host "`n[6/7] Iniciando secuencia de certificación..." -ForegroundColor Yellow
Write-Host "  (esto puede tardar 30-90 segundos...)" -ForegroundColor Gray
$seqResult = Invoke-Ecf -Method POST -Path "/certification/run-sequential" -Body @{ limit = 50 }
if ($seqResult) {
    $sent = ($seqResult.results | Where-Object { $_.ok }).Count
    $failed = ($seqResult.results | Where-Object { -not $_.ok }).Count
    Write-Host "  ✓ Enviados: $sent  /  Fallidos: $failed" -ForegroundColor Green
    $seqResult.results | ForEach-Object {
        $icon = if ($_.ok) { "✓" } else { "✗" }
        $color = if ($_.ok) { "Green" } else { "Red" }
        Write-Host "    $icon $($_.encf): $($_.estado ?? $_.message ?? $_.status)" -ForegroundColor $color
    }
} else {
    Write-Host "  ✗ Fallo en secuencia" -ForegroundColor Red
}

# ─── Paso 7: Poll de estados ─────────────────────────────────────────────────
Write-Host "`n[7/7] Esperando 15 segundos y consultando estados DGII..." -ForegroundColor Yellow
Start-Sleep -Seconds 15
$pollResult = Invoke-Ecf -Method POST -Path "/certification/poll-statuses" -Body @{}
if ($pollResult) {
    Write-Host "  ✓ Poll completado" -ForegroundColor Green
    if ($pollResult.results) {
        $accepted = ($pollResult.results | Where-Object { $_.estado -eq "aceptado" }).Count
        $rejected = ($pollResult.results | Where-Object { $_.estado -eq "rechazado" }).Count
        $pending  = ($pollResult.results | Where-Object { $_.estado -notin @("aceptado","rechazado","aceptado_condicional") }).Count
        Write-Host "  Aceptados: $accepted  /  Rechazados: $rejected  /  Pendientes: $pending" -ForegroundColor Cyan
        $pollResult.results | ForEach-Object {
            $icon = switch ($_.estado) { "aceptado" { "✓" } "rechazado" { "✗" } default { "?" } }
            $color = switch ($_.estado) { "aceptado" { "Green" } "rechazado" { "Red" } default { "Yellow" } }
            $msg = if ($_.mensaje -and $_.mensaje -ne "Consulta completada.") { " — $($_.mensaje.Substring(0,[Math]::Min(80,$_.mensaje.Length)))" } else { "" }
            Write-Host "    $icon $($_.encf): $($_.estado)$msg" -ForegroundColor $color
        }
    }
}

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host " Proceso completado. Revisa el portal DGII para confirmar." -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
