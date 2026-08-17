-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "platform" TEXT NOT NULL,
    "connected" BOOLEAN NOT NULL DEFAULT false,
    "accessToken" TEXT,
    "tokenSecret" TEXT,
    "refreshToken" TEXT,
    "tokenExpiry" DATETIME,
    "scopes" TEXT,
    "accountId" TEXT,
    "accountName" TEXT,
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "integrationId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "recordsCount" INTEGER,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "SyncLog_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MetricSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" DATETIME NOT NULL,
    "platform" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "impressions" REAL,
    "clicks" REAL,
    "sessions" REAL,
    "leads" REAL,
    "mqls" REAL,
    "sqos" REAL,
    "opportunities" REAL,
    "closedWon" REAL,
    "spend" REAL,
    "revenue" REAL,
    "pipeline" REAL,
    "activePipeline" REAL,
    "cpc" REAL,
    "cpl" REAL,
    "cpMql" REAL,
    "cpSqo" REAL,
    "paidCac" REAL,
    "mktgCac" REAL,
    "ctr" REAL,
    "leadToMql" REAL,
    "mqlToSqo" REAL,
    "sqoToClose" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PacingTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "period" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "targetMqls" REAL,
    "targetSqos" REAL,
    "targetPipeline" REAL,
    "targetClosedWon" REAL,
    "targetRevenue" REAL,
    "targetSpend" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Integration_platform_key" ON "Integration"("platform");

-- CreateIndex
CREATE INDEX "MetricSnapshot_date_idx" ON "MetricSnapshot"("date");

-- CreateIndex
CREATE INDEX "MetricSnapshot_channel_idx" ON "MetricSnapshot"("channel");

-- CreateIndex
CREATE UNIQUE INDEX "MetricSnapshot_date_platform_channel_key" ON "MetricSnapshot"("date", "platform", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "PacingTarget_period_channel_key" ON "PacingTarget"("period", "channel");
