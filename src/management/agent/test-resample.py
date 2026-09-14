import sounddevice as sd, numpy as np, json
from vosk import Model, KaldiRecognizer

DEV = 15
USE_SR = 48000
TARGET_SR = 16000
model = Model("C:/Users/USER/models/vosk/vosk-model-small-en-us-0.15")

def resample(audio, orig_sr, target_sr):
    if orig_sr == target_sr:
        return audio
    ratio = orig_sr / target_sr
    n = int(len(audio) / ratio)
    indices = np.linspace(0, len(audio) - 1, n).astype(int)
    return audio[indices]

print("Speak NOW for 5 seconds...")
with sd.InputStream(samplerate=USE_SR, channels=1, dtype="int16", device=DEV, blocksize=24000) as stream:
    all_audio = []
    for i in range(10):
        data, _ = stream.read(24000)
        all_audio.append(data.flatten())
    full = np.concatenate(all_audio)

rms_raw = float(np.sqrt(np.mean(full.astype(np.float64)**2)))
print(f"Raw RMS: {rms_raw:.1f}")

ds = resample(full, USE_SR, TARGET_SR)
print(f"Resampled: {len(full)} -> {len(ds)} samples")

for b in [1, 5, 10]:
    boosted = np.clip(ds.astype(np.float64) * b, -32768, 32767).astype(np.int16)
    rec = KaldiRecognizer(model, TARGET_SR)
    pcm = boosted.tobytes()
    rec.AcceptWaveform(pcm)
    result = json.loads(rec.FinalResult())
    text = result.get("text", "")
    b_rms = float(np.sqrt(np.mean(boosted.astype(np.float64)**2)))
    print(f"Boost={b}: text=\"{text}\" boosted_rms={b_rms:.1f}")
