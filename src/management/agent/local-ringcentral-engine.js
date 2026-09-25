"use strict";
const { sipCallBridge } = require("../portal/softphone");
const FRAME_BYTES = 160;
const SILENCE = 0xff;
const PACKET_MS = 20; // 160 bytes of PCMU = 20ms of speech at 8kHz
const PACE_TICK_MS = 8;
// Extra frames sent ahead of the wall clock (the "+1" below already gives the
// first frame). Measured on this machine: setTimeout(_,8) wakes every ~15.6ms
// (Windows system tick), so frames leave on a 16/32ms grid while speech is
// 20ms/frame - a systematic 32ms hole in the outbound RTP, which is exactly
// what starves the callee's jitter buffer ("your voice is breaking" on the
// live 1.4.17 call). The receiver can only absorb that by holding a deeper
// buffer, so we keep it primed: 60ms of send-ahead turns our holes into
// buffered slack instead of underruns.
const LEAD_FRAMES = 2;
// With a 20ms grid and a 15.6ms wake tick a healthy run alternates 16ms and
// 32ms gaps (measured: 30 of 120 frames above 25ms), so only gaps past two
// frames are a real stall worth counting.
const SLOW_GAP_MS = 40;
const KEEPALIVE_MS = 120; // idle silence cadence: 100ms of audio every 120ms
const KEEPALIVE_AUDIO = Buffer.alloc(FRAME_BYTES * 5, SILENCE);
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
 * never received the WAV it was built from. Re-drive the packet sender from a
 * wall-clock due-count so lateness is caught up instead of accumulated.
 *
 * Two hardening rules, both learned from live calls:
 *  - The SDK only emits "finished" from inside its own packet sender, which we
 *    neutralise. If our loop ever stopped one frame short, playback hung and
 *    only the watchdog (audioMs + 2500ms) released the turn, cutting the voice
 *    mid-sentence. We now emit "finished" ourselves the moment the buffer
 *    drains, so the watchdog is a last resort instead of the normal path.
 *  - Catch-up used to be bounded only by a 500-iteration guard, so one stalled
 *    event-loop tick dumped a whole utterance into the far-end jitter buffer at
 *    once. Catch-up is capped at MAX_BURST_FRAMES and anything further behind
 *    than MAX_BEHIND_FRAMES is skipped on the timeline (dropping <=160ms of
 *    audio is inaudible; a burst is what breaks the voice up).
 * Returns a stop() that silences any further scheduling; stop().stats() reports
 * what actually went out so a live call can be verified instead of guessed at.
 */
const MAX_BURST_FRAMES = 4;
const MAX_BEHIND_FRAMES = 8;
function paceStreamer(streamer, totalBytes) {
  if (!streamer || typeof streamer.sendPacket !== "function" || !streamer.buffer) return Object.assign(() => {}, { stats: null });
  const origSend = streamer.sendPacket;
  // The SDK re-arms setTimeout(...,20) from inside its own packet loop, and
  // invoking it once per catch-up would multiply those chains into a burst that
  // sends ahead of real time. Neutralise the self-rescheduling callback so our
  // loop below is the only clock; origSend still builds and encrypts each packet.
  streamer.sendPacket = () => {};
  const startedAt = Date.now();
  let timer = 0;
  let stopped = false;
  let lastSendAt = startedAt;
  let maxGapMs = 0;
  let slowGaps = 0;
  let maxBurstFrames = 0;
  let droppedBytes = 0;
  const stats = () => ({
    sentBytes: Math.max(0, totalBytes - (streamer && streamer.buffer ? streamer.buffer.length : 0) - droppedBytes),
    droppedBytes, maxGapMs, slowGaps, maxBurstFrames, elapsedMs: Date.now() - startedAt,
  });
  const declareFinished = () => {
    try { streamer.emit("finished"); } catch { /* not an emitter */ }
  };
  const driver = () => {
    timer = 0;
    if (stopped) return;
    if (!streamer.buffer) return;
    if (streamer.finished) { declareFinished(); return; }
    const due = Math.min(totalBytes, (Math.floor((Date.now() - startedAt) / PACKET_MS) + 1 + LEAD_FRAMES) * FRAME_BYTES);
    const sent = totalBytes - streamer.buffer.length;
    const behind = due - sent;
    if (behind > MAX_BEHIND_FRAMES * FRAME_BYTES) {
      const raw = behind - MAX_BEHIND_FRAMES * FRAME_BYTES;
      const aligned = Math.floor(Math.min(raw, streamer.buffer.length) / FRAME_BYTES) * FRAME_BYTES;
      if (aligned > 0) {
        streamer.buffer = streamer.buffer.subarray(aligned);
        droppedBytes += aligned;
      }
    }
    let burst = 0;
    while (!streamer.finished && totalBytes - streamer.buffer.length < due && burst < MAX_BURST_FRAMES) {
      origSend.call(streamer);
      burst++;
    }
    if (burst > maxBurstFrames) maxBurstFrames = burst;
    if (burst > 0) {
      const now = Date.now();
      const gap = now - lastSendAt;
      if (gap > maxGapMs) maxGapMs = gap;
      if (gap > SLOW_GAP_MS) slowGaps++;
      lastSendAt = now;
    }
    if (streamer.finished) { declareFinished(); return; }
    timer = setTimeout(driver, PACE_TICK_MS);
  };
  timer = setTimeout(driver, PACE_TICK_MS);
  return Object.assign(() => { stopped = true; clearTimeout(timer); timer = 0; }, { stats });
}
function createLocalRingCentralEngine({ sip, number, onAudio = () => {}, onLog = () => {}, onSessionGone = null, bridgeFactory = sipCallBridge }) {
  let bridge, session, streamer, activePlayback, closed = false, gone = false, bytesIn = 0, bytesOut = 0;
  let sendChain = Promise.resolve();
  let generation = 0;
  let firstInboundAt = 0;
  let settleUntil = 0;
  let lastInboundAt = 0;
  let maxInboundGapMs = 0;
  let keepAliveSends = 0;
  let keepAliveTimer = 0;
  async function connect() {
    bridge = await bridgeFactory({ ...sip, number });
    if (!bridge || !bridge.ok || !bridge.callSession) throw new Error((bridge && bridge.last) || "RingCentral call bridge failed");
    session = bridge.callSession;
    session.on("audioPacket", packet => {
      const payload = packet && packet.payload;
      if (!payload || !payload.length || closed) return;
      const now = Date.now();
      if (!firstInboundAt) firstInboundAt = now;
      else if (now - lastInboundAt > maxInboundGapMs) maxInboundGapMs = now - lastInboundAt;
      lastInboundAt = now;
      const b = Buffer.from(payload);
      bytesIn += b.length;
      onAudio(b);
    });
    const onGone = () => {
      if (closed || gone) return;
      gone = true;
      clearInterval(keepAliveTimer);
      keepAliveTimer = 0;
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
    // Keep RTP flowing for the whole call, not only while TTS synthesises.
    // The 1.4.17 live log showed ~15s stretches with zero outbound packets
    // during listen windows: the callee-side jitter buffer drains, so every
    // reply starts cold and breaks up. 100ms of mu-law silence every 120ms
    // keeps that buffer primed end to end. unref() so this timer can never be
    // the reason a test process refuses to exit.
    clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(() => { try { keepAlive(); } catch { /* never crash the call */ } }, KEEPALIVE_MS);
    if (keepAliveTimer && typeof keepAliveTimer.unref === "function") keepAliveTimer.unref();
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
      const isKeepAliveFeed = audio.length === KEEPALIVE_AUDIO.length && audio.equals(KEEPALIVE_AUDIO);
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
        // Report what actually left this process before the pacer is torn down.
        // A live call is only verifiable if the log shows the send timeline:
        // gap = longest hole in the outbound RTP, burst = frames pushed in one
        // tick (a burst is what the far-end jitter buffer drops as break-up).
        const s = stopPace && stopPace.stats ? stopPace.stats() : null;
        if (s) {
          const audioMs = Math.ceil(audio.length / 8);
          const complete = s.sentBytes >= audio.length * 0.95;
          const detail = `outbound pacing: ${s.sentBytes}/${audio.length} bytes in ${s.elapsedMs}ms (audio ${audioMs}ms), maxGap ${s.maxGapMs}ms, slowGaps ${s.slowGaps}f, maxBurst ${s.maxBurstFrames}f, dropped ${s.droppedBytes}b`;
          const bad = s.maxGapMs > 60 || s.maxBurstFrames > MAX_BURST_FRAMES || s.droppedBytes > 0 || (complete && s.elapsedMs > audioMs + 300);
          // Idle keep-alive silence repeats ~8x/second for the whole call;
          // logging every one would drown the turns. Log the first for proof
          // and any that misbehave.
          if (isKeepAliveFeed) {
            keepAliveSends++;
            if (bad) onLog("[local-media-v2] pacing warning (keep-alive): " + detail);
            else if (keepAliveSends === 1) onLog("[local-media-v2] " + detail + " (keep-alive silence)");
          } else {
            onLog(bad ? "[local-media-v2] pacing warning: " + detail : "[local-media-v2] " + detail);
          }
        }
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
          // A streamer that is already drained/disposed never emits again; the
          // listener below would wait forever and the watchdog would cut the
          // turn. Resolve straight away instead.
          if (streamer.finished) return finish();
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
    return sendAudio(KEEPALIVE_AUDIO).catch(() => 0);
  }
  function status() { return { connected: !!session && !closed && !gone, bytesIn, bytesOut, frameBytes: FRAME_BYTES, codec: "PCMU/8000" }; }
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(keepAliveTimer);
    keepAliveTimer = 0;
    onLog(`[local-media-v2] media stats: inbound ${bytesIn} bytes, outbound ${bytesOut} bytes, max inbound gap ${maxInboundGapMs}ms, keep-alive sends ${keepAliveSends}`);
    try { if (streamer) streamer.stop(); } catch {}
    try { if (bridge && bridge.cleanup) bridge.cleanup(); } catch {}
    session = null;
  }
  return { connect, waitForInboundMedia, sendAudio, interrupt, keepAlive, status, close };
}
module.exports = { createLocalRingCentralEngine, normalizePcmu, FRAME_BYTES };
