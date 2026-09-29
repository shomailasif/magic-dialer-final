import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authorizeActiveEngineDevice, engineBearerToken } from "@/lib/engine-device-auth";
import { parsePhone, phoneDigits } from "@/lib/lead-mapping";
import { diagnosticId, safeDiagnostic } from "@/lib/safe-diagnostic";

export const dynamic = "force-dynamic";

/**
 * The lead list, for the customer's own PC.
 *
 * /api/leads is a dashboard route: it authenticates with a browser session, so
 * the engine - which holds a device token and no cookie - could not read it. The
 * dial queue had no way to get the list it was built to work through. This is
 * that way in, authenticated the same way every other engine route is.
 *
 * Only leads this device is allowed to call are returned: suppressed numbers and
 * do-not-call rows are filtered out here as well as in the queue, so a number
 * that must never be dialled cannot even be read off the list.
 */
export async function GET(request: Request) {
  const requestId = diagnosticId(request.headers.get("x-request-id"));
  const fail = (error: string, stage: string, code: string, status: number) =>
    NextResponse.json({ error, ...safeDiagnostic(stage, code, status, requestId) }, { status });

  const bearer = engineBearerToken(request);
  const url = new URL(request.url);
  const device = await authorizeActiveEngineDevice(bearer || url.searchParams.get("deviceToken"));
  if (!device) return fail("Unauthorized", "device-auth", "UNAUTHORIZED", 401);

  let take = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));

  try {
    const rows = await prisma.lead.findMany({
      where: { userId: device.userId },
      orderBy: { createdAt: "asc" },
      take: 500,
      select: {
        id: true, name: true, phone: true, email: true, company: true,
        status: true, doNotCall: true, consentStatus: true,
        lastCallAt: true, createdAt: true, extraData: true,
      },
    });

    const suppressed = await prisma.phoneSuppression.findMany({
      where: { userId: device.userId },
      select: { normalizedPhone: true },
    });
    const blocked = new Set(suppressed.map((s) => s.normalizedPhone));

    const leads = rows
      .filter((l) => !l.doNotCall && String(l.consentStatus || "").toUpperCase() !== "DENIED")
      .filter((l) => !blocked.has(phoneDigits(l.phone)))
      // The stored number is already dialable, but a list can be edited by hand
      // or imported before this normalisation existed.
      .map((l) => ({ ...l, phone: parsePhone(l.phone) || l.phone }))
      .filter((l) => {
        const d = phoneDigits(l.phone);
        return d.length >= 7 && d.length <= 15;
      })
      .slice(0, take);

    return NextResponse.json({ ok: true, count: leads.length, leads, requestId });
  } catch (e) {
    console.error("engine leads list failed", e);
    return fail("Could not read the lead list", "db", "DB_UNAVAILABLE", 503);
  }
}
