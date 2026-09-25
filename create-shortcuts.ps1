# デスクトップに「BCL Bridge 起動」「BCL Bridge 終了」のショートカットを作ります。
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell

$start = $shell.CreateShortcut((Join-Path $desktop 'BCL Bridge 起動.lnk'))
$start.TargetPath = Join-Path $root 'start.cmd'
$start.WorkingDirectory = $root
$start.IconLocation = (Join-Path $root 'assets\start.ico') + ',0'
$start.Description = 'BCL Discord中継を起動'
$start.Save()

$stop = $shell.CreateShortcut((Join-Path $desktop 'BCL Bridge 終了.lnk'))
$stop.TargetPath = Join-Path $root 'stop.cmd'
$stop.WorkingDirectory = $root
$stop.IconLocation = (Join-Path $root 'assets\stop.ico') + ',0'
$stop.Description = 'BCL Discord中継を安全に終了'
$stop.WindowStyle = 7
$stop.Save()

ie4uinit.exe -show 2>$null
Write-Host 'デスクトップにショートカットを作りました。' -ForegroundColor Green
