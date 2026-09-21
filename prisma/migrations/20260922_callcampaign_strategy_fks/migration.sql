-- Data-preserving SQLite table rebuild to add the two foreign keys declared by schema.prisma.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_CallCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "callsMade" INTEGER NOT NULL DEFAULT 0,
    "strategyId" TEXT,
    "experimentId" TEXT,
    CONSTRAINT "CallCampaign_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CallCampaign_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "SalesStrategy" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CallCampaign_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "SalesExperiment" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_CallCampaign" ("id","userId","name","status","startedAt","endedAt","callsMade","strategyId","experimentId")
SELECT "id","userId","name","status","startedAt","endedAt","callsMade","strategyId","experimentId" FROM "CallCampaign";

DROP TABLE "CallCampaign";
ALTER TABLE "new_CallCampaign" RENAME TO "CallCampaign";

CREATE INDEX "CallCampaign_userId_idx" ON "CallCampaign"("userId");
CREATE INDEX "CallCampaign_strategyId_idx" ON "CallCampaign"("strategyId");
CREATE INDEX "CallCampaign_experimentId_idx" ON "CallCampaign"("experimentId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
