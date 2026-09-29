import { NextResponse } from "next/server";
import { requireAdmin } from "../_lib";
import { prisma } from "@/lib/db";
import { invalidateConfigCache } from "@/app/api/heartbeat/route";

export const dynamic = "force-dynamic";

/**
 * Release a customer's engine lease from the admin side.
 *
 * The lease stops a second PC running calls while one is active. It normally
 * hands over on its own, but if the holding machine is in a state where it
 * cannot be identified - no device row, revoked, or a value left by an earlier
 * account - the customer is locked out of their own account with 409 and no way
 * out. This is that way out, and it is the only supported manual override:
 *
 *   it only clears who holds the lease, never revokes a device. Revoking is
 *   what bricked a customer's other PC the last time anyone reached for it.
 *
 * The next heartbeat from any registered machine claims the lease, so the
 * operator immediately tells the intended PC to take over.
 */
export async function POST(req: Request) {
  const err = await requireAdmin();
  if (err) return err;

  let b: { userId?: string; userEmail?: string } = {};
  try { b = (await req.json()) as typeof b; } catch { /* allow empty */ }

  const userId = String(b.userId || "").trim();
  const userEmail = String(b.userEmail || "").trim().toLowerCase();
  if (!userId && !userEmail) {
    return NextResponse.json({ error: "userId or userEmail required" }, { status: 400 });
  }

  const user = userId
    ? await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, activeEngineMachineId: true, engineLeaseUntil: true } })
    : await prisma.user.findFirst({ where: { email: userEmail }, select: { id: true, email: true, activeEngineMachineId: true, engineLeaseUntil: true } });
  if (!user) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const before = { machineId: user.activeEngineMachineId, leaseUntil: user.engineLeaseUntil };

  await prisma.user.update({
    where: { id: user.id },
    data: { activeEngineMachineId: null, engineLeaseUntil: null },
  });
  try { invalidateConfigCache(); } catch { /* cache is best effort */ }

  const devices = await prisma.engineDevice.findMany({
    where: { userId: user.id },
    select: { machineId: true, lastSeenAt: true, revokedAt: true },
    orderBy: { lastSeenAt: "desc" },
  });

  return NextResponse.json({
    ok: true,
    userId: user.id,
    email: user.email,
    released: before,
    // What the operator sees in the log, so the cause of a stuck account is
    // recorded rather than guessed at.
    devices: devices.map((d) => ({
      machineId: d.machineId,
      lastSeenAt: d.lastSeenAt,
      revoked: Boolean(d.revokedAt),
      ageSeconds: d.lastSeenAt ? Math.round((Date.now() - new Date(d.lastSeenAt).getTime()) / 1000) : null,
    })),
  });
}
