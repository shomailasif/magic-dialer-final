/* An engine the portal will not authorise must never reach a prospect.
 * Before this, a rejected brain fell back to a canned opening and the call was
 * placed anyway - the customer heard "Could.", "How?" and "You cut out". */
const assert = require("node:assert");
const { runLocalCall } = require("./local-call-controller");

const VOIP = { ready: true, username: "u", sipPassword: "p", number: "+14807166685" };

/* The engine's real surface, from local-ringcentral-engine.js:321.
 *
 * This stub predates it and offered only close() and dial(). The controller grew a
 * connect() call, so the third scenario below died on "engine.connect is not a
 * function" - which is why this file was never in the regression runner. It was
 * the only test asserting that an unauthorised or deaf engine never reaches a
 * prospect, and it had been quietly failing for exactly as long.
 *
 * A stub that drifts from the interface it stands in for is worse than no stub,
 * because it makes the test look present in the repository while proving nothing. */
function stubEngine(onDial) {
  return {
    async connect() { return {}; },
    async waitForInboundMedia() { return { gotInbound: false, waitedMs: 0 }; },
    async sendAudio() { return 3200; },
    interrupt() {},
    keepAlive() { return Promise.resolve(0); },
    status() { return { connected: true, bytesIn: 0, bytesOut: 0, frameBytes: 160, codec: "PCMU/8000" }; },
    close() {},
    /* Not part of the current engine interface - kept only so a regression that
     * reintroduces dialing fails loudly here rather than silently. */
    async dial() { if (onDial) onDial(); return { ok: true }; },
  };
}

function deps(over = {}) {
  return {
    createLocalRingCentralEngine: () => stubEngine(),
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
      createLocalRingCentralEngine: () => stubEngine(() => { used.dialed = true; }),
      opening: async () => ({ text: "Hi, this is Atlas with Zaz Logistics. Is now a good time to talk?" }),
      sttAuthorised: async () => ({ ok: false, fatal: false, reason: "probe could not reach the portal" }),
    }),
  });
  assert.ok(used.dialed, "a network blip must not stop a real call");
  console.log("  ok  a network blip still places the call");

  console.log("PASS: an unauthorised or deaf engine never reaches a prospect");
}

main().catch((e) => { console.error(e); process.exit(1); });
