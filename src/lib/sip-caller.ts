import { runConversation, type SIPConfig, type AgentConfig, type ConversationResult } from "@/lib/sip-conversation";

export type SIPCallConfig = SIPConfig;
export type SIPCallResult = ConversationResult;

export async function makeSIPCall(
  sipConfig: SIPConfig,
  agentConfig: AgentConfig,
  maxDurationMs: number = 120000,
): Promise<ConversationResult> {
  return runConversation(sipConfig, agentConfig, maxDurationMs);
}
