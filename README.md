# Sound Separator 🎛️

音声・動画ファイルをAIでステム分離し、そのままブラウザ上で編集・修復できる**完全ローカル**のWebアプリ。
ファイルは一切外部に送信されません。

![エディタ画面](docs/screenshots/editor.png)

## 特徴

- 🎬 **映像・動画音声の3ステム分離** — 話し声 / 効果音 / BGM（BandIt Plus, DnR SDR 11.50）
- 🎸 **音楽の6ステム分離** — ボーカル / ドラム / ベース / ギター / ピアノ / その他（BS-Roformer → htdemucs_6s 多段パイプライン）
- ✂️ **波形編集** — カット / コピー / ステム間の移動・貼り付け / 詰め削除 / Undo・Redo
- 🔧 **RX風の範囲修復** — クリック・リップノイズ除去 / リバーブ除去(AI) / ハム除去 / ノイズプロファイル除去
- 🎨 色分け波形・同期再生・ミュート/ソロ・トラック追加/リネーム
- 📦 編集内容を反映した WAV / ZIP 書き出し

![アップロード画面](docs/screenshots/upload.png)

## 動作環境

| | 必要 | 推奨 |
|---|---|---|
| OS | Windows 10/11 64bit | Windows 11 |
| GPU | NVIDIA (VRAM 6GB) ※CPUのみでも動くが数十倍遅い | RTX 3080 / 4070 以上 (VRAM 12GB+) |
| RAM | 16GB | 32GB |
| ディスク | 約12GB (venv ~6GB + モデル ~2GB + 作業領域) | SSD |
| その他 | [uv](https://docs.astral.sh/uv/)・[ffmpeg](https://ffmpeg.org/) が PATH にあること | |

参考: RTX 4090 では8秒の音声を標準品質で約2〜5秒で分離します。

## セットアップ

```
git clone https://github.com/midorin40/SoundtSeparator.git
cd SoundtSeparator
setup.bat        ← ダブルクリックでも可 (venv作成 + 依存インストール)
```

AIモデル（合計 約2GB）は**初回使用時に自動ダウンロード**されます（進捗はUIに表示）。

## 起動

`run.bat` をダブルクリック → ブラウザで http://127.0.0.1:8765 が開きます。

## 使い方

### 1. 分離

1. モード（🎬映像・動画音声 / 🎸音楽）を選ぶ
2. ファイルをドロップ（WAV / MP3 / FLAC / M4A / MP4 / MKV など。動画は音声を自動抽出）
3. 品質を選ぶ
   - **高速** … プレビュー向き
   - **標準** … 通常はこれで十分
   - **高品質** … 数倍時間。映像モードでは CDX23 (Demucs4×3) とのアンサンブル

### 2. 確認・ミックス

- 色分けされた波形で表示。**M**=ミュート / **S**=ソロ / スライダで音量
- 「元音源」トラックはA/B比較用（初期ミュート）
- 波形クリックでシーク、Space で再生/停止

### 3. 編集（ドラッグで範囲選択 → ドラッグしたトラックが編集対象）

| 操作 | 動作 | ショートカット |
|---|---|---|
| ✂ カット | 選択トラックから切り取り（その場は無音、尺不変） | Ctrl+X |
| ⧉ コピー / ⇥ 貼り付け | 貼り付け先トラックをクリックして選び、**元と同じ時間位置**にミックス | Ctrl+C / Ctrl+V |
| ➜ 移動先… | 分類ミスの修正。選択範囲を別トラックへワンクリック移動（例: 効果音に入ったため息を話し声へ） | |
| 🧹 除去 | いらない音をその場で消す（尺・クリップボード不変） | Delete |
| ⌦ 詰め削除 | 全トラックから削除して前後を詰める（尺が縮む） | Shift+Delete |
| ✁ 無音カット | しきい値・最小長を指定して無音区間を自動削除 | |
| ↶↷ Undo / Redo | 8段階 | Ctrl+Z / Ctrl+Y |

すべての編集境界には10msのフェードが自動で入り、クリックノイズを防ぎます。

### 4. 修復（🔧 修復パネル・選択範囲に適用）

- **クリック / リップノイズ除去** — インパルス検出+補間（感度調整可）
- **リバーブ除去** — AIモデル（初回 約900MB DL）
- **ハムノイズ除去** — 50/60Hz+倍音のノッチフィルタ
- **フェードイン / フェードアウト / ノーマライズ(-1dB)**
- **〜 ノイズ除去** — ノイズだけの区間を選択→プロファイル学習→トラック全体から除去

### 5. 書き出し

- トラックごとの⬇ボタンでWAV保存、「全ステム保存 (ZIP)」で一括
- **編集内容がそのまま反映されます**

## 使用モデル

| 用途 | モデル | サイズ (自動DL) |
|---|---|---|
| 話し声/効果音/BGM | [BandIt Plus](https://github.com/ZFTurbo/Music-Source-Separation-Training) (DnR SDR 11.50) | 142MB |
| ボーカル抽出 | BS-Roformer viperx ep317 (SDR 12.97) | 610MB |
| 楽器6分割 | htdemucs_6s | ~170MB |
| 高品質アンサンブル | [MVSEP-CDX23](https://github.com/ZFTurbo/MVSEP-CDX23-Cinematic-Sound-Demixing) ×3 | 153MB |
| リバーブ除去 | [anvuew MelBand Roformer](https://huggingface.co/anvuew/dereverb_mel_band_roformer) (SDR 19.17) | 913MB |

各モデルのライセンス・利用条件は配布元を確認してください。

## 技術構成

- バックエンド: Python 3.11 / FastAPI / PyTorch 2.6 (CUDA 12.4)
- 分離エンジン: [Music-Source-Separation-Training](https://github.com/ZFTurbo/Music-Source-Separation-Training) (MSST) フレームワーク — `engine/msst/` に推論用軽量化パッチ込みで同梱
- DSP修復: numpy / scipy（declick=微分外れ値検出+補間, dehum=iirnotch）、ノイズ除去: noisereduce
- フロントエンド: Vanilla JS + Web Audio API + Canvas（ライブラリ不使用。編集・WAVエンコード・ZIP生成もクライアントサイド）

```
SoundtSeparator/
├── setup.bat / run.bat   … セットアップ / 起動
├── app/
│   ├── server.py         … FastAPI (ジョブ管理 / denoise / effect API)
│   ├── separator.py      … 分離エンジン (モデル遅延ロード+キャッシュ)
│   ├── repair.py         … DSP修復
│   └── static/           … フロントエンド
├── engine/msst/          … MSST フレームワーク (パッチ済み同梱)
├── models/               … モデルチェックポイント (自動DL・git管理外)
└── output/               … 分離結果 (git管理外)
```

### MSST への加えたパッチ

推論に不要な学習用依存 (asteroid / pytorch_lightning など) を避けるため:

- `engine/msst/models/bandit/core/__init__.py` … 学習用コードを空に
- `engine/msst/models/bandit/core/model/bsrnn/wrapper.py` … LightningModule → nn.Module
