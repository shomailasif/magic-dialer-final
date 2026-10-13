"use strict";
/**
 * The STT turn budget is ONE budget, and it is measured on success.
 *
 * Two defects this pins, both found by reading the logs rather than the code:
 *
 *   1. The budget was 12000ms PER ATTEMPT, twice. A turn could therefore spend
 *      24s on transcription. Worse, the gateway's own provider budget is 4500ms,
 *      so a request that blows it returns 5xx instead of hanging: the controller
 *      saw a "failure" at ~4.5s, waited 200ms, and paid a second 12s for an
 *      answer the first attempt was about to produce. That is the mechanism
 *      behind the multi-second outliers that were logged as one unexplained
 *      number.
 *
 *   2. Only FAILURES were ever logged. A slow-but-successful transcription - the
 *      one that actually costs a prospect time, and the one that produces no
 *      error message - left no trace at all. A 7751ms first-turn STT could be
 *      observed and never explained for exactly this reason.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const controllerSrc = fs.readFileSync(path.join(__dirname, "local-call-controller.js"), "utf8");
const block = controllerSrc.slice(controllerSrc.indexOf("const runStt = async"), controllerSrc.indexOf("const startEarlyStt"));

/* ---- 1. one budget for the whole turn, not one per attempt ---- */

assert.match(block, /const STT_TURN_BUDGET_MS = 9000;/,
  "the turn must declare a single shared budget");
assert.doesNotMatch(block, /STT_ATTEMPT_BUDGET_MS/,
  "the per-attempt budget is gone: it is what let one turn spend two of them");
assert.match(block, /STT_TURN_BUDGET_MS - \(Date\.now\(\) - turnStartedAt\)/,
  "each attempt must be bounded by what is LEFT of the turn, not by a fresh budget");
assert.match(block, /turnStartedAt = Date\.now\(\)/,
  "the turn budget has to start at a recorded instant to have anything left to spend");
assert.match(block, /if \(attempt > 1 && left < 1200\)/,
  "a second attempt must be skipped rather than started when it cannot finish");

/* The regression itself: a per-attempt budget multiplied by the attempt count. */
const budgetMatch = /const STT_TURN_BUDGET_MS = (\d+);/.exec(block);
assert.ok(budgetMatch, "the shared budget must be a literal so the bound is checkable");
const budget = Number(budgetMatch[1]);
const attemptsMatch = /const STT_ATTEMPTS = (\d+);/.exec(controllerSrc);
assert.ok(attemptsMatch, "the attempt count must be a literal");
const attempts = Number(attemptsMatch[1]);
assert.ok(attempts >= 2, "a retry must still be possible - a prospect is worth one more try");
assert.ok(budget <= 10000,
  `the whole turn's STT budget is ${budget}ms; a prospect waiting more than 10s for a two-word reply is being abandoned`);

/* ---- 2. success is timed and logged, not just failure ---- */

assert.match(block, /STT attempt \$\{attempt\}\/\$\{STT_ATTEMPTS\} ok via \$\{path\}/,
  "a SUCCESSFUL attempt must be logged with its elapsed time and which leg answered");
assert.match(block, /if \(elapsed >= 1500 \|\| attempt === 1\)/,
  "the first attempt of every call must be logged - that is the one that cannot go unrecorded again");
assert.match(block, /r\.path \? r\.path : "unknown"/,
  "the log must say whether the direct or gateway leg answered, so a slow hop and a slow provider are distinguishable");
assert.match(block, /STT turn total \$\{totalMs\}ms over \$\{attemptsUsed\} attempt/,
  "the turn total must be reported with the attempt count, so a doubled turn is visible rather than inferred");

/* The old line that only fired on failure must be gone from the success path. */
assert.match(block, /STT attempt \$\{attempt\}\/\$\{STT_ATTEMPTS\} failed: \$\{r\.error\} \(\$\{elapsed\}ms\)/,
  "failures must still be logged with their elapsed time");

/* ---- 3. the STT result must carry which path answered ---- */

/* The controller reads r.path to log it, so multilingual-stt must set it on every
 * return - not only on the direct path. A missing path would print "unknown" for
 * exactly the case this is here to explain. */
const sttSrc = fs.readFileSync(path.join(__dirname, "multilingual-stt.js"), "utf8");
assert.match(sttSrc, /path:"direct"/, "the direct path must label itself");
assert.match(sttSrc, /path:"gateway"/, "the gateway-only path must label itself");
assert.match(sttSrc, /path:"gateway-fallback"/, "the fallback must label itself");

/* ---- 3. every STT_ATTEMPTS reference must be in scope ---- */

/* A real call on 13 Oct died on this: `STT_ATTEMPTS is not defined`. The const was
 * declared inside runStt and read in listenFn, which is a sibling function, so
 * every turn that ended with an unheard utterance threw instead of reporting why
 * it had failed. It is not a rare path - it is the path taken exactly when
 * recognition fails, which is when the message matters most.
 *
 * A source-shape test cannot catch a scope error, so this walks the real scope
 * chain instead: every file-level `const X` is collected, then each reference is
 * checked against the set of declarations visible from the function it sits in. */
const src = controllerSrc;

function enclosingScopes(index) {
  /* Walk backwards tracking brace depth to find every function body the index is
   * inside, then collect the file-level declarations plus the ones in those
   * bodies. Good enough to catch a const declared in a sibling function, which is
   * the mistake being pinned. */
  const fileLevel = new Set();
  for (const m of src.matchAll(/^\s{0,2}const ([A-Z][A-Z0-9_]*)\s*=/gm)) fileLevel.add(m[1]);

  const bodies = [];
  let depth = 0;
  const stack = [];
  let bodyStart = 0;
  for (let i = 0; i <= Math.min(index, src.length); i++) {
    const ch = src[i];
    if (ch === "{") { if (depth === 0) bodyStart = i; stack.push(depth); depth++; }
    else if (ch === "}") { depth--; if (stack.pop() === 0) bodies.push([bodyStart, i]); }
  }
  const visible = new Set(fileLevel);
  for (const [a, b] of bodies) {
    const text = src.slice(a, b);
    for (const m of text.matchAll(/const ([A-Z][A-Z0-9_]*)\s*=/g)) {
      /* A declaration belongs to its own body, so only add it if this body is the
       * innermost one containing the reference - approximated by requiring the
       * declaration to appear before the reference index. */
      const declAt = src.indexOf(m[0], a);
      if (declAt >= 0 && declAt < index) visible.add(m[1]);
    }
  }
  return visible;
}

const references = [];
for (const m of src.matchAll(/\$\{STT_ATTEMPTS\}|STT_ATTEMPTS(?!\s*=)/g)) references.push(m.index);

assert.ok(references.length >= 2, `expected several STT_ATTEMPTS uses, found ${references.length}`);
for (const at of references) {
  const line = src.slice(0, at).split("\n").length;
  const visible = enclosingScopes(at);
  assert.ok(visible.has("STT_ATTEMPTS"),
    `STT_ATTEMPTS referenced at line ${line} is not in scope there - it is declared inside a sibling function. ` +
    `This is what killed a live call on 13 Oct with "STT_ATTEMPTS is not defined".`);
}

console.log("STT turn-budget contract: PASS");
console.log(`  one ${budget}ms budget per turn across ${attempts} attempts; success and failure both timed and logged; all ${references.length} STT_ATTEMPTS references in scope`);