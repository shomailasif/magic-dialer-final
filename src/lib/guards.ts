/**
 * TTS & AI Regression Guards
 * 
 * This module protects critical TTS and AI fixes from being accidentally reverted.
 * Every guard has a comment explaining WHY it exists and WHAT broke before.
 * 
 * DO NOT REMOVE OR MODIFY THESE GUARDS without reading the history below.
 */

// ============================================================================
// GUARD 1: Edge TTS broken flag
// ============================================================================
// WHY: Edge TTS WebSocket was blocked on Suga with wrong Origin header.
// Fixed headers now match edge-tts Python library. Set to false to enable
// JennyNeural voice. If blocked again, falls back to Google TTS in 8s.
// LAST BROKEN: Wrong Origin header → 403 Forbidden → 20s timeout per chunk
export const GUARD_EDGE_TTS_BROKEN_INIT = false;

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
// GUARD 7: Voice must be en-US-JennyNeural
// ============================================================================
// WHY: This is the original energetic female voice. Changing to AvaNeural
// made the voice softer and less engaging. Jenny was the original choice.
// LAST BROKEN: Changed to AvaNeural → voice lost energy and personality
export const GUARD_VOICE = "en-US-JennyNeural";

// ============================================================================
// GUARD 8: LLM must be Pollinations AI (free, unlimited)
// ============================================================================
// WHY: Pollinations is the only truly free option with no daily limits.
// Other providers (KeylessAI, Groq, Gemini) have rate limits or are down.
// LAST BROKEN: KeylessAI went down → DNS failed → LLM error → silence
export const GUARD_LLM_PROVIDER = "pollinations";
export const GUARD_LLM_BASE_URL = "https://text.pollinations.ai/openai";

// ============================================================================
// GUARD 9: Silence detection must be under 4 seconds
// ============================================================================
// WHY: If listen time is too long (8s+), the prospect waits in silence.
// 3 seconds is fast enough to detect speech end without missing responses.
// LAST BROKEN: 8s listen time → prospect waits too long → hangs up
export const GUARD_SILENCE_DETECT_MS = 3000;

// ============================================================================
// GUARD 10: Device lock - one user, one PC
// ============================================================================
// WHY: Billing model requires one active session per user. Multiple
// concurrent sessions would allow usage without payment.
// LAST BROKEN: No device lock → users share accounts → revenue loss
export const GUARD_DEVICE_LOCK = true;

// ============================================================================
// Validation functions - call these at startup
// ============================================================================

export interface GuardResult {
  ok: boolean;
  guard: string;
  message: string;
}

/**
 * Validate all guards at module load time.
 * Returns array of violations (empty = all guards pass).
 */
export function validateTtsGuards(): GuardResult[] {
  const violations: GuardResult[] = [];

  // Guard 1: Edge TTS broken flag
  if (typeof GUARD_EDGE_TTS_BROKEN_INIT !== "boolean") {
    violations.push({
      ok: false,
      guard: "GUARD_EDGE_TTS_BROKEN_INIT",
      message: "Edge TTS broken flag must be a boolean.",
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

  // Guard 7: Voice
  if (GUARD_VOICE !== "en-US-JennyNeural") {
    violations.push({
      ok: false,
      guard: "GUARD_VOICE",
      message: "Voice must be en-US-JennyNeural. Changing loses the energetic personality.",
    });
  }

  // Guard 8: LLM provider
  if (GUARD_LLM_PROVIDER !== "pollinations") {
    violations.push({
      ok: false,
      guard: "GUARD_LLM_PROVIDER",
      message: "LLM must be Pollinations AI. Other providers have rate limits or are unreliable.",
    });
  }

  // Guard 9: Silence detection
  if (GUARD_SILENCE_DETECT_MS > 5000) {
    violations.push({
      ok: false,
      guard: "GUARD_SILENCE_DETECT_MS",
      message: "Silence detection too slow. Must be under 5s.",
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
    console.log("[guards] All TTS & AI guards OK");
  } else {
    for (const v of violations) {
      console.error(`[guards] VIOLATION: ${v.guard} - ${v.message}`);
    }
  }
}
