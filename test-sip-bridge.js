const http = require('http');
const WebSocket = require('ws');
const { speakToBuffer } = require('./src/management/agent/voice');
const { hearFromBuffer } = require('./src/management/agent/hear');

function api(method, apath, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ hostname: 'localhost', port: 8787, path: apath, method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), setCookie: res.headers['set-cookie'] }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const lr = await api('POST', '/login', { password: 'MagicDialer2026!' });
  const cookie = lr.setCookie[0].split(';')[0];

  const rr = await api('POST', '/api/register', {
    product: 'Solar Panels',
    persona: 'Friendly sales rep',
    settings: {
      voip: {
        provider: 'ringcentral',
        number: '14807164508',
        extension: '102',
      }
    },
    callList: ['+16234001991'],
  }, cookie);
  const token = JSON.parse(rr.body).token;
  console.log('Customer token:', token);

  const dr = await api('POST', '/api/dial', { token, number: '+16234001991' }, cookie);
  const dial = JSON.parse(dr.body);
  console.log('Dial result:', JSON.stringify(dial));

  if (!dial.ok) {
    console.log('FAILED to place call');
    process.exit(1);
  }

  console.log('\n*** YOUR PHONE SHOULD RING NOW - ANSWER IT ***');
  console.log('*** THE LEAD AT 623-400-1991 SHOULD HEAR THE AI ***\n');

  const wsUrl = 'ws://localhost:8787/ws/media/' + dial.id + '?token=' + token;
  const ws = new WebSocket(wsUrl);
  let leadAudioChunks = [];
  let agentConnected = false;

  ws.on('open', async () => {
    agentConnected = true;
    console.log('Agent connected to media channel');
    ws.send(JSON.stringify({ type: 'identify', role: 'agent', name: 'AI Agent' }));

    await new Promise(r => setTimeout(r, 3000));

    try {
      const tts = await speakToBuffer('Hello! This is an AI calling about solar panels for your home. Are you interested in saving money on your electric bill?');
      if (tts && tts.buffer) {
        console.log('Sending AI voice: ' + tts.buffer.length + ' bytes');
        ws.send(tts.buffer);
      }
    } catch (e) {
      console.error('TTS error:', e.message);
    }
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      leadAudioChunks.push(Buffer.from(data));
      console.log('Lead audio: ' + data.length + ' bytes (total chunks: ' + leadAudioChunks.length + ')');
    } else {
      const msg = data.toString();
      if (msg.length < 500) console.log('Text: ' + msg);
    }
  });

  ws.on('error', (err) => console.error('WS error: ' + err.message));

  // Monitor for 60 seconds
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 3000));
    console.log('[' + (i*3) + 's] Status: agent=' + agentConnected + ' leadChunks=' + leadAudioChunks.length);

    if (leadAudioChunks.length > 3) {
      console.log('\nReceiving lead audio! Attempting transcription...');
      const fullAudio = Buffer.concat(leadAudioChunks);
      const heard = hearFromBuffer(fullAudio);
      console.log('Lead said: ' + (heard || '(nothing yet)'));
    }
  }

  ws.close();
  console.log('\nTest complete.');
  process.exit(0);
})();
