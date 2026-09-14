Add-Type -AssemblyName System.Speech
$rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine
try {
    $rec.SetInputToDefaultAudioDevice()
    $dg = New-Object System.Speech.Recognition.DictationGrammar
    $rec.LoadGrammar($dg)
    $rec.InitialSilenceTimeout = New-Object System.TimeSpan(0,0,4)
    $rec.EndSilenceTimeout = New-Object System.TimeSpan(0,0,2)
    Write-Output "Listening 4 sec via SAPI (has built-in AGC)..."
    $res = $rec.Recognize()
    if ($res -and $res.Confidence -ge 0) {
        Write-Output ("HEARD:" + $res.Text)
        Write-Output ("CONF:" + $res.Confidence)
    } else {
        Write-Output "HEARD: (nothing)"
    }
} catch {
    Write-Output ("ERR:" + $_.Exception.Message)
}
