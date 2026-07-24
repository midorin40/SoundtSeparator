@echo off
chcp 65001 > nul
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [エラー] .venv がありません。先に setup.bat を実行してください。
  pause
  exit /b 1
)

rem 既に起動済みならブラウザを開くだけ
netstat -an | findstr /c:"127.0.0.1:8765" | findstr /c:"LISTENING" > nul
if not errorlevel 1 (
  echo 既に起動しています。ブラウザを開きます。
  start "" http://127.0.0.1:8765
  exit /b 0
)

echo ============================================
echo   Sound Separator を起動しています...
echo   準備ができたら自動でブラウザが開きます
echo   このウィンドウは閉じないでください
echo ============================================

rem サーバーが応答したらブラウザを開く監視をバックグラウンドで開始
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 240;$i++){try{$c=New-Object Net.Sockets.TcpClient('127.0.0.1',8765);$c.Close();Start-Process 'http://127.0.0.1:8765';exit}catch{Start-Sleep -Milliseconds 500}}"

.venv\Scripts\python.exe app\server.py
echo.
echo サーバーが終了しました。エラーが表示されている場合は内容を確認してください。
pause
