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
[assembly: AssemblyVersion("1.3.1.0")]
[assembly: AssemblyFileVersion("1.3.1.0")]
[assembly: AssemblyInformationalVersion("1.3.1")]
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
            // Single-instance launcher: if the supervised engine is already
            // running, opening Magic Dialer is a successful no-op. Starting a
            // second packaged agent can make Windows reject the executable
            // with ERROR_SHARING_VIOLATION ("file is being used by another process").
            foreach (Process p in Process.GetProcessesByName("agent"))
            {
                try
                {
                    string running = p.MainModule == null ? "" : p.MainModule.FileName;
                    if (String.Equals(Path.GetFullPath(running), Path.GetFullPath(agent), StringComparison.OrdinalIgnoreCase))
                        return 0;
                }
                catch { }
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
            // The launcher is windowless: it hands off to the hidden agent
            // process, which serves the setup/dashboard in the browser and
            // exits. No console, no PowerShell window, no flash.
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
