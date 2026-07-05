@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo ============================================
echo   Sound Separator を起動しています...
echo   ブラウザで http://127.0.0.1:8765 を開いてください
echo ============================================
start "" http://127.0.0.1:8765
.venv\Scripts\python.exe app\server.py
pause
