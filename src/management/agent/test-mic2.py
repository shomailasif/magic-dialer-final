import sounddevice as sd
import numpy as np

print("=== Testing at native 44100 rate then resample ===")
audio = sd.rec(3 * 44100, samplerate=44100, channels=1, dtype="int16")
sd.wait()
rms44 = float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))
peak44 = int(np.max(np.abs(audio)))
print(f"At 44100: RMS={rms44:.1f}, Peak={peak44}")

# Resample to 16000
ratio = 44100 // 16000
resampled = audio[::ratio]
rms16 = float(np.sqrt(np.mean(resampled.astype(np.float64) ** 2)))
print(f"Resampled to 16000: RMS={rms16:.1f}")

print()
print("=== Testing with explicit MME backend ===")
try:
    sd.default.device = (1, None)  # External Mic
    sd.default.samplerate = 44100
    audio2 = sd.rec(3 * 44100, samplerate=44100, channels=1, dtype="int16")
    sd.wait()
    rms2 = float(np.sqrt(np.mean(audio2.astype(np.float64) ** 2)))
    peak2 = int(np.max(np.abs(audio2)))
    print(f"Device 1 (External): RMS={rms2:.1f}, Peak={peak2}")
    sd.default.device = (None, None)
except Exception as e:
    print(f"Error: {e}")

print()
print("=== Checking Windows mic volume via PowerShell ===")
import subprocess
r = subprocess.run([
    "powershell.exe", "-NoProfile", "-Command",
    "Get-AudioDevice -List 2>$null; if (-not $?) { Write-Output 'No AudioDevice module' }"
], capture_output=True, text=True, timeout=5)
print(r.stdout[:500] if r.stdout else "nothing")
