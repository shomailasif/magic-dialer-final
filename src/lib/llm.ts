/**
 * LLM Client - Pollinations AI (Free, No API Key)
 *
 * Tries openai-fast first (less likely to hit budget), then openai as fallback.
 * OpenAI-compatible endpoint: https://text.pollinations.ai/openai
 */

const POLLINATIONS_URL = "https://text.pollinations.ai/openai";
const LLM_MODELS = ["openai-fast", "openai"];

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  content: string;
  error?: string;
}

/**
 * Send a chat completion request to Pollinations AI
 * Tries multiple models with automatic failover
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

  for (const model of LLM_MODELS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const resp = await fetch(POLLINATIONS_URL, {
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
        console.error(`[llm] ${model} HTTP ${resp.status}:`, errorText.slice(0, 80));
        continue;
      }

      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content || "";

      const errorPatterns = ["budget", "rate limit", "api key", "limit reached", "quota", "exceeded", "raise the key"];
      const lowerContent = content.toLowerCase();
      if (content && errorPatterns.some(p => lowerContent.includes(p))) {
        console.error(`[llm] ${model} returned error content:`, content.slice(0, 100));
        continue;
      }

      if (!content || content.trim().length === 0) {
        console.error(`[llm] ${model} returned empty content`);
        continue;
      }

      console.log(`[llm] ${model} OK:`, content.slice(0, 60));
      return { content };
    } catch (e: any) {
      console.error(`[llm] ${model} error:`, e?.message);
      continue;
    }
  }

  return { content: "", error: "All LLM models failed" };
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
