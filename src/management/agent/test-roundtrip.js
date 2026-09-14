const { speakToBuffer } = require('./voice');
const { hearFromBuffer } = require('./hear');

const testPhrases = [
  'Hello, this is a test.',
  'My name is John and I am interested in solar panels for my home.',
  'Sure, go ahead and tell me more.',
  'How much does it cost per month?',
];

(async () => {
  for (const phrase of testPhrases) {
    const tts = await speakToBuffer(phrase);
    if (!tts || !tts.buffer) {
      console.log('FAIL: TTS returned null for:', phrase);
      continue;
    }
    const heard = hearFromBuffer(tts.buffer);
    const ok = heard && heard.length > 5;
    console.log(ok ? 'PASS' : 'FAIL', '| Said:', phrase);
    console.log('       Heard:', heard || '(nothing)');
  }
})();
