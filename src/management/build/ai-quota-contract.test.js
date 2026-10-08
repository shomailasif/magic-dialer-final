"use strict";
/* The quota decision must stay atomic, bounded and fail-open.
 *
 * The first two checks used to require an interactive `$transaction` with a
 * 15s timeout. That transaction was the latency: four findUnique reads and four
 * upsert writes inside it, eight serialized round trips to a remote Postgres on
 * the way to every AI request the engine makes. It is now one statement that
 * decides and increments all four scopes at once, so the check is inverted -
 * there must be no interactive transaction - and the atomic increment it
 * replaced is asserted directly.
 */
const a=require("node:assert/strict"),f=require("node:fs"),p=require("node:path"),r=p.resolve(__dirname,"..","..",".."),q=f.readFileSync(p.join(r,"src/lib/ai-quota.ts"),"utf8"),c=f.readFileSync(p.join(r,"src/app/api/engine/ai/chat/route.ts"),"utf8"),s=f.readFileSync(p.join(r,"src/app/api/engine/ai/stt/route.ts"),"utf8");
a.doesNotMatch(q,/\$transaction/);
a.match(q,/ON CONFLICT \("scopeKey","windowStart"\) DO UPDATE/);
a.match(q,/catch\s*\{\s*return\s*\{\s*ok:\s*true\s+as const\s*\}\s*;?\s*\}/);
a.match(q,/AI_CHAT_USER_RPM/);
a.match(q,/AI_CHAT_DEVICE_RPM/);
a.match(q,/AI_CHAT_GLOBAL_RPM/);
a.match(q,/AI_CHAT_GLOBAL_DAILY_UNITS/);
a.match(q,/status:\s*429/);
a.match(q,/Retry-After/);
a.match(c,/consumeAIQuota\("chat",d,/);
a.match(s,/consumeAIQuota\("stt",d,/);
a.match(c,/quotaResponse\(quota\.retryAfter\)/);
a.match(s,/quotaResponse\(quota\.retryAfter\)/);
console.log("AI quota enforcement contract: 11/11 checks PASS");