/**
 * Free AI - Real LLM Conversation Engine
 * 
 * Uses KeylessAI (free, unlimited) for intelligent phone conversations.
 * Falls back to pattern matching if LLM is unavailable.
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
}

export interface AIResponse {
  text: string;
  state: ConversationState;
  shouldEnd: boolean;
}

// Pattern banks for fallback and end detection
const BYE = ["bye", "goodbye", "see you", "talk later", "gotta go", "have to go", "hung up", "not interested", "no thanks", "stop calling"];
const POSITIVE = ["yes", "yeah", "yep", "sure", "okay", "ok", "sounds good", "tell me more", "i'm interested", "go on", "continue", "alright"];

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
  const indicators = ["my name is", "i'm", "i am", "this is", "name's"];
  for (const indicator of indicators) {
    const idx = lower.indexOf(indicator);
    if (idx !== -1) {
      let name = text.slice(idx + indicator.length).trim();
      name = name.split(/[.,!?]/)[0].trim();
      if (name.length > 1 && name.length < 50) return name;
    }
  }
  return null;
}

function extractCompany(text: string): string | null {
  const lower = text.toLowerCase();
  const indicators = ["company", "business", "organization", "firm", "corp", "inc", "llc", "work at", "from"];
  for (const indicator of indicators) {
    const idx = lower.indexOf(indicator);
    if (idx !== -1) {
      let company = text.slice(idx + indicator.length).trim();
      company = company.split(/[.,!?]/)[0].trim();
      if (company.length > 1 && company.length < 80) return company;
    }
  }
  return null;
}

function generateClosing(state: ConversationState): string {
  const name = state.collectedName ? ` ${state.collectedName}` : "";
  return `Thank${name ? " you, " + state.collectedName : " you"}! That's everything I needed. One of our dispatch managers will call you back within 30 minutes. Have a great day!`;
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
  };
}

export async function processProspectInput(
  state: ConversationState,
  transcript: string
): Promise<AIResponse> {
  const text = transcript.trim();
  if (!text) {
    return { text: "", state, shouldEnd: false };
  }

  state.turnCount++;
  state.lastProspectSaid = text;
  state.prospectSaidHistory.push(text);

  // Check for goodbye/end signals
  if (matchesAny(text, BYE)) {
    const closing = generateClosing(state);
    state.phase = "done";
    state.agentSaidHistory.push(closing);
    return { text: closing, state, shouldEnd: true };
  }

  // Limit conversation turns
  if (state.turnCount > 20) {
    const closing = generateClosing(state);
    state.phase = "done";
    state.agentSaidHistory.push(closing);
    return { text: closing, state, shouldEnd: true };
  }

  // Get AI response from LLM
  state.conversationHistory.push({ role: "user", content: text });
  
  const aiText = await getAIResponse(state.conversationHistory, {
    productName: state.productName,
    pitch: state.pitch,
    tone: state.tone,
    pricing: state.pricing || undefined,
  });

  state.conversationHistory.push({ role: "assistant", content: aiText });
  state.agentSaidHistory.push(aiText);

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
  if (lowerAi.includes("have a great day") || lowerAi.includes("goodbye") || lowerAi.includes("thank you")) {
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
  const greeting = "Hello! Thank you for taking my call. How are you doing today?";
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
