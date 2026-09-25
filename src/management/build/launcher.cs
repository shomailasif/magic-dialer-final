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
[assembly: AssemblyVersion("1.4.13.0")]
[assembly: AssemblyFileVersion("1.4.13.0")]
[assembly: AssemblyInformationalVersion("1.4.13")]
[assembly: Guid("8f40b2c9-7b0e-4c08-b3f6-9f6a2dfbd4a1")]

static class MagicDialerLauncher
{
    // Every exit path used to be invisible: a headless start swallows the
    // MessageBox and writes nothing, so an unattended update that lost the
    // agent left no trace at all. This log is the record.
    private static readonly string LogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Magic Dialer", "launcher.log");
    private static readonly Stopwatch Age = Stopwatch.StartNew();

    private static void Note(string msg)
    {
        try
        {
            string dir = Path.GetDirectoryName(LogPath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.AppendAllText(LogPath,
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") +
                " pid=" + Process.GetCurrentProcess().Id +
                " +" + Age.ElapsedMilliseconds + "ms " + msg + Environment.NewLine);
        }
        catch { }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ?? ".";
        string agent = Path.Combine(dir, "agent.exe");
        Note("launch cmdline=[" + Environment.CommandLine + "] dir=" + dir);

        if (!File.Exists(agent))
        {
            Note("exit=2 agent.exe is missing from " + dir);
            ReportFailure(args,
                "The Magic Dialer agent engine (agent.exe) is missing from this folder.\n\n" +
                "Reinstall Magic Dialer to fix this.");
            return 2;
        }

        try
        {
            if (EngineIsReady())
            {
                Note("exit=0 engine already ready before spawn");
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

                    if (!ownsStartupMutex)
                    {
                        Note("exit=3 startup mutex busy for 10000ms — another launcher is starting");
                        return 3;
                    }

                    // Another launcher may have completed startup while we waited.
                    if (EngineIsReady())
                    {
                        Note("exit=0 engine became ready while waiting for the mutex");
                        if (!HasArg(args, "--no-browser")) OpenDashboard();
                        return 0;
                    }

                    // One 15s wait used to be the whole story. A single slow first
                    // boot — AV scanning a 60MB image, a port still held by the
                    // process RestartManager just revived — ended with the launcher
                    // walking away and nothing else on the machine restarting the
                    // agent until the next logon. Retry instead of giving up.
                    // A real self-update outage lasted ~3 minutes: every spawn
                    // died before it ran a line of JS for as long as the installer
                    // was alive, then worked. A headless start therefore keeps
                    // trying long enough to outlive that window; an interactive
                    // one stays short so the user is never left staring.
                    bool headless = HasArg(args, "--no-browser");
                    int maxAttempts = headless ? 15 : 3;
                    int lastCode = 4;
                    for (int attempt = 1; attempt <= maxAttempts; attempt++)
                    {
                        if (!File.Exists(agent))
                        {
                            Note("attempt " + attempt + ": agent.exe not on disk yet, waiting");
                            for (int w = 0; w < 5 && !File.Exists(agent); w++) Thread.Sleep(1000);
                            if (!File.Exists(agent))
                            {
                                lastCode = 2;
                                Note("attempt " + attempt + ": agent.exe still missing");
                                continue;
                            }
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
                        int spawnedPid = -1;
                        Process spawned = null;
                        try
                        {
                            spawned = Process.Start(psi);
                            spawnedPid = spawned == null ? -1 : spawned.Id;
                            Note("attempt " + attempt + ": spawned agent pid=" + spawnedPid +
                                 " [" + ImageState(agent) + "]");
                        }
                        catch (Exception spawnEx)
                        {
                            lastCode = 1;
                            Note("attempt " + attempt + ": Process.Start threw " +
                                 spawnEx.GetType().Name + ": " + spawnEx.Message);
                            Thread.Sleep(2000);
                            continue;
                        }

                        // The process can die before it runs a single line of JS.
                        // Its exit code is the only witness to why.
                        var wait = Stopwatch.StartNew();
                        string verdict = null;
                        while (wait.ElapsedMilliseconds < 12000)
                        {
                            if (EngineIsReady())
                            {
                                Note("exit=0 engine ready on attempt " + attempt + " (pid " + spawnedPid + ")");
                                return 0;
                            }
                            if (spawned != null)
                            {
                                try
                                {
                                    if (spawned.HasExited)
                                    {
                                        verdict = "agent pid=" + spawnedPid + " exited code=" +
                                                  spawned.ExitCode + " after " + wait.ElapsedMilliseconds + "ms";
                                        break;
                                    }
                                }
                                catch { verdict = "agent pid=" + spawnedPid + " is gone"; break; }
                            }
                            Thread.Sleep(200);
                        }
                        if (verdict == null)
                            verdict = "agent pid=" + spawnedPid + " still alive after " + wait.ElapsedMilliseconds + "ms";
                        lastCode = verdict.Contains("exited code=") ? 1 : 4;
                        Note("attempt " + attempt + ": " + verdict + " [" + EngineState() + "] " +
                             ImageState(agent));
                        Thread.Sleep(2000);
                    }
                    Note("exit=" + lastCode + " giving up after " + maxAttempts + " attempts [" + EngineState() + "]");
                    return lastCode;
                }
                finally
                {
                    if (ownsStartupMutex) startupMutex.ReleaseMutex();
                }
            }
        }
        catch (Exception ex)
        {
            Note("exit=1 exception " + ex.GetType().Name + ": " + ex.Message);
            ReportFailure(args, "Magic Dialer could not start its agent.\n\n" + ex.Message);
            return 1;
        }
    }

    private static string ImageState(string path)
    {
        try
        {
            var fi = new FileInfo(path);
            return "agent.exe size=" + fi.Length + " mtime=" +
                   fi.LastWriteTime.ToString("HH:mm:ss.fff");
        }
        catch (Exception ex) { return "agent.exe unreadable: " + ex.GetType().Name; }
    }

    // A headless start (--no-browser) runs unattended, at boot, and from the
    // installer. Parking a modal dialog there means an hourglass on a machine
    // nobody is looking at, with no agent and no watchdog behind it.
    private static void ReportFailure(string[] args, string message)
    {
        if (HasArg(args, "--no-browser")) return;
        try
        {
            MessageBox.Show(
                message,
                "Magic Dialer",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
        catch { }
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
        return EndpointState("http://127.0.0.1:18787/health", "\"service\":\"magic-dialer-engine\"") == "ok"
            && EndpointState("http://127.0.0.1:48771/api/health", "\"ok\":true") == "ok";
    }

    private static string EngineState()
    {
        return "18787=" + EndpointState("http://127.0.0.1:18787/health", "\"service\":\"magic-dialer-engine\"")
             + ",48771=" + EndpointState("http://127.0.0.1:48771/api/health", "\"ok\":true");
    }

    private static string EndpointState(string url, string expected)
    {
        try
        {
            var req = System.Net.WebRequest.Create(url);
            req.Timeout = 1200;
            using (var res = req.GetResponse())
            using (var reader = new StreamReader(res.GetResponseStream()))
                return reader.ReadToEnd().Contains(expected) ? "ok" : "mismatch";
        }
        catch (System.Net.WebException) { return "down"; }
        catch (Exception ex) { return ex.GetType().Name; }
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
