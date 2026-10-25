# Capture a region of the real desktop (to verify transparency/positioning).
param([int]$X = 0, [int]$Y = 0, [int]$W = 1920, [int]$H = 1080, [string]$Out = "$PSScriptRoot\..\_shot_screen.png")
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($X, $Y, 0, 0, $bmp.Size)
$bmp.Save((Resolve-Path -LiteralPath (Split-Path $Out)).Path + '\' + (Split-Path $Out -Leaf), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"saved $Out"
