const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const py = 'python';
const script = path.join(__dirname, 'src', 'management', 'agent', 'vosk-transcribe.py');

// Use the WAV we know works
const wav = 'C:\\Users\\USER\\AppData\\Local\\Temp\\md-hear-15084.wav';
console.log('WAV exists:', fs.existsSync(wav));

const r = spawnSync(py, [script, wav], {
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 15000,
});
console.log('Exit:', r.status);
console.log('stdout:', JSON.stringify(r.stdout.toString()));
console.log('stderr:', JSON.stringify(r.stderr.toString().slice(0, 300)));

// Test regex
const out = r.stdout.toString().trim();
const m = out.match(/"text"\s*:\s*"([^"]*)"/);
console.log('Regex match:', m ? m[1] : 'NO MATCH');
