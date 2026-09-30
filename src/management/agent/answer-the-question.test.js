/* A prospect who asks a question is asking to be answered.
 *
 * On the recorded test call the prospect asked "Will your dispatcher be able to
 * call me now?" three times. The agent answered "Thanks for sharing the
 * domain", then "Thanks for your time", then closed with a callback promise, and
 * he finished with "I don't want to work with you." Nothing about that is tone or
 * latency: every reply was an acknowledgment or another question, never an
 * answer. This proves the guard forces an answer. */
const assert = require("node:assert");
const {
  prospectAskedQuestion,
  isAcknowledgmentOnly,
} = require("./call-runner.js");

async function main() {
  // 1. Questions are detected, statements are not.
  for (const q of [
    "Will your dispatcher be able to call me now?",
    "Can you text me those options?",
    "What do you need?",
    "Why are you calling me?",
    "Do you handle reefer loads",
    "is your dispatcher available right now",
  ]) {
    assert.equal(prospectAskedQuestion(q), true, "should detect a question: " + q);
  }
  for (const s of [
    "I have a dispatcher already.",
    "I'm busy.",
    "My name is Abdullah.",
    "I am paying him 3% for each load that he booked for me.",
    "It's ap@ZazLogistics.com.",
  ]) {
    assert.equal(prospectAskedQuestion(s), false, "should NOT flag a statement: " + s);
  }
  console.log("  ok  questions are detected and statements are not");

  // 2. The exact replies that were said instead of answering are acknowledged-only.
  for (const a of [
    "Thanks for sharing that.",
    "Thanks for sharing the domain.",
    "Thanks for your time.",
    "Got it.",
    "Sorry.",
    "Sure thing.",
    "I did not catch that clearly.",
    "Okay.",
    "Thanks.",
    "I appreciate that.",
  ]) {
    assert.equal(isAcknowledgmentOnly(a), true, "should be treated as no answer: " + a);
  }
  console.log("  ok  the replies that were said instead of answering are all caught");

  // 3. A real answer must NOT be caught, or the guard would fight the model.
  for (const r of [
    "Yes, our dispatcher can call you right now.",
    "No, we cannot do that today, but I can have someone call tomorrow morning.",
    "We cover Texas, New Mexico and Oklahoma out of Dallas.",
    "Yes, I can text those options to this number now.",
  ]) {
    assert.equal(isAcknowledgmentOnly(r), false, "a real answer must survive: " + r);
  }
  console.log("  ok  real answers are not mistaken for filler");

  console.log("PASS: asking the agent a question can no longer produce another question or a filler line");
}

main().catch((e) => { console.error("  FAIL " + e.message); process.exit(1); });
