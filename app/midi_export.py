# coding: utf-8
"""MIDI書き出し。basic-pitch (Spotify, ONNX) によるローカルAI採譜。"""
import threading

_model = None
_lock = threading.Lock()


def audio_to_midi_bytes(wav_path, onset=0.5, frame=None, min_note_ms=120.0):
    """WAVファイルを採譜してMIDIバイト列を返す。"""
    import io

    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import Model, predict

    global _model
    with _lock:
        if _model is None:
            _model = Model(str(ICASSP_2022_MODEL_PATH))
        _, midi_data, _ = predict(
            wav_path,
            _model,
            onset_threshold=float(onset),
            frame_threshold=float(frame if frame is not None else max(0.1, onset - 0.2)),
            minimum_note_length=float(min_note_ms),
        )

    buf = io.BytesIO()
    midi_data.write(buf)
    return buf.getvalue()
