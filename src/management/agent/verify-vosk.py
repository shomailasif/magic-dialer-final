import asyncio, edge_tts, os, tempfile, subprocess, wave, json
from vosk import Model, KaldiRecognizer

FFMPEG = r"C:\Users\USER\AppData\Local\Programs\Python\Python312\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe"

async def gen():
    text = "hello my name is john and I am interested in solar panels for my home"
    comm = edge_tts.Communicate(text, 'en-US-GuyNeural')
    mp3_path = os.path.join(tempfile.gettempdir(), 'test-speech.mp3')
    wav_path = os.path.join(tempfile.gettempdir(), 'test-speech-16k.wav')
    raw_path = os.path.join(tempfile.gettempdir(), 'test-speech.raw')
    await comm.save(mp3_path)
    subprocess.run([FFMPEG, '-i', mp3_path, '-ar', '16000', '-ac', '1', '-f', 's16le', raw_path, '-y'],
                   capture_output=True)
    raw = open(raw_path, 'rb').read()
    wf = wave.open(wav_path, 'wb')
    wf.setnchannels(1)
    wf.setsampwidth(2)
    wf.setframerate(16000)
    wf.writeframes(raw)
    wf.close()
    print(f"WAV: {len(raw)//2} frames, {len(raw)/2/16000:.1f}s")
    
    model = Model(os.path.expanduser("~/models/vosk/vosk-model-small-en-us-0.15"))
    rec = KaldiRecognizer(model, 16000)
    rec.AcceptWaveform(raw)
    result = json.loads(rec.FinalResult())
    print(f"Vosk says: '{result.get('text','')}'")

asyncio.run(gen())
