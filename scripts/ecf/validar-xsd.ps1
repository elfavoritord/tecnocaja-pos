# Valida cada XML de la carpeta contra el XSD oficial de la DGII de su tipo, con el validador de .NET.
# El nombre del archivo empieza por el e-NCF (E31-...); los RFCE llevan -RFCE- y usan su propio XSD.
# Uso: pwsh -NoProfile -File scripts/ecf/validar-xsd.ps1 <carpeta>
param([Parameter(Mandatory = $true)][string]$Carpeta)
$xsdDir = Join-Path $PSScriptRoot '..\..\modules\ecf\schemas'
$fallas = 0
foreach ($f in Get-ChildItem $Carpeta -Filter *.xml | Sort-Object Name) {
  $tipo = $f.BaseName.Substring(1, 2)
  $xsd = if ($f.BaseName -match '-RFCE-') { 'RFCE 32 v.1.0.xsd' } else { "e-CF $tipo v.1.0.xsd" }
  $settings = [System.Xml.XmlReaderSettings]::new()
  $settings.ValidationType = [System.Xml.ValidationType]::Schema
  [void]$settings.Schemas.Add($null, (Join-Path $xsdDir $xsd))
  $errores = [System.Collections.Generic.List[string]]::new()
  $settings.add_ValidationEventHandler({ param($s, $e) $errores.Add($e.Message) })
  $reader = [System.Xml.XmlReader]::Create($f.FullName, $settings)
  try { while ($reader.Read()) { } } catch { $errores.Add($_.Exception.Message) } finally { $reader.Dispose() }
  # La firma es de otro espacio de nombres: su contenido no lo describe el XSD de la DGII.
  $reales = @($errores | Where-Object { $_ -notmatch 'xmldsig' -and $_ -notmatch 'Signature' })
  if ($reales.Count) {
    $fallas += 1
    "FALLA $($f.Name)"
    $reales | Select-Object -First 4 | ForEach-Object { "   $_" }
  }
}
"XSD: $(@(Get-ChildItem $Carpeta -Filter *.xml).Count) archivos, $fallas con errores"
exit $(if ($fallas) { 1 } else { 0 })
