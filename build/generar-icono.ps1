# Genera build/icon.ico a partir del logo PNG del proyecto
# Uso: powershell -ExecutionPolicy Bypass -File build\generar-icono.ps1

Add-Type -AssemblyName System.Drawing

# Primero busca el logo en electron/icon.png (copia local); si no, lo toma de la app de delivery
$logoLocal   = Join-Path $PSScriptRoot "..\electron\icon.png"
$logoFallback = Join-Path $PSScriptRoot "..\app delivery\assets\icons\icon.png"
$logoPath = if (Test-Path $logoLocal) { $logoLocal } else { $logoFallback }
$outputPath = Join-Path $PSScriptRoot "icon.ico"

if (-not (Test-Path $logoPath)) {
    Write-Error "No se encontró el logo en: $logoPath"
    Write-Error "Asegúrate de que el archivo exista antes de ejecutar este script."
    exit 1
}

Write-Host "Cargando logo desde: $logoPath" -ForegroundColor Cyan

$sizes = @(256, 128, 64, 48, 32, 16)
$bitmaps = @()

$original = New-Object System.Drawing.Bitmap($logoPath)

function Get-AlphaBounds {
    param(
        [System.Drawing.Bitmap]$Bitmap,
        [int]$Threshold = 8
    )

    $minX = $Bitmap.Width
    $minY = $Bitmap.Height
    $maxX = -1
    $maxY = -1

    for ($y = 0; $y -lt $Bitmap.Height; $y++) {
        for ($x = 0; $x -lt $Bitmap.Width; $x++) {
            if ($Bitmap.GetPixel($x, $y).A -gt $Threshold) {
                if ($x -lt $minX) { $minX = $x }
                if ($y -lt $minY) { $minY = $y }
                if ($x -gt $maxX) { $maxX = $x }
                if ($y -gt $maxY) { $maxY = $y }
            }
        }
    }

    if ($maxX -lt 0 -or $maxY -lt 0) {
        return [System.Drawing.Rectangle]::FromLTRB(0, 0, $Bitmap.Width, $Bitmap.Height)
    }

    return [System.Drawing.Rectangle]::FromLTRB($minX, $minY, $maxX + 1, $maxY + 1)
}

function Get-DesktopIconCrop {
    param([System.Drawing.Bitmap]$Bitmap)

    $contentBounds = Get-AlphaBounds -Bitmap $Bitmap
    $contentWidth = $contentBounds.Width
    $contentHeight = $contentBounds.Height

    if ($contentHeight -le 0) {
        return [System.Drawing.Rectangle]::FromLTRB(0, 0, $Bitmap.Width, $Bitmap.Height)
    }

    $isWideLogo = $contentWidth / $contentHeight -gt 1.35

    if ($isWideLogo) {
        # Para accesos directos de Windows conviene usar la marca cuadrada
        # del POS en vez del logotipo horizontal completo; asi ocupa mas area.
        $side = [Math]::Min(
            [Math]::Max($contentHeight, [int]($contentHeight * 1.12)),
            $Bitmap.Width - $contentBounds.X
        )
        $y = [Math]::Max(0, $contentBounds.Y - [int](($side - $contentHeight) / 2))
        if ($y + $side -gt $Bitmap.Height) {
            $y = $Bitmap.Height - $side
        }

        return [System.Drawing.Rectangle]::FromLTRB(
            $contentBounds.X,
            $y,
            $contentBounds.X + $side,
            $y + $side
        )
    }

    $side = [Math]::Max($contentWidth, $contentHeight)
    $x = [Math]::Max(0, $contentBounds.X - [int](($side - $contentWidth) / 2))
    $y = [Math]::Max(0, $contentBounds.Y - [int](($side - $contentHeight) / 2))

    if ($x + $side -gt $Bitmap.Width) {
        $x = $Bitmap.Width - $side
    }
    if ($y + $side -gt $Bitmap.Height) {
        $y = $Bitmap.Height - $side
    }

    return [System.Drawing.Rectangle]::FromLTRB($x, $y, $x + $side, $y + $side)
}

$sourceRect = Get-DesktopIconCrop -Bitmap $original
Write-Host ("  Recorte base: {0}x{1} en ({2},{3})" -f $sourceRect.Width, $sourceRect.Height, $sourceRect.X, $sourceRect.Y) -ForegroundColor DarkGray

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $padding = [Math]::Max(1, [int]($size * 0.04))
    if ($size -le 32) {
        $padding = [Math]::Max(1, [int]($size * 0.02))
    }

    $destRect = [System.Drawing.Rectangle]::FromLTRB(
        $padding,
        $padding,
        $size - $padding,
        $size - $padding
    )

    $g.DrawImage($original, $destRect, $sourceRect, [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    $bitmaps += $bmp
    Write-Host "  Generado ${size}x${size}" -ForegroundColor Gray
}

$original.Dispose()

# Construir el archivo .ico manualmente (header + directorio + datos PNG)
$ms     = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($ms)

$count = $bitmaps.Count

# ICO header
$writer.Write([uint16]0)       # Reserved
$writer.Write([uint16]1)       # Type: ICO
$writer.Write([uint16]$count)  # Cantidad de imágenes

$dataOffset = 6 + $count * 16
$imageStreams = @()

foreach ($bmp in $bitmaps) {
    $imgMs = New-Object System.IO.MemoryStream
    $bmp.Save($imgMs, [System.Drawing.Imaging.ImageFormat]::Png)
    $imageStreams += $imgMs
}

# Directorio de imágenes
foreach ($i in 0..($count - 1)) {
    $bmp     = $bitmaps[$i]
    $imgData = $imageStreams[$i].ToArray()
    $w = if ($bmp.Width  -ge 256) { 0 } else { [byte]$bmp.Width  }
    $h = if ($bmp.Height -ge 256) { 0 } else { [byte]$bmp.Height }
    $writer.Write([byte]$w)
    $writer.Write([byte]$h)
    $writer.Write([byte]0)       # Color count
    $writer.Write([byte]0)       # Reserved
    $writer.Write([uint16]1)     # Color planes
    $writer.Write([uint16]32)    # Bits per pixel
    $writer.Write([uint32]$imgData.Length)
    $writer.Write([uint32]$dataOffset)
    $dataOffset += $imgData.Length
}

# Datos de imagen
foreach ($imgMs in $imageStreams) {
    $writer.Write($imgMs.ToArray())
    $imgMs.Dispose()
}

$writer.Flush()
[System.IO.File]::WriteAllBytes($outputPath, $ms.ToArray())
$ms.Dispose()

foreach ($bmp in $bitmaps) { $bmp.Dispose() }

Write-Host ""
Write-Host "Icono generado: $outputPath" -ForegroundColor Green
Write-Host "Ejecuta 'npm run build:desktop' para compilar el instalador." -ForegroundColor Cyan
