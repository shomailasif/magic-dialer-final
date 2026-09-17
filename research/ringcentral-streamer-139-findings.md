# RingCentral Softphone 1.3.9 media research

Research-only. No production behavior changes.

## Verified external contract

- Project dependency resolves to `ringcentral-softphone` 1.3.9.
- `PCMU/8000` input to `callSession.streamAudio()` must already be 8-bit mu-law, 8 kHz, mono.
- The SDK does not resample/convert mismatched audio.
- `streamAudio(Buffer)` starts streaming automatically and exposes `finished`; `stop()` ends without `finished`.
- The call session owns RTP sequence/timestamp/SSRC state; therefore a new Streamer does not by itself prove a new RTP identity.

## Verified application mismatch

Current application adds its own queue and watchdog around the SDK Streamer. `drainAudioQueue()` starts `streamAudio(next)`, but it can declare that item complete from an application timer (`expectedMs + 750`, minimum 1200 ms) rather than waiting exclusively for the SDK's `finished` event. Once that timer fires, the application starts the next queued Streamer even if the previous SDK Streamer has not emitted `finished`.

That creates a concrete possible overlap condition: two SDK Streamers can be active on the same CallSession. Because both share the CallSession RTP sequence/timestamp state, concurrent timed send loops can interleave updates/sends. This is materially different from sequential `streamAudio()` calls and is consistent with broken/chopped/out-of-order playback.

## Required proof before repair

Build an isolated deterministic harness with a fake CallSession/Streamer that deliberately completes later than the application's calculated watchdog. Assert that the current queue starts Streamer B before Streamer A finishes. Then validate a candidate lifecycle that advances the queue only on SDK `finished`/`error`/throw or explicit call disposal; no duration-derived success watchdog may start the next speech buffer.

Do not deploy based only on this document.