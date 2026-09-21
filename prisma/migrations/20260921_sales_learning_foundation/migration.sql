-- Add strategy assignment anchors
ALTER TABLE "CallCampaign" ADD COLUMN "strategyId" TEXT;
ALTER TABLE "CallCampaign" ADD COLUMN "experimentId" TEXT;

CREATE TABLE "ProductKnowledge" (
 "id" TEXT NOT NULL PRIMARY KEY,"userId" TEXT NOT NULL,"version" INTEGER NOT NULL,
 "productName" TEXT NOT NULL,"factsJson" TEXT NOT NULL,"source" TEXT NOT NULL DEFAULT 'customer-config',
 "active" BOOLEAN NOT NULL DEFAULT true,"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ProductKnowledge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ProductKnowledge_userId_version_key" ON "ProductKnowledge"("userId","version");
CREATE INDEX "ProductKnowledge_userId_active_idx" ON "ProductKnowledge"("userId","active");

CREATE TABLE "SalesStrategy" (
 "id" TEXT NOT NULL PRIMARY KEY,"userId" TEXT NOT NULL,"version" INTEGER NOT NULL,"name" TEXT NOT NULL,
 "objective" TEXT NOT NULL,"strategyJson" TEXT NOT NULL,"knowledgeVersion" INTEGER NOT NULL,
 "active" BOOLEAN NOT NULL DEFAULT true,"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "SalesStrategy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SalesStrategy_userId_version_key" ON "SalesStrategy"("userId","version");
CREATE INDEX "SalesStrategy_userId_active_idx" ON "SalesStrategy"("userId","active");

CREATE TABLE "SalesExperiment" (
 "id" TEXT NOT NULL PRIMARY KEY,"userId" TEXT NOT NULL,"strategyId" TEXT NOT NULL,"name" TEXT NOT NULL,
 "variantJson" TEXT NOT NULL,"status" TEXT NOT NULL DEFAULT 'ACTIVE',"startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,"endedAt" DATETIME,
 CONSTRAINT "SalesExperiment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "SalesExperiment_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "SalesStrategy" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SalesExperiment_userId_status_idx" ON "SalesExperiment"("userId","status");
CREATE INDEX "SalesExperiment_strategyId_idx" ON "SalesExperiment"("strategyId");

CREATE TABLE "CallAttribution" (
 "id" TEXT NOT NULL PRIMARY KEY,"userId" TEXT NOT NULL,"callId" TEXT NOT NULL,"strategyId" TEXT NOT NULL,"experimentId" TEXT,
 "outcome" TEXT NOT NULL,"score" REAL,"evidenceJson" TEXT,"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "CallAttribution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "CallAttribution_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "CallAttribution_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "SalesStrategy" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "CallAttribution_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "SalesExperiment" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CallAttribution_callId_key" ON "CallAttribution"("callId");
CREATE INDEX "CallAttribution_userId_createdAt_idx" ON "CallAttribution"("userId","createdAt");
CREATE INDEX "CallAttribution_strategyId_idx" ON "CallAttribution"("strategyId");
CREATE INDEX "CallAttribution_experimentId_idx" ON "CallAttribution"("experimentId");

CREATE INDEX "CallCampaign_strategyId_idx" ON "CallCampaign"("strategyId");
CREATE INDEX "CallCampaign_experimentId_idx" ON "CallCampaign"("experimentId");
