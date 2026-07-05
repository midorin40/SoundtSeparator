# coding: utf-8
"""範囲修復用のDSP処理 (RX風機能のローカル実装)。

- declick: クリック/リップノイズ除去。2階微分の外れ値検出 + 補間
- dehum:   ハムノイズ(電源由来 50/60Hz + 倍音)のノッチフィルタ除去
"""
import numpy as np
from scipy.signal import filtfilt, iirnotch


def declick(audio, sensitivity=0.5, sr=44100):
    """クリック・リップノイズ除去。

    audio: (samples, channels) float32
    sensitivity: 0.0(弱)〜1.0(強)。強いほど小さなクリックも検出する。

    2階微分の絶対値がMAD基準の閾値を超えるサンプルをクリックとみなし、
    前後の正常サンプルから線形補間で埋める。短いインパルス性ノイズ
    (マウスクリック音、リップノイズ、レコードのプチ音) に有効。
    """
    # 閾値係数: sensitivity 0→40 (鈍感) / 1→8 (敏感)
    k = 40.0 - 32.0 * float(np.clip(sensitivity, 0.0, 1.0))
    out = audio.copy()
    n = audio.shape[0]
    if n < 16:
        return out

    for c in range(audio.shape[1]):
        x = audio[:, c].astype(np.float64)
        d2 = np.abs(np.diff(x, 2))
        mad = np.median(d2) + 1e-12
        mask = np.zeros(n, dtype=bool)
        hit = d2 > k * mad
        # diff(2) はインデックスが2ずれるので両側に反映
        mask[1:-1] |= hit
        # クリック周辺に少し広げる (前後 ~0.7ms)
        widen = 32
        idx = np.flatnonzero(mask)
        if idx.size == 0:
            continue
        for i in idx:
            mask[max(0, i - widen):min(n, i + widen + 1)] = True
        good = ~mask
        if good.sum() < 2:
            continue
        pos = np.arange(n)
        out[:, c] = np.interp(pos, pos[good], x[good]).astype(np.float32)
    return out


def dehum(audio, base_freq=50.0, harmonics=6, sr=44100):
    """電源ハム除去。基本周波数とその倍音にノッチフィルタを適用する。

    audio: (samples, channels) float32
    base_freq: 50 (東日本/欧州) または 60 (西日本/北米)
    """
    out = audio.astype(np.float64)
    nyq = sr / 2
    for h in range(1, harmonics + 1):
        f0 = base_freq * h
        if f0 >= nyq * 0.95:
            break
        # 低次倍音ほど鋭く深く
        q = 30.0 + 5.0 * h
        b, a = iirnotch(f0, q, fs=sr)
        for c in range(out.shape[1]):
            out[:, c] = filtfilt(b, a, out[:, c])
    return out.astype(np.float32)
