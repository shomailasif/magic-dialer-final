/**
 * LLM Client - Groq API
 */

import { redactDiagnostic } from "@/lib/safe-diagnostic";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 3500);

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse { content: string; error?: string; }

export async function chatCompletion(messages: LLMMessage[], options: { maxTokens?: number; temperature?: number } = {}): Promise<LLMResponse> {
  const { maxTokens = 300, temperature = 0.55 } = options;
  if (!GROQ_KEY) return { content: "", error: "GROQ_API_KEY missing" };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    const resp = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: maxTokens, temperature, stream: false }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "unknown");
      console.error("[llm] Groq HTTP", resp.status, redactDiagnostic(errorText, [GROQ_KEY]));
      return { content: "", error: `Groq HTTP ${resp.status}` };
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || "";
    if (!content.trim()) return { content: "", error: "Empty response" };
    console.log(`[llm] Groq OK:`, content.slice(0, 60));
    return { content };
  } catch (e: any) {
    console.error("[llm] Groq error:", redactDiagnostic(e, [GROQ_KEY]));
    return { content: "", error: "LLM_REQUEST_FAILED" };
  }
}

export function buildSystemPrompt(config: { productName?: string; pitch?: string; tone?: string; pricing?: string; strategyContext?: string }): string {
  const product = config.productName || "the configured service";
  const pitch = config.pitch || "Explain the configured service accurately and discover whether it solves the prospect's problem.";
  const tone = config.tone || "PROFESSIONAL";
  return `You are the live sales conversation brain on a real phone call. Think about the prospect's latest words and the entire conversation before deciding what to say.

NON-NEGOTIABLE BEHAVIOR:
- Respond to what the prospect ACTUALLY said. Do not follow a rigid questionnaire or predetermined script.
- Never invent facts, prices, promises, savings, company details, features, or policies that are not present in the supplied product/pitch/pricing context.
- Use earlier turns as memory. Do not repeat a question already answered.
- Ask at most ONE relevant question at a time, and only when a question naturally advances this specific conversation.
- If the prospect asks a question, answer it first before asking anything else.
- If they object, address that exact objection rather than returning to a script.
- If they sound confused, clarify briefly. If they ask you to wait, wait; do not manufacture another question.
- If they say stop calling/remove me/don't call again, acknowledge immediately and end without persuasion.
- If directly asked whether you are AI/automated, answer truthfully.
- Do not claim the prospect agreed, showed interest, or supplied information unless they actually did.
- Keep each response short enough for a natural phone turn: normally one sentence, maximum two short sentences.
- Do not fill silence. Silence is handled by the call controller, not by you.
- Sound warm, alert and conversational; avoid sales-script phrases unless they fit the actual turn.
- Collect useful lead details naturally when appropriate, not as a forced sequence.

CUSTOMER CONFIGURATION:
PRODUCT/SERVICE: ${product}
SALES PLAN / PITCH / KNOWLEDGE: ${pitch}
TONE: ${tone}
${config.pricing ? `PRICING / COMMERCIAL CONTEXT: ${config.pricing}` : "PRICING: not supplied; do not invent it."}\n${config.strategyContext ? `ASSIGNED STRATEGY CONTEXT: ${config.strategyContext}` : ""}

Your goal is to intelligently pursue the configured sales objective while adapting to the human in real time. Output ONLY the exact words to speak on the phone.`;
}

export async function getAIResponse(conversationHistory: LLMMessage[], config: { productName?: string; pitch?: string; tone?: string; pricing?: string; strategyContext?: string }): Promise<string> {
  const messages: LLMMessage[] = [
    { role: "system", content: buildSystemPrompt(config) },
    ...conversationHistory.slice(-24),
  ];
  // Phone turns must stay brief: fewer generated tokens reduce time-to-TTS without
  // changing the model or provider. The prompt already caps normal output at 1-2 sentences.
  const response = await chatCompletion(messages, { maxTokens: 72, temperature: 0.55 });
  if (response.error || !response.content?.trim()) {
    console.error("[llm] unavailable:", response.error || "empty");
    return "I'm sorry, could you repeat that?";
  }
  return response.content.trim();
}
