/*
 * Cloud call gateway - media channel (the "wire" that carries call audio).
 * Customer PCs connect over WSS/443; carrier SIP/RTP stays in the portal.
 */
const crypto = require("node:crypto");

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const TEXT = 0x1, BINARY = 0x2, CLOSE = 0x8, PING = 0x9, PONG = 0xA;

class Framer {
  constructor(onMessage, onClose) { this._buf = Buffer.alloc(0); this._onMessage = onMessage; this._onClose = onClose; this.closed = false; }
  push(chunk) {
    if (this.closed) return;
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    for (;;) {
      const frame = this._parse(); if (!frame) return;
      switch (frame.opcode) {
        case TEXT: this._onMessage(frame.payload, false); break;
        case BINARY: this._onMessage(frame.payload, true); break;
        case PING: this._onMessage(frame.payload, "ping"); break;
        case PONG: break;
        case CLOSE: this._close(); return;
        default: this._close(); return;
      }
      if (frame.fin !== undefined && !frame.fin) { this._close(); return; }
    }
  }
  _parse() {
    const b = this._buf; if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0, opcode = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return null; len = b.readUInt32BE(2) * 0x100000000 + b.readUInt32BE(6); off = 10; }
    if (len > 128 * 1024) { this._close(); return null; }
    const maskBytes = masked ? 4 : 0;
    if (b.length < off + maskBytes + len) return null;
    const mask = masked ? b.subarray(off, off + 4) : null;
    const payload = Buffer.from(b.subarray(off + maskBytes, off + maskBytes + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this._buf = b.subarray(off + maskBytes + len);
    return { fin, opcode, payload };
  }
  _close() { this.closed = true; this._buf = Buffer.alloc(0); this._onClose(); }
}

function encodeFrame(opcode, payload, mask = false) {
  const pay = Buffer.isBuffer(payload) ? payload : Buffer.from(payload), len = pay.length;
  const head = [0x80 | opcode]; let ext = null;
  if (len < 126) head.push((mask ? 0x80 : 0) | len);
  else if (len < 65536) { head.push((mask ? 0x80 : 0) | 126); ext = Buffer.alloc(2); ext.writeUInt16BE(len, 0); }
  else { head.push((mask ? 0x80 : 0) | 127); ext = Buffer.alloc(8); ext.writeUInt32BE(0, 0); ext.writeUInt32BE(len >>> 0, 4); }
  let out = Buffer.concat([Buffer.from(head), ext || Buffer.alloc(0), pay]);
  if (mask) {
    const k = crypto.randomBytes(4), masked = Buffer.alloc(pay.length);
    for (let i = 0; i < pay.length; i++) masked[i] = pay[i] ^ k[i & 3];
    out = Buffer.concat([Buffer.from(head), ext || Buffer.alloc(0), k, masked]);
  }
  return out;
}

const TONE_8K_16BIT = (() => {
  const n = 0.7 * 8000, b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) { const t = i / 8000, v = t < 0.35 ? Math.sin(2 * Math.PI * 440 * t) * 0.4 : 0; b.writeInt16LE(Math.round(v * 32767), i * 2); }
  return b;
})();

/*
 * Safe RingCentral outbound media path.
 * Agent sends 160-byte PCMU/20ms frames. We serialize those frames through
 * ringcentral-softphone's supported streamAudio() API. This deliberately
 * bypasses the old manual RTP/SRTP packet construction in trunk.js.
 */
function sendRingCentralSipAudio(session, payload) {
  const cs = session && session._sipCallSession;
  if (!cs || cs.disposed || typeof cs.streamAudio !== "function") return false;
  if (!session._sdkAudioQueue) session._sdkAudioQueue = [];
  session._sdkAudioQueue.push(Buffer.from(payload));
  if (session._sdkAudioPumping) return true;
  session._sdkAudioPumping = true;

  const pump = () => {
    if (!session._sdkAudioQueue || !session._sdkAudioQueue.length || cs.disposed) {
      session._sdkAudioPumping = false;
      return;
    }
    const frame = session._sdkAudioQueue.shift();
    let streamer;
    try { streamer = cs.streamAudio(frame); }
    catch { session._sdkAudioPumping = false; return; }
    session.mediaBytesOut = (session.mediaBytesOut || 0) + frame.length;
    if (streamer && typeof streamer.once === "function") {
      streamer.once("finished", pump);
      streamer.once("error", () => { session._sdkAudioPumping = false; });
    } else {
      setTimeout(pump, 20);
    }
  };
  pump();
  return true;
}

function install(server, { getSession }) {
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost"), m = String(url.pathname).match(/^\/ws\/media\/([^/]+)$/);
    if (!m) { socket.destroy(); return; }
    const sessionId = decodeURIComponent(m[1]), key = req.headers["sec-websocket-key"];
    if (!key) { socket.destroy(); return; }
    const session = getSession(sessionId), token = (url.searchParams.get("token") || "").toString();
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\nAccess-Control-Allow-Origin: *\r\n\r\n");
    if (!session || !token || session.token !== token) {
      socket.write(encodeFrame(TEXT, JSON.stringify({ type: "error", error: "forbidden" })));
      socket.end(encodeFrame(CLOSE, Buffer.from([0x03, 0xf0]))); return;
    }

    const media = {
      attachedAt: Date.now(), bytesIn: 0, bytesOut: 0, ended: false,
      send(payload, binary = true) { if (media.ended) return; const frame = encodeFrame(binary ? BINARY : TEXT, payload); media.bytesOut += frame.length; socket.write(frame); },
    };
    session.media = media; session.mediaActive = true;

    const framer = new Framer((payload, kind) => {
      if (kind === "ping") { socket.write(encodeFrame(PONG, payload)); return; }
      if (kind === true) {
        media.bytesIn += payload.length;
        session.mediaBytesIn = (session.mediaBytesIn || 0) + payload.length;
        if (session.provider === "sim") {
          const p = payload; setTimeout(() => { media.send(p); }, 250);
        } else if (session.provider === "ringcentral-sip") {
          // Use only the SDK RTP/SRTP implementation for the live SIP call.
          // If the call session is not ready yet, retain the latest frame; the
          // agent continues sending subsequent frames once the bridge is live.
          if (!sendRingCentralSipAudio(session, payload)) session._agentAudio = payload;
          session._agentAudioAt = Date.now();
        } else if (session.provider === "ringcentral" || session.provider === "twilio") {
          if (session.agentAudioHandler) { try { session.agentAudioHandler(payload); } catch {} }
          session._agentAudio = payload; session._agentAudioAt = Date.now();
        }
        return;
      }
      try {
        const j = JSON.parse(String(payload));
        if (j.type === "bye") { socket.write(encodeFrame(CLOSE, Buffer.from([0x03, 0xe8]))); socket.end(); }
        else if (j.type === "status") socket.write(encodeFrame(TEXT, JSON.stringify({ type: "status", status: session.status })));
      } catch {}
    }, () => {});

    socket.on("data", (d) => framer.push(d)); socket.on("end", teardown); socket.on("error", teardown); socket.on("close", teardown);
    function teardown() {
      if (media.ended) return; media.ended = true; session.mediaActive = false;
      session.mediaBytesIn = session.mediaBytesIn || 0; session.mediaBytesOut = session.mediaBytesOut || 0;
      session._sdkAudioQueue = []; session._sdkAudioPumping = false;
    }
    if (session.provider === "sim") setTimeout(() => { if (!media.ended) media.send(TONE_8K_16BIT); }, 200);
  });
}

function sendFrames(socket, frames) { for (const f of frames) socket.write(f); }
function sendCarrierAudio(session, audioBuffer) { if (!session || !session.media || session.media.ended) return; session.media.send(audioBuffer, true); }

module.exports = { install, encodeFrame, sendCarrierAudio, sendRingCentralSipAudio };
