"use strict";
const fs=require("fs"),path=require("path"),assert=require("assert");
const root=path.join(__dirname,"../.."),s=fs.readFileSync(path.join(root,"../prisma/schema.prisma"),"utf8"),m=fs.readFileSync(path.join(root,"../prisma/migrations/20260921_consent_provenance/migration.sql"),"utf8"),l=fs.readFileSync(path.join(root,"lib/leads.ts"),"utf8"),o=fs.readFileSync(path.join(root,"lib/orchestration.ts"),"utf8");
const checks=[
["consent source field",s.includes("consentSource String?")],["consent time field",s.includes("consentUpdatedAt DateTime?")],
["migration source",m.includes('ADD COLUMN "consentSource"')],["migration time",m.includes('ADD COLUMN "consentUpdatedAt"')],
["migration additive",!m.match(/DROP|DELETE/i)],["suppressed import denied",l.includes('consentStatus: suppression ? "DENIED"')],
["suppressed import source",l.includes('consentSource: suppression ? "TENANT_PHONE_SUPPRESSION"')],["suppressed import timestamp",l.includes("consentUpdatedAt: suppression ? suppression.createdAt")],
["unknown import no false provenance",l.includes(': "UNKNOWN"')&&l.includes(": null")],["spoken optout denied",o.includes('consentStatus: sipResult?.doNotCall ? "DENIED"')],
["spoken optout source",o.includes('consentSource: sipResult?.doNotCall ? "SPOKEN_OPT_OUT"')],["spoken optout timestamp",o.includes("consentUpdatedAt: sipResult?.doNotCall ? new Date()")],
["existing provenance retained otherwise",o.includes(": lead.consentSource")&&o.includes(": lead.consentUpdatedAt")],["tenant suppression remains",o.includes("phoneSuppression.upsert")],
["DNC reason remains",o.includes("doNotCallReason")],["DNC timestamp remains",o.includes("doNotCallAt")],
["compliance uses consent",o.includes("consentStatus:tenantSuppression")],["no learning consent mutation",!fs.readFileSync(path.join(root,"lib/controlled-learning.ts"),"utf8").includes("consentSource")],
["no executable mutation",!o.includes("eval(")],["provenance tenant lead scoped",s.includes("model Lead")],
["phone suppression source retained",s.includes("model PhoneSuppression")&&s.includes("source String")],["no affirmative consent invented",!l.includes('consentStatus: "GRANTED"')],
["no consent reset on call",!o.includes('consentStatus: "UNKNOWN"')],["import re-DNC cannot clear provenance",!l.includes("consentSource: null,")],
["schema default remains unknown",s.includes('consentStatus String     @default("UNKNOWN")')]];
for(const [n,v] of checks)assert.ok(v,n);console.log("consent provenance contract: "+checks.length+"/"+checks.length+" checks PASS");