/**
 * LLM Client - Groq API (Free Tier)
 *
 * Uses Groq free tier with Llama 3.1 8B - fast and reliable.
 * No budget issues, no rate limiting on free tier.
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_KEY = "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";
const GROQ_MODEL = "llama-3.1-8b-instruct";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  content: string;
  error?: string;
}

/**
 * Send a chat completion request to Groq API
 */
export async function chatCompletion(
  messages: LLMMessage[],
  options: {
    maxTokens?: number;
    temperature?: number;
  } = {}
): Promise<LLMResponse> {
  const {
    maxTokens = 300,
    temperature = 0.7,
  } = options;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const resp = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "unknown");
      console.error(`[llm] Groq HTTP ${resp.status}:`, errorText.slice(0, 100));
      return { content: "", error: `Groq HTTP ${resp.status}` };
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || "";

    if (!content || content.trim().length === 0) {
      console.error(`[llm] Groq returned empty content`);
      return { content: "", error: "Empty response" };
    }

    console.log(`[llm] Groq OK:`, content.slice(0, 60));
    return { content };
  } catch (e: any) {
    console.error(`[llm] Groq error:`, e?.message);
    return { content: "", error: e?.message || "Unknown error" };
  }
}

/**
 * Build system prompt for phone conversation
 */
export function buildSystemPrompt(config: {
  productName?: string;
  pitch?: string;
  tone?: string;
  pricing?: string;
}): string {
  const product = config.productName || "dispatch and logistics solutions";
  const pitch = config.pitch || `We provide ${product} that helps businesses save time and money.`;
  const tone = config.tone || "PROFESSIONAL";
  
  return `You are a professional phone sales agent having a REAL conversation with a prospect.

CRITICAL RULES:
- Keep responses SHORT (1-2 sentences max, under 50 words)
- Sound natural and conversational, like a real person
- NEVER say you are AI or a robot
- NEVER use emojis or special characters
- Respond IMMEDIATELY to what the prospect says
- Be warm but professional
- Handle objections gracefully
- NEVER say "goodbye" or "have a great day" until the prospect has given their name and email
- If you need information (name, email, company), ask for it politely
- Never argue or be pushy
- You can say "thank you" as a polite acknowledgment, but keep the conversation going

YOUR PRODUCT: ${product}
YOUR PITCH: ${pitch}
TONE: ${tone}
${config.pricing ? `PRICING: ${config.pricing}` : ""}

CONVERSATION FLOW:
1. Greet warmly and introduce yourself briefly
2. Ask how they're doing, then deliver your pitch
3. Handle any objections or questions naturally
4. Collect their name, company, and email through natural conversation
5. Only say goodbye AFTER you have their name and email

RESPOND ONLY WITH WHAT YOU WOULD SAY ON THE PHONE. No labels, no prefixes.`;
}

/**
 * Get AI response for a conversation turn
 */
export async function getAIResponse(
  conversationHistory: LLMMessage[],
  config: {
    productName?: string;
    pitch?: string;
    tone?: string;
    pricing?: string;
  }
): Promise<string> {
  const systemPrompt = buildSystemPrompt(config);
  
  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.slice(-10), // Keep last 10 messages for context
  ];

  const response = await chatCompletion(messages, {
    maxTokens: 200,
    temperature: 0.7,
  });

  if (response.error) {
    console.error("[llm] Error:", response.error);
    // Return a natural-sounding fallback
    return "I'm sorry, could you repeat that?";
  }

  if (!response.content || response.content.trim().length === 0) {
    console.error("[llm] Empty response from LLM");
    return "I'm sorry, could you repeat that?";
  }

  return response.content;
}
