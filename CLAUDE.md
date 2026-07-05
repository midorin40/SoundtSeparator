# SoundtSeparator 開発ガイド

ローカル音源分離 + 波形編集 Webアプリ。ユーザーは日本語話者。UI・コメント・コミュニケーションはすべて日本語。

## アーキテクチャ

```
run.bat → .venv\Scripts\python.exe app\server.py → http://127.0.0.1:8765
```

| ファイル | 役割 |
|---|---|
| [app/server.py](app/server.py) | FastAPI。ジョブ管理(メモリ内dict+ポーリング)。API: /api/jobs(分離), /api/subseparate, /api/dialogue-export, /api/denoise, /api/effect, /api/midi |
| [app/separator.py](app/separator.py) | 分離エンジン。全AIモデルの遅延ロード+キャッシュ。1ジョブずつ実行(_lock) |
| [app/repair.py](app/repair.py) | DSP修復 (declick=微分外れ値+補間, dehum=ノッチフィルタ) |
| [app/transcriber.py](app/transcriber.py) | Whisper文字起こし、単語タイムスタンプからのクリップ長調整(segment_words)、話者分離(assign_speakers=resemblyzer+階層クラスタリング)、セリフ書き出し(export_dialogue) |
| [app/midi_export.py](app/midi_export.py) | basic-pitch (ONNX) によるAI採譜→MIDI |
| [app/static/app.js](app/static/app.js) | UI全部。波形/スペクトログラムCanvas、Web Audio再生+レベルメーター、編集(全てクライアントサイド)、WAV/ZIP/.ssproj読み書き |
| engine/msst/ | ZFTurbo MSST フレームワーク(clone)。**推論用に軽量化パッチ済み(下記)** |
| models/ | チェックポイント自動DL先 |

**重要: FastAPIの重い処理は `async def` でなく `def` にする** (asyncで同期処理するとイベントループ全体が固まり全リクエストがブロックされる。/api/denoise・/api/effect・/api/midi は sync def)。

### 使用モデル (separator.py の *_CKPT 定数)

- DME(話し声/効果音/BGM): BandIt Plus。high品質時は CDX23 Demucs4×3 と 0.6/0.4 アンサンブル
- 音楽6ステム: BS-Roformer(ボーカル) → htdemucs_6s(残り)。残留ボーカルは other に合算し完全再構成を維持
- リバーブ除去: anvuew MelBand Roformer (target: noreverb)
- 追加分離(subseparate): drums=DrumSep htdemucs (ソース名はスペイン語→英語にマップ) / vocals=Karaoke MelBand Roformer (target: karaoke=バック側, lead=引き算)

### フロントエンドの編集モデル (app.js)

- トラック実体は `tracks[i].chans` (Float32Array[ch])。AudioBuffer は再生時に生成(invalidateBuffers で無効化)
- 編集の設計思想: **カット=移動用(クリップボード上書き) / 除去=その場消し(クリップボード不変) / 詰め削除=全トラック連動で尺短縮**
- 貼り付け・移動は常に「元と同じ時間位置」へミックス加算 (タイミングを守るのが仕様)
- 全編集境界に FADE_SAMPLES(10ms) のフェード必須 — クリックノイズ防止。新しい編集操作を作るときも必ず入れる
- Undo はチャンネルデータ全コピー8段。**トラック追加/削除時は undoStack/redoStack をクリアする**(スナップショットがトラック数前提のため)
- サーバー処理系(denoise/effect)は「選択範囲+前後1.5sコンテキスト」をWAVで送り、返ってきた同尺の音声から選択範囲だけをクロスフェードで書き戻す。トラック全体系(loudnorm/pitchshift/tempo)は全体を送って差し替え。tempoのみ全トラック連動(尺が変わるため)
- 表示: viewStart/viewDur でズーム状態を持ち、描画は track.baseCanvas(オフスクリーン)に一度描いて再生時は明暗2層で合成。スペクトログラムは自前radix-2 FFT+対数周波数軸
- 音量は volumeDb (dB) が正、track.volume はその線形換算。メーターは gainNode→AnalyserNode のタップ+masterGain 集約
- プロジェクト保存(.ssproj)= project.json+track_N.wav の無圧縮ZIP。makeZip/parseZip (自作・store方式のみ対応)
- **非表示タブでは rAF が発火しない** — 初期描画は drawTrack 冒頭の baseCanvas ガードで保険。テストは前面タブで行う

## 環境の注意点 (ハマりどころ)

- venv は **uv の Python 3.11** (`uv venv --python 3.11 .venv`)。システムPythonは3.13だが互換性のため使わない
- torch は 2.6.0+cu124。**`audio-separator` は絶対に入れない** — torchをCPU版に置換しようとする
- 依存追加は `uv pip install --python .venv <pkg>`。torch依存のパッケージは `--no-deps` で入れて純Python依存を手動追加 (例: rotary-embedding-torch)
- torch 2.6+ の weights_only=True 既定: demucs系チェックポイントは separator.py の `_load_demucs_checkpoint` でのみ読む
- Pythonスクリプト実行時は `$env:PYTHONIOENCODING="utf-8"` (日本語出力の文字化け防止)
- MSSTへのパッチ (git pull で消えるので注意):
  - `engine/msst/models/bandit/core/__init__.py` → 空 (asteroid/pytorch_lightning回避)
  - `engine/msst/models/bandit/core/model/bsrnn/wrapper.py` → LightningModule を nn.Module に
- MSST demix の進捗は `utils.model_utils.tqdm` のモンキーパッチ (separator.py `_CallbackPbar`) で取得
- torch非依存を装う要注意パッケージの実績: openai-whisper / basic-pitch / resemblyzer は `--no-deps` で入れ、純Python依存(tiktoken, more-itertools, pretty_midi, resampy, onnxruntime, mir_eval, webrtcvad-wheels)を手動追加。webrtcvad は本家でなく **webrtcvad-wheels** を使う (py3.11 wheelがあるのはこちら)
- **git push が固まったら**: GCMトークン失効で認証ダイアログ待ち。`Start-Process cmd '/c git push'` で対話ウィンドウを出してユーザーにサインインしてもらう。リモート確認は git fetch でなく GitHub API (認証不要)
- jarredou/models リポジトリは消滅済み (MSST docs内のDrumSep mdx23cリンクは404)。DrumSepはhtdemucs版(ZFTurbo release v1.0.5)、karaoke configはHF shiromiya/audio-separation-models を使用

## テスト方法

`.claude/skills/e2e-test/SKILL.md` に手順詳細。要点:

1. テスト音源は ffmpeg lavfi か numpy で合成 (`sine=frequency=440:duration=8` + anoisesrc 等)
2. サーバーは preview_start (name: sound-separator, .claude/launch.json 定義済み)
3. UIテスト: テストwavを app/static/ に置き、preview_eval で `startJob(new File([blob], ...))` を直接呼ぶ
4. 検証は数値で: RMS・FFT帯域パワー・2階微分最大値など (聴感に頼らない)
5. 終わったら app/static/ のテストwav と output/ 配下を削除

## 機能追加の定型手順

- 修復エフェクト追加: `.claude/skills/add-repair-effect/SKILL.md`
- 分離モデル追加/差し替え: `.claude/skills/add-separation-model/SKILL.md`
