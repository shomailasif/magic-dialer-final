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

function smartFallback(state: ConversationState): string {
  const text = state.lastProspectSaid.toLowerCase();
  const turn = state.turnCount;
  const name = state.collectedName;
  const hasName = !!name;

  // Phase 1: Handle goodbye immediately
  if (matchesAny(text, BYE)) {
    if (hasName) return `Thank you ${name}! We'll be in touch. Have a great day!`;
    return "Thank you for your time! We'll be in touch. Have a great day!";
  }

  // Phase 2: Handle objections
  if (matchesAny(text, OBJECTION)) {
    state.objectionCount++;
    if (state.objectionCount >= 3) {
      if (hasName) return `I understand ${name}. I'll let you go. We'll follow up by email instead. Have a great day!`;
      return "I understand. I won't keep you. We'll send you an email instead. Have a great day!";
    }
    if (text.includes("not interested") || text.includes("no thanks")) {
      return "I completely understand. Most of our clients felt the same way at first. Could I just take 30 seconds to explain what we do?";
    }
    if (text.includes("busy") || text.includes("meeting") || text.includes("driving")) {
      return "I'm sorry to bother you. When would be a better time to call back?";
    }
    if (text.includes("who is this") || text.includes("how did you")) {
      return "This is Sarah from Dispatch Solutions. We help businesses like yours save up to 30% on dispatch costs. Can I ask what your current setup looks like?";
    }
    if (text.includes("email")) {
      return "Absolutely, I can send you an email. What's the best email address for you?";
    }
    return "I understand. We just help businesses save time and money on dispatch. Can I ask one quick question?";
  }

  // Phase 3: Handle questions about who we are
  if (matchesAny(text, INTRODUCE)) {
    return "We're Dispatch Solutions. We help businesses streamline their dispatch operations and save money. What does your current dispatch setup look like?";
  }

  // Phase 4: Handle "what" questions
  if (matchesAny(text, QUESTION_WORDS)) {
    return "Great question! We provide dispatch solutions that help businesses save up to 30% on logistics costs. What's your biggest challenge with your current dispatch process?";
  }

  // Phase 5: Handle positive responses
  if (matchesAny(text, POSITIVE)) {
    if (!state.collectedName && turn >= 2) {
      state.phase = "collect_name";
      return hasName ? `Great, ${name}! Let me get your details. What company are you with?` : "Wonderful! Let me get your details. What's your name?";
    }
    if (!state.collectedCompany && state.collectedName) {
      state.phase = "collect_company";
      return `And ${name}, what company are you with?`;
    }
    if (!state.collectedEmail) {
      state.phase = "collect_email";
      return "Perfect! And what's the best email to reach you at?";
    }
    return "Excellent! We have everything we need. A dispatch manager will call you within 30 minutes. Have a great day!";
  }

  // Phase 6: Handle silences
  if (text === "" || text === "silence") {
    state.silenceCount++;
    if (state.silenceCount >= 3) {
      return "I think we might have a bad connection. We'll follow up by email. Have a great day!";
    }
    return randomPick(SILENCE_RESPONSES);
  }

  // Phase 7: Collect data based on phase
  if (state.phase === "collect_name" && !state.collectedName) {
    const nameAttempt = extractName(text);
    if (nameAttempt) {
      state.collectedName = nameAttempt;
      state.collectedCompany = extractCompany(text);
      state.phase = state.collectedCompany ? "collect_email" : "collect_company";
      return `Nice to meet you, ${nameAttempt}! ${state.collectedCompany ? "And what's the best email for you?" : "What company are you with?"}`;
    }
    return "I didn't catch your name. Could you spell it out for me?";
  }

  if (state.phase === "collect_company" && !state.collectedCompany) {
    const companyAttempt = extractCompany(text);
    if (companyAttempt) {
      state.collectedCompany = companyAttempt;
      state.phase = "collect_email";
      return `${companyAttempt}, got it! And what's the best email to reach you at?`;
    }
    return "What's the name of your company?";
  }

  if (state.phase === "collect_email" && !state.collectedEmail) {
    const emailAttempt = extractEmail(text);
    if (emailAttempt) {
      state.collectedEmail = emailAttempt;
      state.phase = "closing";
      const n = state.collectedName || "there";
      return `Perfect, ${n}! I have everything I need. A dispatch manager will reach out to you within 30 minutes. Have a great day!`;
    }
    return "I didn't quite catch the email. Could you spell it out?";
  }

  // Phase 8: Default responses based on turn
  if (turn <= 2) {
    return `Hi${name ? " " + name : ""}! I'm calling from Dispatch Solutions. We help businesses save up to 30% on dispatch costs. What does your current dispatch setup look like?`;
  }

  // Generic smart responses
  const genericResponses = [
    `I appreciate that${name ? ", " + name : ""}. Could you tell me a bit about your business?`,
    `That's interesting. What's the biggest challenge you face with dispatch?`,
    `I see. We've helped businesses like yours save a lot of time and money. Would you like to hear how?`,
    `Makes sense. Can I ask what your role is at the company?`,
  ];
  return randomPick(genericResponses);
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
