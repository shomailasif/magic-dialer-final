import asyncio, edge_tts, os, tempfile, wave, struct, math

async def gen():
    text = 'hello my name is john and I am interested in solar panels'
    comm = edge_tts.Communicate(text, 'en-US-GuyNeural')
    mp3_path = os.path.join(tempfile.gettempdir(), 'test-speech.mp3')
    await comm.save(mp3_path)
    print(f'MP3 size: {os.path.getsize(mp3_path)} bytes')

asyncio.run(gen())
