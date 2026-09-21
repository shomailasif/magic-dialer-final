"use strict";
const fs=require("fs"),path=require("path"),assert=require("assert");
const root=path.join(__dirname,"../../..");
const pkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
const b=fs.readFileSync(path.join(root,"scripts/production-db-bootstrap.cjs"),"utf8");
const robots=fs.readFileSync(path.join(root,"src/app/robots.ts"),"utf8");
const fkMigration=fs.readFileSync(path.join(root,"prisma/migrations/20260922_callcampaign_strategy_fks/migration.sql"),"utf8");
const checks=[
 ["start gates app on db bootstrap",pkg.scripts.start==="node scripts/production-db-bootstrap.cjs && next start"],
 ["normal production path uses migrate deploy",b.includes('["migrate", "deploy"]')],
 ["migration status verified",b.includes('["migrate", "status"]')],
 ["legacy detection requires no migration history",b.includes('!name.startsWith("sqlite_")')&&b.includes('tables.has("_prisma_migrations")')],
 ["legacy reconciliation avoids db push",!b.includes('["db", "push"')],
 ["no accept data loss",!b.includes("--accept-data-loss")],
 ["allow list add column",b.includes("ALTER\\s+TABLE")&&b.includes("ADD\\s+COLUMN")],
 ["allow list create table",b.includes("CREATE\\s+TABLE")],
 ["allow list create index",b.includes("UNIQUE\\s+)?INDEX")],
 ["unknown migration fails closed",b.includes("non-additive or unsupported migration statement")],
 ["live schema diff verification",b.includes('"migrate", "diff"')&&b.includes('"--exit-code"')],
 ["sqlite integrity verified",b.includes("PRAGMA integrity_check")],
 ["foreign key integrity verified",b.includes("PRAGMA foreign_key_check")],
 ["rebuild is exact named migration",b.includes('20260922_callcampaign_strategy_fks')],
 ["rebuild copies CallCampaign data before drop",fkMigration.indexOf('INSERT INTO "new_CallCampaign"')<fkMigration.indexOf('DROP TABLE "CallCampaign"')],
 ["rebuild restores CallCampaign name",fkMigration.includes('ALTER TABLE "new_CallCampaign" RENAME TO "CallCampaign"')],
 ["rebuild adds strategy FK",fkMigration.includes('"strategyId") REFERENCES "SalesStrategy"')],
 ["rebuild adds experiment FK",fkMigration.includes('"experimentId") REFERENCES "SalesExperiment"')],
 ["no force reset",!b.includes("--force-reset")&&!b.includes("migrate reset")],
 ["all checked in migrations enumerated",b.includes("readdirSync(migrationRoot")&&b.includes('migration.sql')],
 ["migration adoption sorted",b.includes(".sort()")],
 ["history adoption uses resolve applied",b.includes('"resolve", "--applied"')],
 ["post adoption migrate deploy",b.lastIndexOf('["migrate", "deploy"]')>b.indexOf('"resolve", "--applied"')],
 ["missing prisma fails closed",b.includes("Prisma CLI is unavailable")&&b.includes("throw new Error")],
 ["command failure fails closed",b.includes("!allowedStatuses.includes(result.status)")&&b.includes("throw new Error")],
 ["app start impossible after bootstrap failure",b.includes("process.exit(1)")],
 ["fresh db supported",b.includes("appTables.length === 0")],
 ["tracked db supported",b.includes("hasHistory || appTables.length === 0")],
 ["legacy path one time",b.includes("Legacy untracked database detected")],
 ["database url not logged",!b.match(/console\.(?:log|error)[^\n]*databaseUrl/i)],
 ["robots metadata route exists",robots.includes("MetadataRoute.Robots")],
 ["robots allows public root",robots.includes('allow: "/"')],
 ["robots blocks admin crawl",robots.includes('"/admin/"')],
 ["robots blocks api crawl",robots.includes('"/api/"')],
 ["robots is not locale import",!robots.includes("next-intl")&&!robots.includes("messages/")],
 ["bootstrap has no destructive SQL",!b.match(/DROP TABLE|DELETE FROM|TRUNCATE/i)]
];
for(const [name,ok] of checks) assert.ok(ok,name);
console.log("production deployment recovery contract: "+checks.length+"/"+checks.length+" checks PASS");
