import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSharedRcEmail } from "@/lib/constants";
import crypto from "crypto";

export const dynamic = "force-dynamic";

function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const h = crypto.scryptSync(password, s, 64).toString("hex");
  return { hash: h, salt: s };
}

export async function GET() {
  return POST();
}

export async function POST() {
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "PortalAdmin" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "email" TEXT NOT NULL,
        "passwordHash" TEXT NOT NULL,
        "passwordSalt" TEXT NOT NULL,
        "displayName" TEXT NOT NULL DEFAULT '',
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "PortalAdmin_email_key" ON "PortalAdmin"("email")`);

    // Idempotently add voipShared column if it doesn't exist
    try {
      const cols: any[] = await prisma.$queryRawUnsafe(`SELECT name FROM pragma_table_info('DialerConfig') WHERE name = 'voipShared'`);
      if (!cols.length) {
        await prisma.$executeRawUnsafe(`ALTER TABLE "DialerConfig" ADD COLUMN "voipShared" INTEGER NOT NULL DEFAULT 0`);
      }
    } catch {}

    const admins = [
      { email: "admin1@autodial.ai", password: "Admin1Pass!", name: "Admin 1" },
      { email: "admin2@autodial.ai", password: "Admin2Pass!", name: "Admin 2" },
    ];
    for (const a of admins) {
      const existing: any[] = await prisma.$queryRawUnsafe(`SELECT id FROM "PortalAdmin" WHERE email = ? LIMIT 1`, a.email);
      if (existing.length === 0) {
        const { hash, salt } = hashPassword(a.password);
        await prisma.$executeRawUnsafe(`INSERT INTO "PortalAdmin" ("id", "email", "passwordHash", "passwordSalt", "displayName") VALUES (?, ?, ?, ?, ?)`, crypto.randomUUID(), a.email, hash, salt, a.name);
      }
    }

    const existingSetting: any[] = await prisma.$queryRawUnsafe(`SELECT id FROM "PlatformSetting" WHERE id = 'platform' LIMIT 1`);
    if (existingSetting.length === 0) {
      await prisma.$executeRawUnsafe(`INSERT INTO "PlatformSetting" ("id","rcSipUsername","rcSipPassword","rcSipAuthId","rcSipDomain","rcSipProxy","rcSipPort","rcCallerId") VALUES ('platform',?,?,?,?,?,?,?)`,
        process.env.RC_SIP_USERNAME || "14807166685",
        process.env.RC_SIP_PASSWORD || "TOdYS",
        process.env.RC_SIP_AUTH_ID || "805626843019",
        process.env.RC_SIP_DOMAIN || "sip.ringcentral.com",
        process.env.RC_SIP_PROXY || "sip40.ringcentral.com",
        process.env.RC_SIP_PORT || "5096",
        process.env.RC_CALLER_ID || "14807164508"
      );
    }

    const firstAdmin: any[] = await prisma.$queryRawUnsafe(`SELECT id FROM "PortalAdmin" ORDER BY "createdAt" ASC LIMIT 1`);
    if (firstAdmin.length > 0) {
      const aid = firstAdmin[0].id;
      await prisma.$executeRawUnsafe(`UPDATE "User" SET "createdByAdminId" = ? WHERE ("createdByAdminId" IS NULL OR "createdByAdminId" = '') AND "role" = 'BUSINESS_ADMIN'`, aid);
    }

    const allCustomers: any[] = await prisma.$queryRawUnsafe(`SELECT u."id", u."email" FROM "User" u JOIN "Subscription" s ON s."userId" = u."id" WHERE u."role" = 'BUSINESS_ADMIN'`);
    await prisma.$executeRawUnsafe(`UPDATE "Subscription" SET "status" = 'ACTIVE', "startedAt" = datetime('now') WHERE "status" != 'ACTIVE'`);
    const settings: any[] = await prisma.$queryRawUnsafe(`SELECT "rcSipUsername","rcSipPassword","rcSipAuthId","rcSipDomain","rcSipProxy","rcSipPort","rcCallerId" FROM "PlatformSetting" WHERE id = 'platform' LIMIT 1`);
    const s = settings[0];
    for (const c of allCustomers) {
      const shared = isSharedRcEmail(c.email);
      await prisma.$executeRawUnsafe(`UPDATE "DialerConfig" SET "voipShared" = ? WHERE "userId" = ?`, shared ? 1 : 0, c.id).catch(() => {});
      if (!shared || !s || !s.rcSipUsername || !s.rcSipPassword) continue;
      await prisma.$executeRawUnsafe(`
        INSERT INTO "DialerConfig" ("id","userId","provider","sipUsername","sipPassword","sipAuthId","sipDomain","sipProxy","sipPort","outboundNumber","validated","updatedAt")
        SELECT ?, ?, 'RINGCENTRAL', ?, ?, ?, ?, ?, ?, ?, 1, datetime('now')
        WHERE NOT EXISTS (SELECT 1 FROM "DialerConfig" WHERE "userId" = ?)
      `, crypto.randomUUID(), c.id, s.rcSipUsername, s.rcSipPassword, s.rcSipAuthId || s.rcSipUsername, s.rcSipDomain || 'sip.ringcentral.com', s.rcSipProxy || 'sip40.ringcentral.com', s.rcSipPort || '5096', s.rcCallerId || s.rcSipUsername, c.id).catch(() => {});
      await prisma.$executeRawUnsafe(`UPDATE "DialerConfig" SET "sipUsername" = ?, "sipPassword" = ?, "sipAuthId" = ?, "sipDomain" = ?, "sipProxy" = ?, "sipPort" = ?, "outboundNumber" = ?, "validated" = 1, "provider" = 'RINGCENTRAL' WHERE "userId" = ?`, s.rcSipUsername, s.rcSipPassword, s.rcSipAuthId || s.rcSipUsername, s.rcSipDomain || 'sip.ringcentral.com', s.rcSipProxy || 'sip40.ringcentral.com', s.rcSipPort || '5096', s.rcCallerId || s.rcSipUsername, c.id).catch(() => {});
    }

    return NextResponse.json({ ok: true, message: "Database initialized with admin accounts, RC credentials, and all customers activated" });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Init failed" }, { status: 500 });
  }
}
