import json, wave, os, subprocess
from vosk import Model, KaldiRecognizer

model_path = os.path.expanduser('~/models/vosk/vosk-model-small-en-us-0.15')
model = Model(model_path)

# Capture from BOTH devices and check which has speech
PS = r'''
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Hm {
  [DllImport("winmm.dll")] public static extern uint waveInGetNumDevs();
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
"@

$devIdx = int($args[0])
$n = 16000 * 2 * 5
$sr = 16000
$fmt = New-Object HmFmt
$fmt.wFormatTag=1; $fmt.nChannels=1; $fmt.nSamplesPerSec=$sr; $fmt.wBitsPerSample=16
$fmt.nBlockAlign=2; $fmt.nAvgBytesPerSec=$sr*2; $fmt.cbSize=0

$h = [IntPtr]::Zero
$rOpen = [Hm]::waveInOpen([ref]$h, [uint32]$devIdx, [ref]$fmt, [IntPtr]::Zero, [IntPtr]::Zero, 0)
if ($rOpen -ne 0) { Write-Output "ERR:$rOpen"; exit }
$data = New-Object byte[] $n
$dp = [Runtime.InteropServices.Marshal]::AllocHGlobal($n)
$hdr = New-Object HmHdr; $hdr.lpData=$dp; $hdr.dwBufferLength=$n; $hdr.dwBytesRecorded=0
$hdrSz = [Runtime.InteropServices.Marshal]::SizeOf([type][HmHdr])
$hp = [Runtime.InteropServices.Marshal]::AllocHGlobal($hdrSz)
[Runtime.InteropServices.Marshal]::StructureToPtr($hdr,$hp,$false)
[void][Hm]::waveInPrepareHeader($h,$hp,$hdrSz)
[void][Hm]::waveInAddBuffer($h,$hp,$hdrSz)
[void][Hm]::waveInStart($h)
Start-Sleep -Milliseconds 5600
[Hm]::waveInStop($h)
$got = [Runtime.InteropServices.Marshal]::PtrToStructure($hp,[type][HmHdr])
$bytes = [int]$got.dwBytesRecorded
$sum=[long]0; $peak=0
if ($bytes -gt 16) {
  $cap = New-Object byte[] $bytes
  [Runtime.InteropServices.Marshal]::Copy($got.lpData,$cap,0,$bytes)
  for ($i=0;$i -lt $bytes;$i+=2){
    $v=[BitConverter]::ToInt16($cap,$i); $ab=[Math]::Abs($v); if($ab -gt $peak){$peak=$ab}; $sum+=[long]$v*$v
  }
  $wav = Join-Path $env:TEMP ("devtest-dev$($args[0]).wav")
  $fs=New-Object System.IO.FileStream($wav,[System.IO.FileMode]::Create)
  $bw=New-Object System.IO.BinaryWriter($fs)
  $bw.Write([Text.Encoding]::ASCII.GetBytes("RIFF"))
  $bw.Write([int](36+$bytes)); $bw.Write([Text.Encoding]::ASCII.GetBytes("WAVEfmt "))
  $bw.Write([int]16); $bw.Write([int16]1); $bw.Write([int16]1); $bw.Write([int]$sr)
  $bw.Write([int]($sr*2)); $bw.Write([int16]2); $bw.Write([int16]16)
  $bw.Write([Text.Encoding]::ASCII.GetBytes("data")); $bw.Write([int]$bytes); $bw.Write($cap)
  $bw.Close(); $fs.Close()
  $rms = [Math]::Sqrt($sum/($bytes/2))
  Write-Output ("RMS=" + [Math]::Round($rms,1) + " peak=" + $peak + " bytes=" + $bytes + " WAV=" + $wav)
}
[Hm]::waveInClose($h)
[Runtime.InteropServices.Marshal]::FreeHGlobal($dp)
[Runtime.InteropServices.Marshal]::FreeHGlobal($hp)
'''

for dev in range(2):
    print(f'\n=== Device {dev} - SPEAK SOMETHING for 5 seconds! ===')
    r = subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS, str(dev)],
                       capture_output=True, text=True, timeout=15)
    out = r.stdout.strip()
    print('Capture:', out)
    
    wav_path = None
    for line in out.split('\n'):
        if 'WAV=' in line:
            wav_path = line.split('WAV=')[1].strip()
            break
    
    if not wav_path or not os.path.exists(wav_path):
        print('No WAV file')
        continue
    
    wf = wave.open(wav_path, 'rb')
    rec = KaldiRecognizer(model, wf.getframerate())
    while True:
        data = wf.readframes(4000)
        if len(data) == 0:
            break
        rec.AcceptWaveform(data)
    result = json.loads(rec.FinalResult())
    text = result.get('text', '').strip()
    print(f'Vosk: "{text}"')
    print(f'WAV size: {os.path.getsize(wav_path)} bytes')
    wf.close()
