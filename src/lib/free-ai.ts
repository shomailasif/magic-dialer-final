/**
 * Free AI - Smart Conversation Engine
 *
 * Pattern-based fallback that works WITHOUT any LLM.
 * Tracks state, collects data, handles objections naturally.
 */

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

// Pattern banks
const BYE = ["bye", "goodbye", "see you", "talk later", "gotta go", "have to go", "hung up", "stop calling", "don't call again", "remove me"];
const POSITIVE = ["yes", "yeah", "yep", "sure", "okay", "ok", "sounds good", "tell me more", "i'm interested", "go on", "continue", "alright", "what is it"];
const OBJECTION = ["not interested", "no thanks", "no thank you", "busy", "can't talk", "cannot talk", "in a meeting", "driving", "send me an email", "not now", "later", "maybe", "not the right time", "who is this", "how did you get my number"];
const QUESTION_WORDS = ["what", "how", "why", "when", "where", "who", "can you", "could you", "tell me", "explain"];
const INTRODUCE = ["who are you", "what is this", "what company", "what do you do", "what are you selling"];
const SILENCE_RESPONSES = ["Are you still there?", "Hello?", "I'm still here if you have any questions.", "Just let me know if you'd like to hear more."];

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
  const indicators = ["my name is", "i'm", "i am", "this is", "name's", "it's", "call me"];
  for (const indicator of indicators) {
    const idx = lower.indexOf(indicator);
    if (idx !== -1) {
      let name = text.slice(idx + indicator.length).trim();
      name = name.split(/[.,!?]/)[0].trim();
      // Clean up common false positives
      const words = name.split(/\s+/);
      if (words.length > 3) name = words.slice(0, 3).join(" ");
      if (name.length > 1 && name.length < 40 && !/^\d+$/.test(name)) return name;
    }
  }
  return null;
}

function extractCompany(text: string): string | null {
  const lower = text.toLowerCase();
  const indicators = ["company", "business", "organization", "firm", "corp", "inc", "llc", "work at", "from", "i'm with", "i work for"];
  for (const indicator of indicators) {
    const idx = lower.indexOf(indicator);
    if (idx !== -1) {
      let company = text.slice(idx + indicator.length).trim();
      company = company.split(/[.,!?]/)[0].trim();
      if (company.length > 1 && company.length < 60) return company;
    }
  }
  return null;
}

function randomPick(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Smart pattern-based response when LLM is unavailable
 */
function normalizeQuestion(text: string): string {
  const q = String(text || "").match(/[^.!?]*\?/g)?.pop() || "";
  return q.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function avoidRepeatedQuestion(state: ConversationState, candidate: string): string {
  const q = normalizeQuestion(candidate);
  if (!q) return candidate;
  const previous = state.agentSaidHistory.map(normalizeQuestion).filter(Boolean);
  if (!previous.includes(q)) return candidate;
  console.warn("[free-ai] repeated question detected; preserving model response rather than injecting scripted dialogue:", q);
  return candidate;
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

export async function processProspectInput(
  state: ConversationState,
  transcript: string
): Promise<AIResponse> {
  const text = transcript.trim();
  if (!text) {
    state.silenceCount++;
    // Silence is not conversational input. Never inject scripted dialogue into a live call.
    // The media/VAD layer decides whether to keep listening or end an idle call.
    return { text: "", state, shouldEnd: false };
  }

  state.turnCount++;
  state.lastProspectSaid = text;
  state.prospectSaidHistory.push(text);
  state.silenceCount = 0;

  // Check for goodbye/end signals
  if (matchesAny(text, BYE)) {
    const closing = "Thank you for your time. Goodbye.";
    state.phase = "done";
    state.agentSaidHistory.push(closing);
    state.conversationHistory.push({ role: "assistant", content: closing });
    return { text: closing, state, shouldEnd: true };
  }

  // Limit conversation turns
  if (state.turnCount > 20) {
    const closing = "Thank you for your time. Goodbye.";
    state.phase = "done";
    state.agentSaidHistory.push(closing);
    state.conversationHistory.push({ role: "assistant", content: closing });
    return { text: closing, state, shouldEnd: true };
  }

  // Get AI response from LLM
  state.conversationHistory.push({ role: "user", content: text });
  
  let aiText: string;
  
  try {
    aiText = await getAIResponse(state.conversationHistory, {
      productName: state.productName,
      pitch: state.pitch,
      tone: state.tone,
      pricing: state.pricing || undefined,
    });
  } catch (e) {
    console.error("[free-ai] LLM threw error; scripted fallback is disabled");
    aiText = "I'm having a technical issue on my side, so I don't want to waste your time. I'll end the call here.";
  }

  // Never masquerade a scripted pattern engine as the conversational brain.
  if (aiText === "I'm sorry, could you repeat that?" || aiText.length < 5) {
    console.error("[free-ai] LLM unavailable; scripted fallback is disabled");
    aiText = "I'm having a technical issue on my side, so I don't want to waste your time. I'll end the call here.";
  }

  // Never re-ask an identical question already asked earlier in this call.
  aiText = avoidRepeatedQuestion(state, aiText);

  state.conversationHistory.push({ role: "assistant", content: aiText });
  state.agentSaidHistory.push(aiText);
  state.lastAgentSaid = aiText;

  // Try to extract collected data from prospect's message
  if (!state.collectedName) {
    const name = extractName(text);
    if (name) state.collectedName = name;
  }
  if (!state.collectedCompany) {
    const company = extractCompany(text);
    if (company) state.collectedCompany = company;
  }
  if (!state.collectedEmail) {
    const email = extractEmail(text);
    if (email) state.collectedEmail = email;
  }

  // Check if AI is closing (indicates we should end)
  const lowerAi = aiText.toLowerCase();
  const hasCollectedData = state.collectedName || state.collectedEmail;
  if (hasCollectedData && (lowerAi.includes("goodbye") || lowerAi.includes("have a great day"))) {
    state.phase = "done";
    return { text: aiText, state, shouldEnd: true };
  }

  // Update phase based on what was collected
  if (state.collectedEmail) {
    state.phase = "closing";
  } else if (state.collectedCompany) {
    state.phase = "collect_email";
  } else if (state.collectedName) {
    state.phase = "collect_company";
  } else if (state.turnCount > 1) {
    state.phase = "collect_name";
  }

  return { text: aiText, state, shouldEnd: false };
}

export function getInitialGreeting(state: ConversationState): string {
  const who = state.productName?.trim();
  const greeting = who ? `Hi, this is Sarah calling about ${who}. Did I catch you at an okay time?` : "Hi, this is Sarah. Did I catch you at an okay time?";
  state.agentSaidHistory.push(greeting);
  state.conversationHistory.push({ role: "assistant", content: greeting });
  return greeting;
}

export function getCollectedData(state: ConversationState): {
  name: string | null;
  company: string | null;
  email: string | null;
} {
  return {
    name: state.collectedName,
    company: state.collectedCompany,
    email: state.collectedEmail,
  };
}
