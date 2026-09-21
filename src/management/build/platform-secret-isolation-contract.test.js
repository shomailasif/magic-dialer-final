"use strict";
const fs=require("fs"),path=require("path"),assert=require("assert");
const root=path.join(__dirname,"../.."),seed=fs.readFileSync(path.join(root,"../prisma/seed-platform.ts"),"utf8"),schema=fs.readFileSync(path.join(root,"../prisma/schema.prisma"),"utf8");
const active=["app/api/heartbeat/route.ts","app/api/dialer/route.ts","app/api/dialer/test/route.ts","lib/orchestration.ts","lib/notifications.ts"].map(p=>fs.readFileSync(path.join(root,p),"utf8")).join("\n");
const checks=[
["platform row seed only",seed.includes('where: { id: "platform" }')],["seed create empty",seed.includes('create: { id: "platform" }')],
["seed update empty",seed.includes("update: {}")],["seed no smtp password",!seed.includes("smtpPass:")],["seed no SIP password",!seed.includes("rcSipPassword:")],
["seed no JWT",!seed.includes("rcJwt:")],["seed no client secret",!seed.includes("rcClientSecret:")],["seed no env secret copy",!seed.includes("process.env")],
["active campaign no platformSetting read",!active.includes("platformSetting.")&&!active.includes("platformSetting.find")],["active path no smtpPass field",!active.includes("smtpPass")],
["active path no rcJwt field",!active.includes("rcJwt")],["active path no rcClientSecret field",!active.includes("rcClientSecret")],
["active path no rcSipPassword platform field",!active.includes("rcSipPassword")],["dialer config crypto boundary active",active.includes("decryptSecret")],
["heartbeat credential migration active",active.includes("isEncryptedSecret")&&active.includes("encryptSecret")],["schema legacy fields acknowledged",schema.includes("model PlatformSetting")],
["no platform secret writer in known active paths",!active.includes("platformSetting.update")&&!active.includes("platformSetting.upsert")],["no platform secret response",!active.includes("platformSettings")],
["production env remains external",seed.includes("deployment environment")],["startup non-mutating",seed.includes("never overwrite existing production values")]];
for(const [n,v] of checks)assert.ok(v,n);console.log("platform secret isolation contract: "+checks.length+"/"+checks.length+" checks PASS");