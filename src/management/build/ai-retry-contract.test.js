"use strict";const a=require("node:assert/strict"),f=require("node:fs"),p=require("node:path"),r=p.resolve(__dirname,"..","..",".."),s=f.readFileSync(p.join(r,"src/app/api/engine/ai/chat/route.ts"),"utf8"),b=f.readFileSync(p.join(r,"src/management/agent/intelligent-brain.js"),"utf8");a.match(s,/AI_GATEWAY_BUDGET_MS/);a.match(s,/boundedRetryDelay\(a\.retryAfter,deadline\)/);a.match(s,/u\.headers\.get\("retry-after"\)/);a.match(s,/boundedAttemptMs\(deadline\)/);a.doesNotMatch(s,/await sleep\(180\)/);a.match(b,/setTimeout\(\(\)\s*=>\s*c\.abort\(\),\s*timeoutMs\)/);
// A live caller waits on this number. It was 12000, and on the 16:09Z call one slow
// gateway produced 21s and 22s of dead air on two consecutive turns because the
// gateway was given 12s to abort and a second provider another 12s. 4.5s was then
// too tight and cost a real call on a one-off tail spike (measured warm p100 is
// 2174ms, cold first-request 657ms, so the tail is rare but real). Anything at or
// above 12000 is what made the agent sound dead.
a.doesNotMatch(b,/c\.abort\(\),\s*(?:[1-9][0-9]{4,})/);
a.match(b,/setTimeout\(\(\)\s*=>\s*controller\.abort\(\),\s*7000\)/);
const cr=f.readFileSync(p.join(r,"src/management/agent/call-runner.js"),"utf8");
a.match(cr,/const BRAIN_BUDGET_MS = \d+;/);
a.ok(/const BRAIN_BUDGET_MS = ([0-9]+);/.exec(cr)[1] <= 8000,"per-turn brain budget must stay under 8s");
const ib=f.readFileSync(p.join(r,"src/management/agent/intelligent-brain.js"),"utf8");
// A live turn must stay short, but the PRE-DIAL preflight is not a conversation:
// nobody is on the line, so a slow brain must not become "Call failed" before
// the phone rings. It had shared the 7s abort and did exactly that.
a.match(ib,/const REQUEST_TIMEOUT_MS = 7000;/);
a.ok(/const PREFLIGHT_TIMEOUT_MS = ([0-9]+);/.exec(ib)[1] >= 20000,"preflight must have its own generous budget");
a.match(ib,/timeoutMs:\s*PREFLIGHT_TIMEOUT_MS/);console.log("AI deadline retry contract: 14/14 checks PASS");
