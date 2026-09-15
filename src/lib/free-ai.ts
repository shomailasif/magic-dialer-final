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
}

export interface AIResponse {
  text: string;
  state: ConversationState;
  shouldEnd: boolean;
}

const GREETINGS = ["hello", "hi", "hey", "good morning", "good afternoon", "good evening", "what's up", "sup", "yo"];
const POSITIVE = ["yes", "yeah", "yep", "sure", "okay", "ok", "sounds good", "tell me more", "i'm interested", "go on", "continue", "alright"];
const NEGATIVE = ["no", "nah", "nope", "not interested", "don't want", "don't need", "stop", "go away", "leave me alone", "busy", "can't talk"];
const OBJECTIONS = ["too expensive", "cost", "price", "budget", "already have", "using another", "satisfied", "call later", "bad time", "in a meeting", "driving"];
const QUESTIONS = ["what", "how", "why", "when", "where", "who", "can you", "could you", "tell me", "explain"];
const NAME_INDICATORS = ["my name is", "i'm", "i am", "this is", "name's"];
const COMPANY_INDICATORS = ["company", "business", "organization", "firm", "corp", "inc", "llc", "work at", "from"];
const EMAIL_INDICATORS = ["email", "@", "dot com", "gmail", "yahoo", "outlook", "hotmail"];
const BYE = ["bye", "goodbye", "see you", "talk later", "gotta go", "have to go", "hung up"];

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
  for (const indicator of NAME_INDICATORS) {
    const idx = lower.indexOf(indicator);
    if (idx !== -1) {
      let name = text.slice(idx + indicator.length).trim();
      name = name.split(/[.,!?]/)[0].trim();
      if (name.length > 1 && name.length < 50) return name;
    }
  }
  const words = text.trim().split(/\s+/);
  if (words.length === 1 && words[0].length > 1 && words[0][0] === words[0][0].toUpperCase()) {
    return words[0];
  }
  if (words.length === 2 && words.every((w) => w[0] && w[0] === w[0].toUpperCase() && w.length > 1)) {
    return words.join(" ");
  }
  return null;
}

function extractCompany(text: string): string | null {
  const lower = text.toLowerCase();
  for (const indicator of COMPANY_INDICATORS) {
    const idx = lower.indexOf(indicator);
    if (idx !== -1) {
      let company = text.slice(idx + indicator.length).trim();
      company = company.split(/[.,!?]/)[0].trim();
      if (company.length > 1 && company.length < 80) return company;
    }
  }
  return null;
}

function generateGreeting(tone: ConversationState["tone"]): string {
  switch (tone) {
    case "FRIENDLY": return "Hi there! Thanks for picking up. How are you doing today?";
    case "DIRECT": return "Hello, thank you for taking my call. I'll be brief.";
    default: return "Hello, thanks for answering. How are you doing today?";
  }
}

function generatePitch(state: ConversationState): string {
  const product = state.productName || "dispatch and logistics solutions";
  const pitch = state.pitch?.trim();
  if (pitch) return pitch;
  return `I'm reaching out because we provide ${product} that helps businesses like yours save time and money.`;
}

function generateCollectName(state: ConversationState): string {
  switch (state.tone) {
    case "FRIENDLY": return "Great! So, what's your name?";
    case "DIRECT": return "What's your name?";
    default: return "Could you share your name with me?";
  }
}

function generateCollectCompany(state: ConversationState): string {
  const name = state.collectedName ? ` ${state.collectedName}` : "";
  return `Nice to meet you${name}! What company are you with?`;
}

function generateCollectEmail(state: ConversationState): string {
  return "And what's the best email to reach you at?";
}

function generateObjectionResponse(state: ConversationState, objection: string): string {
  state.objectionCount++;
  const lower = objection.toLowerCase();

  if (matchesAny(lower, ["too expensive", "cost", "price", "budget"])) {
    return "I understand budget is a concern. We actually have flexible pricing that works for businesses of all sizes. Can I ask what you're currently spending? That way I can show you how we can save you money.";
  }
  if (matchesAny(lower, ["already have", "using another", "satisfied"])) {
    return "That's great that you have a solution! Many of our clients switched to us because they were getting better results. Would you be open to a quick comparison?";
  }
  if (matchesAny(lower, ["call later", "bad time", "in a meeting", "busy", "driving"])) {
    return "Absolutely, I don't want to interrupt. When would be a better time for me to call back? I promise it'll be worth just two minutes of your time.";
  }
  if (matchesAny(lower, ["no", "nah", "not interested"])) {
    if (state.objectionCount >= 2) {
      return "I completely understand. I'll let you go, but if anything changes, we're here to help. Have a great day!";
    }
    return "I respect that. Just so you know, we help businesses save up to 30% on their logistics costs. Would it be okay if I sent you a quick email with some information?";
  }

  return "I appreciate your honesty. Let me ask you this — what's the biggest challenge you're facing right now with your current setup?";
}

function generateClosing(state: ConversationState): string {
  const parts: string[] = [];
  if (state.collectedName) parts.push(state.collectedName);
  
  const name = parts.length ? ` ${parts[0]}` : "";
  return `Thank${name ? " you, " + parts[0] : " you"}! That's everything I needed. One of our dispatch managers will call you back within 30 minutes at 623-400-1991 to discuss your needs further. Have a great day!`;
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
  };
}

export function processProspectInput(
  state: ConversationState,
  transcript: string
): AIResponse {
  const text = transcript.trim();
  if (!text) {
    return { text: "", state, shouldEnd: false };
  }

  state.turnCount++;
  state.lastProspectSaid = text;
  state.prospectSaidHistory.push(text);

  if (matchesAny(text, BYE)) {
    const closing = generateClosing(state);
    state.phase = "done";
    state.agentSaidHistory.push(closing);
    return { text: closing, state, shouldEnd: true };
  }

  if (matchesAny(text, QUESTIONS)) {
    let response = "";
    if (text.toLowerCase().includes("price") || text.toLowerCase().includes("cost")) {
      response = state.pricing
        ? `Great question! Our pricing starts at ${state.pricing}. We also have flexible plans. Would you like to hear more?`
        : "Our pricing is very competitive and depends on your needs. I'd love to give you a personalized quote. What's your name so I can have someone follow up?";
    } else if (text.toLowerCase().includes("what do you") || text.toLowerCase().includes("what does")) {
      response = `We provide ${state.productName || "dispatch and logistics solutions"} that help businesses save time and money. ${generatePitch(state)}`;
    } else {
      response = "That's a great question! I'd love to go into more detail. One of our specialists can give you a thorough answer when they call you back. What's your name so we can personalize the follow-up?";
    }
    state.agentSaidHistory.push(response);
    return { text: response, state, shouldEnd: false };
  }

  if (matchesAny(text, OBJECTIONS)) {
    const response = generateObjectionResponse(state, text);
    state.agentSaidHistory.push(response);
    if (state.objectionCount >= 3 || response.includes("Have a great day")) {
      state.phase = "done";
      return { text: response, state, shouldEnd: true };
    }
    return { text: response, state, shouldEnd: false };
  }

  switch (state.phase) {
    case "greeting": {
      if (matchesAny(text, GREETINGS) || matchesAny(text, POSITIVE)) {
        state.phase = "pitch";
        const response = generatePitch(state);
        state.agentSaidHistory.push(response);
        return { text: response, state, shouldEnd: false };
      }
      state.phase = "pitch";
      const response = `Thanks! ${generatePitch(state)}`;
      state.agentSaidHistory.push(response);
      return { text: response, state, shouldEnd: false };
    }

    case "pitch": {
      if (matchesAny(text, NEGATIVE)) {
        const response = generateObjectionResponse(state, text);
        state.agentSaidHistory.push(response);
        return { text: response, state, shouldEnd: false };
      }
      state.phase = "collect_name";
      const response = generateCollectName(state);
      state.agentSaidHistory.push(response);
      return { text: response, state, shouldEnd: false };
    }

    case "collect_name": {
      const name = extractName(text);
      if (name) {
        state.collectedName = name;
        state.phase = "collect_company";
        const response = generateCollectCompany(state);
        state.agentSaidHistory.push(response);
        return { text: response, state, shouldEnd: false };
      }
      state.collectedName = text.split(/[.,!?]/)[0].trim() || "Prospect";
      state.phase = "collect_company";
      const response = `Got it, ${state.collectedName}! ${generateCollectCompany(state)}`;
      state.agentSaidHistory.push(response);
      return { text: response, state, shouldEnd: false };
    }

    case "collect_company": {
      const company = extractCompany(text);
      if (company) {
        state.collectedCompany = company;
      } else {
        state.collectedCompany = text.split(/[.,!?]/)[0].trim() || "Unknown";
      }
      state.phase = "collect_email";
      const response = generateCollectEmail(state);
      state.agentSaidHistory.push(response);
      return { text: response, state, shouldEnd: false };
    }

    case "collect_email": {
      const email = extractEmail(text);
      if (email) {
        state.collectedEmail = email;
      } else {
        state.collectedEmail = text.split(/[.,!?]/)[0].trim() + "@unknown.com";
      }
      state.phase = "closing";
      const response = generateClosing(state);
      state.phase = "done";
      state.agentSaidHistory.push(response);
      return { text: response, state, shouldEnd: true };
    }

    case "handling_objection": {
      state.phase = "collect_name";
      const response = "I understand. Let me just get a few details so we can follow up properly. What's your name?";
      state.agentSaidHistory.push(response);
      return { text: response, state, shouldEnd: false };
    }

    case "closing": {
      const response = generateClosing(state);
      state.phase = "done";
      state.agentSaidHistory.push(response);
      return { text: response, state, shouldEnd: true };
    }

    default: {
      if (state.turnCount > 20) {
        const response = generateClosing(state);
        state.phase = "done";
        state.agentSaidHistory.push(response);
        return { text: response, state, shouldEnd: true };
      }
      const response = "I appreciate you sharing that. Let me just get your name and email so we can follow up with more details. What's your name?";
      state.phase = "collect_name";
      state.agentSaidHistory.push(response);
      return { text: response, state, shouldEnd: false };
    }
  }
}

export function getInitialGreeting(state: ConversationState): string {
  const greeting = generateGreeting(state.tone);
  state.agentSaidHistory.push(greeting);
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
