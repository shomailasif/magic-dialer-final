# CHECKPOINT — verified state only. Nothing here is aspirational.

Repo: `C:\Users\USER\Documents\Default Project\autodial-ai`
Branch: `build/local-call-engine-v2` → push `final HEAD:main`. Never `origin`. No amend, no force-push.
Latest deployed commit: **edefee6** — deployed on `final/main`. It is `47673e3` (dead-air fix) plus this doc and nothing else, so both are live and the deployed code is `47673e3`.
Required check before any push:
`powershell -NoProfile -ExecutionPolicy Bypass -File src\management\build\run-all-tests.ps1`
must end `ALL REQUIRED REGRESSION SUITES PASSED`. It does, as of 47673e3.

## Live
- Site: `https://0nrl0r6g7wyn-production-4w2zqfnq.europe-west1.suga.run` — UP, HTTP 200
- Database: **Supabase Postgres**, live and serving. `DATABASE_URL` set on Suga as a secret, container `0nrl0r6g7wyn`, env `d31e44b8-2da7-4887-87af-de2bb2ea1edf`.
- DB is reached **only** via the IPv4 pooler: `aws-0-ap-northeast-1.pooler.supabase.com:5432`, user `postgres.ojzcvhxygtkhhtqlpuwj`. The direct host is IPv6-only and Suga cannot resolve it. Do not "fix" this back.
- 18,730 rows migrated, all table counts source==target, 29/29 foreign keys verified orphan-free.
- Per-account leads: zaz3 7725 · zaz1 6465 · zaz2 3036 · demo 14. Users: 9.
- The old SQLite file still exists on the Suga volume as a snapshot fallback. It is NOT being written to.

## Verified working
- Login, session auth, role/subscription checks, `/dashboard`, `/calls`, `/leads` all serve real data from Postgres.
- Writes land (PC heartbeats observed being written seconds after a write test).
- One-click button: `POST /api/queue-command` returns `ok:true` for both start and stop. Verified live.
- `voipShared` column restored as boolean; 3 accounts shared, 3 not.
- Backup: `C:\Users\USER\Documents\MagicDialerBackup\backup-2026-10-01T17-39-53-718Z` — 2.2MB, 500 leads/account only. Not a full backup.

## Security
- Supabase RLS enabled on all 24 tables, `anon`/`authenticated` revoked. Verified: anon cannot read `DialerConfig` or `PasswordReset`. Remaining Supabase linter findings are INFO only ("RLS enabled, no policies") — that is the intended state for an owner-only app. **Do not add policies.**
- DB password was reused from the Supabase login password and appeared in chat. User changed the login password; ask them to reset the *database* password separately.

## Bugs FOUND and their exact locations — the real remaining work
Source of truth: RingCentral transcript of the 2026-10-06 test call + `watchdog-child.log`.

**1. DEAD AIR — FIXED at 47673e3.** `src/management\agent\local-call-controller.js`, `STT_ATTEMPT_BUDGET_MS` 5000→2500. Turn latency was 11–15s (two 5s STT attempts before the AI was ever asked). Expect roughly halved. **Not yet confirmed by a real test call.**

**2. REPEATED QUESTION — NOT FIXED. Cause is known.**
`src\management\agent\call-runner.js` lines ~176–184: `askedFor` / `stripRepeatedAsks` dedupe on **exact phrasing**. The agent asked *"What type of truck do you operate?"*, then *"what kind of truck you operate?"*, then the same again. Paraphrases bypass the guard, so the same question was asked 3 times.

**3. REFUSAL IGNORED — NOT FIXED.**
Prospect said *"I told you I'm a bit busy right now"* at 2:01 and again at 2:35. Agent apologised ("Sorry.") and kept qualifying for ~60s. Needs refusal detection → stop qualifying, close politely.

**4. SILENT TURN ON AI FAILURE — NOT FIXED.**
`AI gateway returned non-JSON (HTTP 502)` and `AI gateway timed out after 7000ms` produced a turn with **no reply at all** — pure dead air. Needs a spoken fallback line.

**5. GARBAGE SPOKEN ALOUD — NOT FIXED.** Agent voiced raw truncated model output: `…" is now a` and ``follow…?`up ``. Turn sanitiser is not catching incomplete/fragmentary replies. `isUsableOpening` exists but only guards the opening.

## Do NOT claim these are fixed. They are not.

## Hard-won rules for this codebase
- Prisma raw SQL placeholders differ by provider: SQLite `?`, Postgres `$1`. Production is Postgres — 49 wrong ones once broke the one-click button with 503.
- `scripts/production-db-bootstrap.cjs` runs before `next start` and refuses to boot on failure. It had a Postgres branch added; SQLite legacy path unchanged.
- Never put `prisma db push` in the startup path. It took the site down before.
- The agent-side PC code (`src\management\agent\db.js`, `agent-bundle.js`) legitimately uses its own local SQLite. That is separate from the portal database — do not "fix" it.
- Local `node_modules\@prisma\client` must match the local schema when running the test suite (SQLite for the suite, Postgres for a Postgres build). Mismatch causes false suite failures.
- `src\management\vitest.config.ts` was created and then deliberately deleted — the runner uses `tsx`, not vitest. Do not re-add it.
- Suga has `set_secret`/`set_env_variable` MCP tools but **no deploy tool**; the deploy button in the UI cannot be automated. Token lives at `sugamcp\token.json`; `node sugamcp\refresh.cjs` renews it.

## Next session — first instruction to give
"Continue from CHECKPOINT.md. Dead air is done. Fix the paraphrase repeat-question guard, refusal handling, silent-turn fallback, and fragment sanitiser. One test call after each."