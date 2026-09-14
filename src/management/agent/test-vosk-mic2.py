import json, wave, os, numpy as np
from vosk import Model, KaldiRecognizer

model = Model(os.path.expanduser("~/models/vosk/vosk-model-small-en-us-0.15"))
wav_path = os.path.join(os.environ["TEMP"], "mic-debug.wav")

wf = wave.open(wav_path, 'rb')
sr = wf.getframerate()
n = wf.getnframes()
data = wf.readframes(n)
wf.close()

arr = np.frombuffer(data, dtype=np.int16)

# Downsample 48k -> 16k properly: use scipy-like anti-alias via averaging
ds = arr.reshape(-1, 3).mean(axis=1).astype(np.int16)
peak = float(np.max(np.abs(ds)))
normed = (ds.astype(np.float64) / max(peak, 1.0)) * 18000
boosted = np.clip(normed, -32768, 32767).astype(np.int16)

print(f"Original: {len(arr)} frames @ {sr}Hz")
print(f"Downsampled: {len(ds)} frames @ 16000Hz")
print(f"Peak: {peak:.0f}, Boosted peak: {np.max(np.abs(boosted)):.0f}")

rec = KaldiRecognizer(model, 16000)
rec.AcceptWaveform(boosted.tobytes())
result = json.loads(rec.FinalResult())
print(f"Vosk: '{result.get('text','')}'")
