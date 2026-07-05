# coding: utf-8
"""セリフ書き出しエンジン。

Whisper (ローカル) で音声トラックを文字起こしし、セリフ単位で
- 連番WAVクリップ (clips/0001.wav ...)
- SRT字幕 (subtitles.srt)
- TTS学習用テキスト (metadata.csv — LJSpeech形式 `ファイル名|テキスト`)
- アノテーション (annotations.json / annotations.csv — 開始/終了/長さ/テキスト)
を生成して ZIP にまとめる。
"""
import csv
import json
import os
import threading
import zipfile

import numpy as np
import soundfile as sf
import torch

MODELS = {"small": "small", "medium": "medium", "large": "large-v3"}
CLIP_PAD_SECONDS = 0.15  # セリフ前後の余白
FADE_SECONDS = 0.01


class Transcriber:
    def __init__(self):
        self._models = {}
        self._lock = threading.Lock()
        self.device = "cuda" if torch.cuda.is_available() else "cpu"

    def _get_model(self, size, progress_cb=None):
        import whisper

        name = MODELS.get(size, "medium")
        if name not in self._models:
            if progress_cb:
                progress_cb(0, f"音声認識モデルをダウンロード/読込中 (Whisper {name})...")
            self._models[name] = whisper.load_model(name, device=self.device)
        return self._models[name]

    def transcribe(self, audio, sr, model_size="medium", language=None, progress_cb=None):
        """audio: (samples, channels) float32
        返り値: (segments [{start,end,text}], words [{start,end,word}], 言語)"""
        with self._lock:
            model = self._get_model(model_size, progress_cb)
            mono = audio.mean(axis=1).astype(np.float32)

            # Whisper は 16kHz 前提。librosa より軽い線形補間で十分 (認識用途)
            import whisper.audio as wa

            if sr != wa.SAMPLE_RATE:
                n_out = int(len(mono) * wa.SAMPLE_RATE / sr)
                x_old = np.linspace(0, 1, len(mono), dtype=np.float64)
                x_new = np.linspace(0, 1, n_out, dtype=np.float64)
                mono16 = np.interp(x_new, x_old, mono).astype(np.float32)
            else:
                mono16 = mono

            if progress_cb:
                progress_cb(10, "文字起こし中... (長さによっては数分かかります)")
            result = model.transcribe(
                mono16,
                language=language or None,
                fp16=self.device == "cuda",
                verbose=None,
                word_timestamps=True,
            )

        segments = []
        words = []
        for seg in result.get("segments", []):
            text = seg["text"].strip()
            if text:
                segments.append({
                    "start": round(float(seg["start"]), 3),
                    "end": round(float(seg["end"]), 3),
                    "text": text,
                })
            for w in seg.get("words", []):
                words.append({
                    "start": round(float(w["start"]), 3),
                    "end": round(float(w["end"]), 3),
                    "word": w["word"],
                })
        return segments, words, result.get("language", language or "")


_SENTENCE_END = ("。", "．", ".", "!", "?", "！", "？")


def segment_words(words, min_len=2.0, max_len=10.0, gap_split=0.6):
    """単語タイムスタンプから、min_len〜max_len 秒に収まるセリフ区間を組み立てる。

    優先順位: 文末記号での区切り > 無音ギャップ > 単語境界での強制分割。
    テキストは単語境界で正しく分割されるため TTS/RVC の学習データに安全。
    """
    if not words:
        return []

    # --- 1) 文候補に分割 (文末記号 or ギャップ) ---
    sentences = []
    cur = [words[0]]
    for prev, w in zip(words, words[1:]):
        if prev["word"].strip().endswith(_SENTENCE_END) or (w["start"] - prev["end"]) >= gap_split:
            sentences.append(cur)
            cur = [w]
        else:
            cur.append(w)
    sentences.append(cur)

    # --- 2) max_len を超える文は中央付近の最大ギャップで再帰分割 ---
    def split_long(ws):
        dur = ws[-1]["end"] - ws[0]["start"]
        if dur <= max_len or len(ws) < 2:
            return [ws]
        best_gap, best_i = -1.0, None
        for i in range(1, len(ws)):
            pos = ws[i]["start"] - ws[0]["start"]
            if pos < dur * 0.2 or pos > dur * 0.8:
                continue
            gap = ws[i]["start"] - ws[i - 1]["end"]
            if gap > best_gap:
                best_gap, best_i = gap, i
        if best_i is None:
            best_i = len(ws) // 2
        return split_long(ws[:best_i]) + split_long(ws[best_i:])

    sentences = [part for s in sentences for part in split_long(s)]

    # --- 3) min_len に満たない文は隣と結合 (max_len を超えない範囲で) ---
    chunks = []
    for s in sentences:
        if chunks:
            last = chunks[-1]
            gap = s[0]["start"] - last[-1]["end"]
            combined = s[-1]["end"] - last[0]["start"]
            last_dur = last[-1]["end"] - last[0]["start"]
            cur_dur = s[-1]["end"] - s[0]["start"]
            if combined <= max_len and (last_dur < min_len or cur_dur < min_len or gap < 0.3):
                last.extend(s)
                continue
        chunks.append(list(s))

    # --- 4) それでも min_len 未満の断片は、隣接チャンクと結合 (max_len の1割超過まで許容) ---
    tolerance = max_len * 1.1
    i = 0
    while i < len(chunks):
        dur = chunks[i][-1]["end"] - chunks[i][0]["start"]
        if dur >= min_len or len(chunks) < 2:
            i += 1
            continue
        prev_ok = i > 0 and (chunks[i][-1]["end"] - chunks[i - 1][0]["start"]) <= tolerance
        next_ok = i < len(chunks) - 1 and (chunks[i + 1][-1]["end"] - chunks[i][0]["start"]) <= tolerance
        if next_ok:  # 前方結合を優先 (次のセリフの頭に付ける方が自然)
            chunks[i + 1] = chunks[i] + chunks[i + 1]
            chunks.pop(i)
        elif prev_ok:
            chunks[i - 1].extend(chunks[i])
            chunks.pop(i)
        else:
            i += 1  # 結合先がない場合はそのまま (UI側で⚠表示)

    segments = []
    for c in chunks:
        text = "".join(w["word"] for w in c).strip()
        if not text:
            continue
        segments.append({
            "start": round(c[0]["start"], 3),
            "end": round(c[-1]["end"], 3),
            "text": text,
        })
    return segments


def _fmt_srt_time(t):
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def export_dialogue(audio, sr, segments, out_dir, base_name="dialogue",
                    make_clips=True, make_srt=True, make_tts=True, mono_clips=True):
    """segments からセリフ別クリップ・SRT・TTSメタデータ・アノテーションを生成し、ZIPのパスを返す。

    audio: (samples, channels) float32 (編集済みトラック)
    """
    os.makedirs(out_dir, exist_ok=True)
    clips_dir = os.path.join(out_dir, "clips")
    n_samples = audio.shape[0]
    fade = int(FADE_SECONDS * sr)

    annotations = []
    clip_files = []

    if make_clips:
        os.makedirs(clips_dir, exist_ok=True)
    for i, seg in enumerate(segments, start=1):
        s = max(0, int((seg["start"] - CLIP_PAD_SECONDS) * sr))
        e = min(n_samples, int((seg["end"] + CLIP_PAD_SECONDS) * sr))
        if e - s < int(0.05 * sr):
            continue
        fname = f"{base_name}_{i:04d}.wav"
        if make_clips:
            clip = audio[s:e].copy()
            if mono_clips and clip.shape[1] > 1:
                clip = clip.mean(axis=1, keepdims=True)
            f = min(fade, len(clip) // 2)
            if f > 0:
                ramp = np.linspace(0, 1, f, dtype=np.float32)[:, None]
                clip[:f] *= ramp
                clip[-f:] *= ramp[::-1]
            sf.write(os.path.join(clips_dir, fname), np.clip(clip, -1, 1), sr, subtype="PCM_16")
            clip_files.append(fname)
        annotations.append({
            "index": i,
            "file": fname if make_clips else None,
            "start": seg["start"],
            "end": seg["end"],
            "duration": round(seg["end"] - seg["start"], 3),
            "text": seg["text"],
        })

    if make_srt:
        with open(os.path.join(out_dir, "subtitles.srt"), "w", encoding="utf-8-sig") as f:
            for i, seg in enumerate(segments, start=1):
                f.write(f"{i}\n{_fmt_srt_time(seg['start'])} --> {_fmt_srt_time(seg['end'])}\n{seg['text']}\n\n")

    if make_tts:
        # LJSpeech 形式: ファイル名(拡張子なし)|テキスト
        with open(os.path.join(out_dir, "metadata.csv"), "w", encoding="utf-8", newline="") as f:
            for a in annotations:
                if a["file"]:
                    f.write(f"{os.path.splitext(a['file'])[0]}|{a['text']}\n")

    with open(os.path.join(out_dir, "annotations.json"), "w", encoding="utf-8") as f:
        json.dump(annotations, f, ensure_ascii=False, indent=2)
    with open(os.path.join(out_dir, "annotations.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["index", "file", "start", "end", "duration", "text"])
        for a in annotations:
            w.writerow([a["index"], a["file"] or "", a["start"], a["end"], a["duration"], a["text"]])

    zip_path = os.path.join(out_dir, "dialogue_export.zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _, files in os.walk(out_dir):
            for name in files:
                if name == "dialogue_export.zip":
                    continue
                full = os.path.join(root, name)
                zf.write(full, os.path.relpath(full, out_dir))
    return zip_path, annotations


transcriber = Transcriber()
