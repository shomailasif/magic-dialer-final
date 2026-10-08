"use strict";

/* A prospect's words are not truncated. Ever.
 *
 * On the 07 Oct 2026 call the transcript contains, as a whole entry:
 *
 *   LEAD:  What do you
 *
 * That is a person cut off mid-sentence, on a dangling function word. The agent
 * then answered "Who is it?" with a promise of a callback, and the prospect said
 * "The fuck?". Both are in this repository's own detector vocabulary -
 * audio-sim.js lists "What do you" as its example of a truncated turn.
 *
 * WHAT CAUSED IT. Not the turn cap. capTurnLength is an OUTPUT budget and every
 * site that calls it is on the agent's own side of the conversation - agent(),
 * the controller's speakFn, and call-sim's grading of agent turns. The inbound
 * path never touched it, and this file pins that down as well as pinning the
 * thing that did.
 *
 * The real cause is the same class of mistake one layer down: a LENGTH budget
 * applied to the caller. listenFn armed a single setTimeout when the listen
 * window opened and resolved the window when it expired, so anyone talking for
 * longer than that budget had their sentence cut off at exactly that point and
 * the recognizer was handed the first five seconds of what they said. Its own
 * comment claimed the ceiling "only governs the far end said nothing at all",
 * which is false for an utterance with less than the VAD's 700ms of end-silence
 * in it - a continuous sentence never triggers the VAD's own end, so the
 * ceiling was the only thing that ever ended the turn. "What do you" is what
 * five seconds of that sentence looks like in a transcript.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { runLocalCall } = require("./local-call-controller");
const { runCall } = require("./call-runner");
const { MAX_TURN_CHARS, capTurnLength } = require("./turn-length");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 1. The controller: a long utterance survives intact.
 * ------------------------------------------------------------------ */

/** One frame of loud audio, and one of mu-law silence (0xff decodes to zero). */
const loudFrame = () => Buffer.alloc(160, 0x00);
const quietFrame = () => Buffer.alloc(160, 0xff);

/**
 * A prospect who talks for `speakingMs` with less than endSilenceMs (700ms) of
 * breath anywhere in it, then stops. The recognizer is a stub that reports how
 * many 20ms frames of audio it was handed and when it was called.
 *
 * The window is opened BEFORE the audio arrives, which is what a real turn does
 * and what the regression needs: an absolute ceiling taken when the window
 * opened only bites if the speech is still going when it expires.
 */
async function driveLongUtterance({ speakingMs, budgetMs = 5000 }) {
  let onAudio;
  let sttFrames = null;
  let sttAt = null;
  let windowOpenedAt = null;
  let listenReturnedAt = null;
  /* A VAD that is honest about a continuous sentence: voiced right through, and
   * only "ended" once the prospect has actually been quiet past the end-of-
   * silence plus the controller's hold. */
  let speaking = false;
  let quietFrames = 0;
  let voicedNow = false;
  const deps = {
    async sttAuthorised() { return { ok: true, fatal: false, reason: "stubbed" }; },
    async opening() { return { text: "Hello, this is Atlas with Zaz Logistics." }; },
    createLocalRingCentralEngine(opts) { onAudio = opts.onAudio; return engine; },
    createVad() {
      return {
        push() {
          if (voicedNow) { speaking = true; quietFrames = 0; }
          else if (speaking) { quietFrames++; }
          const ended = speaking && quietFrames >= 40; // 800ms > endSilence + hold
          return { voiced: voicedNow, speaking, ended, level: voicedNow ? 9000 : 0 };
        },
      };
    },
    async speakToBuffer() { return { buffer: Buffer.alloc(640, 0xff), engine: "stub" }; },
    async transcribeAuto(audio) {
      sttFrames = Math.floor(audio.length / 160);
      sttAt = Date.now() - windowOpenedAt;
      return { text: "I need to tell you about my fleet and where I run.", language: "en" };
    },
    async voiceCall({ speakFn, listenFn }) {
      await speakFn("Hello, this is Atlas with Zaz Logistics.");
      /* Opened first, so the window is live for the whole utterance. */
      const listening = listenFn({ locale: "en", maxSilenceMs: budgetMs });
      windowOpenedAt = Date.now();
      /* Real time, one 20ms frame per 20ms: the controller's budget is measured
       * against the wall clock, and a compressed clock would prove nothing. */
      const speechFrames = Math.round(speakingMs / 20);
      const tailFrames = 120; // 2.4s of silence after they finish
      for (let i = 0; i < speechFrames + tailFrames; i++) {
        voicedNow = i < speechFrames;
        onAudio(voicedNow ? loudFrame() : quietFrame());
        await sleep(20);
      }
      const heard = await listening;
      listenReturnedAt = Date.now() - windowOpenedAt;
      return { heard };
    },
  };
  const engine = {
    async connect() {},
    async waitForInboundMedia() { return { gotInbound: true, waitedMs: 5 }; },
    sendAudio() { return Promise.resolve(640); },
    interrupt() {},
    keepAlive() { return Promise.resolve(0); },
    close() {},
  };
  const out = await runLocalCall({
    config: {
      voip: { ready: true, username: "u", sipPassword: "p", number: "1" },
      product: "Dispatch Services for trucks",
      persona: { name: "Atlas" },
      companyName: { name: "Zaz Logistics" },
    },
    number: "2",
    deps,
    onLog: () => {},
  });
  return { heard: out.heard, sttFrames, sttAt, listenReturnedAt };
}

async function assertControllerKeepsLongUtterances() {
  /* Six and a half seconds of continuous speech. That is longer than the 5000ms
   * budget the listen window used to be a hard ceiling for, and it is an
   * ordinary thing to say - "I need to tell you about my fleet, and where I run
   * out of, and what I am paying" is six seconds without a pause. */
  const speakingMs = 6500;
  const { heard, sttFrames, sttAt, listenReturnedAt } = await driveLongUtterance({ speakingMs });
  const sttMs = sttAt;

  assert.ok(heard && heard.text, `the utterance must be transcribed, got: ${JSON.stringify(heard)}`);
  assert.ok(
    sttMs >= speakingMs,
    `the window must have stayed open for the whole utterance, transcription started ${sttMs}ms into ${speakingMs}ms of speech`
  );
  /* Every 20ms frame of their speech must be in the audio the recognizer was
   * given. This is the assertion the defect would have failed: a 5000ms ceiling
   * delivered roughly 5s/6.5s of the sentence. */
  const expectedFrames = Math.floor(speakingMs / 20) - 1; // one frame of VAD warm-up
  assert.ok(
    sttFrames >= expectedFrames,
    `every frame of prospect speech must reach the recognizer: got ${sttFrames} frames for ~${expectedFrames} of speech`
  );
  /* And a genuinely silent line must still be released promptly, or the fix
   * would have traded truncation for a dead line: the window has to close once
   * they stop, not wait out some larger budget. */
  assert.ok(listenReturnedAt >= sttMs, "the turn is released when the prospect stops, not before");
  assert.ok(listenReturnedAt - sttMs < 3000,
    `once they stop the turn must come back promptly, took ${listenReturnedAt - sttMs}ms more`);
}

/* ------------------------------------------------------------------ *
 * 2. The text path: the prospect's words are never shortened.
 * ------------------------------------------------------------------ */

/** Longer than MAX_TURN_CHARS, and it must arrive whole. */
const LONG_UTTERANCE = [
  "Right, so I run six trucks out of Columbus, mostly reefer and one dry van, and I am paying",
  "three percent a load through a broker who never once told me where the freight came from,",
  "and the second half of that is the part I wanted to talk to you about if you have got a minute.",
].join(" ");

async function assertTextPathKeepsItWhole() {
  process.env.GROQ_API_KEY = "long-prospect-speech-test";
  const globalFetch = global.fetch;
  const seen = [];
  global.fetch = async (_url, init) => {
    try { seen.push(JSON.parse(String(init && init.body))); } catch { seen.push(null); }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "That is a lot to cover - where would you like to start?" } }] }),
    };
  };
  const spoken = [];
  let i = 0;
  const turns = [LONG_UTTERANCE, "Columbus.", { ended: true, text: null }];
  try {
    const out = await runCall({
      product: "Dispatch Services for trucks",
      leadFields: ["MC NUMBER", "TRUCK SIZE"],
      persona: { name: "Atlas" },
      companyName: { name: "Zaz Logistics" },
      callbackNumber: null, callbackIn: null, contactEmail: null, learning: null,
      locale: "en",
      preparedOpeningText: "Hi, this is Atlas with Zaz Logistics. Is now a good time to talk?",
      portal: null, deviceToken: null, callId: "long-prospect-speech-test",
      speak: async (line) => { spoken.push(String(line)); },
      listen: async () => turns[i++],
    });
    assert.ok(LONG_UTTERANCE.length > MAX_TURN_CHARS,
      `the fixture has to be longer than the agent's own turn budget (${MAX_TURN_CHARS}) to be a real test of anything`);
    const heard = out.transcript.find((t) => t.role === "lead" && t.text !== "(silence)");
    assert.equal(heard && heard.text, LONG_UTTERANCE,
      "a long prospect utterance must reach the transcript byte for byte");
    /* It must also reach the BRAIN whole: the reply is only as good as what the
     * model was given, and a clipped turn is a reply to the wrong sentence. */
    const withUtterance = seen.find((p) => p && /Columbus/.test(JSON.stringify(p.messages || [])));
    assert.ok(withUtterance, "the brain must have been asked about the long utterance");
    const sentToModel = (withUtterance.messages || []).map((m) => m.content).join("\n");
    assert.ok(sentToModel.includes(LONG_UTTERANCE),
      `the brain must be given the whole utterance; it was given ${JSON.stringify(sentToModel.slice(0, 300))}`);
    /* It must not have been "tidied" on the way in either: no sentence dropped
     * off the end, no dangling function word, nothing elided. */
    for (const clause of ["six trucks out of Columbus", "paying", "three percent a load", "if you have got a minute"]) {
      assert.ok(sentToModel.includes(clause), `the clause "${clause}" must survive to the brain`);
    }
  } finally {
    global.fetch = globalFetch;
    if (process.env.GROQ_API_KEY !== "long-prospect-speech-test") delete process.env.GROQ_API_KEY;
  }
}

/* ------------------------------------------------------------------ *
 * 3. The contract itself: the turn cap is an OUTPUT budget.
 * ------------------------------------------------------------------ */

/** Every file that touches the length cap, and how it is used there. */
function capCallSites() {
  const dir = __dirname;
  const hits = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".js") || name.endsWith(".test.js")) continue;
    const src = fs.readFileSync(path.join(dir, name), "utf8");
    src.split(/\r?\n/).forEach((line, n) => {
      if (/capTurnLength\s*\(/.test(line)) hits.push({ file: name, line: n + 1, code: line.trim() });
    });
  }
  return hits;
}

async function main() {
  await assertControllerKeepsLongUtterances();
  await assertTextPathKeepsItWhole();

  /* Every call site of the cap must be an outbound one. There is no legitimate
   * inbound use for it: the words on the other end are transcribed and handed on
   * exactly as they came back. */
  const sites = capCallSites();
  assert.ok(sites.length > 0, "the turn cap must still be applied somewhere");
  for (const s of sites) {
    assert.doesNotMatch(
      s.code, /\b(lead|heard|prospect|stt)\b/i,
      `the agent's output-length cap must never be applied to the caller's words - ${s.file}:${s.line}: ${s.code}`
    );
  }
  const controller = fs.readFileSync(path.join(__dirname, "local-call-controller.js"), "utf8");
  assert.doesNotMatch(
    controller,
    /capTurnLength\(\s*(?:stt|heard|prospect|lead)/i,
    "the controller must never cap a transcript coming back from the recognizer"
  );
  /* And the cap still does its job on our own words - it is not simply off. */
  const longAgentTurn = "We help carriers find loads, handle the paperwork, and keep the routes moving. ".repeat(4);
  const capped = capTurnLength(longAgentTurn);
  assert.ok(capped.length <= MAX_TURN_CHARS + 45,
    `the agent's own turn is still capped, got ${capped.length} chars`);
  assert.match(capped.trim(), /[.!?]["')\u2019]?$/, "and a capped turn still ends as a finished sentence");

  console.log("PASS: long prospect speech is captured whole, transcribed whole and handed to the brain whole");
}

main().catch((e) => { console.error(e); process.exit(1); });