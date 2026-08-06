-- CreateTable
CREATE TABLE "cad_history_entries" (
    "id" SERIAL NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeKey" TEXT,
    "action" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "restoredAt" TIMESTAMP(3),
    "restoredBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "cad_history_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cad_history_entries_scope_scopeKey_createdAt_idx" ON "cad_history_entries"("scope", "scopeKey", "createdAt");
