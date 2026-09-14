# Building the customer installer (.exe)

Everything to turn the agent into a Windows `.exe` that a customer installs on
their PC. All tools are **free**. This pipeline has been run and produces a
working installer (see `build/dist/MagicDialer-Setup.exe`).

## The pipeline (what each step does)

1. **Bundle** the agent into one file -> `build/dist/agent-bundle.js` (esbuild, free)
2. **pkg** turns that file into a Windows `.exe` (embeds Node, so the customer
   PC doesn't need Node installed)
3. **patch-gui.cjs** flips the EXE to GUI subsystem so no console window shows
4. **Inno Setup** wraps the `.exe` into a friendly installer. On launch the
   agent opens its own local dashboard (Edge `--app` window on 127.0.0.1) where
   the customer completes the one-time setup â€” no PowerShell anywhere

## Prerequisites (installed once)

- Node.js (already used by this project)
- Inno Setup 6 (free) -> `C:\Users\USER\AppData\Local\Programs\Inno Setup 6\ISCC.exe`
- pkg (free, maintained fork) -> `npm install @yao-pkg/pkg --no-save` in the project root

## Step 1 â€” bundle

```
node build/bundle.js        # -> build/dist/agent-bundle.js
```

## Step 2 â€” .exe with pkg

```
node "<project>/node_modules/@yao-pkg/pkg/lib-es5/bin.js" ^
     build/dist/agent-bundle.js ^
     --targets node22-win-x64 ^
     --output build/dist/MagicDialer.exe
```

> The agent .exe must not be running while rebuilding (Windows locks the file).
> Stop it first (`Stop-Process -Name MagicDialer -Force`).

`pkg` downloads the Node 22 runtime once and embeds it, producing
`build/dist/MagicDialer.exe` (~55 MB).

> Use `node22-win-x64` (not node18): modern Node has a prebuilt binary, so pkg
> doesn't try to build from source (which needs the Unix `patch` tool not
> present on Windows).

## Step 2b â€” hide the console (GUI subsystem)

```
node build/patch-gui.cjs build/dist/MagicDialer.exe
```

Toggles the PE Subsystem bit (3=console -> 2=GUI). The agent runs with no
terminal window; its only face is the local dashboard it opens in Edge.

## Step 3 â€” installer with Inno Setup

`installer.iss` ships `dist\MagicDialer.exe` plus the logo assets.

```
"C:\Users\USER\AppData\Local\Programs\Inno Setup 6\ISCC.exe" build\installer.iss
```

Produces `build/dist/MagicDialer-Setup.exe` (compressed, ~15 MB) â€” the one-time
installer you give each customer.

## What the installer does on the customer's PC

- Installs per-user (no admin needed) to `%LocalAppData%\Magic Dialer`
- Launches the agent (`MagicDialer.exe`), which:
  - opens a chrome-less **Edge app window** (or default browser) pointing at
    its local dashboard on `127.0.0.1:<random port>`
  - shows the one-time setup form right there: company, product, lead info,
    email, callback, plus the **portal URL** and customer **access key**
  - "Save & start" persists `%USERPROFILE%\.magicdialer\config.json` and the
    agent heartbeats to the portal (customer shows ONLINE)
- A second launch while running just brings the dashboard window back (no
  second agent)

The same `MagicDialer-Setup.exe` works for **every** customer â€” the portal + key
come from the setup form, so they connect to the right provider's account.

## Result

Customers run **MagicDialer-Setup.exe** once. The portal then shows them online
and lets you disable them remotely. Check the live portal / VOIP status at the
deploy repo (see PORTAL-LIVE.md).
