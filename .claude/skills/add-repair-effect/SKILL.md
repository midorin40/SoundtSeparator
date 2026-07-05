---
name: add-repair-effect
description: SoundtSeparator に新しい修復エフェクト・音声処理を追加する手順。範囲選択→処理→クロスフェード書き戻しのパターンに沿って、DSP実装からUIまでを一貫して組み込む。
---

# 修復エフェクト追加手順

「範囲を選択 → 対象トラックに処理を適用」型の機能は、以下の定型パターンで追加する。

## A. クライアントサイドで完結する軽い処理 (フェード・ゲイン系)

1. [app/static/app.js](../../../app/static/app.js) の `applyClientEffect(track, s, e, effect)` に分岐を追加
2. `applyRepair()` 冒頭の client-side 判定リスト (`effect === "fadein" || ...`) に追加
3. index.html の `#rp-effect` セレクトに `<option>` 追加、`REPAIR_NOTES` に説明文を追加

## B. サーバーサイドDSP (scipy/numpy 系)

1. [app/repair.py](../../../app/repair.py) に関数追加。シグネチャは `def myeffect(audio, param=..., sr=44100)`、audio は `(samples, channels) float32`、同shapeを返す
2. [app/server.py](../../../app/server.py) `/api/effect` の分岐に追加。パラメータは Form フィールドで受ける
3. index.html: `#rp-effect` に option、必要ならパラメータ行 (`rp-xxx-row`) を追加
4. app.js: `REPAIR_NOTES` に説明、`rp-effect` change ハンドラで行の表示切替、`applyRepair()` の FormData にパラメータ追加

## C. AIモデルを使う処理 (MSST系)

1. [app/separator.py](../../../app/separator.py) に `XXX_CKPT` 定数を追加 (file / url / config / config_url / type)。dereverb (DEREVERB_CKPT) が参考実装
2. `Engine` にメソッド追加。`self._get_msst(XXX_CKPT, ...)` でロード、`self._run_msst(...)` で実行 (進捗コールバック対応)。**`with self._lock:` を忘れない** (VRAM保護)
3. server.py `/api/effect` に分岐 (audio.T ↔ 転置に注意: engine は (ch, samples)、repair.py は (samples, ch))
4. UI は B と同じ

## 共通の約束事

- 書き戻しは applyRepair() が自動でやる: 選択範囲+前後1.5sコンテキストを送信 → 返却音声の選択範囲ぶんだけを10msクロスフェード+適用量(mix)でブレンド。**サーバー側は入力と同じ長さ・チャンネル数を返すだけでよい**
- 処理前に `pushUndo()` される (applyRepair内)。新たに呼ぶ必要はない
- 重い処理は flashInfo でユーザーに状況を伝える (初回モデルDLは分単位)
- 追加したら `/e2e-test` の手順で数値検証: 対象ノイズが減り、信号成分が不変であること
- モデル追加時は README.md の技術構成とモデル一覧も更新
