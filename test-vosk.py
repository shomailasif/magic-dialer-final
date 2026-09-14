import json, wave, os, subprocess, sys, tempfile
from vosk import Model, KaldiRecognizer

model_path = os.path.expanduser('~/models/vosk/vosk-model-small-en-us-0.15')
model = Model(model_path)

# Use the SAME capture method that works in hear.js (probeMic captured RMS:378)
# Capture via PowerShell waveIn with device enumeration, then transcribe with vosk

sec = 5
sr = 16000
ch = 1
bps = 16
nbuf = sr * ch * (bps // 8) * sec

ps_script = r'''
Add-Type -AssemblyName System.Speech
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Hm {
  [DllImport("winmm.dll")] public static extern uint waveInGetNumDevs();
  [DllImport("winmm.dll", CharSet=CharSet.Ansi, EntryPoint="waveInGetDevCaps")]
    public static extern uint waveInGetDevCaps(uint uDeviceID, IntPtr lpCaps, uint cbCaps);
  [DllImport("winmm.dll")] public static extern uint waveInOpen(out IntPtr h, uint devId, ref HmFmt fmt, IntPtr cb, IntPtr ctx, uint flags);
  [DllImport("winmm.dll")] public static extern uint waveInPrepareHeader(IntPtr h, IntPtr hdr, uint size);
  [DllImport("winmm.dll")] public static extern uint waveInAddBuffer(IntPtr h, IntPtr hdr, uint size);
  [DllImport("winmm.dll")] public static extern uint waveInStart(IntPtr h);
  [DllImport("winmm.dll")] public static extern uint waveInStop(IntPtr h);
  [DllImport("winmm.dll")] public static extern uint waveInClose(IntPtr h);
}
[StructLayout(LayoutKind.Sequential)] public struct HmFmt {
  public ushort wFormatTag; public ushort nChannels; public uint nSamplesPerSec;
  public uint nAvgBytesPerSec; public ushort nBlockAlign; public ushort wBitsPerSample; public ushort cbSize;
}
[StructLayout(LayoutKind.Sequential)] public struct HmHdr {
  public IntPtr lpData; public uint dwBufferLength; public uint dwBytesRecorded;
  public IntPtr dwUser; public uint dwFlags; public uint dwLoops; public IntPtr lpNext; public IntPtr reserved;
}
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)] public struct HmCaps {
  public ushort wMid; public ushort wPid; public uint vDriverVersion;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string szPname;
  public uint dwFormats; public ushort wChannels; public ushort wReserved1;
}
"@

$SR = %d; $CH = %d; $BPS = %d; $SEC = %d
$nbuf = $SR * $CH * ($BPS/8) * $SEC
$fmt = New-Object HmFmt
$fmt.wFormatTag=1; $fmt.nChannels=$CH; $fmt.nSamplesPerSec=$SR; $fmt.wBitsPerSample=$BPS
$fmt.nBlockAlign=($CH*$BPS/8); $fmt.nAvgBytesPerSec=($SR*$fmt.nBlockAlign); $fmt.cbSize=0

$n = [Hm]::waveInGetNumDevs()
$pick = -1
for ($i = 0; $i -lt $n; $i++) {
  $sz = [Runtime.InteropServices.Marshal]::SizeOf([type][HmCaps])
  $p  = [Runtime.InteropServices.Marshal]::AllocHGlobal($sz)
  [void][Hm]::waveInGetDevCaps($i, $p, [uint32]$sz)
  $caps = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][HmCaps])
  [Runtime.InteropServices.Marshal]::FreeHGlobal($p)
  if ($caps.szPname -match '(?i)(internal|built.?in|array)') { $pick = $i; break }
}
if ($pick -lt 0) {
  for ($i = 0; $i -lt $n; $i++) {
    $sz = [Runtime.InteropServices.Marshal]::SizeOf([type][HmCaps])
    $p  = [Runtime.InteropServices.Marshal]::AllocHGlobal($sz)
    [void][Hm]::waveInGetDevCaps($i, $p, [uint32]$sz)
    $caps = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][HmCaps])
    [Runtime.InteropServices.Marshal]::FreeHGlobal($p)
    if ($caps.szPname -match '(?i)mic') { $pick = $i; break }
  }
}
if ($pick -lt 0 -and $n -gt 0) { $pick = $n - 1 }
Write-Output ("PICK:" + $pick)

$h = [IntPtr]::Zero
$rOpen = [Hm]::waveInOpen([ref]$h, [uint32]$pick, [ref]$fmt, [IntPtr]::Zero, [IntPtr]::Zero, 0)
if ($rOpen -ne 0) { Write-Output "OPEN_ERR:$rOpen"; exit }

$data = New-Object byte[] $nbuf
$dataPtr = [Runtime.InteropServices.Marshal]::AllocHGlobal($nbuf)
$hdr = New-Object HmHdr; $hdr.lpData=$dataPtr; $hdr.dwBufferLength=$nbuf; $hdr.dwBytesRecorded=0
$hdrSz = [Runtime.InteropServices.Marshal]::SizeOf([type][HmHdr])
$hdrPtr = [Runtime.InteropServices.Marshal]::AllocHGlobal($hdrSz)
[Runtime.InteropServices.Marshal]::StructureToPtr($hdr,$hdrPtr,$false)
$p = [Hm]::waveInPrepareHeader($h,$hdrPtr,$hdrSz)
$a = [Hm]::waveInAddBuffer($h,$hdrPtr,$hdrSz)
$s = [Hm]::waveInStart($h)
Start-Sleep -Milliseconds (($SEC*1000)+600)
[Hm]::waveInStop($h)
$got = [Runtime.InteropServices.Marshal]::PtrToStructure($hdrPtr,[type][HmHdr])
$bytes = [int]$got.dwBytesRecorded
$sum=[long]0; $peak=0
if ($bytes -gt 16) {
  $cap = New-Object byte[] $bytes
  [Runtime.InteropServices.Marshal]::Copy($got.lpData,$cap,0,$bytes)
  for ($i=0;$i -lt $bytes;$i+=2){
    $v=[BitConverter]::ToInt16($cap,$i); $ab=[Math]::Abs($v); if($ab -gt $peak){$peak=$ab}; $sum+=[long]$v*$v
  }
  $wav = Join-Path $env:TEMP ("vosk-capture-" + $PID + ".wav")
  $fs=New-Object System.IO.FileStream($wav,[System.IO.FileMode]::Create)
  $bw=New-Object System.IO.BinaryWriter($fs)
  $bw.Write([Text.Encoding]::ASCII.GetBytes("RIFF"))
  $bw.Write([int](36+$bytes)); $bw.Write([Text.Encoding]::ASCII.GetBytes("WAVEfmt "))
  $bw.Write([int]16); $bw.Write([int16]1); $bw.Write([int16]$CH); $bw.Write([int]$SR)
  $bw.Write([int]($SR*$CH*($BPS/8))); $bw.Write([int16]($CH*$BPS/8)); $bw.Write([int16]$BPS)
  $bw.Write([Text.Encoding]::ASCII.GetBytes("data")); $bw.Write([int]$bytes); $bw.Write($cap)
  $bw.Close(); $fs.Close()
  Write-Output ("RMS:" + [Math]::Round([Math]::Sqrt($sum/($bytes/2)),1) + " peak:" + $peak + " bytes:" + $bytes)
  Write-Output ("WAVPATH:" + $wav)
} else {
  Write-Output "NO_AUDIO_BYTES:$bytes"
}
[Hm]::waveInClose($h)
[Runtime.InteropServices.Marshal]::FreeHGlobal($dataPtr)
[Runtime.InteropServices.Marshal]::FreeHGlobal($hdrPtr)
''' % (sr, ch, bps, sec)

print('Speak into mic for 5 seconds...')
r = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', ps_script],
                    capture_output=True, text=True, timeout=15)
out = r.stdout.strip()
print('Capture output:')
print(out)

wav_path = None
for line in out.split('\n'):
    if line.startswith('WAVPATH:'):
        wav_path = line[len('WAVPATH:'):].strip()
        break

if not wav_path or not os.path.exists(wav_path):
    print('ERROR: No WAV file')
    sys.exit(1)

print('\nTranscribing with vosk...')
wf = wave.open(wav_path, 'rb')
rec = KaldiRecognizer(model, wf.getframerate())
while True:
    data = wf.readframes(4000)
    if len(data) == 0:
        break
    rec.AcceptWaveform(data)
result = json.loads(rec.FinalResult())
text = result.get('text', '').strip()
print('Vosk heard:', text if text else '(nothing)')
wf.close()
