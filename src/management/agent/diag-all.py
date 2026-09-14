import sounddevice as sd
import numpy as np

print("=== ALL DEVICES WITH HOST API ===")
devices = sd.query_devices()
host_apis = sd.query_hostapis()
for i, d in enumerate(devices):
    api_name = host_apis[d["hostapi"]]["name"] if d["hostapi"] < len(host_apis) else "?"
    ch = d["max_input_channels"]
    if ch > 0:
        print(f"  {i}: [{api_name}] {d['name']} (ch={ch} sr={d['default_samplerate']})")

print("\n=== Testing each input device at its native rate ===")
for i, d in enumerate(devices):
    if d["max_input_channels"] > 0:
        sr = int(d["default_samplerate"])
        try:
            audio = sd.rec(2 * sr, samplerate=sr, channels=1, dtype="int16", device=i)
            sd.wait()
            rms = float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))
            peak = int(np.max(np.abs(audio)))
            api_name = host_apis[d["hostapi"]]["name"] if d["hostapi"] < len(host_apis) else "?"
            print(f"  {i}: [{api_name}] {d['name'][:40]} RMS={rms:.1f} Peak={peak}")
        except Exception as e:
            print(f"  {i}: {d['name'][:40]} ERROR: {e}")
