import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/password";

const prisma = new PrismaClient();

async function main() {
  // --- Admin 1 ---
  const admin1Email = "admin1@autodial.ai";
  const admin1Exists = await prisma.user.findUnique({ where: { email: admin1Email } });
  let admin1: Awaited<ReturnType<typeof prisma.user.create>>;
  if (!admin1Exists) {
    const ph = await hashPassword("Admin1Pass!");
    admin1 = await prisma.user.create({
      data: {
        email: admin1Email,
        passwordHash: ph,
        name: "Admin One",
        role: "SUPER_ADMIN",
      },
    });
    console.log("Admin 1 created:", admin1Email, "/ Admin1Pass!");
  } else {
    admin1 = admin1Exists;
    console.log("Admin 1 already exists.");
  }

  // --- Admin 2 ---
  const admin2Email = "admin2@autodial.ai";
  const admin2Exists = await prisma.user.findUnique({ where: { email: admin2Email } });
  let admin2: Awaited<ReturnType<typeof prisma.user.create>>;
  if (!admin2Exists) {
    const ph = await hashPassword("Admin2Pass!");
    admin2 = await prisma.user.create({
      data: {
        email: admin2Email,
        passwordHash: ph,
        name: "Admin Two",
        role: "SUPER_ADMIN",
      },
    });
    console.log("Admin 2 created:", admin2Email, "/ Admin2Pass!");
  } else {
    admin2 = admin2Exists;
    console.log("Admin 2 already exists.");
  }

  // --- Demo business admin (owned by Admin 1) ---
  const demoEmail = "demo@company.com";
  let demo = await prisma.user.findUnique({ where: { email: demoEmail } });
  if (!demo) {
    const ph = await hashPassword("DemoPass123!");
    demo = await prisma.user.create({
      data: {
        email: demoEmail,
        passwordHash: ph,
        name: "Demo Business",
        companyName: "Acme Inc.",
        role: "BUSINESS_ADMIN",
        createdByAdminId: admin1.id,
      },
    });

    await prisma.subscription.create({
      data: {
        userId: demo.id,
        plan: "PRO",
        status: "ACTIVE",
        startedAt: new Date(),
      },
    });

    await prisma.aIAgentConfig.create({
      data: {
        userId: demo.id,
        productName: "Cloud CRM Pro",
        productDesc: "An all-in-one customer relationship management suite for growing teams.",
        valueProps: "Faster pipelines, built-in automations, 24/7 support",
        pricing: "$49/user/month",
        targetAudience: "SaaS founders and mid-market retail",
        pitch:
          "I'm calling about Cloud CRM Pro. We help growing teams close deals faster with automated workflows, unified customer data, and reporting that saves hours every week.",
        tone: "CONSULTATIVE",
        objectionHandling: "Not interested\nToo expensive\nAlready have a solution\nCall me later",
        followUpAttempts: 2,
        followUpIntervalHours: 24,
      },
    });

    await prisma.dialerConfig.create({
      data: {
        userId: demo.id,
        provider: "TWILIO",
        apiKey: "SK-demo-token",
        accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        outboundNumber: "+15551234567",
        validated: true,
      },
    });

    const demoLeads = [
      ["Sarah Johnson", "+14155550101", "sarah@northstar.com", "Northstar Industries"],
      ["Mike Chen", "+13105550202", "mike@brightpath.io", "Brightpath"],
      ["Aisha Patel", "+16175550303", "aisha@vertexdyn.com", "Vertex Dynamics"],
      ["Tom Becker", "+12125550404", "tom@harboranalytics.com", "Harbor Analytics"],
      ["Elena Rossi", "+14155550505", "elena@summittech.com", "Summit Tech"],
      ["David Kim", "+16505550606", "david@prairietech.com", "Prairie Tech"],
    ];
    for (const [name, phone, email, company] of demoLeads) {
      await prisma.lead.create({
        data: { userId: demo.id, name, phone, email, company, status: "PENDING" },
      });
    }

    console.log("Demo business created:", demoEmail, "/ DemoPass123!");
  } else {
    console.log("Demo business already exists.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
