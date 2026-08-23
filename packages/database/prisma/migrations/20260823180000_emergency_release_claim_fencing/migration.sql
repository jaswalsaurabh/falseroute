-- AlterTable
ALTER TABLE "emergency_release_records"
ADD COLUMN "claim_owner" VARCHAR(128),
ADD COLUMN "claim_expires_at" TIMESTAMP(3),
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX "emergency_release_records_status_claim_expires_at_idx"
ON "emergency_release_records"("status", "claim_expires_at");

-- AddConstraint
ALTER TABLE "emergency_release_records"
ADD CONSTRAINT "chk_emergency_release_version" CHECK ("version" >= 1);
