# ============================================================================
#  Tecno Caja — Firewall de Windows para trabajar en red local (multicaja)
#
#  Permite que las cajas de la MISMA red local (y de Tailscale, si se usa para
#  sucursales) se conecten a esta PC principal. Nunca abre el puerto a
#  Internet: la regla solo acepta direcciones de la subred local
#  (LocalSubnet) y de Tailscale (100.64.0.0/10).
#
#  Requiere administrador. Tecno Caja lo ejecuta desde
#  Configuración → Sistema y Red → Red de Terminales → "Permitir cajas de la red".
#  Soporte también puede correrlo a mano en PowerShell como administrador:
#    powershell -ExecutionPolicy Bypass -File configurar-firewall-lan.ps1
#    powershell -ExecutionPolicy Bypass -File configurar-firewall-lan.ps1 -IncluirBaseDeDatos
# ============================================================================

param(
  [int]$Puerto = 3399,
  [switch]$IncluirBaseDeDatos,
  [int]$PuertoBaseDeDatos = 3306
)

$remotas = 'LocalSubnet,100.64.0.0/10'

# Servidor de Tecno Caja (las cajas cargan la pantalla y la API por aquí)
netsh advfirewall firewall delete rule name="Tecno Caja Server" | Out-Null
netsh advfirewall firewall add rule name="Tecno Caja Server" dir=in action=allow protocol=TCP localport=$Puerto remoteip=$remotas profile=any description="Tecno Caja: cajas de la red local. Solo LAN y Tailscale, nunca Internet."
if ($LASTEXITCODE -ne 0) { exit 10 }

# Base de datos (solo si hay cajas terminal que trabajan con la base de esta PC)
if ($IncluirBaseDeDatos) {
  netsh advfirewall firewall delete rule name="Tecno Caja Base de Datos LAN" | Out-Null
  netsh advfirewall firewall add rule name="Tecno Caja Base de Datos LAN" dir=in action=allow protocol=TCP localport=$PuertoBaseDeDatos remoteip=$remotas profile=any description="Tecno Caja: base de datos para cajas terminal de la red local. Solo LAN y Tailscale, nunca Internet."
  if ($LASTEXITCODE -ne 0) { exit 11 }
}

exit 0
