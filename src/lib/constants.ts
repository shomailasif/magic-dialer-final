import type { SubscriptionPlan } from "@prisma/client";

export interface Plan {
  id: SubscriptionPlan;
  name: string;
  price: string;
  blurb: string;
  calls: string;
  features: string[];
  highlighted?: boolean;
}

export const PLANS: Plan[] = [
  {
    id: "FREE",
    name: "Free",
    price: "$0",
    blurb: "Try AutoDial AI with a small lead list.",
    calls: "up to 50 calls / mo",
    features: [
      "50 outbound calls / month",
      "1,000 lead storage",
      "Basic AI agent",
      "Email notifications",
    ],
  },
  {
    id: "STARTER",
    name: "Starter",
    price: "$99",
    blurb: "For growing teams ready to dial autonomously.",
    calls: "up to 500 calls / mo",
    features: [
      "500 outbound calls / month",
      "10,000 lead storage",
      "Full AI agent config",
      "AI lead generation",
      "Email notifications",
    ],
  },
  {
    id: "PRO",
    name: "Pro",
    price: "$299",
    highlighted: true,
    blurb: "Serious outbound volume with advanced AI learning.",
    calls: "up to 2,000 calls / mo",
    features: [
      "2,000 outbound calls / month",
      "50,000 lead storage",
      "Advanced AI pitch & learning",
      "AI lead generation",
      "Priority support",
    ],
  },
  {
    id: "ENTERPRISE",
    name: "Enterprise",
    price: "Custom",
    blurb: "High-volume calling with dedicated onboarding.",
    calls: "unlimited calls / mo",
    features: [
      "Unlimited outbound calls",
      "Unlimited lead storage",
      "Dedicated success manager",
      "Advanced AI learning",
      "Custom integrations",
    ],
  },
];

export const PLAN_BY_ID: Record<string, Plan> = Object.fromEntries(
  PLANS.map((p) => [p.id, p]),
);

export const SUBSCRIPTION_STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending activation",
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
  DEACTIVATED: "Deactivated",
};

// Only these accounts may use the platform-shared RingCentral line.
// Every other (including future) account must configure its own VOIP.
export const SHARED_RC_EMAILS: readonly string[] = [
  "zaz1@autodial.ai",
  "zaz2@autodial.ai",
  "zaz3@autodial.ai",
];

export function isSharedRcEmail(email: string | null | undefined): boolean {
  return !!email && SHARED_RC_EMAILS.includes(String(email).toLowerCase());
}
