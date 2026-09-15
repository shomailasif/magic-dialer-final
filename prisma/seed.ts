import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/password";

const prisma = new PrismaClient();

const ZAZ_LOGISTICS = {
  companyName: "Zaz Logistics",
  product: "Dispatch Services for trucks",
  leadFields: ["NAME", "COMPANY NAME", "MC/DOT NUMBER", "TRUCK TYPE", "TRUCK SIZE", "WHEN AND WHERE IS THE PERSON GETTING EMPTY"],
  pitch:
    "Hello, this is {NAME} from Zaz Logistics. We provide dispatch services for truckers across the USA and Canada. We help owner operators and small carriers find high-paying loads, handle all the paperwork, and keep your trucks running empty miles less. Our service is fast, reliable, and we work with all types of trucks.",
  tone: "CONSULTATIVE" as const,
  callbackNumber: "6234001991",
  callbackIn: "30 minutes",
  voipProvider: "ringcentral",
  callerId: "14807166685",
};

const AI_NAMES = ["Sophie", "Mia", "Lily"];

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

  // --- 3 Zaz Logistics AI callers (owned by Admin 1) ---
  for (let i = 0; i < AI_NAMES.length; i++) {
    const aiName = AI_NAMES[i];
    const email = `zaz${i + 1}@autodial.ai`;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      console.log(`AI caller ${aiName} already exists.`);
      continue;
    }

    const ph = await hashPassword(`Zaz${aiName}2026!`);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: ph,
        name: aiName,
        companyName: ZAZ_LOGISTICS.companyName,
        role: "BUSINESS_ADMIN",
        createdByAdminId: admin1.id,
      },
    });

    await prisma.subscription.create({
      data: {
        userId: user.id,
        plan: "PRO",
        status: "ACTIVE",
        startedAt: new Date(),
      },
    });

    const personalizedPitch = ZAZ_LOGISTICS.pitch.replace("{NAME}", aiName);

    await prisma.aIAgentConfig.create({
      data: {
        userId: user.id,
        productName: ZAZ_LOGISTICS.product,
        productDesc: "Professional dispatch services for truckers. We find high-paying loads, handle paperwork, and reduce empty miles for owner operators and small carriers across the USA and Canada.",
        valueProps: "High-paying loads, reduced empty miles, paperwork handled, 24/7 support, USA & Canada coverage",
        pricing: "Percentage-based commission on loads",
        targetAudience: "Owner operators, small carriers, truck drivers in USA and Canada",
        pitch: personalizedPitch,
        tone: ZAZ_LOGISTICS.tone,
        objectionHandling: "Not interested\nToo expensive\nAlready have a dispatcher\nCall me later\nI do my own loads",
        followUpAttempts: 2,
        followUpIntervalHours: 24,
      },
    });

    await prisma.dialerConfig.create({
      data: {
        userId: user.id,
        provider: "RINGCENTRAL",
        outboundNumber: "+1" + ZAZ_LOGISTICS.callerId,
        validated: true,
      },
    });

    console.log(`AI caller ${aiName} created: ${email} / Zaz${aiName}2026!`);
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
