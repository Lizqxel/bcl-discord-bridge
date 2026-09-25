$ErrorActionPreference = 'SilentlyContinue'
$url = 'http://127.0.0.1:38472'
try {
    Invoke-RestMethod "$url/api/state" -TimeoutSec 2 | Out-Null
} catch {
    Write-Host 'BCL Bridgeは起動していません。' -ForegroundColor Yellow
    Start-Sleep 2
    exit 0
}

Write-Host 'ゲーム中なら全員を待機VCへ戻して、BCL Bridgeを終了します…' -ForegroundColor Cyan
Invoke-RestMethod -Method Post "$url/api/shutdown" -TimeoutSec 5 | Out-Null

for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try { Invoke-RestMethod "$url/api/state" -TimeoutSec 1 | Out-Null } catch { break }
}

# Fallback if the app did not exit on its own.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'dist[\\/]index\.js' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Write-Host '終了しました。' -ForegroundColor Green
Start-Sleep 2