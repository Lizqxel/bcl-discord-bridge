$ErrorActionPreference = 'Stop'

Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'Node.js 24以降が見つかりません。https://nodejs.org/ からLTS版を入れてください。' -ForegroundColor Red
    Read-Host 'Enterで終了'
    exit 1
}

$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 24) {
    Write-Host "Node.js 24以降が必要です。現在: $(node --version)" -ForegroundColor Red
    Read-Host 'Enterで終了'
    exit 1
}

$applicationId = (Read-Host 'Discord Application IDを貼り付けてEnter').Trim()
if ($applicationId -notmatch '^\d+$') {
    Write-Host 'Application IDは数字だけです。最初からやり直してください。' -ForegroundColor Red
    Read-Host 'Enterで終了'
    exit 1
}

$secureToken = Read-Host 'Discord Bot Tokenを貼り付けてEnter（入力内容は画面に出ません）' -AsSecureString
$tokenPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPtr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPtr)
}

if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Host 'Tokenが空です。最初からやり直してください。' -ForegroundColor Red
    Read-Host 'Enterで終了'
    exit 1
}

$envText = @"
DISCORD_BOT_TOKEN=$token
DISCORD_VOICE_BOT_TOKENS=
DISCORD_APPLICATION_ID=$applicationId
BETTERCREWLINK_SERVER=https://bettercrewl.ink
UI_PORT=38472
LOG_LEVEL=info
"@
[IO.File]::WriteAllText((Join-Path $PSScriptRoot '.env'), $envText, [Text.UTF8Encoding]::new($false))
$token = $null
$secureToken.Dispose()

Write-Host '必要な部品をインストールしています…' -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) { throw 'npm installに失敗しました。' }

Write-Host 'ビルドとテストをしています…' -ForegroundColor Cyan
npm run check
if ($LASTEXITCODE -ne 0) { throw 'テストに失敗しました。' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'ビルドに失敗しました。' }

# View Channel, Manage Channels, Send Messages, Read Message History, Connect, Speak, Move Members
$permissions = '19991568'
$inviteUrl = "https://discord.com/oauth2/authorize?client_id=$applicationId&permissions=$permissions&integration_type=0&scope=bot"

Write-Host ''
Write-Host 'セットアップ完了です。' -ForegroundColor Green
Write-Host '次のURLから、遊ぶDiscordサーバーへ管理Botを追加してください。'
Write-Host $inviteUrl -ForegroundColor Yellow
Write-Host ''
Write-Host '2体目以降は add-voice-bot.cmd、遊ぶときは start.cmd を使います。'
Read-Host 'Enterで終了'
