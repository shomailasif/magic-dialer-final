"use strict";
/**
 * A spoken refusal must never end up as a stored lead.
 *
 * The agent was already refusing correctly in conversation - that part worked on
 * the call of 13 Oct. The refusal went nowhere after that, for two independent
 * reasons, and neither was visible from the agent:
 *
 *   1. The engine sends transcript as an ARRAY of {role, text}. The route read
 *      `typeof b.transcript === "string" ? ... : ""`, so for every call the
 *      deployed engine makes the transcript was "" - never stored, and nothing
 *      downstream could read it.
 *   2. The route never called isSpokenOptOut at all. That function lived only on
 *      the SIP path, so the local engine - the one actually deployed - had no
 *      opt-out detection whatsoever.
 *
 * The result: somebody who said "I don't want you to follow-up" was stored as a
 * Lead, with their phone number, and emailed as a qualified lead. A person who
 * refused to be called was entered into the campaign queue that calls people.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..", "..", "src");
const route = fs.readFileSync(path.join(root, "app", "api", "call-result", "route.ts"), "utf8");
const calljs = fs.readFileSync(path.join(__dirname, "..", "agent", "call.js"), "utf8");
const runner = fs.readFileSync(path.join(__dirname, "..", "agent", "call-runner.js"), "utf8");

/* ---- the route must actually reach for the compliance function ---- */
assert.match(route, /import \{ isSpokenOptOut, normalizePhoneForSuppression \} from "@\/lib\/call-compliance"/,
  "the route must import the opt-out detector, or there is no detection here at all");

/* ---- the array transcript must be understood, not discarded ---- */
assert.doesNotMatch(route, /typeof b\.transcript === "string" \? b\.transcript\.slice\(0, 4000\) : ""/,
  "the string-only transcript read is the bug: the engine sends an array, so it always became empty");
assert.match(route, /function parseTranscript\(raw: unknown\)/,
  "the array form must be parsed");
assert.match(route, /Array\.isArray\(raw\)/,
  "parseTranscript must handle the array shape the engine actually sends");
assert.match(route, /prospect:/,
  "the parsed transcript must be rendered back into the Prospect/Agent form");

/* ---- only the PROSPECT's words may trigger suppression ---- */
assert.match(route, /lines\.filter\(\(l\) => l\.lead\)/,
  "isSpokenOptOut must only ever see prospect text");
assert.match(route, /!agent\$|!\/\^agent\$\/i\.test\(m\[1\]\)|!\/\^agent\/i\.test\(m\[1\]\)/,
  "the string form must separate Agent: lines from Prospect: lines");
assert.match(route, /isSpokenOptOut\(prospect\)/,
  "the scan must run against the prospect-only text, never the raw body");

/* ---- both sources count, because they fail differently ---- */
assert.match(route, /const optedOut = b\.doNotCall === true \|\| isSpokenOptOut\(prospect\);/,
  "the agent's own flag is authoritative and the transcript scan is the backstop; either must suppress");

/* ---- suppression must happen BEFORE the lead is created ---- */
const optOutAt = route.indexOf("const optedOut =");
const createAt = route.indexOf("prisma.lead.create");
assert.ok(optOutAt > -1 && createAt > optOutAt,
  "the refusal must be handled before prisma.lead.create, or a refusing prospect is stored as a lead");

/* ---- and it must actually suppress ---- */
assert.match(route, /prisma\.phoneSuppression\.upsert\(/,
  "the number must be written to phoneSuppression");
assert.match(route, /SPOKEN_OPT_OUT/,
  "the suppression must be attributable to a spoken opt-out");
assert.match(route, /optedOut: true/,
  "the response must report the refusal rather than looking like an ordinary non-lead");

/* ---- the failure must not be fatal: a refused call is already over ---- */
/* Both helpers are used in this file and they are NOT interchangeable.
 * redactDiagnostic renders a value to a string; safeDiagnostic builds the
 * traceable object the fail() helper returns and takes (stage, code, status,
 * requestId, callId). Calling safeDiagnostic with an error fails the type check,
 * and removing its import fails it too - which is exactly what happened. */
assert.match(route, /import \{ diagnosticId, safeDiagnostic, redactDiagnostic \} from "@\/lib\/safe-diagnostic"/,
  "safeDiagnostic is still used by fail() and must stay imported; redactDiagnostic renders errors");
assert.match(route, /redactDiagnostic\(e\)\.slice\(0, 200\)/,
  "a suppression write failure must be logged, and must not turn the refusal into a 500 that makes the engine report it again");
assert.doesNotMatch(route, /safeDiagnostic\(e\)/,
  "safeDiagnostic takes (stage, code, status) and never an error");
assert.match(route, /\.\.\.safeDiagnostic\(stage, code, status, requestId, callId\)/,
  "the pre-existing fail() helper uses safeDiagnostic correctly and must keep working");

/* ---- the engine must actually send the flag ---- */
assert.match(runner, /let doNotCall = false;/,
  "the runner must track the refusal");
assert.match(runner, /if \(stopRequested\) doNotCall = true;/,
  "a do-not-call must set the flag");
assert.match(runner, /if \(NO_FOLLOWUP_RE\.test\(heard\)\) \{\s*\n\s*doNotCall = true;/,
  "a follow-up refusal must set the flag too - it was the only refusal on the 13 Oct call");
assert.match(runner, /doNotCall,/,
  "the result must carry it");
assert.match(calljs, /doNotCall: result\.doNotCall === true/,
  "the result must be sent to the route, or the flag never leaves the process");

/* ===================================================================
 * BEHAVIOUR of parseTranscript.
 *
 * The assertions above check that the function is called. They cannot check that
 * it reads the array the engine actually sends - which shape is produced, whether
 * lead roles are recognised, and above all whether an Agent: line can leak into
 * the text that suppresses a number. A false positive there is unrecoverable for
 * that lead, so it is run rather than trusted.
 * =================================================================== */
const fnStart = route.indexOf("function parseTranscript");
assert.ok(fnStart > -1, "parseTranscript must exist");
const fnEnd = route.indexOf("\n}", route.indexOf("prospect: lines.filter", fnStart)) + 2;
const js = route.slice(fnStart, fnEnd)
  .replace(/\(raw: unknown\):\s*\{\s*full:\s*string;\s*prospect:\s*string\s*\}\s*\{/, "(raw) {")
  .replace(/const lines: \{ lead: boolean; text: string \}\[\] = \[\];/, "const lines = [];")
  .replace(/const e = entry as Record<string, unknown>;/, "const e = entry;");
const parseTranscript = new Function("firstString", `${js}; return parseTranscript;`)(function firstString(v) {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (Array.isArray(v)) for (const x of v) { const s = firstString(x); if (s) return s; }
  return "";
});

/* The exact shape the local engine sends. */
const engineTranscript = [
  { role: "agent", text: "Hi, this is Atlas from Zaz Logistics.", locale: "en" },
  { role: "lead", text: "I don't want you to follow-up", locale: "en" },
  { role: "agent", text: "Understood, thanks for your time.", locale: "en" },
];
const parsed = parseTranscript(engineTranscript);
assert.match(parsed.prospect, /I don't want you to follow-up/,
  "the prospect's refusal must be readable - this is the sentence that suppressed nothing");
assert.doesNotMatch(parsed.prospect, /Atlas from Zaz Logistics/,
  "the agent's own words must never reach the suppression scan");
assert.match(parsed.full, /Prospect: /, "the stored transcript must keep the Prospect/Agent form");

/* Roles the engine may emit, and noise that must not be mistaken for speech. */
const roles = parseTranscript([
  { role: "prospect", text: "no call back please" },
  { role: "user", text: "stop calling" },
  { role: "customer", text: "remove me" },
  { role: "assistant", text: "I will call you back shortly" },
]);
assert.match(roles.prospect, /no call back please/);
assert.match(roles.prospect, /stop calling/);
assert.match(roles.prospect, /remove me/);
assert.doesNotMatch(roles.prospect, /I will call you back shortly/,
  "an assistant role must not be scanned");

/* The SIP path sends lines, not objects. */
const sip = parseTranscript("Prospect: I don't want you to follow-up\nAgent: Thanks for your time.");
assert.match(sip.prospect, /follow-up/);
assert.doesNotMatch(sip.prospect, /Thanks for your time/);

/* And the two dangerous shapes. */
assert.equal(parseTranscript(undefined).prospect, "");
assert.equal(parseTranscript(null).prospect, "");
assert.equal(parseTranscript("").prospect, "");
assert.equal(parseTranscript([null, "x", 42, { role: "lead" }]).prospect, "",
  "entries with no text must contribute nothing");
assert.equal(parseTranscript([{ text: "no call back" }]).prospect, "",
  "an entry with text but no role is ambiguous and must not suppress");
assert.equal(parseTranscript({}).prospect, "");

/* ===================================================================
 * THE TWO LISTS MUST NOT DRIFT.
 *
 * There are now two refusal detectors, and that is the shape that caused this:
 * NO_FOLLOWUP_RE decides how the agent behaves, isSpokenOptOut decides whether
 * the number is suppressed. They are deliberately not identical - only the
 * compliance one has the time-box exemption, because "no follow up for now" is
 * still worth handling in conversation while not being a suppression.
 *
 * But they must not diverge on the refusals that matter. If the agent ends the
 * call politely for something the compliance layer does not recognise, we are
 * exactly back where we started: correct on the call, no suppression, and the
 * number in the next campaign. So every sentence below has to trip BOTH.
 * =================================================================== */
const agentFn = runner.indexOf("const NO_FOLLOWUP_RE = new RegExp([");
assert.ok(agentFn > -1, "the agent must have a follow-up refusal detector");
const agentOpen = runner.indexOf("[", agentFn);
const agentParts = eval(runner.slice(agentOpen, runner.indexOf("].join", agentOpen) + 1));
const agentRefusal = new RegExp(agentParts.join("|"), "i");

const complianceSrc = fs.readFileSync(path.join(root, "lib", "call-compliance.ts"), "utf8");
const cTables = complianceSrc.slice(complianceSrc.indexOf("const HARD_OPT_OUT"));
const cJs = cTables.slice(0, cTables.indexOf("export function normalizePhoneForSuppression"))
  .replace(/^export /gm, "")
  .replace(/const (\w+):readonly\s+(?:string\[\]|RegExp\[\])/g, "const $1")
  .replace(/function normaliseForMatching\(text:\s*string\)/, "function normaliseForMatching(text)")
  .replace(/function isSpokenOptOut\(text:\s*string\)/, "function isSpokenOptOut(text)");
const cmod = { exports: {} };
new Function("module", "exports", cJs + "\nmodule.exports.isSpokenOptOut = isSpokenOptOut;")(cmod, cmod.exports);
const complianceRefusal = cmod.exports.isSpokenOptOut;

const MUST_AGREE = [
  "I don't want you to follow-up",
  "I don't want you to follow up",
  "No more follow up please",
  "Don't follow up with me",
  "No call back",
  "don't call me",
  "remove me from your list",
];
for (const u of MUST_AGREE) {
  assert.ok(agentRefusal.test(u), `the agent must handle it: "${u}"`);
  assert.ok(complianceRefusal(u), `the number must be suppressed for it: "${u}"`);
}

/* And the time-boxed case is the documented divergence: handled in
 * conversation, never suppressed. Both halves are asserted so neither can
 * change alone and quietly reintroduce the other bug. */
assert.ok(agentRefusal.test("no follow up for now"), "the agent still handles a time-boxed refusal politely");
assert.equal(complianceRefusal("no follow up for now"), false, "but must not suppress a lead who asked for space");

console.log("refusal suppression path: PASS");
console.log("  array transcript parsed, prospect-only scan, suppressed before any lead row");
console.log(`  ${MUST_AGREE.length} refusals handled by BOTH the agent and the compliance layer`);