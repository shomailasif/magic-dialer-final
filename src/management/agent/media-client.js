const WebSocket = require("ws");

/**
 * Agent-side media channel client.
 *
 * Connects to the portal's WSS media endpoint and provides send/receive
 * audio over the same 443 surface as heartbeat + config. No SIP ports,
 * no firewall holes.
 *
 * Audio format: raw PCM mulaw 8kHz mono (telephony standard).
 * The portal bridges this to/from the carrier (RingCentral, Twilio, etc.).
 *
 * Usage:
 *   const ch = await mediaConnect({ portal, sessionId, token });
 *   ch.onAudio((buffer) => { ... });  // lead's voice arrives here
 *   ch.sendAudio(pcmBuffer);          // agent's TTS goes out here
 *   ch.close();
 */
function mediaConnect({ portal, sessionId, token, onLog = () => {} }) {
  return new Promise((resolve, reject) => {
    const base = String(portal || "").replace(/\/+$/, "");
    const url = `${base.replace(/^http/, "ws")}/ws/media/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(token)}`;
    onLog(`[media] connecting to ${url}`);

    let ws;
    try {
      ws = new WebSocket(url, { headers: { "User-Agent": "MagicDialer-Agent/1.0" } });
    } catch (e) {
      return reject(e);
    }

    const state = {
      ws,
      closed: false,
      audioHandler: null,
      statusHandler: null,
      _resolve: resolve,
      _reject: reject,
      _settled: false,
      bytesIn: 0,
      bytesOut: 0,
    };

    const settle = (err, ch) => {
      if (state._settled) return;
      state._settled = true;
      if (err) reject(err);
      else resolve(ch);
    };

    ws.on("open", () => {
      onLog("[media] channel open");
      const ch = makeChannel(state, onLog);
      settle(null, ch);
    });

    ws.on("message", (data, isBinary) => {
      if (state.closed) return;
      if (isBinary) {
        // Binary frame = raw PCM audio from the lead/carrier
        state.bytesIn += data.length;
        if (state.audioHandler) {
          try { state.audioHandler(Buffer.from(data)); } catch {}
        }
      } else {
        // Text frame = JSON control message
        try {
          const msg = JSON.parse(String(data));
          if (msg.type === "status" && state.statusHandler) {
            state.statusHandler(msg.status);
          } else if (msg.type === "error") {
            onLog("[media] error: " + (msg.error || "unknown"));
          }
        } catch {}
      }
    });

    ws.on("close", () => {
      state.closed = true;
      onLog("[media] channel closed");
    });

    ws.on("error", (e) => {
      onLog("[media] error: " + e.message);
      if (!state.closed) state.closed = true;
      settle(e);
    });

    // Timeout if portal doesn't accept the connection
    setTimeout(() => {
      if (!state._settled) {
        ws.close();
        settle(new Error("media channel connection timeout"));
      }
    }, 10000);
  });
}

function makeChannel(state, onLog) {
  return {
    /** Send raw audio (mulaw/PCM buffer) to the carrier/lead. */
    sendAudio(buffer) {
      if (state.closed || !state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
      const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      state.ws.send(buf, { binary: true });
      state.bytesOut += buf.length;
      return true;
    },

    /** Send a JSON control message over the channel. */
    sendControl(obj) {
      if (state.closed || !state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
      state.ws.send(JSON.stringify(obj), { binary: false });
      return true;
    },

    /** Register a callback for incoming audio from the lead. */
    onAudio(fn) { state.audioHandler = fn; },

    /** Register a callback for call status updates. */
    onStatus(fn) { state.statusHandler = fn; },

    /** Close the media channel. */
    close() {
      state.closed = true;
      try { state.ws.close(1000); } catch {}
    },

    /** Is the channel still connected? */
    get open() {
      return !state.closed && state.ws && state.ws.readyState === WebSocket.OPEN;
    },

    /** Bytes transferred. */
    get bytesIn() { return state.bytesIn; },
    get bytesOut() { return state.bytesOut; },
  };
}

module.exports = { mediaConnect };
