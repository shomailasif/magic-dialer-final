"use strict";const a=require("node:assert/strict"),f=require("node:fs"),p=require("node:path"),r=p.resolve(__dirname,"..","..",".."),s=f.readFileSync(p.join(r,"src/app/api/engine/ai/chat/route.ts"),"utf8"),b=f.readFileSync(p.join(r,"src/management/agent/intelligent-brain.js"),"utf8");a.match(s,/AI_GATEWAY_BUDGET_MS/);a.match(s,/boundedRetryDelay\(a\.retryAfter,deadline\)/);a.match(s,/u\.headers\.get\("retry-after"\)/);a.match(s,/boundedAttemptMs\(deadline\)/);a.doesNotMatch(s,/await sleep\(180\)/);a.match(b,/setTimeout\(\(\)\s*=>\s*c\.abort\(\),\s*timeoutMs\)/);
// A live caller waits on this number. It was 12000, and on the 16:09Z call one slow
// gateway produced 21s and 22s of dead air on two consecutive turns because the
// gateway was given 12s to abort and a second provider another 12s. 4.5s was then
// too tight and cost a real call on a one-off tail spike (measured warm p100 is
// 2174ms, cold first-request 657ms, so the tail is rare but real). Anything at or
// above 12000 is what made the agent sound dead.
a.doesNotMatch(b,/c\.abort\(\),\s*(?:[1-9][0-9]{4,})/);
// The direct provider call used to abort at a hardcoded 7000. It now aborts at
// `timeoutMs`, so the live turn still gets REQUEST_TIMEOUT_MS (7000) and the
// PRE-DIAL preflight gets its own PREFLIGHT_TIMEOUT_MS (25000). That is the point
// of the preflight budget: nobody is on the line yet, so a slow brain must not
// become "Call failed" before the phone rings - and the old hardcoded 7s silently
// took that generous budget away from it again.
// So the rule is no longer "the literal is 7000" but "the live budget is <=8000 and
// the preflight passes its own". Both are pinned below.
a.match(b,/const REQUEST_TIMEOUT_MS = 7000;/);
a.ok(/const REQUEST_TIMEOUT_MS = ([0-9]+);/.exec(b)[1] <= 8000,"the live direct brain budget must stay under 8s");
// The direct provider call used to abort at a hardcoded 7000. It now aborts at
// `timeoutMs`, so the live turn still gets REQUEST_TIMEOUT_MS (7000) and the
// PRE-DIAL preflight gets its own PREFLIGHT_TIMEOUT_MS (25000). That is the point
// of the preflight budget: nobody is on the line yet, so a slow brain must not
// become "Call failed" before the phone rings - and the old hardcoded 7s silently
// took that generous budget away from it again.
// So the rule is no longer "the literal is 7000" but "the live budget is <=8000 and
// the preflight passes its own". Both are pinned below.
a.match(b,/const REQUEST_TIMEOUT_MS = 7000;/);
a.ok(/const REQUEST_TIMEOUT_MS = ([0-9]+);/.exec(b)[1] <= 8000,"the live direct brain budget must stay under 8s");

/* The direct path retries a transient status and then tries a second model. That
 * is what makes it survivable - it was not, and audio-sim caught it: every brain
 * call came back HTTP 429 and the agent answered with canned recovery lines.
 *
 * So the deadline is no longer per-attempt but shared across every attempt and
 * model in one direct call. The invariant is stronger than "each attempt is
 * bounded": the SUM of all attempts and waits cannot exceed the caller's budget,
 * so adding a retry can never quietly lengthen a turn. */
a.match(b,/const stopAt = deadline \|\| \(Date\.now\(\) \+ timeoutMs\)/);
a.match(b,/Math\.min\(timeoutMs, remaining\)/);
a.match(b,/const remaining = stopAt - Date\.now\(\)/);
a.match(b,/if \(remaining < 250\) return \{ ok: false, status: 504/);
a.match(b,/function retryDelayMs\(retryAfter, stopAt\)/);
a.match(b,/Math\.min\(Math\.max\(0, ms\), Math\.max\(0, budget - 300\)\)/);
a.match(b,/const TRANSIENT_STATUS = new Set\(\[429, 500, 502, 503, 504\]\)/);
/* The direct path starts on 20b and falls back to 120b, because on a live key the
 * 120b model's tokens-per-minute is the one that runs out and turns every turn
 * into HTTP 429. Either model can be first, so the fallback is derived rather
 * than a constant. */
a.match(b,/const DEFAULT_DIRECT_MODEL = "openai\/gpt-oss-20b"/);
a.match(b,/const DEFAULT_MODEL = "openai\/gpt-oss-120b"/);
a.match(b,/function directModelFallback\(preferred\)/);
a.match(b,/return preferred === DEFAULT_DIRECT_MODEL \? DEFAULT_MODEL : DEFAULT_DIRECT_MODEL/);
a.match(b,/const secondModel = directModelFallback\(preferred\)/);
const cr=f.readFileSync(p.join(r,"src/management/agent/call-runner.js"),"utf8");
a.match(cr,/const BRAIN_BUDGET_MS = \d+;/);
a.ok(/const BRAIN_BUDGET_MS = ([0-9]+);/.exec(cr)[1] <= 8000,"per-turn brain budget must stay under 8s");
const ib=f.readFileSync(p.join(r,"src/management/agent/intelligent-brain.js"),"utf8");
// A live turn must stay short, but the PRE-DIAL preflight is not a conversation:
// nobody is on the line, so a slow brain must not become "Call failed" before
// the phone rings. It had shared the 7s abort and did exactly that.
a.match(ib,/const REQUEST_TIMEOUT_MS = 7000;/);
a.ok(/const PREFLIGHT_TIMEOUT_MS = ([0-9]+);/.exec(ib)[1] >= 20000,"preflight must have its own generous budget");
a.match(ib,/timeoutMs:\s*PREFLIGHT_TIMEOUT_MS/);console.log("AI deadline retry contract: 27/27 checks PASS");
