-- AlterTable
ALTER TABLE "intrusion_events" ADD COLUMN     "processing_attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "processing_claim_token" UUID,
ADD COLUMN     "processing_lease_expires_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "intrusion_events_status_processing_lease_expires_at_idx" ON "intrusion_events"("status", "processing_lease_expires_at");
