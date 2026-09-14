Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int f(); int g(); int h(); int i();
    int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
    int j();
    int GetMasterVolumeLevelScalar(out float pfLevel);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
}
[Guid("A95664D2-9614-4F35-A746-de8db63617e6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator {}

public static class Vol {
    public static float Get() {
        var d = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice m; d.GetDefaultAudioEndpoint(1, 0, out m);
        var iid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        object o; m.Activate(ref iid, 1, IntPtr.Zero, out o);
        var v = (IAudioEndpointVolume)o;
        float lvl; v.GetMasterVolumeLevelScalar(out lvl);
        return lvl;
    }
    public static void Set(float lvl) {
        var d = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice m; d.GetDefaultAudioEndpoint(1, 0, out m);
        var iid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        object o; m.Activate(ref iid, 1, IntPtr.Zero, out o);
        var v = (IAudioEndpointVolume)o;
        v.SetMasterVolumeLevelScalar(lvl, Guid.Empty);
    }
}
"@

$current = [Vol]::Get()
Write-Output ("CURRENT_MIC_VOL: " + [Math]::Round($current * 100) + "%")
[Vol]::Set(1.0)
$new = [Vol]::Get()
Write-Output ("SET_MIC_VOL: " + [Math]::Round($new * 100) + "%")
