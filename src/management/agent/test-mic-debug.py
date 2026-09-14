import json, os, sys, wave, tempfile
import numpy as np
import sounddevice as sd
from vosk import Model, KaldiRecognizer

model_path = os.path.expanduser("~/models/vosk/vosk-model-small-en-us-0.15")
sec = int(sys.argv[1]) if len(sys.argv) > 1 else 5

model = Model(model_path)
DEV = 8
USE_SR = 48000
TARGET_SR = 16000

total = int(USE_SR * sec)
a = sd.rec(total, samplerate=USE_SR, channels=1, dtype='int16', device=DEV)
sd.wait()

flat = a.flatten()
raw_rms = float(np.sqrt(np.mean(flat.astype(np.float64) ** 2)))
peak = int(np.max(np.abs(flat)))

wav_path = os.path.join(tempfile.gettempdir(), "mic-debug.wav")
wf = wave.open(wav_path, "wb")
wf.setnchannels(1)
wf.setsampwidth(2)
wf.setframerate(USE_SR)
wf.writeframes(flat.tobytes())
wf.close()

per_sec = []
for s in range(sec):
    chunk = flat[s * USE_SR : (s+1) * USE_SR]
    if len(chunk) == 0:
        break
    rms = float(np.sqrt(np.mean(chunk.astype(np.float64) ** 2)))
    pk = int(np.max(np.abs(chunk)))
    nonzero = int(np.count_nonzero(chunk))
    per_sec.append({"sec": s, "rms": round(rms, 1), "peak": pk, "nonzero_pct": round(100*nonzero/len(chunk), 1)})

ds = flat[::3].astype(np.float64)
norm_max = max(float(peak), 1.0)
normed = (ds / norm_max) * 20000
boosted = np.clip(normed, -32768, 32767).astype(np.int16)

rec = KaldiRecognizer(model, TARGET_SR)
rec.AcceptWaveform(boosted.tobytes())
result = json.loads(rec.FinalResult())
text = result.get("text", "").strip()

print(json.dumps({
    "text": text,
    "raw_rms": round(raw_rms, 1),
    "peak": peak,
    "wav": wav_path,
    "per_sec": per_sec,
}, indent=2))
