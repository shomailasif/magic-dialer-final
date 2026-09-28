import { NextResponse } from "next/server";
import { authorizeActiveEngineDevice, engineBearerToken } from "@/lib/engine-device-auth";

/**
 * Sales-strategy research for the live agent.
 *
 * The agent researches proven techniques for the customer's vertical so it stops
 * relying on a playbook frozen at build time. Two hard rules, both deliberate:
 *   - it never fails a call. Any error returns an empty tactic list and the
 *     agent simply uses what it already knows.
 *   - it never returns something off-topic. The search layer enforces a
 *     relevance gate, because a free engine served ChatGPT results for
 *     "cold call opener script for truck dispatch services" from this host, and
 *     teaching an agent from that would be worse than teaching it nothing.
 */
export async function POST(r: Request) {
  const auth = await authorizeActiveEngineDevice(engineBearerToken(r));
  if (!auth.ok) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  let body: any = {};
  try { body = await r.json(); } catch { body = {}; }
  const product = String(body.product || "").slice(0, 120);
  const vertical = String(body.vertical || product).slice(0, 120);
  if (!vertical) return NextResponse.json({ tactics: [] });
  try {
    const { researchSales } = await import("@/management/portal/sales-research");
    const tactics = await researchSales({ vertical, product, limit: 6 });
    return NextResponse.json({ tactics });
  } catch {
    return NextResponse.json({ tactics: [] });
  }
}
