import subprocess

# Check what's using the mic
r = subprocess.run([
    "powershell.exe", "-NoProfile", "-Command",
    "Get-Process | Select-Object ProcessName,Id | Format-Table -AutoSize"
], capture_output=True, text=True, timeout=10)
print("=== Running Processes ===")
print(r.stdout[:3000])
