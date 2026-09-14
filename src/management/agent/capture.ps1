param([int]$DurationSec = 3)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Wm {
  [DllImport("winmm.dll")] public static extern uint waveInGetNumDevs();
  [DllImport("winmm.dll")] public static extern uint waveInOpen(out IntPtr h, uint devId, ref WmFmt fmt, IntPtr cb, IntPtr ctx, uint flags);
  [DllImport("winmm.dll")] public static extern uint waveInPrepareHeader(IntPtr h, IntPtr hdr, uint size);
  [DllImport("winmm.dll")] public static extern uint waveInAddBuffer(IntPtr h, IntPtr hdr, uint size);
  [DllImport("winmm.dll")] public static extern uint waveInStart(IntPtr h);
  [DllImport("winmm.dll")] public static extern uint waveInStop(IntPtr h);
  [DllImport("winmm.dll")] public static extern uint waveInClose(IntPtr h);
}
[StructLayout(LayoutKind.Sequential)] public struct WmFmt {
  public ushort wFormatTag; public ushort nChannels; public uint nSamplesPerSec;
  public uint nAvgBytesPerSec; public ushort nBlockAlign; public ushort wBitsPerSample; public ushort cbSize;
}
[StructLayout(LayoutKind.Sequential)] public struct WmHdr {
  public IntPtr lpData; public uint dwBufferLength; public uint dwBytesRecorded;
  public IntPtr dwUser; public uint dwFlags; public uint dwLoops; public IntPtr lpNext; public IntPtr reserved;
}
"@

$sr = 16000
$n = $sr * 2 * $DurationSec
$fmt = New-Object WmFmt
$fmt.wFormatTag=1; $fmt.nChannels=1; $fmt.nSamplesPerSec=$sr; $fmt.wBitsPerSample=16
$fmt.nBlockAlign=2; $fmt.nAvgBytesPerSec=$sr*2; $fmt.cbSize=0

$devCount = [Wm]::waveInGetNumDevs()
$bestDev = 0; $bestRms = 0
for ($d = 0; $d -lt $devCount; $d++) {
  $h = [IntPtr]::Zero
  $rO = [Wm]::waveInOpen([ref]$h, [uint32]$d, [ref]$fmt, [IntPtr]::Zero, [IntPtr]::Zero, 0)
  if ($rO -ne 0) { continue }
  $dp = [Runtime.InteropServices.Marshal]::AllocHGlobal($n)
  $hdr = New-Object WmHdr; $hdr.lpData=$dp; $hdr.dwBufferLength=$n; $hdr.dwBytesRecorded=0
  $hsz = [Runtime.InteropServices.Marshal]::SizeOf([type][WmHdr])
  $hp = [Runtime.InteropServices.Marshal]::AllocHGlobal($hsz)
  [Runtime.InteropServices.Marshal]::StructureToPtr($hdr,$hp,$false)
  [void][Wm]::waveInPrepareHeader($h,$hp,$hsz)
  [void][Wm]::waveInAddBuffer($h,$hp,$hsz)
  [void][Wm]::waveInStart($h)
  Start-Sleep -Milliseconds 800
  [Wm]::waveInStop($h)
  $got = [Runtime.InteropServices.Marshal]::PtrToStructure($hp,[type][WmHdr])
  $bytes = [int]$got.dwBytesRecorded
  $sum=[long]0
  if ($bytes -gt 16) {
    $cap = New-Object byte[] $bytes
    [Runtime.InteropServices.Marshal]::Copy($got.lpData,$cap,0,$bytes)
    for ($i=0;$i -lt $bytes;$i+=2){ $v=[BitConverter]::ToInt16($cap,$i); $sum+=[long]$v*$v }
    $rms = [Math]::Sqrt($sum/($bytes/2))
    if ($rms -gt $bestRms) { $bestRms = $rms; $bestDev = $d }
  }
  [Wm]::waveInClose($h)
  [Runtime.InteropServices.Marshal]::FreeHGlobal($dp)
  [Runtime.InteropServices.Marshal]::FreeHGlobal($hp)
}

$h = [IntPtr]::Zero
$rO = [Wm]::waveInOpen([ref]$h, [uint32]$bestDev, [ref]$fmt, [IntPtr]::Zero, [IntPtr]::Zero, 0)
if ($rO -ne 0) { exit 1 }
$dp = [Runtime.InteropServices.Marshal]::AllocHGlobal($n)
$hdr = New-Object WmHdr; $hdr.lpData=$dp; $hdr.dwBufferLength=$n; $hdr.dwBytesRecorded=0
$hsz = [Runtime.InteropServices.Marshal]::SizeOf([type][WmHdr])
$hp = [Runtime.InteropServices.Marshal]::AllocHGlobal($hsz)
[Runtime.InteropServices.Marshal]::StructureToPtr($hdr,$hp,$false)
[void][Wm]::waveInPrepareHeader($h,$hp,$hsz)
[void][Wm]::waveInAddBuffer($h,$hp,$hsz)
[void][Wm]::waveInStart($h)
Start-Sleep -Milliseconds (($DurationSec * 1000) + 300)
[Wm]::waveInStop($h)
$got = [Runtime.InteropServices.Marshal]::PtrToStructure($hp,[type][WmHdr])
$bytes = [int]$got.dwBytesRecorded
if ($bytes -gt 16) {
  $cap = New-Object byte[] $bytes
  [Runtime.InteropServices.Marshal]::Copy($got.lpData,$cap,0,$bytes)
  $wav = Join-Path $env:TEMP "hear-capture.wav"
  $fs=New-Object System.IO.FileStream($wav,[System.IO.FileMode]::Create)
  $bw=New-Object System.IO.BinaryWriter($fs)
  $bw.Write([Text.Encoding]::ASCII.GetBytes("RIFF"))
  $bw.Write([int](36+$bytes)); $bw.Write([Text.Encoding]::ASCII.GetBytes("WAVEfmt "))
  $bw.Write([int]16); $bw.Write([int16]1); $bw.Write([int16]1); $bw.Write([int]$sr)
  $bw.Write([int]($sr*2)); $bw.Write([int16]2); $bw.Write([int16]16)
  $bw.Write([Text.Encoding]::ASCII.GetBytes("data")); $bw.Write([int]$bytes); $bw.Write($cap)
  $bw.Close(); $fs.Close()
  Write-Output $wav
}
[Wm]::waveInClose($h)
[Runtime.InteropServices.Marshal]::FreeHGlobal($dp)
[Runtime.InteropServices.Marshal]::FreeHGlobal($hp)
