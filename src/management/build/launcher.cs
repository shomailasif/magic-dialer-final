using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Runtime.InteropServices;
using System.Windows.Forms;

[assembly: AssemblyTitle("Magic Dialer")]
[assembly: AssemblyProduct("Magic Dialer")]
[assembly: AssemblyCompany("Magic Dialer")]
[assembly: AssemblyDescription("Magic Dialer - Automated Voice Outreach Agent")]
[assembly: AssemblyVersion("1.4.9.0")]
[assembly: AssemblyFileVersion("1.4.9.0")]
[assembly: AssemblyInformationalVersion("1.4.9")]
[assembly: Guid("8f40b2c9-7b0e-4c08-b3f6-9f6a2dfbd4a1")]

static class MagicDialerLauncher
{
    [STAThread]
    private static int Main(string[] args)
    {
        string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ?? ".";
        string agent = Path.Combine(dir, "agent.exe");

        if (!File.Exists(agent))
        {
            MessageBox.Show(
                "The Magic Dialer agent engine (agent.exe) is missing from this folder.\n\n" +
                "Reinstall Magic Dialer to fix this.",
                "Magic Dialer",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 2;
        }

        try
        {
            if (EngineIsReady())
            {
                if (!HasArg(args, "--no-browser")) OpenDashboard();
                return 0;
            }

            bool ownsStartupMutex = false;
            using (var startupMutex = new Mutex(false, @"Local\MagicDialer.Startup.8f40b2c9"))
            {
                try
                {
                    try
                    {
                        ownsStartupMutex = startupMutex.WaitOne(10000);
                    }
                    catch (AbandonedMutexException)
                    {
                        // The previous launcher died while owning the startup transition.
                        // Windows grants this thread ownership when this exception is raised.
                        ownsStartupMutex = true;
                    }

                    if (!ownsStartupMutex) return 3;

                    // Another launcher may have completed startup while we waited.
                    if (EngineIsReady())
                    {
                        if (!HasArg(args, "--no-browser")) OpenDashboard();
                        return 0;
                    }

                    var psi = new ProcessStartInfo
                    {
                        FileName = agent,
                        Arguments = BuildAgentArgs(args),
                        WorkingDirectory = dir,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        WindowStyle = ProcessWindowStyle.Hidden
                    };
                    Process.Start(psi);
                    if (!WaitForEngine(15000)) return 4;
                }
                finally
                {
                    if (ownsStartupMutex) startupMutex.ReleaseMutex();
                }
            }
        }
        catch (Exception ex)
        {
            try
            {
                MessageBox.Show(
                    "Magic Dialer could not start its agent.\n\n" + ex.Message,
                    "Magic Dialer",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
            catch { }
            return 1;
        }
        return 0;
    }

    private static bool WaitForEngine(int timeoutMs)
    {
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            if (EngineIsReady()) return true;
            Thread.Sleep(200);
        }
        return false;
    }

    private static bool HasArg(string[] args, string wanted)
    {
        foreach (var arg in args)
            if (string.Equals(arg, wanted, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static bool EngineIsReady()
    {
        return EndpointContains("http://127.0.0.1:18787/health", "\"service\":\"magic-dialer-engine\"")
            && EndpointContains("http://127.0.0.1:48771/api/health", "\"ok\":true");
    }

    private static bool EndpointContains(string url, string expected)
    {
        try
        {
            var req = System.Net.WebRequest.Create(url);
            req.Timeout = 1200;
            using (var res = req.GetResponse())
            using (var reader = new StreamReader(res.GetResponseStream()))
                return reader.ReadToEnd().Contains(expected);
        }
        catch { return false; }
    }

    private static void OpenDashboard()
    {
        try
        {
            string url = "http://127.0.0.1:48771/";
            Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
        }
        catch { }
    }

    private static string BuildAgentArgs(string[] args)
    {
        // Customer launcher always starts the self-healing supervisor.
        // Extra arguments are forwarded to the supervised agent.
        string forwarded = EscapeArgs(args);
        return string.IsNullOrWhiteSpace(forwarded) ? "--watchdog" : "--watchdog " + forwarded;
    }

    private static string EscapeArgs(string[] args)
    {
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            if (string.IsNullOrEmpty(a)) { args[i] = "\"\""; continue; }
            args[i] = "\"" + a.Replace("\"", "\\\"") + "\"";
        }
        return string.Join(" ", args);
    }
}
