param(
  [string]$InstallDir = '',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$logFile = Join-Path $env:TEMP 'tecnocaja-mariadb-install.log'

$managedServiceName = 'TecnoCajaMariaDB'
$fallbackServiceNames = @('MariaDB')
$displayName = 'Tecno Caja MariaDB'
$port = 3306
$hostName = '127.0.0.1'

# IMPORTANTE: runtime-bootstrap.js y ensure-local-mysql.js usan 'Tecno Caja' CON espacio.
# Este script usa el mismo path para evitar que se creen dos carpetas distintas.
# La variante legacy sin espacio ('TecnoCaja\MariaDB') se limpia en el uninstall.
$programDataRoot = Join-Path $env:ProgramData 'Tecno Caja\MariaDB'
$dataDir = Join-Path $programDataRoot 'data'
$logsDir = Join-Path $programDataRoot 'logs'
$configFile = Join-Path $programDataRoot 'my.ini'
$bundleRelativePath = 'resources\mariadb-runtime'

function Write-Log {
  param([string]$Message)
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  $line = "[$ts] [TecnoCaja][MariaDB] $Message"
  Write-Host $line
  Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
}

function Test-PortOpen {
  param([string]$TargetHost, [int]$Port)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect($TargetHost, $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(1500, $false)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Wait-ForPort {
  param([string]$TargetHost, [int]$Port, [int]$Attempts = 45, [int]$DelayMs = 1000)
  for ($i = 0; $i -lt $Attempts; $i++) {
    if (Test-PortOpen -TargetHost $TargetHost -Port $Port) { return $true }
    Write-Log "Esperando MariaDB en puerto $Port... ($($i+1)/$Attempts)"
    Start-Sleep -Milliseconds $DelayMs
  }
  return $false
}

function Get-ServiceIfExists {
  param([string]$Name)
  return Get-Service -Name $Name -ErrorAction SilentlyContinue
}

function Stop-AndDeleteService {
  param([string]$Name)
  $service = Get-ServiceIfExists -Name $Name
  if (-not $service) { return }
  try {
    if ($service.Status -eq 'Running') {
      Write-Log "Deteniendo servicio $Name..."
      Stop-Service -Name $Name -Force -ErrorAction Stop
      Start-Sleep -Seconds 2
    }
  } catch {
    Write-Log "No se pudo detener $Name: $($_.Exception.Message)"
  }
  & sc.exe delete $Name | Out-Null
}

function Get-BundledCandidate {
  if (-not $InstallDir) { return $null }
  $bundleRoot = Join-Path $InstallDir $bundleRelativePath
  $serverExe = Join-Path $bundleRoot 'bin\mariadbd.exe'
  $bootstrapExe = Join-Path $bundleRoot 'bin\mysql_install_db.exe'
  $pluginDir = Join-Path $bundleRoot 'lib\plugin'
  if (-not (Test-Path -LiteralPath $serverExe)) {
    Write-Log "No se encontro mariadbd.exe en: $serverExe"
    return $null
  }
  return [PSCustomObject]@{
    Kind         = 'bundled'
    Root         = $bundleRoot
    ServerExe    = $serverExe
    BootstrapExe = $bootstrapExe
    PluginDir    = $pluginDir
    DefaultsFile = $configFile
  }
}

function Get-SystemCandidate {
  $roots = @('C:\Program Files', 'C:\Program Files (x86)', 'C:\MariaDB', 'C:\MySQL')
  $installDirs = New-Object System.Collections.Generic.List[string]
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    if ($root -match '^[A-Z]:\\(MariaDB|MySQL)$') { $installDirs.Add($root); continue }
    Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^(MariaDB|MySQL)' } |
      Sort-Object Name -Descending |
      ForEach-Object { $installDirs.Add($_.FullName) }
  }
  foreach ($dir in ($installDirs | Select-Object -Unique)) {
    foreach ($exeName in @('mariadbd.exe', 'mysqld.exe')) {
      $serverExe = Join-Path $dir "bin\$exeName"
      if (-not (Test-Path -LiteralPath $serverExe)) { continue }
      $defaultsFile = ''
      foreach ($p in @((Join-Path $dir 'data\my.ini'), (Join-Path $dir 'my.ini'))) {
        if (Test-Path -LiteralPath $p) { $defaultsFile = $p; break }
      }
      return [PSCustomObject]@{
        Kind         = 'system'
        Root         = $dir
        ServerExe    = $serverExe
        BootstrapExe = ''
        PluginDir    = (Join-Path $dir 'lib\plugin')
        DefaultsFile = $defaultsFile
      }
    }
  }
  return $null
}

function Ensure-ManagedConfig {
  param($Candidate)
  New-Item -ItemType Directory -Path $programDataRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
  $errorLog = Join-Path $logsDir 'mariadb.err'
  $content = @"
[mysqld]
basedir=$($Candidate.Root -replace '\\','/')
datadir=$($dataDir -replace '\\','/')
port=$port
bind-address=$hostName
plugin-dir=$($Candidate.PluginDir -replace '\\','/')
log-error=$($errorLog -replace '\\','/')
character-set-server=utf8mb4
collation-server=utf8mb4_unicode_ci
skip-name-resolve

[client]
port=$port
plugin-dir=$($Candidate.PluginDir -replace '\\','/')
"@
  Set-Content -Path $configFile -Value $content -Encoding ASCII
  Write-Log "Configuracion my.ini escrita en: $configFile"
}

function Initialize-BundledData {
  param($Candidate)

  $mysqlDir = Join-Path $dataDir 'mysql'
  $ibdata   = Join-Path $dataDir 'ibdata1'

  # Si los datos ya existen, no tocar nada — proteccion de datos
  if ((Test-Path -LiteralPath $mysqlDir) -and (Test-Path -LiteralPath $ibdata)) {
    Write-Log 'Directorio de datos ya existe y esta completo. Omitiendo inicializacion.'
    Ensure-ManagedConfig -Candidate $Candidate
    return
  }

  # Buscar el ejecutable de bootstrap: preferir mariadb-install-db.exe (v10.9+/12.x),
  # caer a mysql_install_db.exe (v10.8 y anteriores)
  $bootstrapExe = $null
  foreach ($exeName in @('mariadb-install-db.exe', 'mysql_install_db.exe')) {
    $candidate_exe = Join-Path (Split-Path $Candidate.ServerExe -Parent) $exeName
    if (Test-Path -LiteralPath $candidate_exe) {
      $bootstrapExe = $candidate_exe
      break
    }
  }

  if (-not $bootstrapExe) {
    throw "No se encontro ningun ejecutable de bootstrap (mariadb-install-db.exe / mysql_install_db.exe) en: $(Split-Path $Candidate.ServerExe -Parent)"
  }

  Write-Log "Bootstrap executable: $bootstrapExe"

  # Limpiar directorio de datos si existe pero esta incompleto
  if (Test-Path -LiteralPath $dataDir) {
    Write-Log "Limpiando directorio de datos incompleto: $dataDir"
    Get-ChildItem -Path $dataDir -Force -ErrorAction SilentlyContinue |
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  }

  Ensure-ManagedConfig -Candidate $Candidate

  # Intentar bootstrap — primero sin --password (MariaDB 11+/12.x),
  # luego con --password= (10.x compatibilidad)
  $bootstrapSets = @(
    @("--datadir=$dataDir", "--port=$port", "--default-authentication-plugin=mysql_native_password"),
    @("--datadir=$dataDir", "--port=$port"),
    @("--datadir=$dataDir", "--port=$port", '--password=')
  )

  $bootstrapOk = $false
  foreach ($args in $bootstrapSets) {
    Write-Log "Intentando bootstrap: $bootstrapExe $($args -join ' ')"
    & $bootstrapExe @args 2>&1 | ForEach-Object { Write-Log "  > $_" }
    $exitCode = $LASTEXITCODE
    Write-Log "Bootstrap exit code: $exitCode"

    # Verificar si los datos se crearon correctamente (el codigo puede ser no-cero pero datos ok)
    if ((Test-Path -LiteralPath $mysqlDir) -and (Test-Path -LiteralPath $ibdata)) {
      Write-Log "Datos creados correctamente (exit code: $exitCode)"
      $bootstrapOk = $true
      break
    }
    Write-Log "Datos no creados con estos argumentos, intentando siguiente variante..."
  }

  if (-not $bootstrapOk) {
    throw "Bootstrap de MariaDB fallo con todas las variantes. Verifica el log en: $logFile"
  }
}

function Configure-Service {
  param([string]$Name, [string]$ServerExe, [string]$DefaultsFile)

  $binPath = "`"$ServerExe`""
  if ($DefaultsFile) { $binPath += " `"--defaults-file=$DefaultsFile`"" }

  $service = Get-ServiceIfExists -Name $Name
  if ($service) {
    Write-Log "Reconfigurando servicio existente $Name..."
    $configCmd = "sc config `"$Name`" binPath= `"$binPath`" start= auto"
    cmd /c $configCmd 2>&1 | ForEach-Object { Write-Log "  sc: $_" }
    if ($LASTEXITCODE -ne 0) { throw "No se pudo reconfigurar el servicio $Name (sc config, codigo $LASTEXITCODE)." }
    return
  }

  Write-Log "Creando servicio $Name..."
  # Usar cmd /c para manejar correctamente el DisplayName con espacios
  $createCmd = "sc create `"$Name`" binPath= `"$binPath`" start= auto DisplayName= `"$displayName`""
  Write-Log "Ejecutando: $createCmd"
  cmd /c $createCmd 2>&1 | ForEach-Object { Write-Log "  sc: $_" }
  if ($LASTEXITCODE -ne 0) { throw "No se pudo crear el servicio $Name (sc create, codigo $LASTEXITCODE)." }
  & sc.exe description $Name 'MariaDB local incluida con Tecno Caja.' | Out-Null
}

function Start-ManagedService {
  param([string]$Name)
  $service = Get-ServiceIfExists -Name $Name
  if (-not $service) { throw "No se encontro el servicio $Name despues de configurarlo." }
  if ($service.Status -eq 'Running') {
    Write-Log "Servicio $Name ya esta corriendo."
    return
  }
  Write-Log "Iniciando servicio $Name..."
  try {
    Start-Service -Name $Name -ErrorAction Stop
  } catch {
    Write-Log "Start-Service fallo: $($_.Exception.Message) — intentando sc start..."
    & sc.exe start $Name | Out-Null
  }
}

function Ensure-ManagedMariaDb {
  Write-Log "InstallDir: $InstallDir"
  Write-Log "Log completo en: $logFile"

  if (Test-PortOpen -TargetHost $hostName -Port $port) {
    Write-Log "MariaDB ya disponible en ${hostName}:$port."
    return 0
  }

  # Intentar levantar un servicio que ya existe
  foreach ($serviceName in (@($managedServiceName) + $fallbackServiceNames)) {
    $service = Get-ServiceIfExists -Name $serviceName
    if (-not $service) { continue }
    Write-Log "Servicio existente encontrado: $serviceName (estado: $($service.Status))"
    & sc.exe config $serviceName start= auto | Out-Null
    if ($service.Status -ne 'Running') {
      try { Start-Service -Name $serviceName -ErrorAction Stop } catch {
        Write-Log "No se pudo iniciar $serviceName: $($_.Exception.Message)"
      }
    }
    if (Wait-ForPort -TargetHost $hostName -Port $port) {
      Write-Log "MariaDB lista usando servicio $serviceName."
      return 0
    }
    Write-Log "Servicio $serviceName no abrio el puerto en tiempo esperado."
  }

  $candidate = Get-BundledCandidate
  if (-not $candidate) { $candidate = Get-SystemCandidate }

  if (-not $candidate) {
    Write-Log 'No se encontro bundle ni instalacion local de MariaDB/MySQL.'
    return 20
  }

  Write-Log "Candidato encontrado: $($candidate.Kind) en $($candidate.Root)"

  if ($candidate.Kind -eq 'bundled') {
    Initialize-BundledData -Candidate $candidate
    Configure-Service -Name $managedServiceName -ServerExe $candidate.ServerExe -DefaultsFile $configFile
    Start-ManagedService -Name $managedServiceName
    if (-not (Wait-ForPort -TargetHost $hostName -Port $port -Attempts 45)) {
      throw "Timeout: el servicio $managedServiceName no abrio el puerto $port en 45 segundos."
    }
    Write-Log 'MariaDB incluida configurada correctamente.'
    return 0
  }

  Configure-Service -Name $managedServiceName -ServerExe $candidate.ServerExe -DefaultsFile $candidate.DefaultsFile
  Start-ManagedService -Name $managedServiceName
  if (-not (Wait-ForPort -TargetHost $hostName -Port $port -Attempts 45)) {
    throw "Timeout: el servicio $managedServiceName no abrio el puerto $port en 45 segundos."
  }
  Write-Log 'MariaDB del sistema configurada para Tecno Caja.'
  return 0
}

try {
  if ($Uninstall) {
    # Detener y eliminar el servicio MariaDB gestionado
    Stop-AndDeleteService -Name $managedServiceName

    # Intentar también con el nombre legacy por si existe de versión anterior
    Stop-AndDeleteService -Name 'MariaDB'
    Stop-AndDeleteService -Name 'TecnoCajaMariaDB'

    # Limpiar carpeta de datos MariaDB (ambas variantes de nombre)
    # El installer.nsh borra las carpetas AppData/ProgramData, pero por si
    # el script se ejecuta independientemente, también lo hacemos aquí.
    foreach ($legacyRoot in @(
      (Join-Path $env:ProgramData 'Tecno Caja\MariaDB'),   # con espacio (actual)
      (Join-Path $env:ProgramData 'TecnoCaja\MariaDB')     # sin espacio (legacy)
    )) {
      if (Test-Path -LiteralPath $legacyRoot -ErrorAction SilentlyContinue) {
        Write-Log "Eliminando datos MariaDB en: $legacyRoot"
        try {
          Remove-Item -Recurse -Force -LiteralPath $legacyRoot -ErrorAction SilentlyContinue
          Write-Log "Eliminado: $legacyRoot"
        } catch {
          Write-Log "No se pudo eliminar $legacyRoot: $($_.Exception.Message)"
        }
      }
    }

    Write-Log 'Desinstalación MariaDB completada.'
    exit 0
  }
  $result = Ensure-ManagedMariaDb
  exit $result
} catch {
  Write-Log "ERROR FATAL: $($_.Exception.Message)"
  Write-Log "Stack: $($_.ScriptStackTrace)"
  exit 30
}
