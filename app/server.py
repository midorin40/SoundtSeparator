# coding: utf-8
"""Sound Separator - ローカル音源分離アプリのWebサーバー。

- 分離モード dme:   話し声 / 効果音 / BGM (BandIt Plus)
- 分離モード music: ボーカル / ドラム / ベース / ギター / ピアノ / その他 (BS-Roformer + htdemucs_6s)
- /api/denoise: 選択範囲をノイズプロファイルとしたスペクトラルゲート除去 (noisereduce)
"""
import io
import os
import shutil
import subprocess
import threading
import time
import uuid
import zipfile

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from separator import SAMPLE_RATE, engine

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(os.path.dirname(BASE_DIR), "output")
STATIC_DIR = os.path.join(BASE_DIR, "static")
os.makedirs(OUTPUT_DIR, exist_ok=True)

STEM_SPECS = {
    "dme": [
        {"name": "dialog", "label": "話し声", "color": "#38bdf8"},
        {"name": "effect", "label": "効果音", "color": "#fbbf24"},
        {"name": "music", "label": "BGM", "color": "#c084fc"},
    ],
    "music": [
        {"name": "vocals", "label": "ボーカル", "color": "#f472b6"},
        {"name": "drums", "label": "ドラム", "color": "#fb923c"},
        {"name": "bass", "label": "ベース", "color": "#34d399"},
        {"name": "guitar", "label": "ギター", "color": "#fbbf24"},
        {"name": "piano", "label": "ピアノ", "color": "#38bdf8"},
        {"name": "other", "label": "その他", "color": "#a78bfa"},
    ],
}
ALLOWED_AUDIO = {f"{s['name']}.wav" for specs in STEM_SPECS.values() for s in specs} | {"original.wav"}

app = FastAPI(title="Sound Separator")

jobs: dict = {}
jobs_lock = threading.Lock()


def set_job(job_id, **kwargs):
    with jobs_lock:
        jobs[job_id].update(kwargs)


def decode_to_wav(src_path: str, dst_path: str):
    """ffmpegで任意の音声/動画ファイルを 44.1kHz ステレオ WAV に変換する。"""
    cmd = [
        "ffmpeg", "-y", "-i", src_path,
        "-vn", "-ac", "2", "-ar", str(SAMPLE_RATE),
        "-acodec", "pcm_f32le", dst_path,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0 or not os.path.isfile(dst_path):
        tail = (proc.stderr or "").strip().splitlines()[-3:]
        raise RuntimeError("音声の読み込みに失敗しました: " + " / ".join(tail))


def process_job(job_id: str, input_path: str, mode: str, quality: str):
    job_dir = os.path.join(OUTPUT_DIR, job_id)
    try:
        set_job(job_id, status="processing", progress=0, message="音声を読み込み中...")
        mix_path = os.path.join(job_dir, "original.wav")
        decode_to_wav(input_path, mix_path)

        audio, sr = sf.read(mix_path, dtype="float32", always_2d=True)
        audio = audio.T  # (channels, samples)
        duration = audio.shape[1] / sr
        if duration < 0.5:
            raise RuntimeError("音声が短すぎます (0.5秒以上必要です)")
        set_job(job_id, duration=duration)

        def cb(pct, msg):
            set_job(job_id, progress=pct, message=msg)

        t0 = time.time()
        stems = engine.separate(audio, mode=mode, quality=quality, progress_cb=cb)

        set_job(job_id, progress=100, message="ファイルを書き出し中...")
        for spec in STEM_SPECS[mode]:
            data = stems[spec["name"]].T  # (samples, channels)
            data = np.clip(data, -1.0, 1.0)
            sf.write(os.path.join(job_dir, f"{spec['name']}.wav"), data, sr, subtype="PCM_16")

        # 元音源も16bitで保存し直す(ブラウザ再生用に統一)
        sf.write(mix_path, np.clip(audio.T, -1.0, 1.0), sr, subtype="PCM_16")

        set_job(
            job_id,
            status="done",
            message="完了",
            elapsed=round(time.time() - t0, 1),
        )
    except Exception as e:
        import traceback
        traceback.print_exc()
        set_job(job_id, status="error", message=str(e))


@app.post("/api/jobs")
async def create_job(
    file: UploadFile = File(...),
    mode: str = Form("dme"),
    quality: str = Form("standard"),
):
    if mode not in STEM_SPECS:
        raise HTTPException(400, "invalid mode")
    job_id = uuid.uuid4().hex[:12]
    job_dir = os.path.join(OUTPUT_DIR, job_id)
    os.makedirs(job_dir, exist_ok=True)

    ext = os.path.splitext(file.filename or "input")[1] or ".bin"
    input_path = os.path.join(job_dir, "input" + ext)
    with open(input_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    with jobs_lock:
        jobs[job_id] = {
            "id": job_id,
            "filename": file.filename,
            "mode": mode,
            "quality": quality,
            "status": "queued",
            "progress": 0,
            "message": "待機中...",
            "created": time.time(),
        }

    threading.Thread(target=process_job, args=(job_id, input_path, mode, quality), daemon=True).start()
    return {"id": job_id}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "job not found")
        job = dict(job)
    if job["status"] == "done":
        job["stems"] = [
            {**spec, "url": f"/api/jobs/{job_id}/audio/{spec['name']}.wav"}
            for spec in STEM_SPECS[job["mode"]]
        ]
        job["original_url"] = f"/api/jobs/{job_id}/audio/original.wav"
        job["zip_url"] = f"/api/jobs/{job_id}/download.zip"
    return job


@app.get("/api/jobs/{job_id}/audio/{filename}")
def get_audio(job_id: str, filename: str):
    if filename not in ALLOWED_AUDIO:
        raise HTTPException(404)
    path = os.path.join(OUTPUT_DIR, job_id, filename)
    if not os.path.isfile(path):
        raise HTTPException(404)
    return FileResponse(path, media_type="audio/wav")


@app.get("/api/jobs/{job_id}/download.zip")
def download_zip(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404)
    job_dir = os.path.join(OUTPUT_DIR, job_id)
    zip_path = os.path.join(job_dir, "stems.zip")
    if not os.path.isfile(zip_path):
        base = os.path.splitext(job.get("filename") or "audio")[0]
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as zf:
            for spec in STEM_SPECS[job["mode"]]:
                src = os.path.join(job_dir, f"{spec['name']}.wav")
                if os.path.isfile(src):
                    zf.write(src, f"{base}_{spec['label']}.wav")
    return FileResponse(zip_path, media_type="application/zip", filename="stems.zip")


@app.post("/api/denoise")
def denoise(
    file: UploadFile = File(...),
    noise_start: float = Form(...),
    noise_end: float = Form(...),
    strength: float = Form(1.0),
):
    """選択範囲 (noise_start〜noise_end 秒) をノイズプロファイルとして学習し、
    トラック全体からスペクトラルゲーティングで除去して返す。
    重い同期処理のため sync def (FastAPIがスレッドプールで実行し、イベントループを塞がない)。"""
    import noisereduce as nr

    raw = file.file.read()
    audio, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)

    s = max(0, int(noise_start * sr))
    e = min(len(audio), int(noise_end * sr))
    if e - s < int(0.05 * sr):
        raise HTTPException(400, "ノイズ区間が短すぎます (0.05秒以上選択してください)")

    noise = audio[s:e]
    strength = float(np.clip(strength, 0.1, 1.0))

    out = np.stack(
        [
            nr.reduce_noise(
                y=audio[:, c],
                sr=sr,
                y_noise=noise[:, c],
                stationary=True,
                prop_decrease=strength,
            )
            for c in range(audio.shape[1])
        ],
        axis=1,
    ).astype(np.float32)

    buf = io.BytesIO()
    sf.write(buf, np.clip(out, -1.0, 1.0), sr, format="WAV", subtype="PCM_16")
    return Response(content=buf.getvalue(), media_type="audio/wav")


@app.post("/api/effect")
def apply_effect(
    file: UploadFile = File(...),
    effect: str = Form(...),
    sensitivity: float = Form(0.5),
    base_freq: float = Form(50.0),
):
    """範囲修復エフェクト。クライアントは選択範囲+前後コンテキストのWAVを送り、
    処理済みの同じ長さのWAVを受け取って選択範囲だけをクロスフェードで書き戻す。
    重い同期処理のため sync def (イベントループを塞がない)。"""
    from repair import declick, dehum

    raw = file.file.read()
    audio, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)

    if effect == "declick":
        out = declick(audio, sensitivity=sensitivity, sr=sr)
    elif effect == "dehum":
        out = dehum(audio, base_freq=base_freq, sr=sr)
    elif effect == "dereverb":
        out = engine.dereverb(audio.T).T  # (samples, ch) <-> (ch, samples)
    else:
        raise HTTPException(400, "unknown effect")

    buf = io.BytesIO()
    sf.write(buf, np.clip(out, -1.0, 1.0), sr, format="WAV", subtype="PCM_16")
    return Response(content=buf.getvalue(), media_type="audio/wav")


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765)
