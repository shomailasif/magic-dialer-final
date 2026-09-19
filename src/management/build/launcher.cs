using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

[assembly: AssemblyTitle("Magic Dialer")]
[assembly: AssemblyProduct("Magic Dialer")]
[assembly: AssemblyCompany("Magic Dialer")]
[assembly: AssemblyDescription("Magic Dialer - Automated Voice Outreach Agent")]
[assembly: AssemblyVersion("1.3.5.0")]
[assembly: AssemblyFileVersion("1.3.5.0")]
[assembly: AssemblyInformationalVersion("1.3.5")]
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
            // Do not execute agent.exe again when the installed engine already
            // owns its local ports. A packaged Node executable can be locked by
            // the running watchdog/child even when process enumeration is
            // incomplete or access to MainModule is denied.
            if (EngineIsReachable())
            {
                OpenDashboard();
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

    private static bool EngineIsReachable()
    {
        try
        {
            var req = System.Net.WebRequest.Create("http://127.0.0.1:18787/health");
            req.Timeout = 1200;
            using (var res = req.GetResponse())
            using (var reader = new StreamReader(res.GetResponseStream()))
                return reader.ReadToEnd().Contains("\"service\":\"magic-dialer-engine\"");
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
