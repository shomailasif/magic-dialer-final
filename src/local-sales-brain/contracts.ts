// PROTOTYPE ONLY — intentionally disconnected from the production call engine.

export type CallEventType =
  | "call_started"
  | "prospect_turn"
  | "assistant_turn"
  | "objection"
  | "opt_out"
  | "call_ended"
  | "outcome_updated";

export interface CallEvent {
  schemaVersion: 1;
  eventId: string;
  customerId: string;
  callId: string;
  prospectId?: string;
  type: CallEventType;
  occurredAt: string;
  text?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export type PitchFamily =
  | "consultative"
  | "problem_first"
  | "value_first"
  | "concise_direct"
  | "relationship_first";

export interface ConversationSignals {
  wordsPerMinute?: number;
  averageTurnWords?: number;
  interruptionRate?: number;
  questionRate?: number;
  sentimentHint?: "positive" | "neutral" | "negative";
}

export interface AdviceRequest {
  customerId: string;
  callId: string;
  prospectId?: string;
  signals: ConversationSignals;
  allowedPitchFamilies: PitchFamily[];
}

export interface Advice {
  pitchFamily: PitchFamily;
  paceMultiplier: number;
  maxResponseWords: number;
  formality: "casual" | "neutral" | "formal";
  memoryIds: string[];
  evidenceIds: string[];
  expiresAt: string;
}

export interface ResourceBudget {
  maxResidentMb: number;
  maxDatabaseMb: number;
  maxBackgroundCpuPercent: number;
  pauseBackgroundDuringCalls: boolean;
}

export const DEFAULT_RESOURCE_BUDGET: ResourceBudget = {
  maxResidentMb: 256,
  maxDatabaseMb: 1024,
  maxBackgroundCpuPercent: 10,
  pauseBackgroundDuringCalls: true,
};

export function clampAdvice(advice: Advice): Advice {
  return {
    ...advice,
    paceMultiplier: Math.min(1.2, Math.max(0.8, advice.paceMultiplier)),
    maxResponseWords: Math.min(120, Math.max(12, Math.round(advice.maxResponseWords))),
  };
}
