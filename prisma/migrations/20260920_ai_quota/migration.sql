-- CreateTable
CREATE TABLE "AIQuotaBucket" ("id" TEXT NOT NULL PRIMARY KEY,"scopeKey" TEXT NOT NULL,"windowStart" DATETIME NOT NULL,"requestCount" INTEGER NOT NULL DEFAULT 0,"units" INTEGER NOT NULL DEFAULT 0,"updatedAt" DATETIME NOT NULL);
-- CreateIndex
CREATE UNIQUE INDEX "AIQuotaBucket_scopeKey_windowStart_key" ON "AIQuotaBucket"("scopeKey","windowStart");
-- CreateIndex
CREATE INDEX "AIQuotaBucket_windowStart_idx" ON "AIQuotaBucket"("windowStart");
