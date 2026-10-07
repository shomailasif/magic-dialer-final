const { capTurnLength, stripSpokenArtifacts } = require("C:/Users/USER/Documents/Default Project/autodial-ai/src/management/agent/turn-length");

const cases = [
  // The two that were heard as "Talk." and "Let." on the 07 Oct call.
  ["Let me get you a straight answer to that - I will have someone call you back with it.", "Let me get you a straight answer to that - I will have someone call you back with it."],
  ["Happy to talk. What type of trucks do you run?", "Happy to talk. What type of trucks do you run?"],
  // A question must survive: this was deleted whole before.
  ["So, what kind of truck is it?", "So, what kind of truck is it?"],
  ["What type of truck do you operate?", "What type of truck do you operate?"],
  // A genuinely truncated tail is still dropped, but keeps the real sentence.
  ["That is helpful. I was going to ask you about", "That is helpful."],
  ["I understand, that is fair. What", null],
];

let bad = 0;
for (const [input, want] of cases) {
  const got = String(capTurnLength(input) || "");
  const ok = want === null ? got.length > 0 : got === want;
  if (!ok) bad++;
  console.log((ok ? "PASS  " : "FAIL  ") + JSON.stringify(input));
  console.log("        got:  " + JSON.stringify(got));
  if (want !== null && got !== want) console.log("        want: " + JSON.stringify(want));
}

/* Nothing may ever come out as a bare stub. This is the shape of the defect:
 * a whole sentence reduced to one or two words and spoken aloud. */
const stubs = ["Talk.", "Let.", "So.", "Well.", "Yes."];
const victims = [
  "I will just talk you through it.",
  "Let me get you a straight answer to that - I will have someone call you back with it.",
  "So let us start with the basics of your operation.",
  "Well, I think that is reasonable.",
];
for (const v of victims) {
  const got = String(capTurnLength(v) || "").trim();
  const isStub = stubs.includes(got);
  if (isStub) bad++;
  console.log((isStub ? "FAIL  " : "PASS  ") + "no-stub: " + JSON.stringify(got));
}

console.log(bad === 0 ? "\nPASS: no complete sentence is reduced to a spoken stub" : `\nFAIL: ${bad} case(s)`);
process.exitCode = bad === 0 ? 0 : 1;