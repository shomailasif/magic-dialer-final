import subprocess, json, os, tempfile, wave, struct, math

# Step 1: Get Windows audio device info via PowerShell
ps = r"""
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Wave {
  [DllImport("winmm.dll")] public static extern uint waveInGetNumDevs();
  [DllImport("winmm.dll")] public static extern uint waveInGetDevCaps(IntPtr uDeviceID, ref WAVEINCAPS caps, uint cbcaps);
  [DllImport("winmm.dll")] public static extern uint waveInOpen(out IntPtr h, uint devId, ref WAVEFORMATEX fmt, IntPtr cb, IntPtr ctx, uint flags);
  [DllImport("winmm.dll")] public static extern uint waveInPrepareHeader(IntPtr h, IntPtr hdr, uint size);
  [DllImport("winmm.dll")] public static extern uint waveInAddBuffer(IntPtr h, IntPtr hdr, uint size);
  [DllImport("winmm.dll")] public static extern uint waveInStart(IntPtr h);
  [DllImport("winmm.dll")] public static extern uint waveInStop(IntPtr h);
  [DllImport("winmm.dll")] public static extern uint waveInClose(IntPtr h);
}
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct WAVEINCAPS {
  public ushort wMid; public ushort wPid; public uint vDriverVersion;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string szPname;
  public uint dwFormats; public ushort wChannels; public ushort wReserved1;
}
[StructLayout(LayoutKind.Sequential)] public struct WAVEFORMATEX {
  public ushort wFormatTag; public ushort nChannels; public uint nSamplesPerSec;
  public uint nAvgBytesPerSec; public ushort nBlockAlign; public ushort wBitsPerSample; public ushort cbSize;
}
[StructLayout(LayoutKind.Sequential)] public struct WAVEHDR {
  public IntPtr lpData; public uint dwBufferLength; public uint dwBytesRecorded;
  public IntPtr dwUser; public uint dwFlags; public uint dwLoops; public IntPtr lpNext; public IntPtr reserved;
}
"@

$devCount = [Wave]::waveInGetNumDevs()
Write-Output "WAVEIN_DEVICES=$devCount"

for ($d = 0; $d -lt $devCount; $d++) {
  $caps = New-Object WAVEINCAPS
  $capsPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal([System.Runtime.InteropServices.Marshal]::SizeOf([type][WAVEINCAPS]))
  [void][Wave]::waveInGetDevCaps([IntPtr]$d, [ref]$caps, [System.Runtime.InteropServices.Marshal]::SizeOf([type][WAVEINCAPS]))
  $caps = [System.Runtime.InteropServices.Marshal]::PtrToStructure($capsPtr, [type][WAVEINCAPS]) 
  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($capsPtr)
  
  $fmt = New-Object WAVEFORMATEX
  $fmt.wFormatTag=1; $fmt.nChannels=1; $fmt.nSamplesPerSec=16000; $fmt.wBitsPerSample=16
  $fmt.nBlockAlign=2; $fmt.nAvgBytesPerSec=32000; $fmt.cbSize=0
  
  $h = [IntPtr]::Zero
  $rO = [Wave]::waveInOpen([ref]$h, [uint32]$d, [ref]$fmt, [IntPtr]::Zero, [IntPtr]::Zero, 0)
  if ($rO -ne 0) {
    Write-Output "DEV[$d]: OPEN_FAIL code=$rO"
    continue
  }
  
  $n = 16000 * 2 * 3
  $dp = [Runtime.InteropServices.Marshal]::AllocHGlobal($n)
  $hdr = New-Object WAVEHDR; $hdr.lpData=$dp; $hdr.dwBufferLength=$n; $hdr.dwBytesRecorded=0
  $hsz = [Runtime.InteropServices.Marshal]::SizeOf([type][WAVEHDR])
  $hp = [Runtime.InteropServices.Marshal]::AllocHGlobal($hsz)
  [Runtime.InteropServices.Marshal]::StructureToPtr($hdr,$hp,$false)
  [void][Wave]::waveInPrepareHeader($h,$hp,$hsz)
  [void][Wave]::waveInAddBuffer($h,$hp,$hsz)
  [void][Wave]::waveInStart($h)
  Start-Sleep -Milliseconds 3500
  [Wave]::waveInStop($h)
  $got = [Runtime.InteropServices.Marshal]::PtrToStructure($hp,[type][WAVEHDR])
  $bytes = [int]$got.dwBytesRecorded
  $sum=[double]0; $peak=0
  if ($bytes -gt 16) {
    for ($i=0;$i -lt $bytes-1;$i+=2) {
      $v = [BitConverter]::ToInt16([byte[]]@($got.lpData+$i), 0)
      # Can't do pointer math in PS, use different approach
    }
    $cap = New-Object byte[] $bytes
    [Runtime.InteropServices.Marshal]::Copy($got.lpData,$cap,0,$bytes)
    for ($i=0;$i -lt $bytes-1;$i+=2) {
      $v = [BitConverter]::ToInt16($cap,$i)
      $sum += [double]$v*$v
      if ([Math]::Abs($v) -gt $peak) { $peak = [Math]::Abs($v) }
    }
    $rms = [Math]::Sqrt($sum/($bytes/2))
    Write-Output "DEV[$d]: OK name=$($caps.szPname) bytes=$bytes rms=$([Math]::Round($rms,1)) peak=$peak"
  } else {
    Write-Output "DEV[$d]: NO_DATA name=$($caps.szPname) bytes=$bytes"
  }
  [Wave]::waveInClose($h)
  [Runtime.InteropServices.Marshal]::FreeHGlobal($dp)
  [Runtime.InteropServices.Marshal]::FreeHGlobal($hp)
}
"""

r = subprocess.run(
    ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    capture_output=True, text=True, timeout=30
)
print("=== WAVEIN DEVICE SCAN ===")
for line in r.stdout.strip().split('\n'):
    print(line.strip())
if r.stderr:
    print("STDERR:", r.stderr[:200])
