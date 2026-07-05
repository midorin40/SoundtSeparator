---
name: add-separation-model
description: SoundtSeparator の分離モデルを追加・差し替える手順 (MSSTフレームワークのモデル登録、チェックポイント入手先、依存の増やし方、パッチ方針)。BandIt v2 への移行や新しい Roformer 系の導入時に使う。
---

# 分離モデルの追加・差し替え手順

## モデルの探し方

1. `engine/msst/docs/pretrained_models.md` — MSST公式の学習済みモデル一覧 (config URL + weights URL が表になっている)
2. MVSEP や UVR コミュニティの新モデルも、MSST対応形式 (config yaml + ckpt) なら使える
3. モデルタイプは `engine/msst/utils/settings.py` の `get_model_from_config` にある分岐が対応一覧 (bandit, bandit_v2, bs_roformer, mel_band_roformer, htdemucs, mdx23c, scnet ...)

## 登録手順 (separator.py)

1. `XXX_CKPT = {"file", "url", "config", "type"}` 定数を追加
   - config が MSST リポジトリ内なら `os.path.join(MSST_DIR, "configs", ...)`
   - 外部 (HuggingFace等) なら models/ に置き `config_url` も指定 (自動DLされる)
2. 使用箇所で `model, config = self._get_msst(XXX_CKPT, progress_cb, "表示名")`
3. 実行は `self._run_msst(model, config, XXX_CKPT["type"], audio, frac_cb)` — 返り値は `{stem名: (ch, samples)}`
   - stem名は config の `training.instruments` / `target_instrument` で決まる。まず config を読んで確認する
4. 品質プリセットは `config.inference.num_overlap` の上書きで調整 (fast=2, standard=4, high=6 が目安)

## 新しい model_type の依存が足りないとき

1. まず対象モデルのコードの import を洗う:
   `Grep pattern="^(import|from)\s+\S+" path=engine/msst/models/<model>/`
2. 純Python依存は普通に `uv pip install --python .venv <pkg>`
3. torch に依存するパッケージは `--no-deps` で入れ、その依存を手で足す (torch 2.6.0+cu124 を壊さないため)
4. 学習専用の重い依存 (asteroid, pytorch_lightning, torchmetrics, torch_audiomentations 等) は**インストールせず、vendoredコードをパッチして回避する**のが本プロジェクトの方針:
   - 学習用 `__init__.py` を空にする / LightningModule 基底を nn.Module に差し替える
   - パッチには `NOTE (SoundtSeparator patch):` コメントを必ず付け、README の「MSSTへのパッチ」節に追記する

## チェックポイント読み込みの注意

- MSST系: `_load_state_dict_flexible` が state / state_dict / model_state_dict を自動アンラップ
- demucs系 (クラスごとpickle): `_load_demucs_checkpoint` を使う (torch 2.6 weights_only 対応)
- サイズ目安: BSRNN系 ~150MB, Roformer系 600〜900MB。初回DLは進捗メッセージを出す

## 検証

`/e2e-test` の手順で: 合成音源 → 各ステム shape 一致・成分の分類先が妥当・足し戻しで元音源に近いこと。
実素材での聴感確認はユーザーに依頼する (品質判断はユーザーが行う)。
