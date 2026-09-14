import sounddevice as sd, numpy as np, wave, os, tempfile, json
from vosk import Model, KaldiRecognizer

DEV = 15
USE_SR = 48000
sr = 16000
model = Model(os.path.expanduser("~/models/vosk/vosk-model-small-en-us-0.15"))

print("Speak NOW for 5 seconds...")
with sd.InputStream(samplerate=USE_SR, channels=1, dtype="int16", device=DEV, blocksize=24000) as stream:
    all_audio = []
    for i in range(10):
        data, _ = stream.read(24000)
        audio = data.flatten()
        rms_chunk = float(np.sqrt(np.mean(audio.astype(np.float64)**2)))
        print(f"  Chunk {i}: rms={rms_chunk:.1f} peak={np.max(np.abs(audio))}")
        all_audio.append(audio)
    full = np.concatenate(all_audio)

rms_raw = float(np.sqrt(np.mean(full.astype(np.float64)**2)))
print(f"\nRaw RMS: {rms_raw:.1f}, Peak: {np.max(np.abs(full))}")

wav_path = os.path.join(tempfile.gettempdir(), "debug-capture.wav")
wf = wave.open(wav_path, "wb")
wf.setnchannels(1)
wf.setsampwidth(2)
wf.setframerate(USE_SR)
wf.writeframes(full.tobytes())
wf.close()
print(f"Saved: {wav_path} ({os.path.getsize(wav_path)} bytes)")

for b in [1, 5, 10, 20]:
    ratio = USE_SR // sr
    ds = full[::ratio]
    boosted = np.clip(ds.astype(np.float64) * b, -32768, 32767).astype(np.int16)
    rec = KaldiRecognizer(model, sr)
    pcm = boosted.tobytes()
    for j in range(0, len(pcm), 8000):
        chunk = pcm[j:j+8000]
        rec.AcceptWaveform(chunk)
    result = json.loads(rec.FinalResult())
    text = result.get("text", "")
    b_rms = float(np.sqrt(np.mean(boosted.astype(np.float64)**2)))
    print(f"Boost={b}: text=\"{text}\" boosted_rms={b_rms:.1f}")
