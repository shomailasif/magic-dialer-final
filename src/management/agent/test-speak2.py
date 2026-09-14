import sounddevice as sd, numpy as np, wave, os, tempfile, json
from vosk import Model, KaldiRecognizer

DEV = 15
USE_SR = 48000
TARGET_SR = 16000
model = Model(os.path.expanduser("~/models/vosk/vosk-model-small-en-us-0.15"))

def resample(audio, orig_sr, target_sr):
    ratio = orig_sr / target_sr
    n = int(len(audio) / ratio)
    indices = np.linspace(0, len(audio) - 1, n).astype(int)
    return audio[indices]

print("I will record 5 seconds. Please SPEAK ALOUD - say your name and anything.")
input("Press Enter when ready to speak...")

with sd.InputStream(samplerate=USE_SR, channels=1, dtype="int16", device=DEV, blocksize=24000) as stream:
    all_audio = []
    for i in range(10):
        data, _ = stream.read(24000)
        audio = data.flatten()
        rms = float(np.sqrt(np.mean(audio.astype(np.float64)**2)))
        print(f"  Sec {i*0.5:.1f}-{(i+1)*0.5:.1f}: rms={rms:.1f} peak={np.max(np.abs(audio))}")
        all_audio.append(audio)
    full = np.concatenate(all_audio)

ds = resample(full, USE_SR, TARGET_SR)
boosted = np.clip(ds.astype(np.float64) * 10, -32768, 32767).astype(np.int16)

rec = KaldiRecognizer(model, TARGET_SR)
pcm = boosted.tobytes()
rec.AcceptWaveform(pcm)
result = json.loads(rec.FinalResult())
text = result.get("text", "")
print(f"\nVosk result: \"{text}\"")
print(f"Boosted RMS: {float(np.sqrt(np.mean(boosted.astype(np.float64)**2))):.1f}")

# Save WAV for manual inspection
wav_path = os.path.join(tempfile.gettempdir(), "user-speech-test.wav")
wf = wave.open(wav_path, "wb")
wf.setnchannels(1)
wf.setsampwidth(2)
wf.setframerate(TARGET_SR)
wf.writeframes(boosted.tobytes())
wf.close()
print(f"Saved WAV: {wav_path}")
