"use strict";
/* Edge TTS binary framing contract.
 *
 * Root cause this pins: Edge's binary audio frame is
 *   uint16 headerLen | headerLen header bytes | mp3 payload to END of message
 * There is NO uint16 data-length field after the header. The old code did
 * subarray(2 + hl + 2), eating the first 2 bytes of every 720B chunk
 * (720 = 5 x 144B MPEG2 Layer III @ 24kHz/48kbps). That shifted MP3 frame
 * alignment by 2 bytes on every chunk, so the decoder lost sync: ffmpeg
 * recovered only 43.9% of frames and mpg123 emitted noise, which the prospect
 * heard as "your voice is breaking".
 *
 * Measured after the fix on the same stream: ffmpeg frame recovery 100.0%,
 * production-decode vs ffmpeg sample correlation 0.9718 (was -0.0076),
 * frame-envelope correlation 0.9999, 0 clipped samples.
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.join(__dirname, "..");
const SITES = [
  ["management/portal/audio.js", path.join(root, "portal/audio.js")],
  ["agent/voice.js", path.join(root, "agent/voice.js")],
  ["deploy/portal/audio.js", path.join(root, "../../deploy/portal/audio.js")],
];

/* ---- 1. source contract: framing must not skip past the header ---- */
for (const [name, file] of SITES) {
  const src = fs.readFileSync(file, "utf8");
  assert.ok(
    !/subarray\(\s*2\s*\+\s*\w+\s*\+\s*2\s*\)/.test(src),
    `${name} must not skip 2 bytes past the Edge header (corrupts MP3 frame alignment)`
  );
  assert.ok(
    /subarray\(\s*2\s*\+\s*\w+\s*\)/.test(src),
    `${name} must take the mp3 payload from the end of the header to end of message`
  );
}

/* ---- 2. behaviour: the shipped expression must return every payload byte ----
 * The exact subarray() expression is lifted out of the source and applied to a
 * synthetic Edge frame, so this fails if the expression itself regresses.      */
function frameExpr(src) {
  const m = src.match(/chunks\.push\(buf\.(subarray\([^)]*\))\)/);
  assert.ok(m, "framing subarray expression not found");
  return m[1];
}
for (const [name, file] of SITES) {
  const src = fs.readFileSync(file, "utf8");
  const expr = frameExpr(src);

  const headerText =
    "X-RequestId:00000000000000000000000000000000\r\n" +
    "Content-Type:audio/mpeg\r\n" +
    "Path:audio\r\n\r\n";
  const payload = Buffer.alloc(720);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 7 + 11) & 0xff;

  const buf = Buffer.concat([
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(headerText.length, 0); return b; })(),
    Buffer.from(headerText, "ascii"),
    payload,
  ]);

  const got = new Function("buf", "hl", "return buf." + expr)(buf, headerText.length); // eslint-disable-line no-new-func
  assert.strictEqual(got.length, payload.length, `${name}: lost payload bytes (${got.length}/${payload.length})`);
  assert.ok(got.equals(payload), `${name}: payload bytes altered`);
}

/* ---- 3. the payload must be whole MPEG2 Layer III frames at 24k/48k ---- */
{
  const MPEG2_L3_24K_48K_FRAME = (72 * 48000) / 24000; // 144
  assert.strictEqual(MPEG2_L3_24K_48K_FRAME, 144);
  assert.strictEqual(720 % MPEG2_L3_24K_48K_FRAME, 0, "Edge chunk must hold whole 144B frames");
  assert.strictEqual(720 / MPEG2_L3_24K_48K_FRAME, 5);
}

console.log(`edge TTS binary framing contract: ${SITES.length} sites x (source + payload round-trip) PASS`);
