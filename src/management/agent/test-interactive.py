import sounddevice as sd, numpy as np, sys, os
from vosk import Model, KaldiRecognizer
import json

DEV = 15
USE_SR = 48000
TARGET_SR = 16000
model = Model(os.path.expanduser("~/models/vosk/vosk-model-small-en-us-0.15"))

chunk = int(USE_SR * 0.5)
rec = KaldiRecognizer(model, TARGET_SR)

print("=== MIC TEST ===")
print("When you see '>>> SPEAK <<<', please say your name out loud.")
print("When you see '>>> SILENCE <<<', please stay quiet.")
print()

with sd.InputStream(samplerate=USE_SR, channels=1, dtype="int16", device=DEV, blocksize=chunk) as stream:
    for round_num in range(3):
        if round_num % 2 == 0:
            print(f">>> ROUND {round_num+1}: SPEAK NOW - say your name! <<<")
        else:
            print(f">>> ROUND {round_num+1}: SILENCE - stay quiet <<<")
        
        all_audio = []
        for i in range(6):
            data, _ = stream.read(chunk)
            audio = data.flatten()
            rms = float(np.sqrt(np.mean(audio.astype(np.float64)**2)))
            peak = int(np.max(np.abs(audio)))
            all_audio.append(audio)
            print(f"  {i*0.5:.1f}-{(i+1)*0.5:.1f}s: rms={rms:.0f} peak={peak}")
        
        full = np.concatenate(all_audio)
        ratio = USE_SR // TARGET_SR
        ds = full[::ratio].astype(np.float64)
        boosted = np.clip(ds * 10, -32768, 32767).astype(np.int16)
        
        rec2 = KaldiRecognizer(model, TARGET_SR)
        rec2.AcceptWaveform(boosted.tobytes())
        result = json.loads(rec2.FinalResult())
        text = result.get("text", "")
        b_rms = float(np.sqrt(np.mean(boosted.astype(np.float64)**2)))
        print(f"  RESULT: text=\"{text}\" boosted_rms={b_rms:.0f}")
        print()
