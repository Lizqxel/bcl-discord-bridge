$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$envPath = Join-Path $PSScriptRoot '.env'
if (-not (Test-Path -LiteralPath $envPath)) {
    Write-Host '先に setup.cmd を実行してください。' -ForegroundColor Red
    Read-Host 'Enterで終了'
    exit 1
}

$applicationId = (Read-Host '追加BotのApplication IDを貼り付けてEnter').Trim()
if ($applicationId -notmatch '^\d+$') {
    Write-Host 'Application IDは数字だけです。' -ForegroundColor Red
    Read-Host 'Enterで終了'
    exit 1
}

$secureToken = Read-Host '追加BotのTokenを貼り付けてEnter（入力内容は画面に出ません）' -AsSecureString
$tokenPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPtr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPtr)
}
if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Host 'Tokenが空です。' -ForegroundColor Red
    Read-Host 'Enterで終了'
    exit 1
}

$lines = [Collections.Generic.List[string]](Get-Content -LiteralPath $envPath)
$index = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -like 'DISCORD_VOICE_BOT_TOKENS=*') { $index = $i; break }
}
$current = if ($index -ge 0) { $lines[$index].Substring('DISCORD_VOICE_BOT_TOKENS='.Length).Trim() } else { '' }
$tokens = @($current.Split(',', [StringSplitOptions]::RemoveEmptyEntries) | ForEach-Object { $_.Trim() })
if ($tokens -notcontains $token) { $tokens += $token }
$newLine = 'DISCORD_VOICE_BOT_TOKENS=' + ($tokens -join ',')
if ($index -ge 0) { $lines[$index] = $newLine } else { $lines.Add($newLine) }
[IO.File]::WriteAllLines($envPath, $lines, [Text.UTF8Encoding]::new($false))
$token = $null
$secureToken.Dispose()

$permissions = '3146752'
$inviteUrl = "https://discord.com/oauth2/authorize?client_id=$applicationId&permissions=$permissions&integration_type=0&scope=bot"
Write-Host ''
Write-Host '追加Botを安全に保存しました。次のURLから管理Botと同じDiscordサーバーへ追加してください。' -ForegroundColor Green
Write-Host $inviteUrl -ForegroundColor Yellow
Write-Host ''
Write-Host 'アプリを起動中なら、いったん閉じて start.cmd から起動し直してください。'
Read-Host 'Enterで終了'
