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

function createVad(opts = {}) {
  const minSpeechMs = Number(opts.minSpeechMs || 160);
  const endSilenceMs = Number(opts.endSilenceMs || 420);
  const floorFrames = Number(opts.floorFrames || 20);
  const absoluteFloor = Number(opts.absoluteFloor || 180);
  let noise = 0;
  let noiseCount = 0;
  let speaking = false;
  let speechMs = 0;
  let silenceMs = 0;

  return {
    push(frame, frameMs = 20) {
      const level = rmsPcmu(frame);
      if (!speaking && noiseCount < floorFrames) {
        noise = noiseCount === 0 ? level : noise * 0.85 + level * 0.15;
        noiseCount++;
      }
      const threshold = Math.max(absoluteFloor, noise * 2.6 + 90);
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
      return { level, threshold, voiced, speaking, ended: speaking && silenceMs >= endSilenceMs };
    },
    get speaking() { return speaking; },
  };
}

module.exports = { createVad, rmsPcmu, mulawDecode };
