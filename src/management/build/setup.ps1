# Legacy setup entry point retained only for compatibility with older shortcuts.
# Customer account enrollment is deliberately NOT performed here.
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show(
  "Sign in to your Magic Dialer web portal and click 'Connect This PC'. No access key is required.",
  "Magic Dialer",
  [System.Windows.Forms.MessageBoxButtons]::OK,
  [System.Windows.Forms.MessageBoxIcon]::Information
) | Out-Null
