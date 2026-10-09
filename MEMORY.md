# Magic Dialer — state at end of session 2026-10-09

## What "perfect" actually requires

Turns are currently **2.5–3.7s**, down from 9–13s. The remaining cost is
structural, and three items are left. In order of impact:

### 1. The turn path still pays the gateway twice (biggest win)
Every reply costs two gateway HTTP round trips: one for STT, one for the brain.
Direct-to-Groq from the engine measures **184ms**; the same call through the
gateway is **1000–1300ms**. The gateway exists so the engine never holds a
provider API key.

The fix is to invert priority: the engine already has direct-Groq paths in
`src/management/agent/multilingual-stt.js` and `src/management/agent/intelligent-brain.js`
(used only as fallbacks today). Make direct the primary path when a key is
available, gateway the fallback.

**The trade-off, stated plainly:** this puts a Groq key on the customer's PC.
There are contract tests that enforce the current boundary —
`src/management/build/runtime-credential-boundary-contract.test.js` and
`platform-secret-isolation-contract.test.js` — and they will need an explicit,
deliberate decision, not a silent removal. This is a product/security
decision for the owner, not a code cleanup.

Expected result if adopted: turns ~1.2–1.5s instead of 2.5–3.7s.

### 2. ~500ms per database round trip inside the container
Measured: heartbeat 1664ms minus 171ms of base response time, over 3 round
trips. The database sits far from the Suga container.

**Not a code problem.** Options are a Supabase region nearer the container,
or the Supavisor transaction pooler, which is often materially faster than a
direct connection over a long path. Owner decision — infrastructure change.

### 3. VAD end-of-speech 700ms
The floor before transcription even starts. Cutting it re-broke truncation
earlier in this work, so it was deliberately left alone. Only revisit with the
dead-line ceiling logic already in place, and re-run the long-speech tests.

## Unexplained: first-turn STT outlier
One run showed turn 1 STT at **7751ms** while turns 2–4 were normal. Not yet
explained. Possibly a cold first request. Instrument it before assuming.

## Diagnosis mistakes made this session — do not repeat
Three wrong root causes in a row, each stated confidently:
1. "It's the DB round-trip count" — batching changed 1668ms → 1664ms.
2. "It's the Prisma client not being cached in production" — no change.
3. "It's slow hosting, can't fix in code" — **wrong. The platform answers a
   warm request in 171ms.** The half-second floor was PowerShell
   `Invoke-WebRequest` measuring itself.

**The lesson:** time an endpoint that does no database work *first*, and
measure with a keep-alive connection (`src/management/build/floor-probe.cjs`
does this). Never trust a convenient number over an isolated variable.

Also: never bulk-edit source with PowerShell `Get-Content -Raw` +
`WriteAllText` — it reads UTF-8 as ANSI and silently destroys every non-ASCII
string. It corrupted all Urdu/Russian/Chinese/Spanish literals in
`call-runner.js`. Use the Edit tool.

## Build the engine (this is easy to forget and silently skips every fix)
Deploying to Suga deploys the **gateway only**. The engine is a separate binary
and must be rebuilt, installed and released, or agent-side fixes never ship.
This cost most of a day.

```
Stop-Process -Name agent,MagicDialer -Force        # Windows locks the exe
node build/bundle.js
npm install @yao-pkg/pkg --no-save                # not a checked-in dep
node node_modules/@yao-pkg/pkg/lib-es5/bin.js build/dist/agent-bundle.js ^
  --targets node22-win-x64 --output build/dist/MagicDialer.exe
node build/patch-gui.cjs build/dist/MagicDialer.exe
Copy-Item build/dist/MagicDialer.exe "$env:LOCALAPPDATA\Magic Dialer\agent.exe" -Force
```
Version is declared in **four** places and must move together: `agent.js`,
`installer.iss`, `launcher.cs`, `.github/workflows/build-windows-engine.yml`
(`ENGINE_VERSION`). `release-version-consistency.test.js` enforces this.
Verify the built bundle actually contains the fix before installing.

## Deploying the gateway
There is no deploy tool in the Suga MCP (43 tools, none deploy).
`replace_draft` only stages. A `set_env_variable` change sometimes triggers a
deployment but is unreliable. The UI click is the real path:
`https://dashboard.suga.app/project/<project>/env/<env>?action=review-draft`
The MCP OAuth token expires roughly hourly — re-run `sugamcp/oauth.cjs` and
open the URL it prints when calls start returning `{}`.

## Fixed and verified this session
- Opener waits for a voice, answers whoever spoke first, never repeats itself
- Long prospect speech no longer clipped (was: "What do you"); listen-window
  ceiling re-based on the last voiced frame
- "Who is it?" answered from config, not a callback deflection
- Brief brain outage no longer hangs up an interested lead
- Heartbeat priority lane — heartbeats no longer delay a reply
- Gateway AI retry cascade capped (4s/1800ms) — no more HTML-502s
- Engine 1.4.69 published, CI green, full suite green

## Verification tooling worth keeping
- `src/management/build/audio-sim.js <scenario>` — real WAV → real VAD/STT/brain/TTS, per-stage ms
- `src/management/build/floor-probe.cjs` — keep-alive vs fresh-connection latency
- `src/management/build/gateway-breakdown.cjs` — isolates DB cost from provider cost
- `src/management/build/stt-path-compare.cjs` — gateway vs direct Groq
- `src/management/build/tts-latency-probe.cjs` — separates TTS handshake from synthesis