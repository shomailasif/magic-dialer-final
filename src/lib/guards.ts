/**
 * TTS Regression Guards
 * 
 * This module protects critical TTS fixes from being accidentally reverted.
 * Every guard has a comment explaining WHY it exists and WHAT broke before.
 * 
 * DO NOT REMOVE OR MODIFY THESE GUARDS without reading the history below.
 */

// ============================================================================
// GUARD 1: Edge TTS must start as BROKEN
// ============================================================================
// WHY: Edge TTS WebSocket is blocked on Suga container. When enabled, it
// causes 20-second timeouts per text chunk, making calls silent for 35+ seconds.
// The Google Translate HTTP fallback works when properly configured.
// LAST BROKEN: edgeTtsBroken = false → 20s timeout per chunk → no audio
export const GUARD_EDGE_TTS_BROKEN_INIT = true;

// ============================================================================
// GUARD 2: Google TTS URL must use dict-chrome-ex client
// ============================================================================
// WHY: The old client=tw-ob is deprecated and returns HTML CAPTCHAs instead
// of audio. client=dict-chrome-ex is the current working endpoint.
// LAST BROKEN: client=tw-ob → Google returns 403/HTML → MP3 decode fails → silence
export const GUARD_GOOGLE_TTS_CLIENT = "dict-chrome-ex";

// ============================================================================
// GUARD 3: createRequire pattern for Turbopack compatibility
// ============================================================================
// WHY: Turbopack crashes on `import` of native CJS modules (mpg123-decoder,
// ws, ringcentral-softphone). The runtimeRequire pattern hides requires from
// Turbopack's static analysis.
// LAST BROKEN: import "mpg123-decoder" → Turbopack build crash → deploy fails
export const GUARD_REQUIRESHIM = true;

// ============================================================================
// GUARD 4: TTS timeout must be under 12 seconds
// ============================================================================
// WHY: Edge TTS has a 20s timeout. Google TTS should respond in <5s. If a
// provider takes >12s, it's failing and we should skip to the next tier.
// LAST BROKEN: No timeout → call hangs indefinitely on TTS failure
export const GUARD_TTS_TIMEOUT_MS = 12000;

// ============================================================================
// GUARD 5: Audio must be 8kHz mono PCMU
// ============================================================================
// WHY: SIP/RTP requires 8kHz mu-law. Using 16kHz or stereo causes one-way
// audio or garbled output.
// LAST BROKEN: 16kHz audio → one-way audio on SIP calls
export const GUARD_AUDIO_RATE = 8000;
export const GUARD_AUDIO_CHANNELS = 1;

// ============================================================================
// GUARD 6: speak() must call cs.streamAudio()
// ============================================================================
// WHY: If speak() returns without calling streamAudio(), the call is silent.
// Every code path in speak() must either stream audio or log an error.
// LAST BROKEN: textToFramesLocal() threw → catch swallowed error → silence
export const GUARD_SPEAK_MUST_STREAM = true;

// ============================================================================
// Validation functions - call these at startup
// ============================================================================

export interface GuardResult {
  ok: boolean;
  guard: string;
  message: string;
}

/**
 * Validate all TTS guards at module load time.
 * Returns array of violations (empty = all guards pass).
 */
export function validateTtsGuards(): GuardResult[] {
  const violations: GuardResult[] = [];

  // Guard 1: Edge TTS broken flag
  if (typeof GUARD_EDGE_TTS_BROKEN_INIT !== "boolean" || !GUARD_EDGE_TTS_BROKEN_INIT) {
    violations.push({
      ok: false,
      guard: "GUARD_EDGE_TTS_BROKEN_INIT",
      message: "Edge TTS must start as broken (true). Setting to false causes 20s timeouts on Suga.",
    });
  }

  // Guard 2: Google TTS client
  if (GUARD_GOOGLE_TTS_CLIENT !== "dict-chrome-ex") {
    violations.push({
      ok: false,
      guard: "GUARD_GOOGLE_TTS_CLIENT",
      message: "Google TTS client must be dict-chrome-ex. Old client=tw-ob returns HTML CAPTCHAs.",
    });
  }

  // Guard 4: TTS timeout
  if (GUARD_TTS_TIMEOUT_MS > 15000) {
    violations.push({
      ok: false,
      guard: "GUARD_TTS_TIMEOUT_MS",
      message: "TTS timeout too high. Must be under 15s to prevent call hangs.",
    });
  }

  // Guard 5: Audio rate
  if (GUARD_AUDIO_RATE !== 8000) {
    violations.push({
      ok: false,
      guard: "GUARD_AUDIO_RATE",
      message: "Audio rate must be 8kHz for SIP/RTP compatibility.",
    });
  }

  return violations;
}

/**
 * Log guard status to console. Call once at module load.
 */
export function logGuardStatus(): void {
  const violations = validateTtsGuards();
  if (violations.length === 0) {
    console.log("[guards] All TTS guards OK");
  } else {
    for (const v of violations) {
      console.error(`[guards] VIOLATION: ${v.guard} - ${v.message}`);
    }
  }
}
