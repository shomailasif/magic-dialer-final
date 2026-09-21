import type { DialerConfig, DialerProvider } from "@prisma/client";
import { redactDiagnostic } from "@/lib/safe-diagnostic";

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
  script?: string | null;
}

export async function validateProvider(config: DialerConfig) {
  const hasApiKey = !!config.apiKey;
  const hasAccountSid = !!config.accountSid;
  const hasSipUser = !!(process.env.RC_SIP_USERNAME && process.env.RC_SIP_PASSWORD);
  const hasRcApi = !!(process.env.RC_CLIENT_ID && process.env.RC_CLIENT_SECRET);

  if (!hasApiKey && !hasAccountSid && !hasSipUser && !hasRcApi) {
    return { ok: false, error: "No dialer credentials configured." };
  }

  switch (config.provider) {
    case "TWILIO": {
      if (!config.accountSid) return { ok: false, error: "Twilio requires an Account SID." };
      if (!config.outboundNumber) return { ok: false, error: "An outbound caller ID number is required." };
      break;
    }
    case "RINGCENTRAL": {
      if (!hasRcApi && !hasSipUser) return { ok: false, error: "RingCentral requires API or SIP credentials." };
      break;
    }
  }
  return { ok: true };
}

let rcTokenCache: { token: string; expiresAt: number } | null = null;

async function rcGetToken(): Promise<string> {
  // Return cached token if still valid (with 60s safety margin)
  if (rcTokenCache && Date.now() < rcTokenCache.expiresAt - 60000) {
    return rcTokenCache.token;
  }

  const clientId = process.env.RC_CLIENT_ID || "";
  const clientSecret = process.env.RC_CLIENT_SECRET || "";
  const jwt = process.env.RC_JWT || "";

  if (jwt && clientId && clientSecret) {
    const basic = "Basic " + Buffer.from(clientId + ":" + clientSecret).toString("base64");
    const r = await fetch("https://platform.ringcentral.com/restapi/oauth/token", {
      method: "POST",
      headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }).toString(),
    });
    if (!r.ok) throw new Error("RC JWT rejected: " + r.status);
    const data = await r.json();
    const expiresIn = Number(data.expires_in) || 3600;
    rcTokenCache = { token: data.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    return rcTokenCache.token;
  }

  const sipUser = process.env.RC_SIP_USERNAME || "";
  const sipPass = process.env.RC_SIP_PASSWORD || "";
  if (sipUser && sipPass && clientId && clientSecret) {
    const basic = "Basic " + Buffer.from(clientId + ":" + clientSecret).toString("base64");
    const r = await fetch("https://platform.ringcentral.com/restapi/v1.0/oauth/token", {
      method: "POST",
      headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", username: sipUser, password: sipPass, extension: "101" }).toString(),
    });
    if (!r.ok) throw new Error("RC password token rejected: " + r.status);
    const data = await r.json();
    const expiresIn = Number(data.expires_in) || 3600;
    rcTokenCache = { token: data.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    return rcTokenCache.token;
  }

  throw new Error("No RingCentral credentials configured");
}

export async function placeCall(input: PlaceCallInput): Promise<DialResult> {
  const check = await validateProvider({ provider: input.provider } as DialerConfig);
  if (!check.ok) throw new Error(check.error as string);

  if (input.provider === "RINGCENTRAL") {
    try {
      const token = await rcGetToken();
      const from = input.from || process.env.RC_CALLER_ID || process.env.RC_SIP_USERNAME || "";

      const r = await fetch("https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/ring-out", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({
          to: { phoneNumber: input.to },
          from: { phoneNumber: from },
          callerId: { phoneNumber: from },
          playPrompt: false,
        }),
      });
      if (!r.ok) {
        // If 401, invalidate token cache so next call refreshes
        if (r.status === 401) rcTokenCache = null;
        return { connected: false, outcome: "FAILED", durationSecs: 0 };
      }
      const d = await r.json();
      const ringoutId = d.id || "";

      const start = Date.now();
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
          const poll = await fetch("https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/ring-out/" + ringoutId, {
            headers: { Authorization: "Bearer " + token },
          });
          if (!poll.ok) continue;
          const pd = await poll.json();
          const cs = String((pd.status || {}).callStatus || "").toLowerCase();
          if (/connected|completed|success/.test(cs)) {
            await new Promise((r) => setTimeout(r, 5000));
            return { connected: true, outcome: "CONNECTED", durationSecs: Math.round((Date.now() - start) / 1000) };
          }
          if (/invalid|error|fail|denied|unavailable|no.?answer/.test(cs)) {
            return { connected: false, outcome: cs.includes("busy") ? "BUSY" : "NO_ANSWER", durationSecs: 0 };
          }
        } catch {}
      }
      return { connected: false, outcome: "NO_ANSWER", durationSecs: 0 };
    } catch (e: unknown) {
      console.error("[dialer] RingCentral error:", redactDiagnostic(e, [process.env.RC_CLIENT_SECRET, process.env.RC_JWT, process.env.RC_SIP_PASSWORD]));
      return { connected: false, outcome: "FAILED", durationSecs: 0 };
    }
  }

  // Production safety: unsupported providers must never fabricate a call result.
  // Real provider adapters are required before TWILIO/VONAGE can place calls.
  throw new Error(`Provider ${input.provider} is not enabled for live calling yet.`);
}
