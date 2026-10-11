/* Lightweight PCMU voice-activity detector for live telephone audio.
 * No cloud service, model or timer-driven turn sequencing. A safety timeout
 * only prevents a dead call from waiting forever.
 */
function mulawDecode(u) {
  u = (~u) & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 1) + 0x21) << (exponent + 2);
  sample -= 0x84;
  return sign ? -sample : sample;
}

function rmsPcmu(buf) {
  if (!buf || !buf.length) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const s = mulawDecode(buf[i]);
    sum += s * s;
  }
  return Math.sqrt(sum / buf.length);
}

/* How long the line must be quiet before we believe the prospect finished.
 *
 * This was a flat 700ms, and it was flat for a good reason: 350ms cut three
 * people off mid-sentence on the 20:25Z call ("like this.", "of do.", "if I
 * can.") while the agent went on asking for a name it had never heard.
 *
 * But 700ms was chosen when a wrong guess cost a whole utterance. It does not
 * any more, and holding onto it now costs 700ms on every single turn - which is
 * more than half of what a turn costs once the gateway is out of the path.
 *
 * Three things make a shorter guard safe now, and this is the argument for
 * changing it rather than just lowering a number:
 *
 *   1. The pause required SHRINKS the longer they have been talking. Someone who
 *      has already spoken two seconds is at a natural clause break; someone 200ms
 *      in has not finished their first word. A fixed 700ms ignores that entirely,
 *      and the short utterances are the ones it hurts most in ratio.
 *   2. There is a hard floor. 300ms of true silence is past any breath or any
 *      interdigit pause, and a turn boundary inside a word cannot produce it.
 *   3. Getting it wrong is no longer silent. The controller starts transcription
 *      at end-of-speech SPECULATIVELY, keeps a 250ms hold open alongside it, and
 *      if the prospect resumes it counts voiced frames after the latch and
 *      re-transcribes the whole utterance. So a premature end is corrected in the
 *      same turn, at the cost of one extra recognizer call - instead of speaking
 *      back a truncated sentence.
 *
 * STOPS rather than thresholds: a prospect mid-sentence who pauses 400ms still
 * gets 400ms of quiet to be counted, and a turn boundary inside a word cannot
 * produce it. The 350ms failure was a *floor* problem - the window closed at
 * 350ms regardless of what the person was doing - and this keeps a floor.
 */
const QUIET_FLOOR_MS = 300;
const QUIET_MAX_MS = 700;

/* Above this the frame is a voice, not a room. Well under real speech (a normal
 * telephone voice measures 4000-10000 RMS here) and well over a noisy office, so
 * it separates "someone is talking" from "this is what the line sounds like". */
const NOISE_TRAIN_CEILING = 1200;

/* Speech duration at which each level of patience applies. Long enough to have
 * reached a clause break, in that order. */
const PATIENCE_STEPS = [
  { speechMs: 2500, quietMs: 300 },
  { speechMs: 1200, quietMs: 400 },
  { speechMs: 0, quietMs: 700 },
];

function createVad(opts = {}) {
  const minSpeechMs = Number(opts.minSpeechMs || 160);
  /* An explicit endSilenceMs is an override and is honoured exactly - callers and
   * tests that pin a value get that value, not the adaptive schedule. Only the
   * default adapts. */
  const pinned = Number(opts.endSilenceMs || 0) > 0;
  const endSilenceMs = Number(opts.endSilenceMs || QUIET_MAX_MS);
  const floorFrames = Number(opts.floorFrames || 20);
  const absoluteFloor = Number(opts.absoluteFloor || 180);
  let noise = 0;
  let noiseCount = 0;
  let speaking = false;
  let speechMs = 0;
  let silenceMs = 0;
  let lastRequired = QUIET_MAX_MS;

  /* The quiet this particular pause has to earn, given how long they have been
   * talking. Monotonically non-increasing in speech duration, so a pause that
   * follows more speech never needs MORE patience than one that follows less. */
  function requiredQuiet() {
    if (pinned) return endSilenceMs;
    for (const step of PATIENCE_STEPS) {
      if (speechMs >= step.speechMs) return step.quietMs;
    }
    return QUIET_MAX_MS;
  }

  return {
    push(frame, frameMs = 20) {
      const level = rmsPcmu(frame);
      /* Learn the room, but never from someone already talking.
       *
       * The floor used to be trained from the first 20 frames whatever they were.
       * Those 20 frames are 400ms, and a prospect who starts speaking immediately
       * - which is exactly what happens on an opening line, where the window opens
       * the moment they answer - spends all of them at full speech level. The EMA
       * then converges on their voice, the threshold became 2.6x that, and the
       * detector could not hear them at all: `voiced` stayed false for the entire
       * utterance, so the turn was reported as silence and the agent hung up on
       * someone mid-sentence. The window only recovered because a later turn found
       * a quiet gap to train on.
       *
       * A frame this loud is not the room, whatever the count says, so it is not
       * allowed into the estimate. Training still needs `floorFrames` samples, so
       * an install where the prospect never pauses simply never adapts upward
       * rather than learning a threshold that hides the caller. */
      const trainsNoise = !speaking && noiseCount < floorFrames && level <= NOISE_TRAIN_CEILING;
      if (trainsNoise) {
        noise = noiseCount === 0 ? level : noise * 0.85 + level * 0.15;
        noiseCount++;
      }
      /* With no training samples the floor stays 0, and the threshold falls back
       * to the absolute one. That is the correct behaviour for a loud line: a
       * high absolute floor is better than one calibrated to the caller. */
      const threshold = Math.max(absoluteFloor, (noiseCount ? noise : 0) * 2.6 + 90);
      const voiced = level >= threshold;
      if (voiced) {
        speechMs += frameMs;
        silenceMs = 0;
        if (speechMs >= minSpeechMs) speaking = true;
      } else if (speaking) {
        silenceMs += frameMs;
      } else {
        speechMs = Math.max(0, speechMs - frameMs);
      }
      /* Recomputed on every frame rather than frozen at speech start, so a
       * prospect who keeps talking past every threshold earns the shorter guard
       * partway through the same utterance. */
      lastRequired = requiredQuiet();
      return {
        level,
        threshold,
        voiced,
        speaking,
        ended: speaking && silenceMs >= lastRequired,
        requiredQuietMs: lastRequired,
      };
    },
    get speaking() { return speaking; },
    /* For the log and the tests: what this pause currently has to earn. */
    get requiredQuietMs() { return lastRequired; },
    get speechMs() { return speechMs; },
  };
}

module.exports = {
  createVad,
  rmsPcmu,
  mulawDecode,
  QUIET_FLOOR_MS,
  QUIET_MAX_MS,
  NOISE_TRAIN_CEILING,
  PATIENCE_STEPS,
};
