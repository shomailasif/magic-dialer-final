ALTER TABLE "StrategyLearningEvent" ADD COLUMN "sourceCallId" TEXT;
CREATE UNIQUE INDEX "StrategyLearningEvent_sourceCallId_key" ON "StrategyLearningEvent"("sourceCallId");
