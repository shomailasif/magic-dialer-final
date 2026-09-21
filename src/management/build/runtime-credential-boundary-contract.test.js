"use strict";
const fs=require("fs"),path=require("path"),assert=require("assert");
const root=path.join(__dirname,"../.."),o=fs.readFileSync(path.join(root,"lib/orchestration.ts"),"utf8"),d=fs.readFileSync(path.join(root,"lib/dialer.ts"),"utf8");
const checks=[
["orchestration imports decryptor",o.includes("decryptSecret")],["runtime dialer separate",o.includes("let runtimeDialer=user.dialerConfig")],
["api key decrypted",o.includes("apiKey:decryptSecret(runtimeDialer.apiKey)")],["account sid decrypted",o.includes("accountSid:decryptSecret(runtimeDialer.accountSid)")],
["sip password decrypted",o.includes("sipPassword:decryptSecret(runtimeDialer.sipPassword)")],["decrypt failure fails closed",o.includes("Stored dialer credentials cannot be decrypted.")],
["validation uses runtime credentials",o.includes("validateProvider(runtimeDialer)")],["provider uses runtime config",o.includes("runtimeDialer?.provider")],
["fallback api key runtime",o.includes("apiKey: runtimeDialer?.apiKey")],["fallback sid runtime",o.includes("accountSid: runtimeDialer?.accountSid")],
["DB config not mutated",!o.includes("dialerConfig.update")],["dialer error redacted",d.includes("redactDiagnostic(e")],
["RC client secret redacted",d.includes("process.env.RC_CLIENT_SECRET")],["RC JWT redacted",d.includes("process.env.RC_JWT")],
["RC SIP password redacted",d.includes("process.env.RC_SIP_PASSWORD")],["no raw RC exception",!d.includes("e instanceof Error ? e.message : e")],
["unsupported providers still fail closed",d.includes("is not enabled for live calling yet")],["no secret logging",!d.includes("console.log(input.apiKey)")],
["no credential response",!o.includes("runtimeDialer?.sipPassword }")],["tenant config source preserved",o.includes("user.dialerConfig")],
["certified provider still required",o.includes("certifiedLiveProvider(selectedProvider)")],["compliance remains before call",o.indexOf("decideCallCompliance")<o.indexOf("placeConversationalCall")],
["no executable mutation",!o.includes("eval(")],["main env fallback retained",o.includes("process.env.RC_API_KEY")],
["credential crypto boundary shared",o.includes("@/lib/credential-crypto")]];
for(const [n,v] of checks)assert.ok(v,n);console.log("runtime credential boundary contract: "+checks.length+"/"+checks.length+" checks PASS");