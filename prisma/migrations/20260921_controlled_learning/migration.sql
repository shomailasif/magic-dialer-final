CREATE TABLE "StrategyLearningEvent" (
 "id" TEXT NOT NULL PRIMARY KEY,"userId" TEXT NOT NULL,"strategyId" TEXT NOT NULL,"outcome" TEXT NOT NULL,
 "reward" REAL NOT NULL,"sampleSize" INTEGER NOT NULL,"action" TEXT NOT NULL DEFAULT 'OBSERVE',"evidenceJson" TEXT,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "StrategyLearningEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "StrategyLearningEvent_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "SalesStrategy" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "StrategyLearningEvent_userId_createdAt_idx" ON "StrategyLearningEvent"("userId","createdAt");
CREATE INDEX "StrategyLearningEvent_strategyId_createdAt_idx" ON "StrategyLearningEvent"("strategyId","createdAt");
