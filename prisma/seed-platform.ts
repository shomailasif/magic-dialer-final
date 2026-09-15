const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  await prisma.platformSetting.upsert({
    where: { id: "platform" },
    create: {
      id: "platform",
      // SMTP (ProtonMail)
      smtpHost: "smtp.protonmail.ch",
      smtpPort: "465",
      smtpSecure: "true",
      smtpUser: "autodial.ai@proton.me",
      smtpPass: "Inza@123",
      smtpFrom: "AutoDial AI <autodial.ai@proton.me>",
      // RingCentral SIP
      rcSipUsername: "14807166685",
      rcSipPassword: "TOdYS",
      rcSipAuthId: "805626843019",
      rcSipDomain: "sip.ringcentral.com",
      rcSipProxy: "sip40.ringcentral.com",
      rcSipPort: "5096",
      rcCallerId: "14807166685",
      // RingCentral API
      rcClientId: "2c28dvx7cnueCB1vQ3Lg90",
      rcClientSecret: "Yi8Wt2U3K94dokmUaPAcyq8EkjUvbF4rHfit0JMWkTHE",
      rcJwt: "eyJraWQiOiI4NzYyZjU5OGQwNTk0NGRiODZiZjVjYTk3ODA0NzYwOCIsInR5cCI6IkpXVCIsImFsZyI6IlJTMjU2In0.eyJhdWQiOiJodHRwczovL3BsYXRmb3JtLnJpbmdjZW50cmFsLmNvbS9yZXN0YXBpL29hdXRoL3Rva2VuIiwic3ViIjoiNzQ5NjgwMDE4IiwiaXNzIjoiaHR0cHM6Ly9wbGF0Zm9ybS5yaW5nY2VudHJhbC5jb20iLCJleHAiOjM5MzYzNzA3NDksImlhdCI6MTc4ODg4NzEwMiwianRpIjoiUG9ZN1M3OW9SR2ltQml6ZXRTSHNfQSJ9.ZfejuA9n5zgWb99W3L5kJ3J8LvHyCkbIski4zlvuWHFtmj_R-6dwnuKnSKW1LwJzwXXUorf7GdFhQyaC6Wzxw32y7Xt6FOT8h_m1iBE14qLnkG-L4eY6scjwFxOIXoh4r9On8wBnv7CHintDxmMHeUfuI1kdOiYApOgQppvZPor9UXPwnPUC5d-ZCllZ25u0VgDfE56H-4gMi836DrVXRQVshp6o7wi3zmI3UwTamM1nlN_Aptj2R35B0q35gqtPdmIGE6EfiowCVxhvf0ZlxI-z6phWmAcnJjLEdxAhkm3tguoSpViQLvgSGaVP0MMORBBdhPJo-FJH5qgykeHo2A",
      // Onboarding
      onboardingEmail: "onboarding@zazlogistics.com",
      // Notes
      notes: "All credentials saved 2026-09-15. Recovery PDF at C:\\Users\\USER\\Downloads\\proton-recovery-phrase.pdf",
    },
    update: {
      smtpHost: "smtp.protonmail.ch",
      smtpPort: "465",
      smtpSecure: "true",
      smtpUser: "autodial.ai@proton.me",
      smtpPass: "Inza@123",
      smtpFrom: "AutoDial AI <autodial.ai@proton.me>",
      rcSipUsername: "14807166685",
      rcSipPassword: "TOdYS",
      rcSipAuthId: "805626843019",
      rcSipDomain: "sip.ringcentral.com",
      rcSipProxy: "sip40.ringcentral.com",
      rcSipPort: "5096",
      rcCallerId: "14807166685",
      rcClientId: "2c28dvx7cnueCB1vQ3Lg90",
      rcClientSecret: "Yi8Wt2U3K94dokmUaPAcyq8EkjUvbF4rHfit0JMWkTHE",
      rcJwt: "eyJraWQiOiI4NzYyZjU5OGQwNTk0NGRiODZiZjVjYTk3ODA0NzYwOCIsInR5cCI6IkpXVCIsImFsZyI6IlJTMjU2In0.eyJhdWQiOiJodHRwczovL3BsYXRmb3JtLnJpbmdjZW50cmFsLmNvbS9yZXN0YXBpL29hdXRoL3Rva2VuIiwic3ViIjoiNzQ5NjgwMDE4IiwiaXNzIjoiaHR0cHM6Ly9wbGF0Zm9ybS5yaW5nY2VudHJhbC5jb20iLCJleHAiOjM5MzYzNzA3NDksImlhdCI6MTc4ODg4NzEwMiwianRpIjoiUG9ZN1M3OW9SR2ltQml6ZXRTSHNfQSJ9.ZfejuA9n5zgWb99W3L5kJ3J8LvHyCkbIski4zlvuWHFtmj_R-6dwnuKnSKW1LwJzwXXUorf7GdFhQyaC6Wzxw32y7Xt6FOT8h_m1iBE14qLnkG-L4eY6scjwFxOIXoh4r9On8wBnv7CHintDxmMHeUfuI1kdOiYApOgQppvZPor9UXPwnPUC5d-ZCllZ25u0VgDfE56H-4gMi836DrVXRQVshp6o7wi3zmI3UwTamM1nlN_Aptj2R35B0q35gqtPdmIGE6EfiowCVxhvf0ZlxI-z6phWmAcnJjLEdxAhkm3tguoSpViQLvgSGaVP0MMORBBdhPJo-FJH5qgykeHo2A",
      onboardingEmail: "onboarding@zazlogistics.com",
      notes: "All credentials saved 2026-09-15. Recovery PDF at C:\\Users\\USER\\Downloads\\proton-recovery-phrase.pdf",
    },
  });
  console.log("Platform settings saved.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
