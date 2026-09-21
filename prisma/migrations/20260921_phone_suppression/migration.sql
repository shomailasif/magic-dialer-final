CREATE TABLE "PhoneSuppression" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "normalizedPhone" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PhoneSuppression_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PhoneSuppression_userId_normalizedPhone_key" ON "PhoneSuppression"("userId","normalizedPhone");
CREATE INDEX "PhoneSuppression_userId_createdAt_idx" ON "PhoneSuppression"("userId","createdAt");
