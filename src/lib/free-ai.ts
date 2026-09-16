import { getAIResponse, type LLMMessage } from "@/lib/llm";

export interface ConversationState {
  phase: "greeting" | "pitch" | "collect_name" | "collect_company" | "collect_email" | "handling_objection" | "closing" | "done";
  collectedName: string | null;
  collectedCompany: string | null;
  collectedEmail: string | null;
  turnCount: number;
  objectionCount: number;
  lastProspectSaid: string;
  prospectSaidHistory: string[];
  agentSaidHistory: string[];
  tone: "FRIENDLY" | "PROFESSIONAL" | "DIRECT";
  productName: string;
  pitch: string;
  pricing: string | null;
  conversationHistory: LLMMessage[];
  lastAgentSaid: string;
  silenceCount: number;
}

export interface AIResponse {
  text: string;
  state: ConversationState;
  shouldEnd: boolean;
}

const END_SIGNALS = [
  "bye", "goodbye", "gotta go", "have to go", "stop calling", "don't call again",
  "do not call again", "remove me", "take me off your list", "not interested goodbye",
];

function matchesAny(text: string, patterns: string[]): boolean {
  const lower = text.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

function extractEmail(text: string): string | null {
  const match = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
  return match ? match[0] : null;
}

function extractName(text: string): string | null {
  const lower = text.toLowerCase();
  const indicators = ["my name is", "i'm", "i am", "this is", "name's", "call me"];
  for (const indicator of indicators) {
    const idx = lower.indexOf(indicator);
    if (idx === -1) continue;
    let name = text.slice(idx + indicator.length).trim().split(/[.,!?]/)[0].trim();
    const words = name.split(/\s+/).filter(Boolean);
    if (words.length > 3) name = words.slice(0, 3).join(" ");
    if (name.length > 1 && name.length < 40 && !/^\d+$/.test(name)) return name;
  }
  return null;
}

function extractCompany(text: string): string | null {
  const lower = text.toLowerCase();
  const indicators = ["i work for", "i work at", "i'm with", "company is", "business is", "organization is"];
  for (const indicator of indicators) {
    const idx = lower.indexOf(indicator);
    if (idx === -1) continue;
    const company = text.slice(idx + indicator.length).trim().split(/[.,!?]/)[0].trim();
    if (company.length > 1 && company.length < 80) return company;
  }
  return null;
}

function tenantFallback(state: ConversationState): string {
  const text = state.lastProspectSaid.toLowerCase();
  if (!text) return "I'm here. Take your time.";
  if (matchesAny(text, END_SIGNALS)) return "Of course. Thank you for your time. Goodbye.";
  if (text.includes("busy") || text.includes("meeting") || text.includes("driving")) {
    return "Of course. I don't want to interrupt you. When would be a better time to call?";
  }
  if (text.includes("email")) return "Absolutely. What's the best email address to use?";
  if (text.includes("not interested") || text.includes("no thanks")) {
    return "Understood. Thank you for letting me know.";
  }
  if (text.includes("price") || text.includes("cost") || text.includes("how much")) {
    return state.pricing ? `The pricing information I have is ${state.pricing}. What would you like me to clarify about it?` : "I don't want to guess about pricing. I can note that question for the company.";
  }
  if (state.pitch) return `I understand. The main reason for my call is ${state.pitch} What would be most useful for you to know?`;
  if (state.productName) return `I understand. I'm calling about ${state.productName}. What would you like to know about it?`;
  return "I understand. Could you tell me a little more about what matters most to you?";
}

function recordAssistant(state: ConversationState, text: string) {
  state.conversationHistory.push({ role: "assistant", content: text });
  state.agentSaidHistory.push(text);
  state.lastAgentSaid = text;
}

export function createConversation(config: {
  tone?: string;
  productName?: string;
  pitch?: string;
  pricing?: string;
}): ConversationState {
  return {
    phase: "greeting",
    collectedName: null,
    collectedCompany: null,
    collectedEmail: null,
    turnCount: 0,
    objectionCount: 0,
    lastProspectSaid: "",
    prospectSaidHistory: [],
    agentSaidHistory: [],
    tone: (config.tone as ConversationState["tone"]) || "PROFESSIONAL",
    productName: config.productName || "",
    pitch: config.pitch || "",
    pricing: config.pricing || null,
    conversationHistory: [],
    lastAgentSaid: "",
    silenceCount: 0,
  };
}

export async function processProspectInput(state: ConversationState, transcript: string): Promise<AIResponse> {
  const text = transcript.trim();
  if (!text) {
    state.silenceCount++;
    const response = state.silenceCount === 1 ? "I'm here." : "No problem. Take your time.";
    recordAssistant(state, response);
    return { text: response, state, shouldEnd: false };
  }

  state.turnCount++;
  state.silenceCount = 0;
  state.lastProspectSaid = text;
  state.prospectSaidHistory.push(text);

  if (!state.collectedName) state.collectedName = extractName(text);
  if (!state.collectedCompany) state.collectedCompany = extractCompany(text);
  if (!state.collectedEmail) state.collectedEmail = extractEmail(text);

  if (matchesAny(text, END_SIGNALS)) {
    const closing = "Of course. Thank you for your time. Goodbye.";
    state.phase = "done";
    recordAssistant(state, closing);
    return { text: closing, state, shouldEnd: true };
  }

  if (state.turnCount > 30) {
    const closing = "Thank you for the conversation. I'll let you get back to your day. Goodbye.";
    state.phase = "done";
    recordAssistant(state, closing);
    return { text: closing, state, shouldEnd: true };
  }

  state.conversationHistory.push({ role: "user", content: text });
  let aiText = "";
  try {
    aiText = await getAIResponse(state.conversationHistory, {
      productName: state.productName,
      pitch: state.pitch,
      tone: state.tone,
      pricing: state.pricing || undefined,
    });
  } catch (e) {
    console.error("[free-ai] LLM threw error, using tenant-neutral fallback", e);
  }

  if (!aiText || aiText.trim().length < 5 || aiText === "I'm sorry, could you repeat that?") {
    aiText = tenantFallback(state);
  }

  recordAssistant(state, aiText);
  const lowerAi = aiText.toLowerCase();
  const shouldEnd = lowerAi.includes("goodbye") || lowerAi.includes("do not call") || lowerAi.includes("won't call again");
  if (shouldEnd) state.phase = "done";
  return { text: aiText, state, shouldEnd };
}

export function getInitialGreeting(state: ConversationState): string {
  const greeting = state.productName
    ? `Hello! Thanks for taking my call. I'm calling about ${state.productName}. How are you today?`
    : "Hello! Thanks for taking my call. How are you today?";
  recordAssistant(state, greeting);
  return greeting;
}

export function getCollectedData(state: ConversationState): { name: string | null; company: string | null; email: string | null } {
  return { name: state.collectedName, company: state.collectedCompany, email: state.collectedEmail };
}
