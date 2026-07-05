---
name: e2e-test
description: SoundtSeparator の分離・編集・修復機能をE2Eテストする手順。機能追加や修正の後に必ず実行する。テスト音源の合成、preview経由のUI操作、数値検証、後片付けまで。
---

# E2Eテスト手順

## 1. テスト音源の合成

聴感ではなく数値で検証できる合成音源を使う。

```powershell
# 正弦波+ノイズ (分離テスト用: ノイズ→効果音, 正弦波→ピアノ/BGM系に分類される)
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=8" -f lavfi -i "anoisesrc=duration=8:color=pink:amplitude=0.1" -filter_complex "[0][1]amix=inputs=2,aformat=channel_layouts=stereo" -ar 44100 app\static\test.wav

# 無音区間入り (無音カットテスト用: 3s音 + 2s無音 + 3s音)
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=3" -f lavfi -i "anullsrc=duration=2:sample_rate=44100" -f lavfi -i "sine=frequency=880:duration=3" -filter_complex "[0][1][2]concat=n=3:v=0:a=1,aformat=channel_layouts=stereo" -ar 44100 app\static\test.wav
```

クリック/ハム等の特殊ノイズは numpy で注入する (例は git 履歴 or CLAUDE.md 参照):
クリック=ランダム位置に短いインパルス加算、ハム=50Hz正弦波を混ぜる。

## 2. サーバー起動

preview_start (name: `sound-separator`)。サーバー側コード (server.py / separator.py / repair.py) を変更したら preview_stop → preview_start で再起動が必要。静的ファイル (app/static/) は F5 リロードだけでよい。

## 3. APIレベルのテスト (速い・確実)

```powershell
# 分離ジョブ投入 (mode: dme | music, quality: fast | standard | high)
curl.exe -s -F "file=@test.wav" -F "mode=dme" -F "quality=fast" http://127.0.0.1:8765/api/jobs
# ポーリング
curl -s http://127.0.0.1:8765/api/jobs/<id>
# 修復エフェクト
curl.exe -s -F "file=@test.wav" -F "effect=declick" -F "sensitivity=0.6" http://127.0.0.1:8765/api/effect -o out.wav -w "%{http_code}"
```

## 4. UIレベルのテスト (preview_eval)

ファイル入力UIは自動操作できないため、テストwavを `app/static/` に置いて JS から直接投入する:

```js
(async () => { const res = await fetch('/test.wav'); const blob = await res.blob();
  startJob(new File([blob], 'test.wav', {type: 'audio/wav'})); return 'started'; })()
```

編集機能は内部関数を直接呼んで検証する (UI操作をエミュレートするより確実):

```js
selection = {start: 2.0, end: 4.0}; setActiveTrack(1); renderSelection(); updateToolbar();
doCut();      // → duration() 不変・対象トラックのRMSが0になること
doPaste();    // 先に setActiveTrack(0) で貼り付け先を切替
doMove(0);    // 移動
doRippleDelete(); // → duration() が縮む
undo(); redo();
```

RMS計測ヘルパー:
```js
const rms = (ti, t0, t1) => { const s = Math.floor(t0*sampleRate), e = Math.floor(t1*sampleRate);
  let a = 0; const c = tracks[ti].chans[0]; for (let i = s; i < e; i++) a += c[i]*c[i];
  return Math.sqrt(a/(e-s)); };
```

注意: 編集後に配列参照 (`const c = tracks[i].chans[0]`) を跨いで使わない。undo/restore は配列を差し替えるため、計測のたびに取り直す。

## 5. 数値検証の観点

- 分離: 各ステムの shape が入力と一致、成分が期待ステムに集中 (RMS比較)
- 編集: 尺 (duration()) の変化有無が仕様通りか、非対象トラックが不変か
- フェード: 境界サンプルが中間値 (急峻な0でない) か
- declick: `np.abs(np.diff(x,2)).max()` が大幅減、正弦波部分は無傷
- dehum: FFTで50Hz帯パワー減・信号帯 (440Hz等) 不変
- ZIP: 先頭4byte = PK\x03\x04、Expand-Archive で実解凍して中身確認

## 6. 後片付け (必ず)

```powershell
Remove-Item -Force app\static\test*.wav, out*.wav, mk_*.py, chk_*.py -ErrorAction SilentlyContinue
Get-ChildItem output | ForEach-Object { Remove-Item -Recurse -Force $_.FullName }
```
