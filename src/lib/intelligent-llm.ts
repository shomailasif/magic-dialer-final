import { chatCompletion, type LLMMessage } from "@/lib/llm";

export interface SalesBrainConfig {
  productName?: string;
  productDesc?: string;
  valueProps?: string;
  targetAudience?: string;
  pitch?: string;
  tone?: string;
  pricing?: string;
  objectionHandling?: string;
  learningNotes?: string;
  companyName?: string;
}

export function buildIntelligentSalesPrompt(config: SalesBrainConfig): string {
  const facts = [
    config.companyName && `Company: ${config.companyName}`,
    config.productName && `Product/service: ${config.productName}`,
    config.productDesc && `Description: ${config.productDesc}`,
    config.valueProps && `Value propositions: ${config.valueProps}`,
    config.targetAudience && `Target audience: ${config.targetAudience}`,
    config.pitch && `Sales objective / plan: ${config.pitch}`,
    config.pricing && `Pricing: ${config.pricing}`,
    config.objectionHandling && `Approved objection guidance: ${config.objectionHandling}`,
    config.learningNotes && `Prior sales learnings: ${config.learningNotes}`,
  ].filter(Boolean).join("\n");

  return `You are the live conversational sales agent for the customer whose business context appears below.

This is a real phone conversation, not a script. Understand what the prospect just said, remember the conversation, and choose the most useful next response toward the customer's sales objective.

RULES:
- Respond to the prospect's actual meaning before advancing the sale.
- Never force a fixed name -> company -> email sequence. Collect details only when useful to the configured sales objective.
- Handle questions, objections, interruptions, corrections and topic changes naturally.
- Do not repeat the pitch when the prospect has already understood it.
- Use only the supplied business facts. Never invent prices, guarantees, savings, features, company names, callback times or policies.
- If a fact is unavailable, say you do not want to guess and offer the appropriate next step.
- Respect clear opt-outs immediately. Do not pressure someone who asks to stop or not be called.
- If directly asked whether you are an AI/automated assistant, answer truthfully and briefly, then continue only if the prospect wants to.
- Keep spoken replies concise: normally 1-3 short sentences and one question at a time.
- Sound energetic, friendly, polite and natural. Tone preference: ${config.tone || "professional and friendly"}.
- No emojis, markdown, labels, stage directions or commentary.
- End the call only when the prospect asks to end, the sales objective is complete, or continuing would not be useful.

CUSTOMER BUSINESS CONTEXT:
${facts || "No additional business facts were supplied. Do not invent them."}

Return only the exact words to speak on the phone.`;
}

export async function getIntelligentSalesResponse(history: LLMMessage[], config: SalesBrainConfig): Promise<string> {
  const response = await chatCompletion(
    [{ role: "system", content: buildIntelligentSalesPrompt(config) }, ...history.slice(-16)],
    { maxTokens: 180, temperature: 0.65 },
  );
  if (response.error || !response.content?.trim()) return "I'm sorry, could you repeat that?";
  return response.content.trim();
}
