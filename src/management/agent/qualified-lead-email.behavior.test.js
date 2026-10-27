/* A qualified lead must reach the operator whether their portal is alive or gone.
 *
 * The portal emailed every result it accepted, and that was the whole delivery
 * path - the agent's own emailQualifiedLead was imported and never called, so
 * the dashboard reported "EMAILED to <address>" on a lead nobody sent. The
 * hosting then went away entirely, which would have made every qualified lead
 * from every campaign disappear silently: no portal to accept the result, no
 * mailbox to tell the operator.
 *
 * So the PC sends the lead itself when the portal did not, and these are the
 * two rules that keep it honest in both directions:
 *
 *  1. Never twice. The portal's `emailed` flag short-circuits before any SMTP
 *     work, because a duplicate lead email is worse than a delayed one.
 *  2. Never claimed. When the send fails the result says so, and the queue's
 *     "the operator has been emailed" line only appears on a real success -
 *     the old code asserted delivery in its log line regardless of what
 *     happened.
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { deliverQualifiedLead } = require("./email");

const LEAD = { name: "Dana Reyes", phone: "+15555550100", company: "Ridgeway Freight", email: "dana@example.com" };
const cfg = (over = {}) => ({ contactEmail: "owner@example.com", product: "LTL freight", smtp: undefined, ...over });
const logs = [];
const log = (m) => logs.push(String(m));
const outboxFiles = (dir) => {
  const b = path.join(dir, "outbox");
  return fs.existsSync(b) ? fs.readdirSync(b) : [];
};

async function main() {
  const cwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "md-email-"));
  process.chdir(tmp);
  try {
    // 1. A call that did not qualify sends nothing at all.
    const r1 = await deliverQualifiedLead({ config: cfg(), result: { goodLead: false }, lead: LEAD, log });
    assert.equal(r1.skipped, "not a qualified lead", "must skip a non-qualifying call, got " + JSON.stringify(r1));
    assert.equal(outboxFiles(tmp).length, 0, "a non-qualifying call must not write anything");

    // 2. The portal already emailed it: accepted, and nothing else happens.
    const r2 = await deliverQualifiedLead({ config: cfg(), result: { goodLead: true, emailed: true, score: 9 }, lead: LEAD, log });
    assert.equal(r2.ok, true, "a portal-delivered lead counts as delivered");
    assert.equal(r2.method, "portal", "must report the portal as the sender, got " + r2.method);
    assert.equal(outboxFiles(tmp).length, 0, "the portal's email must suppress the local one entirely");

    // 3. Nowhere to send it: reported as a failure, not invented.
    const r3 = await deliverQualifiedLead({ config: cfg({ contactEmail: "  " }), result: { goodLead: true }, lead: LEAD, log });
    assert.equal(r3.ok, false, "with no destination the send must fail rather than claim success");
    assert.ok(/No contact email/.test(r3.error), "the failure must say what is missing: " + r3.error);
    assert.equal(outboxFiles(tmp).length, 0, "no destination must not write an outbox file");

    // 4. SMTP that cannot be reached falls back to the outbox, never a claim
    //    of delivery. Port 1 on loopback refuses immediately, so this is the
    //    dead-mail-server case rather than a hang.
    const r4 = await deliverQualifiedLead({
      config: cfg({ smtp: { host: "127.0.0.1", port: 1, user: "u", pass: "p", from: "u@example.com" } }),
      result: { goodLead: true, score: 8, summary: "Wants a rate to Chicago.", answers: { lanes: "CHI" } },
      lead: LEAD, log,
    });
    assert.equal(r4.ok, true, "an unreachable SMTP server must still deliver the lead to the outbox: " + JSON.stringify(r4));
    assert.equal(r4.method, "outbox", "must say the lead went to the outbox, got " + r4.method);
    const files = outboxFiles(tmp);
    assert.equal(files.length, 1, "exactly one outbox file expected, got " + files.length);
    const body = fs.readFileSync(path.join(tmp, "outbox", files[0]), "utf8");
    assert.ok(body.includes(LEAD.phone), "the outbox copy must contain the lead's number");
    assert.ok(body.includes("LTL freight"), "the outbox copy must contain the product: " + body.split("\n")[1]);
    assert.ok(/To: owner@example\.com/.test(body), "the outbox copy must be addressed to the operator's contact email");
    assert.ok(logs.some((m) => /Qualified lead for owner@example\.com saved to .*outbox.*nothing was emailed/.test(m)),
      "the operator must be told where it actually went, and that it was not emailed, logs: " + JSON.stringify(logs));

    /* The engine passes its own data directory: a packaged install can start
     * from Program Files, where writing the last-resort copy used to fail. */
    const dataDir = path.join(tmp, "engine-data");
    const r4b = await deliverQualifiedLead({
      config: cfg({ smtp: undefined, outboxDir: dataDir }),
      result: { goodLead: true }, lead: LEAD, log,
    });
    assert.equal(r4b.method, "outbox");
    assert.ok(fs.existsSync(r4b.path), "the saved copy must be readable at the reported path: " + r4b.path);
    assert.ok(r4b.path.startsWith(dataDir), "the copy must land in the directory the engine chose, not the working directory: " + r4b.path);

    // 5. The failure message must name the address, so a mis-typed contact is
    //    diagnosable from the log alone.
    logs.length = 0;
    const r5 = await deliverQualifiedLead({
      config: cfg({ contactEmail: "ops@example.com", smtp: { host: "127.0.0.1", port: 1 } }),
      result: { goodLead: true }, lead: LEAD, log,
    });
    assert.ok(r5.ok && r5.method === "outbox", "still delivered locally");
    assert.ok(logs.some((m) => /ops@example\.com/.test(m)), "the address must appear in the log: " + JSON.stringify(logs));
  } finally {
    process.chdir(cwd);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  // Source contracts: the wiring itself, since neither path can be run without
  // placing a real call and this is what fails a build instead of a campaign.
  const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
  const callSrc = read("call.js");
  assert.ok(/emailed = Boolean\(body && body\.emailed\)/.test(callSrc),
    "call.js must report whether the portal itself emailed the lead");
  assert.ok(/posted, emailed, learning: updatedLearning/.test(callSrc),
    "call.js must return the emailed flag to its caller");
  assert.ok(/posted: null, emailed: false/.test(callSrc),
    "a failed call must report that nobody emailed anything");

  const agentSrc = read("agent.js");
  const wiring = agentSrc.split("deliverQualifiedLead({").length - 1;
  assert.ok(wiring >= 2,
    "both call paths (single call and the dial queue) must hand the result to deliverQualifiedLead, found " + wiring);
  assert.ok(agentSrc.includes("out.leadEmailed"), "the queue path must report the email outcome back to the queue");

  const queueSrc = read("lead-queue.js");
  assert.ok(queueSrc.includes("leadEmailed"), "the queue must read the email outcome before claiming delivery");
  assert.ok(queueSrc.includes("the operator has been emailed"), "a delivered lead must still be reported as emailed");
  assert.ok(queueSrc.includes("the email could not be sent"), "a failed email must never be reported as delivered");

  console.log("PASS: a qualified lead reaches the operator whether the portal emailed it or this PC did");
}

main().catch((e) => { console.error("  FAIL " + (e && e.stack || e)); process.exit(1); });
