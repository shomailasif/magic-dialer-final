Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WaveDev {
  [DllImport("winmm.dll")] public static extern uint waveInGetNumDevs();
  [DllImport("winmm.dll", CharSet=CharSet.Ansi, EntryPoint="waveInGetDevCapsA")]
    public static extern uint waveInGetDevCaps(uint id, IntPtr caps, uint sz);
}
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)] public struct WaveCaps {
  public ushort wMid; public ushort wPid; public uint vDriverVersion;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string szPname;
  public uint dwFormats; public ushort wChannels; public ushort wReserved1;
}
"@

$n = [WaveDev]::waveInGetNumDevs()
Write-Output "Found $n input devices:"
for ($i = 0; $i -lt $n; $i++) {
  $sz = [Runtime.InteropServices.Marshal]::SizeOf([type][WaveCaps])
  $p = [Runtime.InteropServices.Marshal]::AllocHGlobal($sz)
  [void][WaveDev]::waveInGetDevCaps($i, $p, [uint32]$sz)
  $c = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][WaveCaps])
  [Runtime.InteropServices.Marshal]::FreeHGlobal($p)
  Write-Output ("DEV$i`: $($c.szPname) channels=$($c.wChannels)")
}
