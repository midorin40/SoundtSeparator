# NOTE (SoundtSeparator patch): 元の __init__.py は学習用の LightningSystem を定義し、
# asteroid / pytorch_lightning / torchmetrics / torch_audiomentations を要求する。
# 推論では models.bandit.core.model のみ使うため空にしている。
# オリジナル: https://github.com/ZFTurbo/Music-Source-Separation-Training
