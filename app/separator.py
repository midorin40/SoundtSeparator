# coding: utf-8
"""音源分離エンジン。

2つの分離モードを提供する:

- dme:   映像・動画音声向け。話し声 / 効果音 / BGM の3ステム。
         BandIt Plus (MSST, DnR SDR 11.50) を使用。
         high 品質では CDX23 (Demucs4) 3モデルとのアンサンブル。
- music: 音楽向け。ボーカル / ドラム / ベース / ギター / ピアノ / その他 の6ステム。
         BS-Roformer (SDR 12.97) でボーカル抽出後、残りを htdemucs_6s で分割する多段構成。
"""
import os
import sys
import threading

import numpy as np
import torch

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MSST_DIR = os.path.join(BASE_DIR, "engine", "msst")
MODELS_DIR = os.path.join(BASE_DIR, "models")
sys.path.insert(0, MSST_DIR)

from demucs.apply import apply_model  # noqa: E402
from demucs.pretrained import get_model as demucs_get_model  # noqa: E402
from demucs.states import load_model as demucs_load_model  # noqa: E402

import utils.model_utils as msst_model_utils  # noqa: E402  (MSST)
from utils.model_utils import demix as msst_demix  # noqa: E402  (MSST)
from utils.settings import get_model_from_config  # noqa: E402  (MSST)

SAMPLE_RATE = 44100

# ---------------------------------------------------------------------------
# モデル定義
# ---------------------------------------------------------------------------
BANDIT_CKPT = {
    "file": "model_bandit_plus_dnr_sdr_11.47.chpt",
    "url": "https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/download/v.1.0.3/model_bandit_plus_dnr_sdr_11.47.chpt",
    "config": os.path.join(MSST_DIR, "configs", "config_dnr_bandit_bsrnn_multi_mus64.yaml"),
    "type": "bandit",
}
BSROFORMER_CKPT = {
    "file": "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
    "url": "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/model_bs_roformer_ep_317_sdr_12.9755.ckpt",
    "config": os.path.join(MSST_DIR, "configs", "viperx", "model_bs_roformer_ep_317_sdr_12.9755.yaml"),
    "type": "bs_roformer",
}
DEREVERB_CKPT = {
    "file": "dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt",
    "url": "https://huggingface.co/anvuew/dereverb_mel_band_roformer/resolve/main/dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt",
    "config": os.path.join(MODELS_DIR, "dereverb_mel_band_roformer_anvuew.yaml"),
    "config_url": "https://huggingface.co/anvuew/dereverb_mel_band_roformer/resolve/main/dereverb_mel_band_roformer_anvuew.yaml",
    "type": "mel_band_roformer",
}
KARAOKE_CKPT = {
    "file": "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt",
    "url": "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt",
    "config": os.path.join(MODELS_DIR, "config_mel_band_roformer_karaoke.yaml"),
    "config_url": "https://huggingface.co/shiromiya/audio-separation-models/resolve/main/mel_band_roformer_karaoke_aufr33_viperx/config_mel_band_roformer_karaoke.yaml",
    "type": "mel_band_roformer",
}
DRUMSEP_CKPT_FILE = "model_drumsep.th"
DRUMSEP_CKPT_URL = "https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/download/v1.0.5/model_drumsep.th"
CDX23_URL = "https://github.com/ZFTurbo/MVSEP-CDX23-Cinematic-Sound-Demixing/releases/download/v.1.0.0/"
CDX23_FILES = ["97d170e1-a778de4a.th", "97d170e1-dbb4db15.th", "97d170e1-e41a5468.th"]

# demucs チャンク処理 (進捗報告用の外部分割)
CHUNK_SECONDS = 40
CHUNK_OVERLAP_SECONDS = 4

# ---------------------------------------------------------------------------
# MSST demix の進捗を tqdm シムで取得する
# ---------------------------------------------------------------------------
_demix_progress_cb = None


class _CallbackPbar:
    def __init__(self, total=None, **kwargs):
        self.total = max(total or 1, 1)
        self.n = 0

    def update(self, n=1):
        self.n += n
        if _demix_progress_cb:
            _demix_progress_cb(min(self.n / self.total, 1.0))

    def close(self):
        pass


msst_model_utils.tqdm = _CallbackPbar


def _download(url, filename, progress_cb=None, label=""):
    os.makedirs(MODELS_DIR, exist_ok=True)
    path = os.path.join(MODELS_DIR, filename)
    if not os.path.isfile(path):
        if progress_cb:
            progress_cb(0, f"モデルをダウンロード中 ({label})...")
        torch.hub.download_url_to_file(url, path)
    return path


def _load_state_dict_flexible(model, path):
    sd = torch.load(path, map_location="cpu", weights_only=False)
    for key in ("state", "state_dict", "model_state_dict"):
        if isinstance(sd, dict) and key in sd:
            sd = sd[key]
    model.load_state_dict(sd)


class Engine:
    """全モデルを遅延ロード・キャッシュする分離エンジン。1ジョブずつ実行。"""

    def __init__(self):
        self._cache = {}
        self._lock = threading.Lock()
        self.device = "cuda:0" if torch.cuda.is_available() else "cpu"

    # ------------------------------------------------------------------ モデルロード
    def _get_msst(self, spec, progress_cb=None, label=""):
        key = spec["file"]
        if key not in self._cache:
            if "config_url" in spec and not os.path.isfile(spec["config"]):
                torch.hub.download_url_to_file(spec["config_url"], spec["config"])
            path = _download(spec["url"], spec["file"], progress_cb, label)
            if progress_cb:
                progress_cb(0, f"モデルを読み込み中 ({label})...")
            model, config = get_model_from_config(spec["type"], spec["config"])
            _load_state_dict_flexible(model, path)
            model = model.to(self.device).eval()
            self._cache[key] = (model, config)
        return self._cache[key]

    def _get_htdemucs6s(self, progress_cb=None):
        if "htdemucs_6s" not in self._cache:
            if progress_cb:
                progress_cb(0, "モデルをダウンロード中 (htdemucs_6s)...")
            model = demucs_get_model("htdemucs_6s")
            model.to(self.device).eval()
            self._cache["htdemucs_6s"] = model
        return self._cache["htdemucs_6s"]

    def _get_cdx23(self, progress_cb=None):
        if "cdx23" not in self._cache:
            models = []
            for f in CDX23_FILES:
                path = _download(CDX23_URL + f, f, progress_cb, "CDX23")
                model = _load_demucs_checkpoint(path)
                model.to(self.device).eval()
                models.append(model)
            self._cache["cdx23"] = models
        return self._cache["cdx23"]

    # ------------------------------------------------------------------ 分離 (公開API)
    def separate(self, audio, mode="dme", quality="standard", progress_cb=None):
        """audio: float32 ndarray (channels, samples) @44100Hz
        返り値: dict stem名 -> ndarray (channels, samples)
        """
        with self._lock:
            if mode == "music":
                return self._separate_music(audio, quality, progress_cb)
            return self._separate_dme(audio, quality, progress_cb)

    # ------------------------------------------------------------------ DME モード
    def _separate_dme(self, audio, quality, progress_cb):
        overlap = {"fast": 2, "standard": 4, "high": 6}.get(quality, 4)
        use_ensemble = quality == "high"

        model, config = self._get_msst(BANDIT_CKPT, progress_cb, "BandIt Plus")
        config.inference.num_overlap = overlap

        bandit_span = 0.55 if use_ensemble else 0.92

        def cb(frac):
            if progress_cb:
                pct = int(100 * frac * bandit_span)
                progress_cb(pct, f"分離処理中 (BandIt Plus)... ({pct}%)")

        res = self._run_msst(model, config, BANDIT_CKPT["type"], audio, cb)
        stems = {
            "dialog": res["speech"],
            "effect": res["effects"],
            "music": res["music"],
        }

        if use_ensemble:
            cdx = self._separate_cdx23(audio, progress_cb, base_pct=55, span=40)
            for k in stems:
                n = min(stems[k].shape[1], cdx[k].shape[1], audio.shape[1])
                stems[k] = 0.6 * stems[k][:, :n] + 0.4 * cdx[k][:, :n]

        return stems

    def _separate_cdx23(self, audio, progress_cb, base_pct=0, span=90):
        models = self._get_cdx23(progress_cb)
        out = _chunked_demucs(
            models, audio, self.device, overlap=0.75,
            progress_cb=(lambda f: progress_cb(
                int(base_pct + span * f), f"分離処理中 (アンサンブル)... ({int(base_pct + span * f)}%)"
            )) if progress_cb else None,
        )
        # CDX23 の出力順: 0=music, 1=effect, 2=dialog
        return {"dialog": out[2], "effect": out[1], "music": out[0]}

    # ------------------------------------------------------------------ 音楽モード
    def _separate_music(self, audio, quality, progress_cb):
        rof_overlap = {"fast": 2, "standard": 4, "high": 6}.get(quality, 4)
        dem_overlap = {"fast": 0.25, "standard": 0.55, "high": 0.8}.get(quality, 0.55)

        # --- stage 1: BS-Roformer でボーカル抽出 ---
        model, config = self._get_msst(BSROFORMER_CKPT, progress_cb, "BS-Roformer")
        config.inference.num_overlap = rof_overlap

        def cb1(frac):
            if progress_cb:
                pct = int(50 * frac)
                progress_cb(pct, f"ボーカルを分離中 (BS-Roformer)... ({pct}%)")

        res = self._run_msst(model, config, BSROFORMER_CKPT["type"], audio, cb1)
        vocals = res["vocals"][:, : audio.shape[1]]
        if vocals.shape[1] < audio.shape[1]:
            vocals = np.pad(vocals, ((0, 0), (0, audio.shape[1] - vocals.shape[1])))
        instrumental = audio - vocals

        # --- stage 2: 残りを htdemucs_6s で楽器分割 ---
        model6 = self._get_htdemucs6s(progress_cb)

        def cb2(frac):
            if progress_cb:
                pct = int(50 + 45 * frac)
                progress_cb(pct, f"楽器を分離中 (Demucs 6stem)... ({pct}%)")

        out = _chunked_demucs([model6], instrumental, self.device, overlap=dem_overlap, progress_cb=cb2)
        # htdemucs_6s の出力順: drums, bass, other, vocals, guitar, piano
        idx = {name: i for i, name in enumerate(model6.sources)}
        stems = {
            "vocals": vocals,
            "drums": out[idx["drums"]],
            "bass": out[idx["bass"]],
            "guitar": out[idx["guitar"]],
            "piano": out[idx["piano"]],
            # 段間の残留ボーカルは "その他" に合算して完全再構成を保つ
            "other": out[idx["other"]] + out[idx["vocals"]],
        }
        return stems

    # ------------------------------------------------------------------ トラックの追加分離
    def subseparate(self, audio, kind, progress_cb=None):
        """既存トラックをさらに分離する。
        kind="drums":  kick / snare / cymbals / toms (DrumSep htdemucs)
        kind="vocals": lead / back (MelBand Roformer Karaoke)
        audio: (channels, samples) → dict stem名 -> (channels, samples)
        """
        with self._lock:
            if kind == "drums":
                if "drumsep" not in self._cache:
                    path = _download(DRUMSEP_CKPT_URL, DRUMSEP_CKPT_FILE, progress_cb, "DrumSep")
                    if progress_cb:
                        progress_cb(0, "モデルを読み込み中 (DrumSep)...")
                    model = _load_demucs_checkpoint(path)
                    model.to(self.device).eval()
                    self._cache["drumsep"] = model
                model = self._cache["drumsep"]

                def cb(frac):
                    if progress_cb:
                        progress_cb(int(100 * frac), f"ドラムを細分化中... ({int(100 * frac)}%)")

                out = _chunked_demucs([model], audio, self.device, overlap=0.55, progress_cb=cb)
                # DrumSep のソース名はスペイン語 (bombo=キック, redoblante=スネア, platillos=シンバル)
                name_map = {"bombo": "kick", "redoblante": "snare", "platillos": "cymbals", "toms": "toms"}
                return {name_map.get(name, name): out[i] for i, name in enumerate(model.sources)}

            if kind == "vocals":
                model, config = self._get_msst(KARAOKE_CKPT, progress_cb, "Karaoke Roformer")

                def cb(frac):
                    if progress_cb:
                        progress_cb(int(100 * frac), f"リード/バックを分離中... ({int(100 * frac)}%)")

                res = self._run_msst(model, config, KARAOKE_CKPT["type"], audio, cb)
                # target: karaoke = 入力からリードボーカルを除いたもの
                # (ボーカルステムに適用した場合 ≈ バックボーカル)
                back = res["karaoke"][:, : audio.shape[1]]
                if back.shape[1] < audio.shape[1]:
                    back = np.pad(back, ((0, 0), (0, audio.shape[1] - back.shape[1])))
                lead = audio - back
                return {"lead": lead, "back": back}

            raise ValueError(f"unknown subseparate kind: {kind}")

    # ------------------------------------------------------------------ リバーブ除去
    def dereverb(self, audio, progress_cb=None):
        """audio: (channels, samples) → リバーブ除去済み (channels, samples)"""
        with self._lock:
            model, config = self._get_msst(DEREVERB_CKPT, progress_cb, "Dereverb Roformer")

            def cb(frac):
                if progress_cb:
                    progress_cb(int(100 * frac), "リバーブ除去中...")

            res = self._run_msst(model, config, DEREVERB_CKPT["type"], audio, cb)
            out = res["noreverb"][:, : audio.shape[1]]
            if out.shape[1] < audio.shape[1]:
                out = np.pad(out, ((0, 0), (0, audio.shape[1] - out.shape[1])))
            return out

    # ------------------------------------------------------------------ MSST 実行
    def _run_msst(self, model, config, model_type, audio, frac_cb):
        global _demix_progress_cb
        _demix_progress_cb = frac_cb
        try:
            mix = torch.from_numpy(audio)
            res = msst_demix(config, model, mix, self.device, model_type, pbar=True)
        finally:
            _demix_progress_cb = None
        return {k: v.astype(np.float32) for k, v in res.items()}


def _load_demucs_checkpoint(path):
    """PyTorch 2.6+ は weights_only=True が既定でこのチェックポイント
    (HTDemucsクラスをpickle) を読めないため、一時的に既定を戻して読み込む。
    モデルは ZFTurbo の GitHub リリース (固定URL) 由来のみ。"""
    orig_load = torch.load

    def patched(*args, **kwargs):
        kwargs.setdefault("weights_only", False)
        return orig_load(*args, **kwargs)

    torch.load = patched
    try:
        return demucs_load_model(path)
    finally:
        torch.load = orig_load


def _chunked_demucs(models, audio, device, overlap=0.55, progress_cb=None):
    """demucs系モデル(複数ならアンサンブル平均)をチャンク+クロスフェードで適用。
    返り値: ndarray (stems, channels, samples)"""
    n_sources = len(models[0].sources)
    n_samples = audio.shape[1]
    chunk = CHUNK_SECONDS * SAMPLE_RATE
    hop = chunk - CHUNK_OVERLAP_SECONDS * SAMPLE_RATE

    starts = list(range(0, max(n_samples - CHUNK_OVERLAP_SECONDS * SAMPLE_RATE, 1), hop))
    if not starts:
        starts = [0]

    out = np.zeros((n_sources, audio.shape[0], n_samples), dtype=np.float32)
    weight = np.zeros(n_samples, dtype=np.float32)

    total_steps = len(starts) * len(models)
    step = 0
    for si, start in enumerate(starts):
        end = min(start + chunk, n_samples)
        seg = audio[:, start:end]
        seg_t = torch.from_numpy(np.expand_dims(seg, 0)).float().to(device)

        seg_outs = []
        for model in models:
            with torch.no_grad():
                res = apply_model(model, seg_t, shifts=1, overlap=overlap)[0].cpu().numpy()
            seg_outs.append(res)
            step += 1
            if progress_cb:
                progress_cb(step / total_steps)
        seg_out = np.mean(seg_outs, axis=0)

        # 三角窓でクロスフェード合成
        w = np.ones(end - start, dtype=np.float32)
        fade = CHUNK_OVERLAP_SECONDS * SAMPLE_RATE
        if si > 0:
            ramp = min(fade, end - start)
            w[:ramp] = np.linspace(0.0, 1.0, ramp, dtype=np.float32)
        if start + chunk < n_samples:
            ramp = min(fade, end - start)
            w[-ramp:] = np.minimum(w[-ramp:], np.linspace(1.0, 0.0, ramp, dtype=np.float32))
        out[:, :, start:end] += seg_out * w
        weight[start:end] += w

    weight = np.maximum(weight, 1e-8)
    out /= weight
    return out


engine = Engine()
