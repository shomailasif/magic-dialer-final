const { voiceCall } = require('./agent/call.js');

console.log('=== Local AI Call Test ===');
console.log('AI will speak through your speakers.');
console.log('Speak into your mic when you hear the AI pause.');
console.log('');

voiceCall({
  product: 'Solar Panels',
  leadFields: [
    { key: 'name', question: 'What is your name?' },
    { key: 'need', question: 'Are you interested in solar panels for your home?' },
  ],
  persona: 'Friendly solar sales rep',
  companyName: 'ZAZ Logistics',
  callbackNumber: '+14807166685',
  token: null,
  portal: null,
  locale: 'en',
  voiceStyle: 'human',
  onLog: (msg) => console.log(msg),
  onMode: (mode) => { if (mode === 'listening') console.log('  (speak now...)'); },
}).then((result) => {
  console.log('');
  console.log('=== Call Result ===');
  console.log('Score:', result.score);
  console.log('Good lead:', result.goodLead);
  console.log('Summary:', result.summary);
  console.log('Transcript lines:', result.transcript.length);
  process.exit(0);
}).catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
