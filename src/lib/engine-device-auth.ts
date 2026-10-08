import { createHash } from "crypto";
import { prisma } from "@/lib/db";

const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");

/* Device auth, held for three seconds.
 *
 * Every AI request the engine makes re-read the device row and the lease on the
 * account behind it. That is one more blocking round trip to a remote Postgres
 * on the way to a phone call, during a call the engine is asking several times a
 * second, and none of it can change in the time it takes to answer.
 *
 * Three seconds is the ceiling because that is the shape of the traffic: the
 * engine heartbeats every three seconds and sends an STT and a brain request per
 * turn, so the second request of a turn is answered from memory while a
 * revocation or a lease handover is at most three seconds behind. The heartbeat
 * route renews the lease every three seconds, so the cached record is at most
 * one beat old.
 *
 * Two rules keep this from hiding a revocation:
 *   - only a success is ever cached. A denied device is re-read on every call,
 *     so a revoked token or an expired lease is never answered from memory.
 *   - a hit is not trusted. The cached record goes back through the same
 *     authorizeEngineDeviceRecord, against a fresh `now`, so a lease that
 *     expires inside the window still denies on the next request.
 *
 * Entries are keyed by token hash. The token itself is never held, and an entry
 * is dropped as soon as it is older than the window, so the cache cannot grow
 * without bound even if a caller sends a token that never authorizes.
 */
const AUTH_CACHE_MS = 3_000;
const AUTH_CACHE_MAX = 64;

/* The columns the decision is made from, and nothing else - the cache holds no
 * more of the device than the read that authorizes it needs. */
type EngineDeviceAuthRecord = {
  id: string;
  userId: string;
  machineId: string;
  revokedAt: Date | null;
  leaseUntil: Date | null;
  user: { activeEngineMachineId: string | null; engineLeaseUntil: Date | null } | null;
};

const authCache = new Map<string, { at: number; record: EngineDeviceAuthRecord }>();

export function invalidateEngineDeviceAuthCache(deviceId?: string) {
  if (deviceId) {
    for (const [key, entry] of authCache) {
      if (entry.record?.id === deviceId) authCache.delete(key);
    }
    return;
  }
  authCache.clear();
}

function cachedDevice(hash: string) {
  const hit = authCache.get(hash);
  if (!hit) return null;
  // Measured against the wall clock, not the caller's `now`, so a caller cannot
  // extend an entry's life by passing an old date.
  if (Date.now() - hit.at >= AUTH_CACHE_MS) {
    authCache.delete(hash);
    return null;
  }
  return hit.record;
}

function cacheDevice(hash: string, record: EngineDeviceAuthRecord) {
  authCache.set(hash, { at: Date.now(), record });
  if (authCache.size > AUTH_CACHE_MAX) {
    const oldest = [...authCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) authCache.delete(oldest[0]);
  }
}

export function engineBearerToken(request: Request) {
  const header = request.headers.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export async function authorizeActiveEngineDevice(tokenValue: unknown, now = new Date()) {
  const token = String(tokenValue || "").trim();
  if (!token) return null;
  const hash = tokenHash(token);

  const cached = cachedDevice(hash);
  if (cached) return authorizeEngineDeviceRecord(cached, now);

  const device = await prisma.engineDevice.findUnique({
    where: { tokenHash: hash },
    select: {
      id: true, userId: true, machineId: true, revokedAt: true, leaseUntil: true,
      user: { select: { activeEngineMachineId: true, engineLeaseUntil: true } },
    },
  });
  const allowed = authorizeEngineDeviceRecord(device, now);
  // A denial is never stored, so revocation cannot outlive the window.
  if (allowed && device) cacheDevice(hash, device);
  return allowed;
}

export function authorizeEngineDeviceRecord(device: any, now = new Date()) {
  if (!device || device.revokedAt) return null;
  if (!device.leaseUntil || device.leaseUntil <= now) return null;
  if (!device.user?.engineLeaseUntil || device.user.engineLeaseUntil <= now) return null;
  if (device.user.activeEngineMachineId !== device.machineId) return null;
  return { deviceId: device.id, userId: device.userId, machineId: device.machineId };
}
