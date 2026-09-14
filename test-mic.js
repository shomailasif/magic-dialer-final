const { hear, probeMic } = require('./src/management/agent/hear.js');
const { speak } = require('./src/management/agent/voice.js');
const { spawnSync } = require('child_process');

(async () => {
  console.log('=== Mic test (quiet) ===');
  const p1 = probeMic({ sec: 3 });
  console.log('RMS:', p1.rms, 'Peak:', p1.peak, 'Heard:', p1.text || '(nothing)');

  console.log('\n=== AI speaks then listens ===');
  console.log('AI: Hello, can you hear me? Say something...');
  await speak('Hello, can you hear me? Say something now.', { locale: 'en' });

  console.log('Listening for 6 seconds...');
  const heard = await hear({ timeoutMs: 6000, locale: 'en' });
  console.log('Heard:', heard || '(nothing - this is the bug)');

  console.log('\n=== DictationGrammar direct test ===');
  console.log('Say ANYTHING for 5 seconds...');
  const script = `
Add-Type -AssemblyName System.Speech
$r = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$dg = New-Object System.Speech.Recognition.DictationGrammar
$r.LoadGrammar($dg)
$r.SetInputToDefaultAudioDevice()
$r.InitialSilenceTimeout = New-Object System.TimeSpan(0,0,5)
$r.EndSilenceTimeout = New-Object System.TimeSpan(0,0,2)
$res = $r.Recognize()
if ($res) { Write-Output ("DICT:" + $res.Text + " conf:" + $res.Confidence) } else { Write-Output "DICT:nothing" }
`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
  });
  console.log('DictationGrammar:', r.stdout.toString().trim());
})().catch(e => console.error('ERROR:', e.message));
