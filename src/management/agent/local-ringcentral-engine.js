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
  async function connect() {
    bridge = await bridgeFactory({ ...sip, number });
    if (!bridge || !bridge.ok || !bridge.callSession) throw new Error((bridge && bridge.last) || "RingCentral call bridge failed");
    session = bridge.callSession;
    session.on("audio", audio => {
      if (!audio || !audio.length || closed) return;
      const b = Buffer.from(audio);
      bytesIn += b.length;
      onAudio(b);
    });
    onLog("[local-media-v2] RingCentral answered; local media active");
    return status();
  }
  function play(audio) {
    return new Promise((resolve, reject) => {
      if (!session || closed) return reject(new Error("local media is not connected"));
      let settled = false;
      const finish = () => { if (!settled) { settled = true; if (activePlayback && activePlayback.finish === finish) activePlayback = null; resolve(audio.length); } };
      const fail = err => { if (!settled) { settled = true; if (activePlayback && activePlayback.finish === finish) activePlayback = null; reject(err instanceof Error ? err : new Error(String(err || "audio stream failed"))); } };
      try {
        streamer = session.streamAudio(audio);
        activePlayback = { finish };
        bytesOut += audio.length;
        if (!streamer || typeof streamer.once !== "function") return finish();
        streamer.once("finished", finish);
        streamer.once("error", fail);
      } catch (err) { fail(err); }
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
    sendChain = Promise.resolve();
    onLog("[local-media-v2] outbound playback interrupted");
  }
  function status() { return { connected: !!session && !closed, bytesIn, bytesOut, frameBytes: FRAME_BYTES, codec: "PCMU/8000" }; }
  function close() {
    if (closed) return;
    closed = true;
    try { if (streamer) streamer.stop(); } catch {}
    try { if (bridge && bridge.cleanup) bridge.cleanup(); } catch {}
    session = null;
  }
  return { connect, sendAudio, interrupt, status, close };
}
module.exports = { createLocalRingCentralEngine, normalizePcmu, FRAME_BYTES };
