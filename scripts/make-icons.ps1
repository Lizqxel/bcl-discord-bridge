# Draws the desktop shortcut icons (crewmate with headset) and packs them into .ico files.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\make-icons.ps1
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$outDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'assets'
New-Item -ItemType Directory -Force $outDir | Out-Null

function Color($hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }

function RoundRect([System.Drawing.Drawing2D.GraphicsPath]$p, [float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $d = $r * 2
    $p.StartFigure()
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
}

function Draw-Icon($theme) {
    $size = 256
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.PixelOffsetMode = 'HighQuality'
    $g.Clear([System.Drawing.Color]::Transparent)
    $ink = Color '#150d24'

    # Background tile
    $bg = New-Object System.Drawing.Drawing2D.GraphicsPath
    RoundRect $bg 6 6 244 244 58
    $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.PointF]::new(0, 0)), ([System.Drawing.PointF]::new(256, 256)), (Color $theme.bg1), (Color $theme.bg2)
    $g.FillPath($grad, $bg)
    # Stars
    $star = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(150, 255, 255, 255))
    foreach ($s in @(@(36, 40, 5), @(214, 34, 4), @(30, 150, 3), @(222, 206, 4), @(58, 216, 3), @(190, 70, 3))) {
        $g.FillEllipse($star, $s[0], $s[1], $s[2], $s[2])
    }

    # Crewmate silhouette: backpack + body + legs as one path, outlined then filled
    $body = New-Object System.Drawing.Drawing2D.GraphicsPath
    $body.FillMode = 'Winding'
    RoundRect $body 50 104 40 78 16      # backpack
    RoundRect $body 74 46 114 140 56     # body
    RoundRect $body 74 146 48 66 18      # back leg
    RoundRect $body 140 146 48 66 18     # front leg
    $outline = New-Object System.Drawing.Pen $ink, 16
    $outline.LineJoin = 'Round'
    $g.DrawPath($outline, $body)
    $g.FillPath((New-Object System.Drawing.SolidBrush (Color $theme.suit)), $body)

    # Suit shading on the back side
    $shade = New-Object System.Drawing.Drawing2D.GraphicsPath
    RoundRect $shade 50 104 40 78 16
    $g.FillPath((New-Object System.Drawing.SolidBrush (Color $theme.suitShade)), $shade)

    # Visor
    $visor = New-Object System.Drawing.Drawing2D.GraphicsPath
    RoundRect $visor 110 72 92 54 27
    $g.DrawPath((New-Object System.Drawing.Pen $ink, 12), $visor)
    $g.FillPath((New-Object System.Drawing.SolidBrush (Color $theme.visor)), $visor)
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(230, 255, 255, 255))), 142, 82, 40, 14)

    # Headset: band over the helmet and a cup on the back of the head
    $band = New-Object System.Drawing.Pen $ink, 20
    $band.StartCap = 'Round'; $band.EndCap = 'Round'
    $g.DrawArc($band, 70, 26, 120, 110, 195, 150)
    $bandFill = New-Object System.Drawing.Pen (Color $theme.headset), 9
    $bandFill.StartCap = 'Round'; $bandFill.EndCap = 'Round'
    $g.DrawArc($bandFill, 70, 26, 120, 110, 195, 150)
    $g.FillEllipse((New-Object System.Drawing.SolidBrush $ink), 66, 70, 48, 48)
    $g.FillEllipse((New-Object System.Drawing.SolidBrush (Color $theme.headset)), 74, 78, 32, 32)

    if ($theme.badge -eq 'waves') {
        # Voice waves in front of the visor
        foreach ($w in @(@(190, 82, 26, 36), @(196, 68, 40, 64))) {
            $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 9
            $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
            $g.DrawArc($pen, $w[0], $w[1], $w[2], $w[3], -50, 100)
        }
    } else {
        # Power badge
        $g.FillEllipse((New-Object System.Drawing.SolidBrush $ink), 164, 156, 84, 84)
        $g.FillEllipse((New-Object System.Drawing.SolidBrush (Color $theme.badgeFill)), 170, 162, 72, 72)
        $pw = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 9
        $pw.StartCap = 'Round'; $pw.EndCap = 'Round'
        $g.DrawArc($pw, 186, 178, 40, 40, -60, 300)
        $g.DrawLine($pw, 206, 172, 206, 196)
    }

    $g.Dispose()
    return $bmp
}

function Save-Ico($bmp, $path) {
    $sizes = 256, 64, 48, 32, 16
    $pngs = foreach ($s in $sizes) {
        $scaled = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [System.Drawing.Graphics]::FromImage($scaled)
        $g.InterpolationMode = 'HighQualityBicubic'
        $g.SmoothingMode = 'AntiAlias'
        $g.PixelOffsetMode = 'HighQuality'
        $g.DrawImage($bmp, 0, 0, $s, $s)
        $g.Dispose()
        $ms = New-Object System.IO.MemoryStream
        $scaled.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        , $ms.ToArray()
    }
    $fs = [System.IO.File]::Create($path)
    $w = New-Object System.IO.BinaryWriter $fs
    $w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
        $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
        $w.Write([UInt16]1); $w.Write([UInt16]32)
        $w.Write([UInt32]$pngs[$i].Length); $w.Write([UInt32]$offset)
        $offset += $pngs[$i].Length
    }
    foreach ($png in $pngs) { $w.Write($png) }
    $w.Close()
}

$themes = @{
    start = @{ bg1 = '#8b5cf6'; bg2 = '#3b1c8c'; suit = '#38e8d4'; suitShade = '#1fa99c'; visor = '#a8e6ff'; headset = '#ffd23f'; badge = 'waves' }
    stop  = @{ bg1 = '#f43f5e'; bg2 = '#6b1020'; suit = '#e9eef7'; suitShade = '#a7b1c2'; visor = '#7fb6d9'; headset = '#5b6475'; badge = 'power'; badgeFill = '#e11d48' }
}
foreach ($name in $themes.Keys) {
    $bmp = Draw-Icon $themes[$name]
    $bmp.Save((Join-Path $outDir "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    Save-Ico $bmp (Join-Path $outDir "$name.ico")
    $bmp.Dispose()
}
Write-Host "icons written to $outDir"
