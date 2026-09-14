import sounddevice as sd, numpy as np, json

devs = sd.query_devices()
results = []
for i in range(len(devs)):
    d = devs[i]
    if d['max_input_channels'] < 1:
        continue
    sr = min(int(d['default_samplerate']), 48000)
    try:
        a = sd.rec(int(sr * 1), samplerate=sr, channels=1, dtype='int16', device=i)
        sd.wait()
        f = a.flatten()
        rms = float(np.sqrt(np.mean(f.astype(np.float64)**2)))
        peak = int(np.max(np.abs(f)))
        api = sd.query_hostapis(d['hostapi'])['name']
        results.append({"dev": i, "api": api[:4], "name": d['name'][:40], "rms": round(rms,1), "peak": peak})
    except:
        pass

results.sort(key=lambda x: -x['rms'])
for r in results[:10]:
    print(f"  {r['dev']:2d} [{r['api']}] {r['name']:<40s} rms={r['rms']:>8.1f} peak={r['peak']}")
print(json.dumps(results[:3]))
