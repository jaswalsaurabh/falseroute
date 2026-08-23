-- CreateEnum
CREATE TYPE "BudgetCategory" AS ENUM ('DAILY_USD', 'DAILY_GEMINI_TOKENS', 'HOURLY_TOOL_OPERATIONS');

-- CreateEnum
CREATE TYPE "BudgetReservationStatus" AS ENUM ('RESERVED', 'CONSUMED', 'RELEASED', 'EXPIRED', 'RECONCILED');

-- AlterTable
ALTER TABLE "decoy_deployment_leases" ADD COLUMN "cleanup_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "last_failure_reason" VARCHAR(512);

-- AlterTable
ALTER TABLE "false_route_leases" ADD COLUMN "cleanup_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "last_failure_reason" VARCHAR(512);

-- AlterTable
ALTER TABLE "quarantine_leases" ADD COLUMN "cleanup_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "last_failure_reason" VARCHAR(512);

-- CreateTable
CREATE TABLE "budget_reservation_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "idempotency_key" VARCHAR(128) NOT NULL,
    "category" "BudgetCategory" NOT NULL,
    "window_key" VARCHAR(64) NOT NULL,
    "amount_reserved" DECIMAL(12,4) NOT NULL,
    "amount_consumed" DECIMAL(12,4),
    "status" "BudgetReservationStatus" NOT NULL,
    "owner_id" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "reconciled_at" TIMESTAMP(3),
    "event_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_reservation_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_budget_amount_reserved" CHECK ("amount_reserved" > 0),
    CONSTRAINT "chk_budget_amount_consumed" CHECK ("amount_consumed" IS NULL OR ("amount_consumed" >= 0 AND "amount_consumed" <= "amount_reserved")),
    CONSTRAINT "chk_budget_version" CHECK ("version" >= 1)
);

-- CreateTable
CREATE TABLE "emergency_release_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "idempotency_key" VARCHAR(128) NOT NULL,
    "principal_id" VARCHAR(128) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "correlation_id" VARCHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "requested_count" INTEGER NOT NULL,
    "verified_count" INTEGER NOT NULL DEFAULT 0,
    "pending_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "emergency_release_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cleanup_sweep_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sweep_owner_token" VARCHAR(128) NOT NULL,
    "fencing_token" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(32) NOT NULL,
    "cleaned_decoys" INTEGER NOT NULL DEFAULT 0,
    "cleaned_routes" INTEGER NOT NULL DEFAULT 0,
    "cleaned_quarantines" INTEGER NOT NULL DEFAULT 0,
    "discovered_orphans" INTEGER NOT NULL DEFAULT 0,
    "failures" JSONB,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "cleanup_sweep_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "budget_reservation_records_idempotency_key_key" ON "budget_reservation_records"("idempotency_key");

-- CreateIndex
CREATE INDEX "budget_reservation_records_category_window_key_status_idx" ON "budget_reservation_records"("category", "window_key", "status");

-- CreateIndex
CREATE INDEX "budget_reservation_records_status_expires_at_idx" ON "budget_reservation_records"("status", "expires_at");

-- CreateIndex
CREATE INDEX "budget_reservation_records_event_id_idx" ON "budget_reservation_records"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "emergency_release_records_idempotency_key_key" ON "emergency_release_records"("idempotency_key");

-- CreateIndex
CREATE INDEX "emergency_release_records_idempotency_key_idx" ON "emergency_release_records"("idempotency_key");

-- CreateIndex
CREATE INDEX "emergency_release_records_principal_id_idx" ON "emergency_release_records"("principal_id");

-- CreateIndex
CREATE INDEX "emergency_release_records_created_at_idx" ON "emergency_release_records"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "cleanup_sweep_records_sweep_owner_token_key" ON "cleanup_sweep_records"("sweep_owner_token");

-- CreateIndex
CREATE INDEX "cleanup_sweep_records_status_expires_at_idx" ON "cleanup_sweep_records"("status", "expires_at");

-- AddForeignKey
ALTER TABLE "budget_reservation_records" ADD CONSTRAINT "budget_reservation_records_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "intrusion_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
