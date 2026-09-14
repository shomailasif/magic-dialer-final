import os, tempfile, json
from faster_whisper import WhisperModel

model = WhisperModel("tiny", device="cpu", compute_type="int8")

wav_path = os.path.join(os.environ["TEMP"], "mic-debug.wav")
segments, info = model.transcribe(wav_path, language="en", beam_size=5)
text = " ".join([s.text for s in segments])
print(json.dumps({"text": text.strip(), "language": info.language, "duration": round(info.duration, 1)}))
