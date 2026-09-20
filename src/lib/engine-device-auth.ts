import { createHash } from "crypto";
import { prisma } from "@/lib/db";

const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");

export function engineBearerToken(request: Request) {
  const header = request.headers.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export async function authorizeActiveEngineDevice(tokenValue: unknown, now = new Date()) {
  const token = String(tokenValue || "").trim();
  if (!token) return null;
  const device = await prisma.engineDevice.findUnique({
    where: { tokenHash: tokenHash(token) },
    select: {
      id: true, userId: true, machineId: true, revokedAt: true, leaseUntil: true,
      user: { select: { activeEngineMachineId: true, engineLeaseUntil: true } },
    },
  });
  return authorizeEngineDeviceRecord(device, now);
}

export function authorizeEngineDeviceRecord(device: any, now = new Date()) {
  if (!device || device.revokedAt) return null;
  if (!device.leaseUntil || device.leaseUntil <= now) return null;
  if (!device.user?.engineLeaseUntil || device.user.engineLeaseUntil <= now) return null;
  if (device.user.activeEngineMachineId !== device.machineId) return null;
  return { deviceId: device.id, userId: device.userId, machineId: device.machineId };
}
