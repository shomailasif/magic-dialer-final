/**
 * LLM Client - KeylessAI (Free, Unlimited, No API Key)
 * 
 * OpenAI-compatible endpoint: https://keylessai.thryx.workers.dev/v1
 * Routes through Pollinations.ai + ApiAirforce (public, no-auth endpoints)
 * Automatic failover between providers
 */

const KEYLESS_BASE_URL = "https://keylessai.thryx.workers.dev/v1";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  content: string;
  error?: string;
}

/**
 * Send a chat completion request to KeylessAI
 */
export async function chatCompletion(
  messages: LLMMessage[],
  options: {
    model?: string;
    maxTokens?: number;
    temperature?: number;
  } = {}
): Promise<LLMResponse> {
  const {
    model = "gpt-4o",
    maxTokens = 300,
    temperature = 0.7,
  } = options;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const resp = await fetch(`${KEYLESS_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
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
      return { content: "", error: `LLM HTTP ${resp.status}: ${errorText}` };
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || "";
    return { content };
  } catch (e: any) {
    return { content: "", error: `LLM error: ${e?.message}` };
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
- Extract name, company, and email naturally during conversation
- If they say goodbye or "not interested", gracefully end the call
- Never argue or be pushy

YOUR PRODUCT: ${product}
YOUR PITCH: ${pitch}
TONE: ${tone}
${config.pricing ? `PRICING: ${config.pricing}` : ""}

CONVERSATION FLOW:
1. Greet warmly and introduce yourself briefly
2. Ask how they're doing, then deliver your pitch
3. Handle any objections or questions naturally
4. Collect their name, company, and email through natural conversation
5. End with a clear next step

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
    model: "gpt-4o",
    maxTokens: 200,
    temperature: 0.7,
  });

  if (response.error) {
    console.error("[llm]", response.error);
    // Fallback response
    return "I apologize, could you repeat that?";
  }

  return response.content;
}
