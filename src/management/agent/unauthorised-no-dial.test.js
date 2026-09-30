/* An engine the portal will not authorise must never reach a prospect.
 * Before this, a rejected brain fell back to a canned opening and the call was
 * placed anyway - the customer heard "Could.", "How?" and "You cut out". */
const assert = require("node:assert");
const { runLocalCall } = require("./local-call-controller");

const VOIP = { ready: true, username: "u", sipPassword: "p", number: "+14807166685" };

function deps(over = {}) {
  return {
    createLocalRingCentralEngine: () => ({ close() {}, dial: async () => ({ ok: true }) }),
    speakToBuffer: async () => ({ buffer: Buffer.alloc(4000, 7), engine: "test" }),
    // A brain the portal rejected: no text, an auth error.
    voiceCall: async () => ({}),
    transcribeAuto: async () => ({ text: null, error: "Unauthorized" }),
    // The brain the portal rejected: no text, an auth error.
    opening: async () => ({ text: null, error: "Unauthorized" }),
    ...over,
  };
}
const CONFIG = { voip: VOIP, deviceToken: "tok", portalUrl: "https://portal.example", persona: { name: "Atlas" }, companyName: { name: "Zaz" } };

async function main() {
  // 1. Rejected brain -> no call, and the reason names enrolment.
  await assert.rejects(
    () => runLocalCall({ config: CONFIG, number: "+15555550100", onLog: () => {}, deps: deps() }),
    (e) => {
      assert.ok(/not authorised/i.test(e.message), "message must say the PC is not authorised: " + e.message);
      assert.ok(/re-enrol|re-enroll/i.test(e.message), "message must say how to fix it: " + e.message);
      return true;
    },
  );
  console.log("  ok  a rejected brain refuses to dial, and says how to fix it");

  // 2. Rejected hearing -> no call either.
  await assert.rejects(
    () => runLocalCall({
      config: CONFIG, number: "+15555550100", onLog: () => {},
      deps: deps({
        opening: async () => ({ text: "Hi, this is Atlas with Zaz Logistics. Is now a good time to talk?" }),
        sttAuthorised: async () => ({ ok: false, fatal: true, reason: "STT gateway rejected this PC (HTTP 401)" }),
      }),
    }),
    /not authorised/i,
  );
  console.log("  ok  a deaf engine refuses to dial");

  // 3. A gateway blip is NOT a broken PC - the call must still go out.
  const used = { dialed: false };
  await runLocalCall({
    config: CONFIG, number: "+15555550100", onLog: () => {},
    deps: deps({
      voiceCall: async (o) => { used.dialed = true; return { score: 0, goodLead: false }; },
      createLocalRingCentralEngine: () => ({ close() {}, dial: async () => { used.dialed = true; return { ok: true }; } }),
      opening: async () => ({ text: "Hi, this is Atlas with Zaz Logistics. Is now a good time to talk?" }),
      sttAuthorised: async () => ({ ok: false, fatal: false, reason: "probe could not reach the portal" }),
    }),
  });
  assert.ok(used.dialed, "a network blip must not stop a real call");
  console.log("  ok  a network blip still places the call");

  console.log("PASS: an unauthorised or deaf engine never reaches a prospect");
}

main().catch((e) => { console.error(e); process.exit(1); });
