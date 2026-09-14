import sounddevice as sd, numpy as np, json

devices = sd.query_devices()
host_apis = sd.query_hostapis()

print("=== Testing ALL input devices for your headset mic ===\n")
results = []
for i, d in enumerate(devices):
    if d["max_input_channels"] <= 0:
        continue
    api = host_apis[d["hostapi"]]["name"]
    if "WDM" in api:
        continue
    name = d["name"]
    sr = min(int(d["default_samplerate"]), 48000)
    try:
        audio = sd.rec(int(sr * 2), samplerate=sr, channels=1, dtype="int16", device=i)
        sd.wait()
        rms = float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))
        peak = int(np.max(np.abs(audio)))
        results.append((i, api[:6], name[:50], rms, peak))
        print(f"  {i}: [{api[:6]}] {name[:50]} rms={rms:.1f} peak={peak}")
    except Exception as e:
        pass

results.sort(key=lambda x: -x[3])
if results:
    best = results[0]
    print(f"\nBEST DEVICE: {best[0]} '{best[2]}' rms={best[3]:.1f}")
    print(json.dumps({"best_device": best[0], "name": best[2], "rms": best[3]}))
