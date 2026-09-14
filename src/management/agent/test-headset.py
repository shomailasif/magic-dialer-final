import sounddevice as sd, numpy as np, wave, os, tempfile, json
from vosk import Model, KaldiRecognizer

DEV = 1
USE_SR = 44100
TARGET_SR = 16000
model = Model(os.path.expanduser("~/models/vosk/vosk-model-small-en-us-0.15"))

total = int(USE_SR * 5)
audio = sd.rec(total, samplerate=USE_SR, channels=1, dtype="int16", device=DEV)
sd.wait()

flat = audio.flatten()
rms = float(np.sqrt(np.mean(flat.astype(np.float64)**2)))
peak = int(np.max(np.abs(flat)))
print(f"raw rms={rms:.1f} peak={peak}")

# Save raw WAV
wav = os.path.join(tempfile.gettempdir(), "test-headset.wav")
wf = wave.open(wav, "wb")
wf.setnchannels(1)
wf.setsampwidth(2)
wf.setframerate(USE_SR)
wf.writeframes(flat.tobytes())
wf.close()

# Resample and test vosk
ratio = USE_SR // TARGET_SR
ds = flat[::ratio].astype(np.float64)
for b in [3, 10, 20]:
    boosted = np.clip(ds * b, -32768, 32767).astype(np.int16)
    rec = KaldiRecognizer(model, TARGET_SR)
    rec.AcceptWaveform(boosted.tobytes())
    r = json.loads(rec.FinalResult())
    brms = float(np.sqrt(np.mean(boosted.astype(np.float64)**2)))
    print(f"boost={b}: text='{r.get('text','')}' rms={brms:.1f}")

print(f"WAV saved: {wav}")
