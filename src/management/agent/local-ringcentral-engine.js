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
function createLocalRingCentralEngine({ sip, number, onAudio = () => {}, onLog = () => {} }) {
  let bridge, session, streamer, closed = false, bytesIn = 0, bytesOut = 0;
  async function connect() {
    bridge = await sipCallBridge({ ...sip, number });
    if (!bridge || !bridge.ok || !bridge.callSession) throw new Error((bridge && bridge.last) || "RingCentral call bridge failed");
    session = bridge.callSession;
    session.on("audioPacket", packet => {
      const payload = packet && packet.payload;
      if (!payload || !payload.length || closed) return;
      const b = Buffer.from(payload); bytesIn += b.length; onAudio(b);
    });
    onLog("[local-media-v2] RingCentral answered; local media active");
    return status();
  }
  function sendAudio(input) {
    if (!session || closed) throw new Error("local media is not connected");
    const audio = normalizePcmu(input); if (!audio.length) return 0;
    if (streamer) { try { streamer.stop(); } catch {} }
    streamer = session.streamAudio(audio);
    bytesOut += audio.length;
    return audio.length;
  }
  function status() { return { connected: !!session && !closed, bytesIn, bytesOut, frameBytes: FRAME_BYTES, codec: "PCMU/8000" }; }
  function close() { if (closed) return; closed = true; try { if (streamer) streamer.stop(); } catch {} try { if (bridge && bridge.cleanup) bridge.cleanup(); } catch {} session = null; }
  return { connect, sendAudio, status, close };
}
module.exports = { createLocalRingCentralEngine, normalizePcmu, FRAME_BYTES };
