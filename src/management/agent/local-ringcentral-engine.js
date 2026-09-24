"use strict";
const { sipCallBridge } = require("../portal/softphone");
const FRAME_BYTES = 160;
const SILENCE = 0xff;
function normalizePcmu(input) {
  if (!input) return Buffer.alloc(0);
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (!b.length) return b;
  const rem = b.length % FRAME_BYTES;
  return rem ? Buffer.concat([b, Buffer.alloc(FRAME_BYTES - rem, SILENCE)]) : b;
}
function createLocalRingCentralEngine({ sip, number, onAudio = () => {}, onLog = () => {}, bridgeFactory = sipCallBridge }) {
  let bridge, session, streamer, activePlayback, closed = false, bytesIn = 0, bytesOut = 0;
  let sendChain = Promise.resolve();
  let generation = 0;
  let firstInboundAt = 0;
  let settleUntil = 0;
  async function connect() {
    bridge = await bridgeFactory({ ...sip, number });
    if (!bridge || !bridge.ok || !bridge.callSession) throw new Error((bridge && bridge.last) || "RingCentral call bridge failed");
    session = bridge.callSession;
    session.on("audioPacket", packet => {
      const payload = packet && packet.payload;
      if (!payload || !payload.length || closed) return;
      if (!firstInboundAt) firstInboundAt = Date.now();
      const b = Buffer.from(payload);
      bytesIn += b.length;
      onAudio(b);
    });
    const onGone = () => {
      if (closed) return;
      const p = activePlayback;
      if (p && typeof p.finish === "function") p.finish();
      streamer = null;
      sendChain = Promise.resolve();
      onLog("[local-media-v2] call session ended remotely");
    };
    try {
      session.on("disposed", onGone);
      session.on("ended", onGone);
      session.on("bye", onGone);
    } catch { /* older SDK sessions */ }
    // Punch the RTP path with mu-law silence before the first spoken frame so
    // the SBC learns our media source and the callee does not hear dead air.
    try {
      const warm = Buffer.alloc(160 * 25, SILENCE);
      streamer = session.streamAudio(warm);
      if (streamer && typeof streamer.once === "function") {
        await new Promise((resolve) => {
          const done = () => resolve();
          streamer.once("finished", done);
          streamer.once("error", done);
          setTimeout(done, 400);
        });
      }
    } catch { /* warm-up is best-effort */ }
    streamer = null;
    onLog("[local-media-v2] RingCentral answered; local media active");
    return status();
  }
  /** Wait until the callee path has produced RTP (or a short cap), so we do
   * not start the opening before media is actually flowing both ways. */
  async function waitForInboundMedia(maxWaitMs = 1200) {
    const start = Date.now();
    while (!closed && !firstInboundAt && Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 40));
    }
    return { gotInbound: !!firstInboundAt, waitedMs: Date.now() - start };
  }
  function play(audio) {
    return new Promise((resolve, reject) => {
      if (!session || closed) return reject(new Error("local media is not connected"));
      let settled = false;
      const audioMs = Math.ceil(audio.length / 8);
      const watchdogMs = Math.min(Math.max(audioMs + 2500, 4000), 45000);
      let watchdog = 0;
      let settleTimer = 0;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        clearTimeout(settleTimer);
        if (activePlayback && activePlayback.finish === finish) activePlayback = null;
        resolve(audio.length);
      };
      const fail = err => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        clearTimeout(settleTimer);
        if (activePlayback && activePlayback.finish === finish) activePlayback = null;
        reject(err instanceof Error ? err : new Error(String(err || "audio stream failed")));
      };
      const startStream = () => {
        if (settled || closed || !session) { if (!settled) fail(new Error("local media is not connected")); return; }
        try {
          streamer = session.streamAudio(audio);
          activePlayback = { finish };
          bytesOut += audio.length;
          if (!streamer || typeof streamer.once !== "function") return finish();
          streamer.once("finished", finish);
          streamer.once("error", fail);
          // streamAudio() can silently never finish after interrupt/remote hangup;
          // a hung promise left the live call stuck with no further turns.
          watchdog = setTimeout(() => {
            if (settled) return;
            try { if (streamer && typeof streamer.stop === "function") streamer.stop(); } catch {}
            onLog(`[local-media-v2] outbound watchdog after ${watchdogMs}ms; releasing turn`);
            finish();
          }, watchdogMs);
        } catch (err) { fail(err); }
      };
      // Soft re-entry after barge-in: a short settle avoids re-opening the
      // RTP stream in the same tick as stop(), which clicks/breaks the voice.
      const waitMs = settleUntil - Date.now();
      if (waitMs > 0) {
        activePlayback = { finish };
        settleTimer = setTimeout(startStream, waitMs);
      } else {
        startStream();
      }
    });
  }
  function sendAudio(input) {
    const audio = normalizePcmu(input);
    if (!audio.length) return Promise.resolve(0);
    const mine = generation;
    sendChain = sendChain.catch(() => 0).then(() => mine === generation ? play(audio) : 0);
    return sendChain;
  }
  function interrupt() {
    generation++;
    const interrupted = activePlayback;
    try { if (streamer && typeof streamer.stop === "function") streamer.stop(); } catch {}
    if (interrupted && typeof interrupted.finish === "function") interrupted.finish();
    streamer = null;
    activePlayback = null;
    sendChain = Promise.resolve();
    settleUntil = Date.now() + 40;
    onLog("[local-media-v2] outbound playback interrupted");
  }
  /** Idle μ-law silence so RTP stays warm while TTS/STT/brain think. */
  function keepAlive() {
    if (closed || !session || activePlayback) return Promise.resolve(0);
    return sendAudio(Buffer.alloc(FRAME_BYTES * 5, SILENCE));
  }
  function status() { return { connected: !!session && !closed, bytesIn, bytesOut, frameBytes: FRAME_BYTES, codec: "PCMU/8000" }; }
  function close() {
    if (closed) return;
    closed = true;
    try { if (streamer) streamer.stop(); } catch {}
    try { if (bridge && bridge.cleanup) bridge.cleanup(); } catch {}
    session = null;
  }
  return { connect, waitForInboundMedia, sendAudio, interrupt, keepAlive, status, close };
}
module.exports = { createLocalRingCentralEngine, normalizePcmu, FRAME_BYTES };
