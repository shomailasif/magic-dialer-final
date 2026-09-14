import sounddevice as sd
import numpy as np

print("=== DEFAULT INPUT DEVICE ===")
d = sd.query_devices(kind="input")
print(d)
print()

print("=== ALL INPUT DEVICES ===")
devices = sd.query_devices()
for i, d in enumerate(devices):
    if d["max_input_channels"] > 0:
        print(f"{i}: {d['name']} (ch={d['max_input_channels']}, sr={d['default_samplerate']})")
print()

print("=== RECORD 3 SEC FROM DEFAULT MIC ===")
audio = sd.rec(3 * 16000, samplerate=16000, channels=1, dtype="int16")
sd.wait()
rms = float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))
peak = int(np.max(np.abs(audio)))
nonzero = int(np.sum(np.abs(audio) > 100))
total = audio.shape[0]
print(f"RMS: {rms:.1f}, Peak: {peak}, NonZero: {nonzero}/{total}")
print(f"First 20: {audio[:20].flatten().tolist()}")
print(f"Middle 20: {audio[total//2:total//2+20].flatten().tolist()}")

if rms > 200:
    print("\nGOOD: Mic is capturing audio!")
else:
    print(f"\nBAD: RMS={rms:.1f} is too low. Mic may be muted or wrong device.")
    print("Trying all input devices...")
    for i, dev in enumerate(devices):
        if dev["max_input_channels"] > 0:
            try:
                sd.default.device = (i, None)
                test = sd.rec(1 * 16000, samplerate=16000, channels=1, dtype="int16")
                sd.wait()
                trms = float(np.sqrt(np.mean(test.astype(np.float64) ** 2)))
                print(f"  Device {i} '{dev['name']}': RMS={trms:.1f}")
            except Exception as e:
                print(f"  Device {i} '{dev['name']}': ERROR {e}")
    sd.default.device = (None, None)
