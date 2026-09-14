import os, wave, numpy as np, json
from vosk import Model, KaldiRecognizer

wav = r"C:\Users\USER\AppData\Local\Temp\debug-capture.wav"
model = Model(os.path.expanduser("~/models/vosk/vosk-model-small-en-us-0.15"))
wf = wave.open(wav, "rb")
data = wf.readframes(wf.getnframes())
sr = wf.getframerate()
wf.close()

samples = np.frombuffer(data, dtype=np.int16)
print(f"Input: {len(samples)} samples at {sr}Hz")

# Resample 48000->16000
ratio = sr // 16000
ds = samples[::ratio].astype(np.float64)
boosted = np.clip(ds * 10, -32768, 32767).astype(np.int16)
print(f"Resampled: {len(ds)} samples")

rms = float(np.sqrt(np.mean(boosted.astype(np.float64)**2)))
print(f"Boosted RMS: {rms:.1f}")

# Test at 16000
rec = KaldiRecognizer(model, 16000)
rec.AcceptWaveform(boosted.tobytes())
r = json.loads(rec.FinalResult())
print(f"Vosk at 16000Hz: '{r.get('text', '')}'")

# Test at 48000 native
rec2 = KaldiRecognizer(model, 48000)
rec2.AcceptWaveform(data)
r2 = json.loads(rec2.FinalResult())
print(f"Vosk at 48000Hz: '{r2.get('text', '')}'")
