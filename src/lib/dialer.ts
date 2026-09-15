import type { DialerConfig, DialerProvider } from "@prisma/client";

export interface DialResult {
  connected: boolean;
  outcome: "CONNECTED" | "NO_ANSWER" | "BUSY" | "UNREACHABLE" | "FAILED";
  durationSecs: number;
}

export interface PlaceCallInput {
  from: string;
  to: string;
  provider: DialerProvider;
  apiKey?: string | null;
  accountSid?: string | null;
}

/**
 * Validate a dialer provider's credentials.
 *
 * For Twilio/RingCentral/Vonage the real validation calls the provider's API.
 * In this environment (no live provider accounts) we perform structural
 * validation of the entered credentials so the "Test connection" button has
 * meaningful behavior, while leaving a clearly-marked hook where real API
 * validation would occur.
 */
export async function validateProvider(config: DialerConfig) {
  const hasApiKey = !!config.apiKey;
  const hasAccountSid = !!config.accountSid;
  const hasSipUser = !!(process.env.RC_SIP_USERNAME && process.env.RC_SIP_PASSWORD);

  if (!hasApiKey && !hasAccountSid && !hasSipUser) {
    return {
      ok: false,
      error: "API key and account SID are required.",
    };
  }

  // Structural checks per provider.
  switch (config.provider) {
    case "TWILIO": {
      if (!config.accountSid) {
        return { ok: false, error: "Twilio requires an Account SID." };
      }
      if (!/^AC[0-9a-fA-F]{32}$/.test(config.accountSid) && !/^AC/.test(config.accountSid)) {
        return { ok: false, error: "Twilio Account SID must start with 'AC'." };
      }
      if (!config.outboundNumber) {
        return { ok: false, error: "An outbound caller ID number is required." };
      }
      break;
    }
    case "VONAGE": {
      if (!config.apiKey) {
        return { ok: false, error: "Vonage requires an API key." };
      }
      break;
    }
    case "RINGCENTRAL": {
      if (!config.apiKey && !process.env.RC_SIP_USERNAME) {
        return { ok: false, error: "RingCentral requires an API token/credential." };
      }
      break;
    }
  }

  return { ok: true };
}

/**
 * Place an outbound call through the configured provider.
 *
 * NOTE: This is a simulation layer. It validates the provider config is
 * present/valid and then simulates a plausible call outcome so the campaign
 * orchestration can be demonstrated end-to-end without charging a real
 * telephony account. To go live, replace the body with the provider's SDK
 * (e.g. twilio.rest.client.calls.create(...)) and return the real outcome.
 */
export async function placeCall(
  input: PlaceCallInput,
): Promise<DialResult> {
  const providerConfig = {
    provider: input.provider,
    apiKey: input.apiKey,
    accountSid: input.accountSid,
    outboundNumber: input.from,
  } as DialerConfig;

  const check = await validateProvider(providerConfig);
  if (!check.ok) {
    throw new Error(check.error as string);
  }

  // Deterministic-ish simulation based on the phone number so outcomes vary
  // across a lead list rather than all being identical.
  const seed = [...input.to].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const r = seed % 100;

  if (r < 55) {
    const duration = 15 + (seed % 90);
    return {
      connected: true,
      outcome: "CONNECTED",
      durationSecs: duration,
    };
  } else if (r < 70) {
    return { connected: false, outcome: "NO_ANSWER", durationSecs: 0 };
  } else if (r < 80) {
    return { connected: false, outcome: "BUSY", durationSecs: 0 };
  } else if (r < 90) {
    return { connected: false, outcome: "UNREACHABLE", durationSecs: 0 };
  } else {
    return { connected: false, outcome: "FAILED", durationSecs: 0 };
  }
}
