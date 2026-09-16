const WS = require('ws');
const crypto = require('crypto');

const token = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const host = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const connId = crypto.randomUUID().replace(/-/g, '');
let ticks = Date.now() / 1000 + 11644473600;
ticks -= ticks % 300;
ticks *= 1e9 / 100;
const secMsGec = crypto.createHash('sha256').update(Math.floor(ticks) + token, 'ascii').digest('hex').toUpperCase();

const url = host + '?TrustedClientToken=' + token + '&ConnectionId=' + connId + '&Sec-MS-GEC=' + secMsGec + '&Sec-MS-GEC-Version=1-143.0.3650.75';

console.log('Connecting to Edge TTS...');
const ws = new WS(url, { headers: { 'Pragma': 'no-cache', 'User-Agent': 'Mozilla/5.0', 'Origin': 'chrome-extension://jdiccldimpdaibmpdmdce' }, perMessageDeflate: true });

const timer = setTimeout(() => { console.log('TIMEOUT - Edge TTS WebSocket blocked on this network'); ws.close(); process.exit(1); }, 8000);

ws.on('open', () => {
  clearTimeout(timer);
  console.log('WS OPEN! Edge TTS connection works!');
  const stamp = new Date().toUTCString();
  ws.send('X-Timestamp:' + stamp + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-8khz-16kbitrate-mono-mp3"}}}}\r\n');
  ws.send('X-RequestId:' + crypto.randomUUID().replace(/-/g, '') + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + stamp + 'Z\r\nPath:ssml\r\n\r\n<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="en-US-JennyNeural"><prosody pitch="+0Hz" rate="+0%" volume="+0%">Hello, this is a test of the Jenny neural voice.</prosody></voice></speak>');
});

ws.on('message', (data, isBinary) => {
  if (!isBinary) {
    const msg = String(data);
    if (msg.includes('turn.end')) {
      console.log('SUCCESS! Edge TTS generated audio!');
      clearTimeout(timer);
      ws.close();
      process.exit(0);
    }
  }
});

ws.on('error', (e) => { clearTimeout(timer); console.log('WS ERROR:', e.message); process.exit(1); });
ws.on('close', (code, reason) => { console.log('WS closed:', code, reason?.toString()?.slice(0, 100)); });
