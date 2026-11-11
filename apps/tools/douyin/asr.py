# Synapse 3 · 本机语音转写（faster-whisper；优先用完整下载的 small/base/tiny）
import os
import sys

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
from faster_whisper import WhisperModel

wav = sys.argv[1]
root = r"E:\BOT\data\models"
model_path = None
for name, min_size in (("small", 300 * 1024 * 1024), ("base", 100 * 1024 * 1024), ("tiny", 30 * 1024 * 1024)):
    p = os.path.join(root, name)
    mb = os.path.join(p, "model.bin")
    if os.path.exists(mb) and os.path.getsize(mb) > min_size:
        model_path = p
        break
if not model_path:
    model_path = os.environ.get("ASR_MODEL", "tiny")
model = WhisperModel(model_path, device="cpu", compute_type="int8")
segments, info = model.transcribe(wav, language="zh", vad_filter=True, beam_size=1)
print("".join(seg.text for seg in segments).strip())
