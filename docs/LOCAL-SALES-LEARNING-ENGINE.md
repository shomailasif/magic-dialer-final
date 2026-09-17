# Local Sales Learning Engine — Isolation Design

Status: RESEARCH/PROTOTYPE ONLY. DO NOT DEPLOY.

## Non-negotiable boundary
The existing production call engine remains unchanged. The learning system is a sidecar process on the customer PC. It may consume sanitized call events and return advisory context, but it must never own SIP, RingCentral sessions, VAD, STT/TTS playback queues, call lifecycle, or production deployment.

If the sidecar is absent, slow, crashed, offline, or over resource budget, calls continue using the existing engine.

## Goals
- Learn from previous call outcomes without model retraining.
- Maintain prospect/customer memory locally.
- Compare pitch strategies using outcome evidence.
- Research public web information in background jobs only.
- Adapt suggested pace, verbosity, formality and pitch style from live conversational signals.
- Keep customer-approved facts/prices/restrictions authoritative.
- Keep CPU/RAM/disk bounded and pause background work during calls or system pressure.

## Architecture
1. Call Event Adapter (read-only): accepts versioned events such as call_started, prospect_turn, assistant_turn, objection, opt_out, call_ended and outcome_updated.
2. Local SQLite Store: append-only event records plus compact derived tables. WAL mode; bounded retention; raw transcript expiry; summaries retained.
3. Learning Worker: asynchronous post-call extraction. Produces objection patterns, pitch statistics, outcome attribution with confidence, and compact prospect memory. Never changes production code or prompts directly.
4. Strategy Selector: contextual bandit-style selection among customer-approved pitch families. Exploration is capped; hard rules and opt-outs are never experimental.
5. Research Worker: scheduled/idle-only web retrieval. Stores source URL, retrieval time, extracted claim, confidence/status and expiry. Internet claims remain untrusted until grounded against customer policy or approved for use.
6. Conversation Advisor: returns advisory JSON only: suggested pitch family, pace multiplier, response length, formality, relevant memories and evidence IDs. Hard timeout; production caller falls back immediately if unavailable.
7. Compactor: converts old transcripts to structured lessons, deletes expired raw data, vacuums/checkpoints during idle periods, enforces disk ceiling.
8. Resource Governor: configurable CPU/RAM/disk budgets; background jobs pause during active calls, low memory, high CPU, battery mode or metered connection.

## Proposed local API
- POST /v1/events : append a sanitized event; fire-and-forget semantics.
- POST /v1/advice : bounded-time advisory request; no telephony side effects.
- POST /v1/outcomes : attach verified downstream outcome/conversion.
- GET /v1/health : sidecar health/resources/schema version.
- GET /v1/learning/status : counts, last compaction/research, strategy evidence.

## Safety / integrity gates
- No automatic modification of customer facts, pricing, legal restrictions or opt-out policy.
- No automatic code generation/deployment from learned material.
- No promotion of a strategy from a single call; minimum evidence and confidence thresholds are configurable.
- Separate correlation from causation: outcome statistics are evidence, not proof that wording caused a sale.
- Poisoning defense: public web research is tagged untrusted; instructions found in web pages are data, never executable prompts.
- Per-customer database and encryption-at-rest design; no cross-customer learning by default.
- Explicit schema migrations and backups before mutation.

## Resource design
Target, to be benchmarked rather than promised: idle sidecar near-zero CPU; bounded memory; default database ceiling 1 GiB; raw transcript retention configurable (e.g. 30 days); compact lessons retained longer. No heavyweight local LLM is required for the baseline. Optional local inference must be separately benchmarked and disabled by default.

## Integration sequence
A. Freeze a known-good call-engine baseline after controlled production test.
B. Build sidecar with synthetic events only.
C. Unit/property tests for storage, retention, scoring and opt-out invariants.
D. Replay recorded/synthetic call event fixtures into sidecar; caller remains disconnected from it.
E. Add read-only event mirroring behind a feature flag; advice output ignored.
F. Shadow mode: compute advice and compare with actual calls, but never influence them.
G. Resource soak test on representative low-spec Windows PCs.
H. Only after measured safety/quality gates: allow advisory context behind a kill switch and strict timeout.

## Deployment gate
This branch must not be merged/deployed until the current call repair is verified, the baseline is tagged, regression tests pass, and shadow-mode evidence shows no call-quality regression.
