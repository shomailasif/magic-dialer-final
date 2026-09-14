import subprocess, ctypes, ctypes.wintypes

# Try to set mic volume via Windows Core Audio API
try:
    from comtypes import CLSCTX_ALL, CoCreateInstance, GUID
    # Alternative: use PowerShell to set mic volume
    ps = """
Add-Type @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int NotImpl1(); int NotImpl2(); int NotImpl3(); int NotImpl4();
    int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
    int NotImpl5(); int NotImpl6(); int NotImpl7(); int NotImpl8(); int NotImpl9();
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator {}
'@

$enumerator = New-Object MMDeviceEnumerator
$device = $null
$enumerator.GetDefaultAudioEndpoint(1, 0, [ref]$device)
$iid = [Guid]"5CDF2C82-841E-4546-9722-0CF74078229A"
$volume = $null
$device.Activate([ref]$iid, 1, [IntPtr]::Zero, [ref]$volume)
$volume.SetMasterVolumeLevelScalar(1.0, [Guid]::Empty)
Write-Output 'VOLUME_SET_TO_MAX'
"""
    r = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
        capture_output=True, text=True, timeout=10
    )
    print("Volume result:", r.stdout.strip())
    if r.stderr:
        print("Volume stderr:", r.stderr[:200])
except Exception as e:
    print(f"Volume set failed: {e}")

# Now test mic with amplification
import sounddevice as sd
import numpy as np

print("\n=== Recording 3 seconds with default mic ===")
audio = sd.rec(3 * 16000, samplerate=16000, channels=1, dtype="int16")
sd.wait()
rms_before = float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))
print(f"RMS before boost: {rms_before:.1f}")

# Amplify by 20x
boosted = np.clip(audio.astype(np.float64) * 20, -32768, 32767).astype(np.int16)
rms_after = float(np.sqrt(np.mean(boosted.astype(np.float64) ** 2)))
print(f"RMS after 20x boost: {rms_after:.1f}")

# Save boosted audio and run vosk
import wave, os, tempfile, json
from vosk import Model, KaldiRecognizer

model = Model(os.path.expanduser("~/models/vosk/vosk-model-small-en-us-0.15"))
rec = KaldiRecognizer(model, 16000)
pcm = boosted.tobytes()
rec.AcceptWaveform(pcm)
result = json.loads(rec.FinalResult())
print(f"Vosk text (boosted): '{result.get('text', '')}'")
