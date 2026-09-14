import json, wave, os
from vosk import Model, KaldiRecognizer

model = Model(os.path.expanduser("~/models/vosk/vosk-model-small-en-us-0.15"))
wav_path = os.path.join(os.environ["TEMP"], "mic-debug.wav")

wf = wave.open(wav_path, 'rb')
sr = wf.getframerate()
n = wf.getnframes()
data = wf.readframes(n)
wf.close()

print(f"WAV: {n} frames, {sr}Hz, {n/sr:.1f}s, bytes={len(data)}")

rec = KaldiRecognizer(model, sr)
rec.AcceptWaveform(data)
result = json.loads(rec.FinalResult())
print(f"Vosk raw: '{result.get('text','')}'")

# Also test with normalized audio
import numpy as np
arr = np.frombuffer(data, dtype=np.int16)
peak = float(np.max(np.abs(arr)))
normed = (arr.astype(np.float64) / max(peak, 1.0)) * 18000
boosted = np.clip(normed, -32768, 32767).astype(np.int16)

rec2 = KaldiRecognizer(model, sr)
rec2.AcceptWaveform(boosted.tobytes())
result2 = json.loads(rec2.FinalResult())
print(f"Vosk normalized: '{result2.get('text','')}'")

# Per-second analysis
for s in range(int(n/sr)):
    chunk = arr[s*sr:(s+1)*sr]
    rms = float(np.sqrt(np.mean(chunk.astype(np.float64)**2)))
    pk = int(np.max(np.abs(chunk)))
    print(f"  sec {s}: rms={rms:.1f} peak={pk}")
