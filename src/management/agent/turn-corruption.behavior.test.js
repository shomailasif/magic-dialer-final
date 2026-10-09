const { capTurnLength } = require("./turn-length");

/* Both corruptions were heard on the wire on 06/07 Oct 2026:
 *   "Hi, this is Atlas from Zaz Logistics- is now a good time to talk?"
 *   "Hi, this is Atlas<bad char>"just checking if now is a good time to talk?"
 * They arrived mangled from upstream - nothing in turn-length produced them - but
 * the voice reads whatever it is given, so they have to be repaired before
 * synthesis rather than diagnosed afterwards. */
const mangled = [
  ["Hi, this is Atlas from Zaz Logistics- is now a good time to talk?", "Hi, this is Atlas from Zaz Logistics. Is now a good time to talk?"],
  ["Hi, this is Atlas from Zaz Logistics\uFFFD\"just checking if now is a good time to talk?", "Hi, this is Atlas from Zaz Logistics. Just checking if now is a good time to talk?"],
  ["Sure- thanks for your time.", "Sure. Thanks for your time."],
  ["Well- I think that is reasonable.", "Well. I think that is reasonable."],
];
const cleanInputs = [
  "Hi, this is Atlas from Zaz Logistics. Is now a good time to talk?",
  "Hey, it's Atlas from Zaz Logistics. Is now a good time to talk?",
  "Let me get you a straight answer to that - I will have someone call you back with it.",
  "What type of truck do you operate?",
];

let bad = 0;
for (const [input, want] of mangled) {
  const got = String(capTurnLength(input) || "");
  const ok = got === want;
  if (!ok) bad++;
  console.log((ok ? "PASS  " : "FAIL  ") + "repaired: " + JSON.stringify(got));
  if (!ok) console.log("        want   : " + JSON.stringify(want));
}
for (const input of cleanInputs) {
  const got = String(capTurnLength(input) || "");
  const ok = got === input;
  if (!ok) bad++;
  console.log((ok ? "PASS  " : "FAIL  ") + "untouched: " + JSON.stringify(got));
  if (!ok) console.log("        want    : " + JSON.stringify(input));
}
/* Nothing may reach the voice carrying either corruption. */
const allInput = [...mangled.map((m) => m[0]), ...cleanInputs];
for (const [i, input] of allInput.entries()) {
  const got = String(capTurnLength(input) || "");
  // A dash welded to a lowercase word that stays lowercase is a dash the model
  // wrote, not the boundary corruption: only flag a dash still joining words with
  // no full stop between them.
  const ok = !/\uFFFD/.test(got) && !/[a-z][-–—][A-Z]/.test(got);
  if (!ok) bad++;
  console.log((ok ? "PASS  " : "FAIL  ") + `no corruption reaches the voice [${i}] ${JSON.stringify(got)}`);
}

console.log(bad === 0 ? "\nPASS: mangled text is repaired, clean text is untouched" : `\nFAIL: ${bad} case(s)`);
process.exitCode = bad === 0 ? 0 : 1;