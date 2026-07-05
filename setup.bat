@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo ============================================
echo   Sound Separator セットアップ
echo   (uv と ffmpeg が必要です。README参照)
echo ============================================

where uv > nul 2>&1
if errorlevel 1 (
    echo [エラー] uv が見つかりません。https://docs.astral.sh/uv/ からインストールしてください
    pause & exit /b 1
)
where ffmpeg > nul 2>&1
if errorlevel 1 (
    echo [エラー] ffmpeg が見つかりません。PATH に追加してください
    pause & exit /b 1
)

echo [1/4] Python 3.11 仮想環境を作成...
uv venv --python 3.11 .venv || (pause & exit /b 1)

echo [2/4] PyTorch (CUDA 12.4) をインストール... (約2.5GB)
uv pip install --python .venv torch torchaudio --index-url https://download.pytorch.org/whl/cu124 || (pause & exit /b 1)

echo [3/4] 依存パッケージをインストール...
uv pip install --python .venv demucs fastapi "uvicorn[standard]" python-multipart soundfile librosa omegaconf ml_collections beartype einops spafe noisereduce pyloudnorm || (pause & exit /b 1)

echo [4/4] torch依存パッケージ (--no-deps でtorchを保護)...
uv pip install --python .venv --no-deps rotary-embedding-torch openai-whisper basic-pitch resemblyzer || (pause & exit /b 1)
uv pip install --python .venv tiktoken more-itertools pretty_midi resampy onnxruntime mir_eval webrtcvad-wheels || (pause & exit /b 1)

echo.
echo セットアップ完了! run.bat で起動してください
echo (AIモデルは初回使用時に models/ へ自動ダウンロードされます)
pause
