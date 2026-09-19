const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

/**
 * Ensure the singleton platform-settings row exists.
 * Production credentials must be supplied through the deployment environment
 * or the authenticated admin settings flow. Never commit secrets here and
 * never overwrite existing production values during application startup.
 */
async function main() {
  await prisma.platformSetting.upsert({
    where: { id: "platform" },
    create: { id: "platform" },
    update: {},
  });
  console.log("Platform settings row ready.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
