import json, os, sys
import numpy as np
import sounddevice as sd
from vosk import Model, KaldiRecognizer

model_path = os.path.expanduser("~/models/vosk/vosk-model-small-en-us-0.15")
sec = int(sys.argv[1]) if len(sys.argv) > 1 else 3

model = Model(model_path)
TARGET_SR = 16000
USE_SR = 48000
DEV = 8

warmup = int(USE_SR * 0.3)
sd.rec(warmup, samplerate=USE_SR, channels=1, dtype='int16', device=DEV)
sd.wait()

total = int(USE_SR * sec)
a = sd.rec(total, samplerate=USE_SR, channels=1, dtype='int16', device=DEV)
sd.wait()

flat = a.flatten().astype(np.float64)
raw_rms = float(np.sqrt(np.mean(flat ** 2)))
raw_peak = int(np.max(np.abs(flat)))

ratio = USE_SR // TARGET_SR
ds = flat[::ratio]

noise_floor = np.percentile(np.abs(ds), 10)
threshold = max(noise_floor * 2.5, 30.0)

clean = np.where(np.abs(ds) > threshold, ds - np.sign(ds) * noise_floor, 0.0)

peak = float(np.max(np.abs(clean)))
if peak < 1.0:
    peak = 1.0
normed = (clean / peak) * 22000.0
boosted = np.clip(normed, -32768, 32767).astype(np.int16)

rec = KaldiRecognizer(model, TARGET_SR)
rec.AcceptWaveform(boosted.tobytes())
result = json.loads(rec.FinalResult())
text = result.get("text", "").strip()
b_rms = float(np.sqrt(np.mean(boosted.astype(np.float64) ** 2)))

print(json.dumps({"text": text, "raw_rms": round(raw_rms, 1), "raw_peak": raw_peak, "device": DEV, "nf": round(noise_floor, 1), "thr": round(threshold, 1)}))
