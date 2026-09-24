"use strict";
const { sipCallBridge } = require("../portal/softphone");
const FRAME_BYTES = 160;
const SILENCE = 0xff;
const PACKET_MS = 20; // 160 bytes of PCMU = 20ms of speech at 8kHz
const PACE_TICK_MS = 8;
function normalizePcmu(input) {
  if (!input) return Buffer.alloc(0);
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (!b.length) return b;
  const rem = b.length % FRAME_BYTES;
  return rem ? Buffer.concat([b, Buffer.alloc(FRAME_BYTES - rem, SILENCE)]) : b;
}
/**
 * The SDK Streamer schedules the next packet with setTimeout(20), but Windows
 * timer granularity is ~15.6ms so a packet actually leaves every ~32ms: RTP
 * went out at 62% of real time, the callee's jitter buffer starved (99.3%
 * underrun in replay) and the opening took 1.6x its duration - the far end
 * never received the WAV it was built from. Re-drive sendPacket from a
 * wall-clock due-count so lateness is caught up instead of accumulated.
 * Returns a stop() that silences any further scheduling.
 */
function paceStreamer(streamer, totalBytes) {
  if (!streamer || typeof streamer.sendPacket !== "function" || !streamer.buffer) return () => {};
  const origSend = streamer.sendPacket;
  // The SDK re-arms setTimeout(...,20) from inside its own packet loop, and
  // invoking it once per catch-up would multiply those chains into a burst that
  // sends ahead of real time. Neutralise the self-rescheduling callback so our
  // loop below is the only clock; origSend still builds and encrypts each packet.
  streamer.sendPacket = () => {};
  const startedAt = Date.now();
  let timer = 0;
  let stopped = false;
  const driver = () => {
    timer = 0;
    if (stopped || !streamer.buffer || streamer.finished) return;
    // packets whose 20ms slot has already elapsed by wall-clock
    const due = Math.min(totalBytes, (Math.floor((Date.now() - startedAt) / PACKET_MS) + 1) * FRAME_BYTES);
    let guard = 500;
    while (!streamer.finished && totalBytes - streamer.buffer.length < due && guard-- > 0) {
      origSend.call(streamer);
    }
    if (!stopped && !streamer.finished) timer = setTimeout(driver, PACE_TICK_MS);
  };
  timer = setTimeout(driver, PACE_TICK_MS);
  return () => { stopped = true; clearTimeout(timer); timer = 0; };
}
function createLocalRingCentralEngine({ sip, number, onAudio = () => {}, onLog = () => {}, onSessionGone = null, bridgeFactory = sipCallBridge }) {
  let bridge, session, streamer, activePlayback, closed = false, gone = false, bytesIn = 0, bytesOut = 0;
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
      if (closed || gone) return;
      gone = true;
      const p = activePlayback;
      if (p && typeof p.finish === "function") p.finish();
      streamer = null;
      sendChain = Promise.resolve();
      onLog("[local-media-v2] call session ended remotely");
      // The conversation loop must stop on BYE: without this the controller
      // kept speaking/listening for ~35s after hangup (watchdogs fired).
      if (typeof onSessionGone === "function") { try { onSessionGone(); } catch {} }
    };
    try {
      session.on("disposed", onGone);
      session.on("ended", onGone);
      session.on("bye", onGone);
    } catch { /* older SDK sessions */ }
    // Punch the RTP path with mu-law silence before the first spoken frame so
    // the SBC learns our media source and the callee does not hear dead air.
    let stopWarmPace = () => {};
    try {
      const warm = Buffer.alloc(160 * 25, SILENCE);
      streamer = session.streamAudio(warm);
      stopWarmPace = paceStreamer(streamer, warm.length);
      if (streamer && typeof streamer.once === "function") {
        await new Promise((resolve) => {
          const done = () => resolve();
          streamer.once("finished", done);
          streamer.once("error", done);
          setTimeout(done, 400);
        });
      }
    } catch { /* warm-up is best-effort */ }
    // The warm-up must never outlive connect(): an unstopped Streamer keeps
    // emitting mu-law silence while the opening plays, and its frames land in
    // the middle of the opening's RTP timeline (replay: 16-30 foreign packets,
    // 520ms of dead air punched into a 2420ms line).
    stopWarmPace();
    try { if (streamer && typeof streamer.stop === "function") streamer.stop(); } catch { /* best-effort */ }
    streamer = null;
    onLog("[local-media-v2] RingCentral answered; local media active");
    return status();
  }
  /** Wait until the callee path has produced RTP (or a short cap), so we do
   * not start the opening before media is actually flowing both ways. */
  async function waitForInboundMedia(maxWaitMs = 1200) {
    const start = Date.now();
    while (!closed && !gone && !firstInboundAt && Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 40));
    }
    return { gotInbound: !!firstInboundAt, waitedMs: Date.now() - start };
  }
  function play(audio) {
    return new Promise((resolve, reject) => {
      if (!session || closed || gone) return reject(new Error(gone ? "call session ended remotely" : "local media is not connected"));
      let settled = false;
      const audioMs = Math.ceil(audio.length / 8);
      const watchdogMs = Math.min(Math.max(audioMs + 2500, 4000), 45000);
      let watchdog = 0;
      let settleTimer = 0;
      let stopPace = () => {};
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        clearTimeout(settleTimer);
        stopPace();
        if (activePlayback && activePlayback.finish === finish) activePlayback = null;
        resolve(audio.length);
      };
      const fail = err => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        clearTimeout(settleTimer);
        stopPace();
        if (activePlayback && activePlayback.finish === finish) activePlayback = null;
        reject(err instanceof Error ? err : new Error(String(err || "audio stream failed")));
      };
      const startStream = () => {
        if (settled || closed || gone || !session) { if (!settled) fail(new Error(gone ? "call session ended remotely" : "local media is not connected")); return; }
        try {
          streamer = session.streamAudio(audio);
          activePlayback = { finish };
          bytesOut += audio.length;
          if (!streamer || typeof streamer.once !== "function") return finish();
          streamer.once("finished", finish);
          streamer.once("error", fail);
          stopPace = paceStreamer(streamer, audio.length);
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
    // Remote BYE: resolve quietly so callers/keep-alive never see a
    // late rejection after the leg is already gone.
    if (gone) return Promise.resolve(0);
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
    if (closed || gone || !session || activePlayback) return Promise.resolve(0);
    // never reject: an unhandled keep-alive promise would crash the child
    return sendAudio(Buffer.alloc(FRAME_BYTES * 5, SILENCE)).catch(() => 0);
  }
  function status() { return { connected: !!session && !closed && !gone, bytesIn, bytesOut, frameBytes: FRAME_BYTES, codec: "PCMU/8000" }; }
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
