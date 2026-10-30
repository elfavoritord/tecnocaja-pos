param(
  [Parameter(Mandatory)] [string]$Rnc,
  [Parameter(Mandatory)] [string]$P12,
  [string]$Nombre = ''
)
# Registra una empresa en el gateway e-CF y sube su certificado .p12.
# Hay que correrlo ANTES del Paso 7 de la certificacion, desde la PC de Emilio
# (usa gcloud y el token de administrador; nunca en la PC de un cliente).
# La clave se pide por teclado y no se escribe en disco ni en pantalla.
$ErrorActionPreference = 'Stop'
$gw = 'https://tecno-caja-ecf-gateway-1052855422372.us-east1.run.app'

if (-not (Test-Path -LiteralPath $P12)) { throw "No existe el archivo: $P12" }
$admin = (gcloud secrets versions access latest --secret=ecf-gateway-admin-token --project=reporte-sistema-pos).Trim()
if (-not $admin) { throw 'No se pudo leer el token de administrador.' }
$headers = @{ Authorization = "Bearer $admin" }

$secure = Read-Host "Clave del certificado $(Split-Path -Leaf $P12)" -AsSecureString
$password = [System.Net.NetworkCredential]::new('', $secure).Password
if (-not $password) { throw 'La clave esta vacia.' }

$alta = Invoke-RestMethod -Method Post -Uri "$gw/admin/tenants" -Headers $headers -ContentType 'application/json' `
  -Body (@{ rnc = $Rnc; nombre = $Nombre } | ConvertTo-Json -Compress)
Write-Host "Empresa $Rnc registrada en el gateway."

$payload = @{
  certificateBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $P12).Path))
  password = $password
} | ConvertTo-Json -Compress
$cert = Invoke-RestMethod -Method Put -Uri "$gw/admin/tenants/$Rnc/certificate" -Headers $headers -ContentType 'application/json' -Body $payload
Write-Host "Certificado guardado: $($cert.tenant.certificate.subject)"
Write-Host "Vence: $($cert.tenant.certificate.validTo)"

if ($alta.token) {
  $dir = Join-Path $env:USERPROFILE 'Documents\TecnoCaja-gateway'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $file = Join-Path $dir "$Rnc-token.txt"
  Set-Content -LiteralPath $file -Value "ECF_GATEWAY_BASE_URL=$gw`nECF_GATEWAY_TOKEN=$($alta.token)" -Encoding UTF8
  Write-Host "Token de la empresa guardado en: $file (el gateway no lo vuelve a mostrar)"
} else {
  Write-Host 'La empresa ya existia: se conserva su token anterior.'
}
Write-Host 'Listo. La empresa ya puede hacer los Pasos 7 a 11 de la certificacion.'
