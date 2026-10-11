# Magic Dialer — state at end of session 2026-10-09

## First-turn STT outlier — mechanism found and fixed, engine 1.4.72

Cold start was already ruled out. Reading the logs instead of theorising found
the actual mechanism, and it was a bug in the *bound* rather than in the network.

**The budget was per attempt, twice.** `STT_ATTEMPT_BUDGET_MS = 12000` ×
`STT_ATTEMPTS = 2` meant a single turn could spend **24s** on transcription.
Worse, the gateway's own provider budget is 4500ms — a request that blows it
returns 5xx rather than hanging — so the controller saw a "failure" at ~4.5s,
waited 200ms, and paid a *second* 12s for an answer the first attempt was about
to produce. That is exactly the shape of a multi-second outlier.

Now there is **one 9000ms budget for the whole turn**, shared by every attempt
(`STT_TURN_BUDGET_MS`), each attempt bounded by what is *left*, and a second
attempt skipped rather than started when it cannot finish. A per-attempt bound is
not a bound on the turn — the same mistake as `BRAIN_BUDGET_MS` and the gateway's
retry cascade.

**Success was never logged.** Only failures produced a line, so a
slow-but-successful transcription — the one that actually costs a prospect time
and produces no error message — left no trace. That is precisely why a 7751ms
first-turn STT could be observed and never explained. Every attempt is now timed
on success too, with the leg that answered (`direct` / `gateway-fallback` /
`gateway`), and the turn total is reported with its attempt count.

## The regression suite was reporting passes it never ran

Worth reading before trusting any "full suite green" in this repo.

`agent/local-call-controller.behavior.test.js` **exited 0 and printed nothing.**
`main()` awaited `scenarioSpeechBargeIn`, whose stub resolves playback only on a
barge-in interrupt; no interrupt meant the promise never settled, and because
nothing else held the event loop open node exited silently with code 0. The
runner saw 0 and recorded a pass.

Everything after that hang had **never executed** — including a barge-in
assertion that said `700ms` while the code declared `400ms`, and the
`endSilenceMs: 400` assertion that would have caught the inert adaptive VAD.
Running it exposed four wrong fixtures, all pre-existing:

1. **Frames pushed synchronously.** The controller decides barge-in partly from
   wall-clock time; 50 frames in one tick advanced the frame counter while the
   clock stood still. Real telephony delivers one frame per 20ms.
2. **Speech too short to clear the yield.** The fixture spoke for ~240ms against
   a 400ms `BARGE_YIELD_MS`, so the next silent frame reset the counter. The
   controller was right; the fixture talked for less than a person does.
3. **`{...engine}` spread.** The stub spread its engine into a new object, so
   overrides installed on the original were never the ones the controller called.
   It looked correctly wired in the source.
4. **A Devanagari opening on an English locale.** `driveListenWindow` asserted
   `sends === 1`, but the controller correctly refuses to put non-Latin script
   through a voice that cannot speak it, so `sends` was 0. The assertion had been
   dead long enough to be wrong.

Every step now runs under a named timeout, so a hang is a **named failure**, not a
silent exit. Barge-in yield is read from the source instead of restated as a
literal — restating it is how it drifted to 700 unnoticed.

## audio-sim: a harness that exhausts the quota it is measuring

`--provider=direct` reported INCONCLUSIVE on every scenario. The harness was
honest; the problem was upstream of it: the scenario gap was a flat 3s and the
in-turn cadence was as fast as the real-time audio loop produced, which is faster
than the provider's tokens-per-minute budget.

Now: **adaptive pacing between scenarios, doubling back-off on a 429** (capped at
30s), decaying when calls succeed. And the verdict distinguishes
`provider RATE LIMITED` from a provider outage, because they need opposite
responses — wait versus raise the limit. "the provider failed" read like the
product was broken when the account was simply out of budget.

The INCONCLUSIVE verdict itself is **unchanged and still non-zero exit**: a run
where the provider failed must not be mistaken for a passing run.

## Where this actually stands

| item | state |
|---|---|
| 1. gateway bypass | **DONE** — engines 1.4.70/1.4.71/1.4.72 built, installed, verified. Turn **2854ms → 1186ms** |
| 2. DB round trip | **code done, infra blocked on you** — ~247ms/round trip is the ocean; move the Supabase region to `europe-west1`. The pooler will *not* fix it |
| 3. VAD 700ms | **DONE** — adaptive 300–700ms, plus a real deafness bug fixed |
| first-turn 7751ms outlier | **mechanism found and fixed** (engine 1.4.72) — a per-attempt budget that let one turn spend 24s, and successes were never timed so the case could never be diagnosed |
| regression suite | **was reporting passes it never ran** — a test hung and exited 0 silently; fixed, with hangs now named failures |

Also found and fixed while verifying the above: the system prompt was 7362 chars
of instructions re-sent every call, which was the **root cause** of most of the
provider rate limiting. Now 4466. Three further direct-path defects (no retry on
a rate limit, retrying a limit that cannot clear in-turn, HTTP-200-empty on token
truncation) are fixed and covered.

Full suite green, `tsc --noEmit` clean, engine reports `version=1.4.72`.

**Not verifiable right now:** the account's tokens-per-minute is exhausted from
testing, so `audio-sim --provider=direct` reports INCONCLUSIVE rather than a
result. That is a quota state, not a code state — it will clear on its own.
STT is unaffected (the whisper endpoint is a separate limit and answers 200).

## What "perfect" actually requires

Turns are currently **2.5–3.7s**, down from 9–13s. The remaining cost is
structural, and three items are left. In order of impact:

### 1. Gateway bypass — DONE, engines 1.4.70 → 1.4.72

**Status: implemented, built, installed and verified.** See "What changed" below for
the measured result. The summary of the decision and the numbers behind it:

Every reply cost two gateway HTTP round trips: one for STT, one for the brain. The
engine already had direct-Groq paths; they were fallbacks. They are now primary
**when the PC holds a key**, with the gateway as the fallback and as the default
for anyone who does not opt in.

Measured end to end through the engine's own code, same process pair, real mu-law
audio, 5 rounds per path (`build/direct-path-verify.cjs`, clean run, 0 fallbacks):

| stage | via gateway | direct first | saved |
|---|---|---|---|
| STT | 1182ms | 210ms | 972ms |
| brain | 1672ms | 976ms | 696ms |
| **turn** | **2854ms** | **1186ms** | **1668ms** |

The saving is larger than the 509ms the stage probe predicted, because the brain
leg was under-measured there (one sample, warm, no concurrency).

**A direct path does not just skip the hop, it skips the quota write.** That is
the part to be honest about with a customer: opting in means the platform no
longer meters that PC's AI usage through the gateway. Local quota is not
implemented, so the abuse control for a direct-key install is the key owner's own
account limits. That is a real trade, not a free win.

#### What the two "boundary" contract tests actually covered
MEMORY.md said `runtime-credential-boundary-contract.test.js` and
`platform-secret-isolation-contract.test.js` enforced this boundary deliberately.
**They do not, and never did.** Both pass unchanged after this work. They pin
server-side *telephony and mail* secrets — tenant dialer `apiKey`/`accountSid`/
`sipPassword` decryption, and the platform not holding SMTP/SIP/RC JWT secrets.
Neither reads the engine's AI path. The boundary that was actually load-bearing
("the engine never holds a provider key") was a comment, not a test.

So rather than weaken two tests that were enforcing something else, the new
boundary is pinned by a new test:
`build/engine-provider-key-boundary-contract.test.js` — opt-in, encrypted at rest,
never sent to the portal, gateway still holds its own key, removable.

#### The new boundary, in one place
- **Opt-in.** No local key = exactly the old behaviour. Nothing is required of a
  customer. `GET/POST /api/provider-key` on the local engine (127.0.0.1:48771).
- **At rest**: AES-256-GCM, `enc:v1:` envelope, random per-machine wrapping key in
  a separate owner-only file, `icacls /inheritance:r`. A copied `provider.json`
  alone yields nothing — asserted by the contract test.
- **Honest limit**: anything running as that Windows user can read the key, because
  it has to be able to use it. This protects a copied config, a backup and a
  support engineer with file access. It does not protect against malware already
  running as the user. No local scheme does — which is the real argument for
  keeping the gateway as the default.
- **Fallback**: a direct failure falls through to the gateway in the same turn,
  and a circuit breaker (`stt-direct` / `brain-direct`) stops paying once the
  provider is provably dead. The breaker is deliberately **off when there is no
  gateway** — failing fast with nowhere to fall back to turns a slow turn into no
  turn, which is the failure `brain-outage.behavior.test.js` exists to prevent.
  That was a real regression caught by the suite, not a hypothetical.

#### Three defects the direct path introduced, all found by running it
The direct path shipped working and then failed in ways only real traffic shows.
Each was found by the harness, not by reading the code.

**1. A rate limit is not an outage, and must not be retried in-turn.** The first
version had no retry and no second model, so it was *less* survivable than the
gateway it replaced — audio-sim returned HTTP 429 on every brain call and the agent
answered with canned recovery lines. Fixed with the gateway's own shape: retry a
transient status once, honour `retry-after`, fall through to the second model.

Then the retry itself became the bug. Measured on the live key: a 429 comes back
in **~100ms**, and it is a **tokens-per-minute** limit. Retrying it inside a 7s
budget cannot clear a limit measured in minutes, so every retry was a guaranteed
failure that spent the prospect's entire wait — audio-sim showed brain at 7003ms,
the whole budget. **429 is now never retried in-turn**; it goes straight to the
second model, which answers in ~550ms. `retry-after: 120` is clamped to the
deadline, because a provider asking for two minutes is asking a prospect to wait
two minutes.

**2. An open-weights model can run out of room and return HTTP 200 with empty
content.** `finish_reason: "length"`. Handled by one extra attempt with double the
token allowance — and it must be handled for **both** models, because the second
model answers in ~190 tokens against a 220 limit and truncates too.

**3. The direct path started on the model that was rate-limited.** `gpt-oss-120b`
is better and is still what the gateway uses, but on a live key its TPM is spent.
The direct path now starts on `20b` and falls back to `120b`.
`AUTODIAL_GROQ_MODEL`/`GROQ_MODEL` still override, and either model can be first.

#### The system prompt was the actual cause of most of the 429s
7362 characters — roughly **2100 tokens — re-sent on every call**. The provider's
limit is tokens-per-minute. Measured directly: a *short* prompt answers HTTP 200
in ~400ms while the real one returns 429 on every model. Re-sending 2100 tokens of
standing instructions on a 3-second-turn conversation exhausts the budget, and
after that the agent talks in canned recovery lines.

It is now **4466 chars / ~1022 tokens** — same rules, one short sentence each,
duplicates removed ("never ask twice" appeared three times). Groq does not support
`cached: true` on these models, so there is no caching to lean on.

`agent/brain-prompt-coverage.behavior.test.js` pins both halves: a size ceiling,
and **18 rules each mapped to the real defect it prevents**. A future trim has to
come here and say which recorded failure it is willing to risk.

### 2. ~500ms per database round trip inside the container — PARTLY DONE, needs your Supabase access

**Confirmed and priced: ~247ms per DB round trip.** Measured as
(`runtime-proof` − `health`) / 3, both over one keep-alive connection.

**It is genuinely the ocean, and the pooler will not fix it.** The container is
`europe-west1`; a TCP connect from this machine to that host is **27ms**. A
247ms round trip is not a 27ms host being busy — the database is roughly a
transatlantic hop away. Supavisor runs in the *same region as the project
database*, so pointing `DATABASE_URL` at the pooler leaves the ocean crossing
exactly where it is and buys nothing. **Moving the project region to europe-west1
is the fix.** MEMORY.md previously presented pooler and region as interchangeable
options; they are not, and the pooler option is the one that does not work here.

Done in code, ready for the flip:
- `src/lib/db.ts` now picks the pool limit from the URL: **1** connection per
  process against a pooler (Prisma's pool multiplies against Supavisor's, and a
  container sized from a large core count will exhaust the pooler and then queue
  on connection acquisition — which looks exactly like a slow database), **10**
  against a direct database. An explicit `connection_limit` in the URL still wins.
- `src/lib/db.ts` logs the real round trip **from inside the container** at
  startup, five samples of `SELECT 1` on a warm pooled connection. Never fatal,
  skips a local file database, and always reports a non-empty reason. Read this
  line in the boot log after the region move to confirm the fix.
- `sugamcp/db-distance-probe.cjs` prints the production DB host, whether it is
  already pooled, and the TCP floor — credentials are never printed.

**Still needs you, and I cannot do it from here.** Region is bound at project
creation — there is **no in-place region change**, and neither dashboard flow
helps: the in-place upgrade swaps the instance inside the same region, and
"Restore to a New Project" clones into the *source's* region. So this is always
a new project + data move + repoint.

`src/management/build/cutover-region.mjs` walks it, with gates that refuse to declare success
on an unverified run:

```
node src/management/build/cutover-region.mjs --verify     # read-only; safe to run now
node src/management/build/cutover-region.mjs --plan       # prints the steps, changes nothing
node src/management/build/cutover-region.mjs --dump  --confirm
node src/management/build/cutover-region.mjs --restore --confirm
node src/management/build/cutover-region.mjs --repoint
```

Deliberate design choices in that tool, each of which is a way this could have
gone wrong quietly:
- It **never edits the Suga environment.** `--repoint` prints what to do by hand.
  A script that repoints production at an unverified database is precisely the
  failure it exists to prevent.
- `--dump` / `--restore` refuse without `--confirm`, and `--restore` refuses an
  empty dump (an empty dump is not a migration).
- **Credentials are never printed** — host, region and pooler only.
- `--verify` compares TCP floors and **says so if the target is not closer**, so
  a pointless migration does not get justified by optimism.
- The number that actually decides it is the boot log after the repoint, not the
  probe: `[db] direct round trip median XXms`, and **above 100ms means roll
  `DATABASE_URL` back**. The old project stays authoritative until that passes.

**Two gotchas worth knowing before you start.** The pooler hostname embeds the
region (`aws-<n>-eu-west-1.pooler.supabase.com`) — hand-editing the region into
the old host points you at the wrong cluster, so copy the whole string from the
new project's Connect panel. And the *direct* host (`db.<ref>.supabase.co`) is
**IPv6-only** unless the project has the IPv4 add-on: verified here, the direct
host was unreachable from this machine while the pooler host answered in
201–1015ms. If the container is IPv4-only, the pooler is not optional.

This app uses no Supabase Storage, Edge Functions, or OAuth provider callbacks,
so the move is Postgres only — the simple case.

Note that item 1 already removed the quota write from the hot path on a direct-key
install, which is the largest single DB cost in a turn. Item 2 is still worth
doing for every *other* route: the heartbeat makes four serialized round trips
(~1s) every three seconds, for the whole length of every live call.

### 3. VAD end-of-speech 700ms — DONE, engine 1.4.71

`src/management/agent/vad.js` now scales the guard with how long the prospect has
already been speaking, instead of waiting a flat 700ms every turn:

| speech so far | quiet required |
|---|---|
| under 1.2s | 700ms (unchanged — they have barely started) |
| 1.2–2.5s | 400ms |
| over 2.5s | 300ms (hard floor) |

Why this is safe *now* and was not before: transcription starts **speculatively**
at end-of-speech, a 250ms hold runs alongside it, and a prospect who resumes is
counted and re-transcribed whole. A premature end is corrected in the same turn
for one extra recognizer call, instead of the agent speaking back a truncated
sentence. `agent/vad-adaptive-eos.behavior.test.js` (9 tests) holds the line: a
short utterance still waits the full 700ms, a mid-sentence pause still does not
end the turn, and nothing ever goes under 300ms.

**A real deafness bug fixed on the way.** The noise floor was trained from the
first 20 frames *whatever they were*. A prospect who starts speaking immediately —
exactly what happens on an opening line — spent all 20 frames at full speech
level, the threshold became 2.6x **their own voice**, and the VAD could not hear
them for the whole utterance. Frames above `NOISE_TRAIN_CEILING` (1200 RMS; real
speech is 4000–10000, room noise is far below) no longer train the floor.

## The cold-start probe that ruled a theory out

`build/first-turn-probe.cjs` spawns a fresh node process per trial, which
separates per-process cold start from container warm state. 8 trials:

```
first trial 2295ms · median of the rest 1181ms · slowest 4133ms (trial 3)
```

Trial 1 was 1.94x the warm median — inside the spread the gateway shows on every
trial — and **the slowest trial was #3, not #1**. Cold start is not the cause,
and this probe is what stopped it being filed as the answer.

It did not, however, explain the outlier. That took reading the engine's own log
(`%LOCALAPPDATA%\Magic Dialer\watchdog-child.log`) instead of theorising — see
the section at the top of this file. The lesson is that ruling a theory out and
finding the cause are different amounts of work, and a probe that only does the
first is not a diagnosis.

## How the turn breaks down, and where the time went

`build/gateway-stage-probe.cjs` separates a turn into four stages that each add
exactly one thing, over one keep-alive connection. Median of 5, real mu-law 8kHz
audio so the provider does real work:

| stage | what it adds | ms |
|---|---|---|
| `GET /api/health` | platform floor, no DB | 172 |
| `GET /api/engine/runtime-proof` | 3 uncached DB reads | 912 |
| `POST /api/engine/ai/stt` (4 bytes) | device auth (cache hit) + quota write | 426 |
| `POST /api/engine/ai/stt` (real audio) | the whole turn | 705 |
| direct to Groq from this PC, same run | provider only | **195** |

Two findings from this that changed decisions:
- **Device auth costs ~7ms, not ~500ms.** The 3s cache in `engine-device-auth.ts`
  works. Auth was never the cost; anyone budgeting around it would be wrong.
- The **quota write is one DB round trip (~254ms)** and the platform floor is
  ~172ms. A direct key removes both *only because* a direct call does no local
  metering at all.

### Harness bugs found and fixed while measuring
Each produced clean, confident, wrong numbers — the exact failure mode this file
warns about. They are listed because the next person will hit them too:
1. `stt-path-compare.cjs` sends the 16kHz WAV raw, but the STT route mu-law-decodes
   and wraps at 8kHz. Groq transcribes noise, answers `"."`, and looks ~5x faster
   than real speech. It is kept for reference and marked in "Verification tooling"
   as not comparable.
2. `/api/health` and `/api/engine/runtime-proof` export GET only. POSTing returns
   405 before the handler body runs, which reads as a fast healthy stage and hides
   the database entirely.
3. Stages 1 and 2 are not nested, so they must not be differenced against each
   other — doing so reported auth+quota at **−505ms**. Each is differenced against
   the platform floor instead.
4. `direct-path-verify.cjs` originally cleared the on-disk key store to make a
   gateway-only baseline. That does not work: `providerKey()` reads
   `GROQ_API_KEY` from the environment first, so the "baseline" silently took the
   direct path too and the run compared direct against direct. Each phase now
   runs in its own child process with its own environment, and the run **refuses
   to report a comparison** if the baseline was not actually gateway-only.
5. Brain requests paced 250ms–3s apart return **HTTP 429** from the provider. A
   real conversation is seconds apart and does not. The probe now paces the brain
   like a call (≥7s) and counts fallbacks, refusing to quote a saving from a run
   where any direct call fell back.

## Diagnosis mistakes made this session — do not repeat
Three wrong root causes in a row, each stated confidently:
1. "It's the DB round-trip count" — batching changed 1668ms → 1664ms.
2. "It's the Prisma client not being cached in production" — no change.
3. "It's slow hosting, can't fix in code" — **wrong. The platform answers a
   warm request in 171ms.** The half-second floor was PowerShell
   `Invoke-WebRequest` measuring itself.

Five more were made *this* session, all of the same shape:
4. "The engine never holds a provider key, and two contract tests enforce it" —
   the engine did not, and neither test covered it. Both pass unchanged today.
   A stated boundary with no test behind it is a comment, not a constraint.
5. "The pooler and the region move are interchangeable options" — they are not.
   Supavisor sits in the database's region, so the pooler leaves the ocean
   crossing untouched. The pooler option would have been a wasted change.
6. "Turn 1 at 7751ms is probably a cold connection" — tested and wrong. The
   slowest trial was #3.
7. "A direct key saves ~509ms per STT" — real, but the end-to-end turn figure is
   **1668ms**, because the brain leg was under-sampled in the stage probe. A
   number from a single warm sample is a floor, not a measurement.
8. "The 429s are a rate-limit problem to be retried" — the rate limit was real,
   but the **cause** was our own prompt: 2100 tokens re-sent every turn. Fixed the
   retry, then fixed the cause. Diagnosing the symptom first bought a wasted
   round of work.
9. "The VAD 700ms is only a tuning number" — changing it surfaced a **deafness
   bug** underneath: the noise floor trained on the prospect's own first 20
   frames, so anyone who spoke immediately was inaudible.

**The lesson, unchanged and reinforced:** time an endpoint that does no database
work *first*, measure with a keep-alive connection, and never trust a number whose
baseline you have not actually observed. `floor-probe.cjs` and
`gateway-stage-probe.cjs` exist so nobody has to re-derive this. Every probe built
this session **refuses to print a verdict when its own run was invalid** — wrong
verb, audio that transcribed to noise, a baseline that was not what it claimed, a
direct path that silently fell back, or a provider that failed for reasons
unrelated to the agent (reported as INCONCLUSIVE, not PASS) all produce an
explicit "do not quote this run" rather than a number. Use that habit.

**And the corollary that cost the most this session:** *a fix that makes the
measured number better is not yet a fix.* The direct path measured 1668ms faster
and was, on the evidence, **worse** than the gateway it replaced — it had no retry,
no model fallback, and burned a full 7s budget on a rate limit that had already
answered in 100ms. The latency win and the correctness win were different work.

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
`installer.iss` (both `AppVersion` and the `known-good-*.exe` cache name),
`launcher.cs`, `.github/workflows/build-windows-engine.yml` (`ENGINE_VERSION`
*and* the `$version` in the release step). `release-version-consistency.test.js`
enforces this. Verify the built bundle actually contains the fix before installing
— `MagicDialer.exe` is not minified, so
`Select-String`-style substring checks on the exe read the real source.

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

- Engine 1.4.72 published locally, installed, reporting `version=1.4.72`; full
  suite green, `tsc --noEmit` clean. **Not yet released to GitHub** — the workflow
  publishes on push to `main`.

New files:
- `agent/provider-key.js` — local key store (AES-256-GCM, owner-only, opt-in)
- `agent/stt-turn-budget.contract.test.js` — one budget per turn, not per attempt;
  success and failure both timed and logged
- `agent/direct-provider.behavior.test.js` — 18 tests: call *order*, fallback,
  breaker, rate-limit handling, redaction. Not source shape.
- `agent/vad-adaptive-eos.behavior.test.js` — 9 tests: the truncation regression
  that stopped the VAD being cut before, plus the hard floor
- `agent/brain-prompt-coverage.behavior.test.js` — size ceiling, and 18 rules each
  mapped to the real defect it prevents
- `build/engine-provider-key-boundary-contract.test.js` — the new credential boundary
- `build/db-round-trip-contract.test.js` — pool limit follows the URL; round trip
  measured inside the container
- `build/gateway-stage-probe.cjs`, `build/first-turn-probe.cjs`,
  `build/probe-audio.cjs`, `build/direct-path-verify.cjs`,
  `sugamcp/db-distance-probe.cjs`

Changed:
- `multilingual-stt.js` / `intelligent-brain.js` — direct primary, gateway
  fallback, breakers, retry + model fallback + rate-limit handling, 20b-first
- `local-call-controller.js` — **one shared STT turn budget**; success timed and
  logged with the leg that answered
- `vad.js` — adaptive silence guard, noise-floor ceiling
- `webui.js` — `GET`/`POST /api/provider-key`, never echoes the key
- `src/lib/db.ts` — pooler-aware pool limit, in-container round-trip probe
- `audio-sim.js` — adaptive pacing, back-off on 429, rate-limit vs outage verdict
- `local-call-controller.behavior.test.js` — hangs are named failures; four
  fixtures corrected; barge-in yield read from source instead of restated
- `ai-retry-contract.test.js` — pins the *shared deadline* (every retry summed
  cannot exceed the budget) rather than a per-attempt literal, plus the derived
  model fallback
- `who-is-it.behavior.test.js` — assertions follow the rewritten prompt

## Turn on the direct path (opt-in, per PC)

```
POST http://127.0.0.1:48771/api/provider-key  {"key":"gsk_..."}   # store
GET  http://127.0.0.1:48771/api/provider-key                     # status only
POST http://127.0.0.1:48771/api/provider-key  {"clear":true}     # back to gateway
```

Verified live on the installed engine: a fresh one reports
`{"configured":false,"source":"none"}`; after setting, the file on disk holds
`enc:v1:...` and **not** the plaintext; after clearing, the file is gone. Or set
`GROQ_API_KEY` / `AUTODIAL_PROVIDER_KEY` in the environment instead and nothing
touches disk at all.

## Verification tooling worth keeping
- `src/management/build/gateway-stage-probe.cjs` — **start here.** Per-stage turn
  attribution (floor / DB / auth+quota / provider) plus a same-run direct
  comparison. Refuses a verdict if a stage did not do the work it claims.
- `src/management/build/direct-path-verify.cjs` — end-to-end A/B of gateway vs
  direct through the engine's own code, one process per phase. Refuses to quote a
  saving if the baseline was not gateway-only or if any direct call fell back.
- `src/management/build/first-turn-probe.cjs` — fresh process per trial; tests the
  cold-start hypothesis instead of assuming it
- `src/management/build/probe-audio.cjs` — shared WAV→mu-law 8kHz conversion.
  `.cjs` is not in CommonJS extension resolution order, so require it *with* the
  extension.
- `src/management/build/audio-sim.js <scenario>` — real WAV → real VAD/STT/brain/TTS, per-stage ms
- `src/management/build/floor-probe.cjs` — keep-alive vs fresh-connection latency
- `src/management/build/gateway-breakdown.cjs` — isolates DB cost from provider cost
- `src/management/build/stt-path-compare.cjs` — **not comparable**: sends raw WAV
  where the route expects mu-law 8kHz, so the direct numbers understate. Kept for
  reference only; use `gateway-stage-probe.cjs` instead.
- `src/management/build/tts-latency-probe.cjs` — separates TTS handshake from synthesis
- `src/management/build/cutover-region.mjs` — gated region migration. `--verify`
  is read-only and safe; `--dump`/`--restore` need `--confirm`; it never edits the
  Suga environment.
- `src/management/build/db-connection-audit.behavior.test.js` — the pooler/IPv6
  audit against **live DNS**, so a wrong-region host reports the wrong region
- `sugamcp/db-distance-probe.cjs` — production DB host via the Suga MCP. Lives in
  the gitignored `sugamcp/` because that directory holds a live OAuth token; it
  needs that token, so it cannot be committed. The cutover tool above needs no
  token and therefore lives in `src/management/build/` where it is tracked.