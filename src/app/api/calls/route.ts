import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import type { CallOutcome, LeadStatus } from "@prisma/client";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const outcome = searchParams.get("outcome");
  const status = searchParams.get("status");

  const where: Record<string, unknown> = { userId: user.id };
  const rangeFilter: { gte?: Date; lte?: Date } = {};
  if (from) { const d = new Date(from); if (!Number.isNaN(d.getTime())) rangeFilter.gte = d; }
  if (to) { const d = new Date(to); if (!Number.isNaN(d.getTime())) rangeFilter.lte = new Date(d.getTime() + 86399999); }
  if (rangeFilter.gte || rangeFilter.lte) where.timestamp = rangeFilter;
  if (outcome && outcome !== "ALL") where.outcome = outcome as CallOutcome;
  if (status && status !== "ALL") where.resultStatus = status as LeadStatus;

  const calls = await prisma.call.findMany({
    where,
    orderBy: { timestamp: "desc" },
    take: 500,
    include: { lead: true },
  });

  const rangeWhere: Record<string, unknown> = { userId: user.id };
  if (from || to) rangeWhere.timestamp = rangeFilter;

  const totalCalls = await prisma.call.count({ where: rangeWhere });
  const connected = await prisma.call.count({
    where: { ...rangeWhere, outcome: "CONNECTED" },
  });
  const [interested, converted, failedAttempts] = await Promise.all([
    prisma.call.count({ where: { ...rangeWhere, resultStatus: "INTERESTED" } }),
    prisma.call.count({ where: { ...rangeWhere, resultStatus: "CONVERTED" } }),
    prisma.call.count({
      where: {
        ...rangeWhere,
        outcome: { in: ["NO_ANSWER", "BUSY", "UNREACHABLE", "FAILED"] },
      },
    }),
  ]);

  const connectionRate = totalCalls ? (connected / totalCalls) * 100 : 0;
  const interestRate = totalCalls ? (interested / totalCalls) * 100 : 0;
  const conversionRate = totalCalls ? (converted / totalCalls) * 100 : 0;

  return NextResponse.json({
    calls,
    report: {
      totalCalls,
      connected,
      interested,
      converted,
      failedAttempts,
      connectionRate: Number(connectionRate.toFixed(1)),
      interestRate: Number(interestRate.toFixed(1)),
      conversionRate: Number(conversionRate.toFixed(1)),
    },
  });
}
