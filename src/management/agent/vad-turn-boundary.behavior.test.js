const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert/strict");

/* The agent must not cut people off mid-sentence.
 *
 * On 06/07 Oct the engine decided the prospect had stopped talking after 250ms of
 * silence and transcribed half-sentences:
 *
 *   LEAD:  it's the
 *   LEAD:  6234001991        (17 seconds later, as a separate turn)
 *
 * The pause between "it's the" and the digits is longer than 250ms, so the agent
 * decided they had finished, replied, and made them say the number again. That is
 * the stuttering on the call, and it reads as the agent not listening.
 *
 * This drives the real VAD with a synthetic utterance that contains a realistic
 * pause in the middle, and asserts the whole sentence comes out in one window. */
const { createVad } = require("./vad");
const FRAME = 160;
const FRAME_MS = 20;

/* PCMU is mu-law: 0xFF and 0x7F decode to zero amplitude, so those are silence.
 * 0x00 decodes to full scale. Getting this backwards makes "speech" silent and
 * the whole test meaningless - verified against rmsPcmu before being used here.
 *
 * Every utterance starts with a quiet lead-in because the VAD calibrates its
 * noise floor over the first frames and will otherwise treat speech as noise. */
const SILENT = 0xff;
const LOUD = 0x00;

function leadIn(vad) {
  for (let i = 0; i < 25; i++) vad.push(Buffer.alloc(FRAME, SILENT), FRAME_MS);
}
function speech(vad, ms) {
  let last = null;
  for (let i = 0; i < Math.round(ms / FRAME_MS); i++) last = vad.push(Buffer.alloc(FRAME, LOUD), FRAME_MS);
  return last;
}
function silence(vad, ms) {
  let last = null;
  for (let i = 0; i < Math.round(ms / FRAME_MS); i++) last = vad.push(Buffer.alloc(FRAME, SILENT), FRAME_MS);
  return last;
}

function main() {
  // A mid-sentence pause of 500ms: natural when someone pauses before saying a
  // number, and the exact case the 250ms setting truncated.
// "it's the [500ms] 6234001991" - the pause before the digits must not end it.
  const vad = createVad({ minSpeechMs: 160 });
  leadIn(vad);
  speech(vad, 400);
  const during = silence(vad, 500);
  assert.equal(
    during && during.ended, false,
    "a 500ms pause inside a sentence must not end the turn"
  );
  const resumed = speech(vad, 400);
  assert.equal(resumed && resumed.speaking, true, "speech must resume into the same turn");
  assert.equal(resumed && resumed.ended, false, "the turn must still be open at the end of the sentence");

  // A real finish - a long silence - must still end the turn, or the agent would
  // wait forever and never answer.
  /* No endSilenceMs here either, and that is the point of the change.
 *
 * Both scenarios used to pin 700ms, which is the exact override that disabled the
 * adaptive schedule in production. createVad treats an explicit value as a
 * straight bypass, so these were testing the configuration that had been REMOVED
 * from the controller - they would still have passed with the entire adaptive
 * schedule deleted from vad.js, and reported themselves as covering turn
 * boundaries. A behavioural test that only exercises a disabled path is worse
 * than no test, because it is indistinguishable from coverage in review.
 *
 * The scenarios now build the VAD exactly as the controller does. */
const vad2 = createVad({ minSpeechMs: 160 });
  leadIn(vad2);
  speech(vad2, 500);
  silence(vad2, 900);
  const end = silence(vad2, 200);
  assert.equal(
    end && end.ended, true,
    "a genuine pause of over a second must end the turn so the agent can reply"
  );

  // The controller must not configure the VAD down to something that truncates.
  // It passed 250ms while the module default was 700ms, and "it's the" plus the
  // number after it arrived as two turns.
  //
  // It must also not PIN it. It pinned 700ms at all three makeVad() sites for
  // the life of the feature, which is an explicit override, so the adaptive
  // schedule never ran on a single live call - while this file and
  // vad-adaptive-eos.behavior.test.js both passed the whole time. The assertion
  // below is now "no value below a safe floor", checked against the module's own
  // constants rather than against a hardcoded number that drifts.
  const controller = fs.readFileSync(path.join(__dirname, "local-call-controller.js"), "utf8");
  const settings = [...controller.matchAll(/endSilenceMs:\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(
    settings,
    [],
    `no controller call site may pin endSilenceMs (found ${settings.join(", ")}ms). createVad treats an explicit value as an override, so a pin silently disables the adaptive schedule - which is exactly what happened for the entire life of the adaptive VAD.`,
  );

  // The schedule itself has to stay clear of the truncation value.
  const { QUIET_FLOOR_MS, QUIET_MAX_MS } = require("./vad");
  assert.ok(QUIET_FLOOR_MS >= 500, `adaptive floor of ${QUIET_FLOOR_MS}ms truncates mid-sentence`);
  assert.ok(QUIET_MAX_MS >= QUIET_FLOOR_MS, "patience must never invert");

  // And the hold that covers trailing digits must be long enough to matter.
  const hold = Number((controller.match(/const SPEECH_HOLD_MS = (\d+);/) || [])[1]);
  assert.ok(hold >= 200, `SPEECH_HOLD_MS of ${hold}ms is too short to catch digits that land late`);

  console.log("PASS: a mid-sentence pause is not treated as the end of the turn");
}

main();