param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$UserDataPath,
  [string]$PreviousUserInstall = '',
  [string]$PreviousMachineInstall = ''
)
$ErrorActionPreference = 'Stop'

# Solo copia los datos fiscales de esta instalacion. Nunca borra los originales
# ni reemplaza un archivo que ya exista en la carpeta permanente del negocio.
try {
  $targetRoot = [IO.Path]::GetFullPath($UserDataPath)
  if ($env:TECNO_CAJA_USER_DATA) { $targetRoot = [IO.Path]::GetFullPath($env:TECNO_CAJA_USER_DATA) }
  $roots = @($InstallDir, $PreviousUserInstall, $PreviousMachineInstall) |
    Where-Object { $_ } | ForEach-Object { [IO.Path]::GetFullPath($_) } | Select-Object -Unique
  foreach ($root in $roots) {
    if ($targetRoot.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or
      $targetRoot.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
      throw 'La carpeta de datos esta dentro de la instalacion. Configura una carpeta permanente fuera de ella antes de actualizar.'
    }
  }
  $copied = 0
  $archived = 0

  function Get-Digest([string]$file) {
    $stream = [IO.File]::OpenRead($file)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
  }

  function Assert-NoLink([string]$file) {
    $cursor = [IO.Path]::GetFullPath($file)
    while ($cursor) {
      if (Test-Path -LiteralPath $cursor) {
        if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
          throw 'No se puede preservar la certificacion a traves de un enlace.'
        }
      }
      $parent = [IO.Path]::GetDirectoryName($cursor)
      if ($parent -eq $cursor) { break }
      $cursor = $parent
    }
  }

  function Copy-Verified([string]$from, [string]$to) {
    Assert-NoLink $from
    Assert-NoLink $to
    if (Test-Path -LiteralPath $to) {
      if ((Get-Digest $from) -ne (Get-Digest $to)) {
        throw 'Un archivo de recuperacion existente no coincide con el original.'
      }
      return
    }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to)) | Out-Null
    [IO.File]::Copy($from, $to, $false)
    if ((Get-Digest $from) -ne (Get-Digest $to)) {
      throw 'No se pudo verificar la copia de los archivos de certificacion.'
    }
  }

  function Preserve-File([string]$file, [string]$relative) {
    $dest = [IO.Path]::GetFullPath((Join-Path $targetRoot $relative))
    if (-not $dest.StartsWith($targetRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Destino fiscal fuera de la carpeta del negocio.' }
    if ($file.Equals($dest, [StringComparison]::OrdinalIgnoreCase)) { return }
    $digest = Get-Digest $file
    # Conservar tambien los conflictos: dos lotes pueden tener el mismo e-NCF.
    $recovery = Join-Path $targetRoot ('certification-recovery\' + $digest + '\' + $relative)
    Copy-Verified $file $recovery
    $script:archived++
    if (-not (Test-Path -LiteralPath $dest)) {
      Copy-Verified $file $dest
      $script:copied++
    }
  }

  function Preserve-Tree([string]$source, [string]$relative) {
    if (-not (Test-Path -LiteralPath $source)) { return }
    Assert-NoLink $source
    foreach ($entry in Get-ChildItem -LiteralPath $source -Force) {
      Assert-NoLink $entry.FullName
      $next = Join-Path $relative $entry.Name
      if ($entry.PSIsContainer) {
        Preserve-Tree $entry.FullName $next
      } else {
        Preserve-File $entry.FullName $next
      }
    }
  }

  foreach ($root in $roots) {
    foreach ($base in @($root, (Join-Path $root 'runtime-data'), (Join-Path $root 'resources\app'), (Join-Path $root 'resources'))) {
      Preserve-Tree (Join-Path $base 'storage\ecf') 'storage\ecf'
      Preserve-Tree (Join-Path $base 'ecf') 'ecf'
      $counter = Join-Path $base 'ecf-sequence-high-watermarks.json'
      if (Test-Path -LiteralPath $counter) { Preserve-File $counter 'ecf-sequence-high-watermarks.json' }
      # Las versiones anteriores llevaban esta credencial en resources.
      # Conservarla localmente antes de instalar una version que ya no la distribuye.
      $firebase = Join-Path $base 'firebase-key.json'
      if (Test-Path -LiteralPath $firebase) { Preserve-File $firebase 'config\firebase-key.json' }
    }
  }
  [Console]::Out.WriteLine("CERTIFICATION_PRESERVED copied=$copied archived=$archived")
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
