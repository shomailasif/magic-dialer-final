import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const number = String(body.number || "").replace(/[^0-9+]/g, "");
  if (!number || number.length < 7) {
    return NextResponse.json({ error: "Enter a valid phone number (e.g. +16234001991)" }, { status: 400 });
  }

  const rcUser = process.env.RC_SIP_USERNAME;
  const rcPass = process.env.RC_SIP_PASSWORD;
  const rcCallerId = process.env.RC_CALLER_ID || process.env.RC_PHONE;
  const rcDomain = process.env.RC_SIP_DOMAIN || "sip.ringcentral.com";
  const rcProxy = process.env.RC_SIP_PROXY || "sip40.ringcentral.com";
  const rcPort = process.env.RC_SIP_PORT || "5096";

  if (!rcUser || !rcPass) {
    return NextResponse.json({ error: "RingCentral SIP credentials not configured on the server." }, { status: 500 });
  }

  try {
    const { spawn } = require("child_process");
    const result = await new Promise<{ ok: boolean; output: string }>((resolve) => {
      const child = spawn("node", [
        "-e",
        `
const sdk = require("ringcentral-softphone");
const SipSession = sdk.SipSession;

const session = new SipSession({
  domain: "${rcDomain}",
  outboundProxy: "${rcProxy}:${rcPort}",
  username: "${rcUser}",
  password: "${rcPass}",
  authorizationId: "${rcUser}",
  codec: "PCMU/8000",
});

let resolved = false;
function done(ok, msg) {
  if (resolved) return;
  resolved = true;
  try { session.close(); } catch {}
  process.stdout.write(JSON.stringify({ ok, output: msg }));
  process.exit(ok ? 0 : 1);
}

session.on("registered", () => {
  console.error("SIP registered, placing call to ${number}...");
  session.call("${number}", { timeout: 15000 });
});

session.on("ringing", () => {
  console.error("Ringing...");
});

session.on("answered", () => {
  console.error("Answered! Hanging up after 3 seconds...");
  setTimeout(() => done(true, "Test call connected and answered."), 3000);
});

session.on("ended", () => {
  done(true, "Call ended.");
});

session.on("error", (err) => {
  done(false, "Error: " + (err.message || err));
});

session.on("failed", (err) => {
  done(false, "Failed: " + (err.message || err));
});

setTimeout(() => done(false, "Timeout - no answer after 15 seconds"), 16000);

session.register();
        `,
      ], { timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => { stdout += d; });
      child.stderr.on("data", (d: Buffer) => { stderr += d; });
      child.on("close", (code: number) => {
        try {
          const parsed = JSON.parse(stdout);
          resolve(parsed);
        } catch {
          resolve({ ok: code === 0, output: stdout || stderr || "No output" });
        }
      });
      child.on("error", (err: Error) => {
        resolve({ ok: false, output: "Process error: " + err.message });
      });
    });

    if (result.ok) {
      return NextResponse.json({ ok: true, status: "completed", message: result.output });
    } else {
      return NextResponse.json({ ok: false, error: result.output }, { status: 400 });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: "Test call failed: " + msg }, { status: 500 });
  }
}
