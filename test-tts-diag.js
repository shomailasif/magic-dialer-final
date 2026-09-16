#!/usr/bin/env node
/**
 * TTS Diagnostic Script
 * Tests each TTS tier independently to find where audio breaks.
 */

const GUARD_GOOGLE_TTS_CLIENT = "dict-chrome-ex";
const EDGE_VOICE = "en-US-AvaNeural";
const EDGE_HOST = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const EDGE_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_GEC_VERSION = "1-143.0.3650.75";

async function testGoogleTTS(text) {
  console.log(`\n[Tier 1] Google Translate TTS (client=${GUARD_GOOGLE_TTS_CLIENT})`);
  console.log(`  Text: "${text}"`);
  try {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=${GUARD_GOOGLE_TTS_CLIENT}&q=${encodeURIComponent(text)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win6; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Referer": "https://translate.google.com/",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const ct = resp.headers.get("content-type") || "";
    console.log(`  Status: ${resp.status}, Content-Type: ${ct}`);
    if (resp.ok && ct.includes("audio")) {
      const buf = Buffer.from(await resp.arrayBuffer());
      console.log(`  SUCCESS: ${buf.length} bytes of audio`);
      if (buf.length > 100) {
        require("fs").writeFileSync("test-tts-google.mp3", buf);
        console.log("  Saved to test-tts-google.mp3");
        return true;
      }
      console.log("  WARNING: Audio too small, likely not real audio");
    } else {
      const html = await resp.text();
      console.log(`  FAILED: Got ${ct}, body preview: ${html.slice(0, 200)}`);
    }
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  }
  return false;
}

async function testEdgeTTS(text) {
  console.log(`\n[Tier 2] Edge TTS WebSocket`);
  console.log(`  Text: "${text}"`);
  try {
    const WS = require("ws");
    const crypto = require("crypto");
    const muid = crypto.randomBytes(16).toString("hex").toUpperCase();
    const randomId = crypto.randomUUID().replace(/-/g, "");
    const ticks = (Date.now() / 1000 + 11644473600);
    const tickNorm = Math.floor(ticks - (ticks % 300)) * (1e9 / 100);
    const secMsGec = crypto.createHash("sha256").update(`${Math.floor(tickNorm)}${EDGE_TOKEN}`, "ascii").digest("hex").toUpperCase();
    const stamp = new Date().toUTCString();

    const url = `${EDGE_HOST}?TrustedClientToken=${EDGE_TOKEN}&ConnectionId=${randomId}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${EDGE_GEC_VERSION}`;

    const result = await new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { console.log("  TIMEOUT after 15s"); finish(null); }, 15000);
      function finish(buf) { if (!done) { done = true; clearTimeout(timer); resolve(buf); } }

      const ws = new WS(url, {
        headers: {
          "Pragma": "no-cache",
          "Cache-Control": "no-cache",
          "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Cookie": `muid=${muid};`
        },
        perMessageDeflate: true
      });
      const chunks = [];
      ws.on("open", () => {
        console.log("  WS connected, sending config...");
        ws.send(`X-Timestamp:${stamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-8khz-16kbitrate-mono-mp3"}}}}\r\n`, (err) => {
          if (err) { console.log("  Config send error:", err.message); finish(null); return; }
          ws.send(`X-RequestId:${randomId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp}Z\r\nPath:ssml\r\n\r\n<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${EDGE_VOICE}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${text.replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">")}</prosody></voice></speak>`);
        });
      });
      ws.on("message", (raw, isBinary) => {
        if (!isBinary) {
          if (String(raw).includes("turn.end")) { console.log(`  Received ${chunks.length} audio chunks`); finish(Buffer.concat(chunks)); ws.close(); }
          return;
        }
        const buf = Buffer.from(raw);
        if (buf.length < 2) return;
        const hl = buf.readUInt16BE(0);
        const head = buf.toString("ascii", 2, 2 + hl);
        if (head.includes("Path:audio")) chunks.push(buf.subarray(2 + hl + 2));
      });
      ws.on("error", (e) => { console.log("  WS error:", e.code, e.message); finish(null); });
    });
    if (result && result.length > 100) {
      console.log(`  SUCCESS: ${result.length} bytes`);
      require("fs").writeFileSync("test-tts-edge.mp3", result);
      console.log("  Saved to test-tts-edge.mp3");
      return true;
    }
    console.log("  FAILED: No audio received");
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  }
  return false;
}

async function main() {
  console.log("=== TTS Diagnostic ===\n");
  const testText = "Hello! Thanks for picking up. How are you doing today?";

  const googleOk = await testGoogleTTS(testText);
  const edgeOk = await testEdgeTTS(testText);

  console.log("\n=== Summary ===");
  console.log(`Google TTS: ${googleOk ? "OK" : "FAIL"}`);
  console.log(`Edge TTS:   ${edgeOk ? "OK" : "FAIL"}`);
  if (!googleOk && !edgeOk) {
    console.log("\nBoth TTS tiers failed! Calls will be silent.");
    console.log("Possible causes:");
    console.log("  - Network blocked on container");
    console.log("  - Google CAPTCHA on IP");
    console.log("  - Edge WebSocket blocked by firewall");
  } else if (googleOk) {
    console.log("\nGoogle TTS works - fallback should produce audio.");
    console.log("If calls are still silent, check:");
    console.log("  - Is edgeTtsBroken=true (should be true on Suga)?");
    console.log("  - Is MP3 decoder working (mpg123-decoder)?");
    console.log("  - Is cs.streamAudio() actually sending RTP packets?");
  }
}

main().catch(console.error);
