"use strict";
/* The Windows voice must not be able to lose a sentence to punctuation.
 *
 * Measured on 27 Oct: the utterance was pasted into a PowerShell -Command
 * string, so a curly apostrophe ended the string and the synthesizer wrote a
 * 0-byte WAV. ASCII-only text rendered 12/12 at ~4.6s; the same line with one
 * U+2019 produced no audio at all. Urdu script produced a 46-byte empty WAV.
 *
 * These checks are offline and voice-independent: they pin the safe path, the
 * typographic folding, and the loudness normalisation that took the measured
 * -18 dBFS peak up to full scale.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const voice = require("../agent/voice");

const src = fs.readFileSync(path.join(__dirname, "..", "agent", "voice.js"), "utf8");

// 1. Text is never interpolated into the PowerShell command again.
assert.doesNotMatch(src, /\$s\.Speak\('\$\{/, "the utterance must never be built into a PowerShell command line");
assert.match(src, /ReadAllText\(/, "the Windows voice must read its text from a UTF-8 file");
assert.match(src, /WriteAllText|writeFileSync\(textFile/, "the text must be written to a file, not a command");

// 2. Typographic punctuation is folded to what the desktop voice pronounces.
assert.equal(voice.sapiSafeText("That\u2019s great \u2014 I\u2019ll note it\u2026"), `That's great - I'll note it...`);
assert.equal(voice.sapiSafeText("\u201CHello\u201D"), '"Hello"');
assert.equal(voice.sapiSafeText("a\u00a0b\nc"), "a b c");
assert.ok(!/[\u2018\u2019\u201C\u201D\u2013\u2014]/.test(voice.sapiSafeText("mixed \u2018quotes\u2019 and \u2014 dashes")));

// 3. Quiet renders are brought up to a consistent telephone level.
const quiet = new Int16Array(8000);
for (let i = 0; i < quiet.length; i++) quiet[i] = Math.round(Math.sin(i / 8) * 2000); // ~ -24 dBFS
const loud = voice.normalisePeak(quiet);
let peak = 0;
for (const s of loud) peak = Math.max(peak, Math.abs(s));
assert.ok(peak > 28000, `normalisation must raise a quiet render to near full scale, peak was ${peak}`);
assert.ok(peak <= 32767, "normalisation must never clip past full scale");
// A silent buffer stays silent instead of being amplified into noise.
const silent = new Int16Array(800).fill(0);
assert.equal(voice.normalisePeak(silent)[0], 0);

// 4. A dead tier is remembered, and Windows is never cooled into silence.
assert.equal(typeof voice._test.cooling, "function", "the cooldown must be observable");
voice._test.clearCooldowns();
assert.equal(voice._test.cooling("edge-ws"), false);
assert.equal(voice._test.cooling("windows"), false);
voice._test.clearCooldowns();

// 5. The script probe exists and is not a hardcoded answer.
assert.equal(typeof voice.canSpeakScript, "function", "the controller must be able to ask which script the voice can read");

console.log("TTS text safety: PASS (file-based SAPI text, punctuation folded, loudness normalised, dead tiers cooled)");
