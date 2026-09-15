import { createRequire } from "module";
import path from "path";

const runtimeRequire = createRequire(path.join(process.cwd(), "src", "lib", "free-stt.ts"));

let transcriber: any = null;
let modelLoading = false;
let loadError: string | null = null;

async function getTranscriber() {
  if (transcriber) return transcriber;
  if (loadError) return null;
  if (modelLoading) {
    while (modelLoading && !transcriber && !loadError) {
      await new Promise((r) => setTimeout(r, 200));
    }
    return transcriber;
  }

  modelLoading = true;
  try {
    const { pipeline } = runtimeRequire("@xenova/transformers");
    transcriber = await pipeline("automatic-speech-recognition", "Xenova/whisper-tiny", {
      chunk_length_s: 30,
      stride_length_s: 5,
      language: "en",
      task: "transcribe",
    });
    console.log("[free-stt] Whisper model loaded successfully");
  } catch (e: any) {
    loadError = e?.message || "Failed to load Whisper model";
    console.error("[free-stt] Model load error:", loadError);
    transcriber = null;
  }
  modelLoading = false;
  return transcriber;
}

export interface TranscriptResult {
  text: string;
  confidence: number;
}

export async function transcribeAudio(pcm16: Int16Array, sampleRate: number = 8000): Promise<TranscriptResult> {
  const engine = await getTranscriber();
  if (!engine) return { text: "", confidence: 0 };

  try {
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768.0;
    }

    let audio = float32;
    if (sampleRate !== 16000) {
      const ratio = 16000 / sampleRate;
      const newLen = Math.ceil(float32.length * ratio);
      audio = new Float32Array(newLen);
      for (let i = 0; i < newLen; i++) {
        const srcIdx = i / ratio;
        const idx = Math.floor(srcIdx);
        const frac = srcIdx - idx;
        audio[i] = idx + 1 < float32.length
          ? float32[idx] * (1 - frac) + float32[idx + 1] * frac
          : float32[idx] || 0;
      }
    }

    const result = await engine(audio, {
      language: "en",
      task: "transcribe",
    });

    const text = (result?.text || "").trim();
    return { text, confidence: text ? 0.8 : 0 };
  } catch (e) {
    console.error("[free-stt] Transcription error:", e);
    return { text: "", confidence: 0 };
  }
}

export function isSTTReady(): boolean {
  return transcriber !== null;
}

export function preloadSTT(): void {
  getTranscriber().catch(() => {});
}
