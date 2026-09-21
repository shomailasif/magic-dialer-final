"use strict";
const fs=require("fs"),path=require("path"),assert=require("assert");
const root=path.join(__dirname,"../.."),s=fs.readFileSync(path.join(root,"../prisma/schema.prisma"),"utf8"),m=fs.readFileSync(path.join(root,"../prisma/migrations/20260921_phone_suppression/migration.sql"),"utf8"),cc=fs.readFileSync(path.join(root,"lib/call-compliance.ts"),"utf8"),l=fs.readFileSync(path.join(root,"lib/leads.ts"),"utf8"),o=fs.readFileSync(path.join(root,"lib/orchestration.ts"),"utf8");
const checks=[
["suppression model",s.includes("model PhoneSuppression")],["tenant relation",s.includes("phoneSuppressions PhoneSuppression[]")],
["tenant phone unique",s.includes("@@unique([userId, normalizedPhone])")],["migration table",m.includes('CREATE TABLE "PhoneSuppression"')],
["migration unique",m.includes("PhoneSuppression_userId_normalizedPhone_key")],["migration additive",!m.match(/DROP|DELETE/i)],
["pure normalizer",cc.includes('replace(/\\D/g,"")')],["import uses normalizer",l.includes("normalizePhoneForSuppression(r.phone)")],
["import checks suppression",l.includes("prisma.phoneSuppression.findUnique")],["import inherits DNC",l.includes("doNotCall: !!suppression")],
["import inherits denied consent",l.includes('consentStatus: suppression ? "DENIED"')],["import reason explicit",l.includes("TENANT_PHONE_SUPPRESSION")],
["pre-dial normalized",o.includes("normalizePhoneForSuppression(lead.phone)")],["pre-dial suppression lookup",o.includes("prisma.phoneSuppression.findUnique")],
["pre-dial DNC combines row and tenant",o.includes("lead.doNotCall||!!tenantSuppression")],["tenant suppression denies consent",o.includes('tenantSuppression?"DENIED"')],
["spoken DNC persists tenant suppression",o.includes("prisma.phoneSuppression.upsert")],["suppression source live call",o.includes('source:"LIVE_CALL"')],
["suppression reason optout",o.includes('reason:"SPOKEN_OPT_OUT"')],["suppression atomic transaction",o.indexOf("txWrites.push(prisma.phoneSuppression.upsert")<o.indexOf("prisma.$transaction(txWrites)")],
["call still atomic",o.includes("const storedCall=txResult[1]")],["compliance before telephony",o.indexOf("tenantSuppression")<o.indexOf("placeConversationalCall")],
["no learning mutation",!fs.readFileSync(path.join(root,"lib/controlled-learning.ts"),"utf8").includes("phoneSuppression")],["no executable mutation",!cc.includes("eval(")],
["phone not stored in suppression raw",s.includes("normalizedPhone String")&&!s.includes("rawPhone")],["reimport not allowed to erase DNC",!l.includes("doNotCall: false")],
["suppression tenant scoped import",l.includes("userId_normalizedPhone:{userId,normalizedPhone}")],["suppression tenant scoped dial",o.includes("userId_normalizedPhone:{userId,normalizedPhone}")],
["empty phone normalization safe",cc.includes('String(phone||"")')],["lead row DNC retained",s.includes("doNotCall     Boolean")]];
for(const [n,v] of checks)assert.ok(v,n);console.log("tenant phone suppression contract: "+checks.length+"/"+checks.length+" checks PASS");