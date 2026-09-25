@echo off
chcp 65001 >nul
cd /d "%~dp0"

powershell.exe -NoProfile -Command "try { Invoke-RestMethod http://127.0.0.1:38472/api/state -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if %errorlevel%==0 (
  echo BCL Bridgeはすでに起動しています。操作画面を開きます。
  start "" http://127.0.0.1:38472/
  timeout /t 2 >nul
  exit /b 0
)

if not exist ".env" (
  echo 先に setup.cmd を実行してください。
  pause
  exit /b 1
)

if not exist "dist\index.js" (
  echo ビルドがありません。先に setup.cmd を実行してください。
  pause
  exit /b 1
)

title BCL Bridge
echo BCL Bridge Controlを起動します。操作画面がブラウザで自動的に開きます。
echo 遊んでいる間、この黒い画面は閉じないでください。
echo 終わるときはデスクトップの「BCL Bridge 終了」を使ってください。
npm start
echo.
echo Botが終了しました。
timeout /t 5