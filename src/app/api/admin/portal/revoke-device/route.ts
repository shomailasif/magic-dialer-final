import { NextResponse } from "next/server";
import { requireAdmin } from "../_lib";
import { prisma } from "@/lib/db";
import { invalidateConfigCache } from "@/app/api/heartbeat/route";

export const dynamic = "force-dynamic";

/**
 * Revoke a customer's engine device from the admin side.
 *
 * The lease has a supported way out (release-lease) but nothing can remove a
 * *device*. So a PC that has been decommissioned, rebuilt, or reassigned keeps
 * its enrollment forever, keeps heartbeating, and takes the lease back every few
 * seconds - which is what happened on 07 Oct. The holder was a machineId nobody
 * on the team could place, so the account could not be used from any machine
 * that could be found, and release-lease only bought seconds.
 *
 * Revoking sets revokedAt on the device row and nothing else. It does not
 * delete the row, so the machine keeps its identity and can be re-enrolled
 * deliberately later, and it does not touch the customer's account, credentials
 * or configuration. A revoked device is rejected by device-auth, so it cannot
 * heartbeat, cannot hold the lease and cannot use the AI gateway.
 *
 * When the last device on an account is revoked the account would otherwise be
 * left holding a lease that nothing can claim, so the lease is released at the
 * same time.
 */
export async function POST(req: Request) {
  const err = await requireAdmin();
  if (err) return err;

  let body: { machineId?: string; userEmail?: string } = {};
  try { body = (await req.json()) as typeof body; } catch { /* allow empty */ }

  const machineId = String(body.machineId || "").trim();
  const userEmail = String(body.userEmail || "").trim().toLowerCase();
  if (!machineId && !userEmail) {
    return NextResponse.json({ error: "machineId or userEmail required" }, { status: 400 });
  }

  const user = userEmail
    ? await prisma.user.findUnique({ where: { email: userEmail }, select: { id: true, email: true } })
    : null;
  if (userEmail && !user) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const devices = await prisma.engineDevice.findMany({
    where: user ? { userId: user.id } : { machineId },
    select: { id: true, userId: true, machineId: true, lastSeenAt: true, revokedAt: true },
    orderBy: { lastSeenAt: "desc" },
  });
  if (!devices.length) return NextResponse.json({ error: "No matching device" }, { status: 404 });

  /* Only the requested machine when one was named, so revoking by email cannot
   * silently strip every PC a customer has. */
  const target = machineId ? devices.filter((d) => d.machineId === machineId) : devices;
  if (!target.length) return NextResponse.json({ error: "Device not found on that account" }, { status: 404 });

  const already = target.filter((d) => d.revokedAt).map((d) => d.machineId);
  const toRevoke = target.filter((d) => !d.revokedAt);
  if (toRevoke.length) {
    await prisma.engineDevice.updateMany({
      where: { id: { in: toRevoke.map((d) => d.id) } },
      data: { revokedAt: new Date() },
    });
    /* Release the lease if the machine we just revoked was holding it, or if
     * nothing is left on the account that could legitimately hold it. */
    const affected = Array.from(new Set(toRevoke.map((d) => d.userId)));
    for (const userId of affected) {
      const remaining = await prisma.engineDevice.count({
        where: { userId, revokedAt: null },
      });
      const owner = await prisma.user.findUnique({
        where: { id: userId },
        select: { activeEngineMachineId: true },
      });
      const revokedHolder = owner?.activeEngineMachineId
        && toRevoke.some((d) => d.userId === userId && d.machineId === owner.activeEngineMachineId);
      if (remaining === 0 || revokedHolder) {
        await prisma.user.update({
          where: { id: userId },
          data: { activeEngineMachineId: null, engineLeaseUntil: null },
        });
      }
    }
  }
  try { invalidateConfigCache(); } catch { /* cache is best effort */ }

  return NextResponse.json({
    ok: true,
    revoked: toRevoke.map((d) => ({
      machineId: d.machineId,
      userId: d.userId,
      lastSeenAt: d.lastSeenAt,
      ageSeconds: d.lastSeenAt ? Math.round((Date.now() - new Date(d.lastSeenAt).getTime()) / 1000) : null,
    })),
    alreadyRevoked: already,
    remainingOnAccount: devices.length - toRevoke.length,
  });
}