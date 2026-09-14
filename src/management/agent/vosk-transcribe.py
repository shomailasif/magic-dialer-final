import json, wave, os, sys
from vosk import Model, KaldiRecognizer

model_path = os.path.expanduser('~/models/vosk/vosk-model-small-en-us-0.15')

if not os.path.exists(model_path):
    print(json.dumps({"error": "model not found"}))
    sys.exit(0)

wav_path = sys.argv[1] if len(sys.argv) > 1 else None
if not wav_path or not os.path.exists(wav_path):
    print(json.dumps({"error": "wav not found"}))
    sys.exit(0)

model = Model(model_path)
wf = wave.open(wav_path, 'rb')
rec = KaldiRecognizer(model, wf.getframerate())
while True:
    data = wf.readframes(4000)
    if len(data) == 0:
        break
    rec.AcceptWaveform(data)
result = json.loads(rec.FinalResult())
text = result.get('text', '').strip()
wf.close()
print(json.dumps({"text": text}))
