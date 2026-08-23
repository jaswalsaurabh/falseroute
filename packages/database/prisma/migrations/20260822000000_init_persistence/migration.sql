-- CreateEnum
CREATE TYPE "ProcessingStatus" AS ENUM ('PENDING', 'PROCESSING', 'ENRICHED', 'DECIDED', 'FAILED');

-- CreateEnum
CREATE TYPE "ContainmentMode" AS ENUM ('SIMULATED');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('UNAUTHORIZED_ACCESS_ATTEMPT', 'CREDENTIAL_STUFFING', 'SUSPICIOUS_LOGIN');

-- CreateEnum
CREATE TYPE "DeceptionAction" AS ENUM ('ASSIGN_FALSE_ROUTE', 'ALLOW', 'ALERT_OPERATOR', 'OBSERVE');

-- CreateEnum
CREATE TYPE "ProvenanceClassification" AS ENUM ('OBSERVED', 'INFERRED', 'DERIVED', 'UNAVAILABLE', 'OPERATOR');

-- CreateTable
CREATE TABLE "intrusion_events" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "correlation_id" VARCHAR(64) NOT NULL,
    "source_ip" INET NOT NULL,
    "target_asset" VARCHAR(64) NOT NULL,
    "event_type" "EventType" NOT NULL,
    "failed_login_count" INTEGER NOT NULL,
    "risk_indicators" TEXT[] NOT NULL,
    "containment_mode" "ContainmentMode" NOT NULL,
    "used_decoy_credential" BOOLEAN NOT NULL,
    "decoy_identifier" VARCHAR(64),
    "status" "ProcessingStatus" NOT NULL,
    "provenance" "ProvenanceClassification" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intrusion_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deception_decisions" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "correlation_id" VARCHAR(64) NOT NULL,
    "action" "DeceptionAction" NOT NULL,
    "assigned_false_route" VARCHAR(64),
    "matched_policy" VARCHAR(64) NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "containment_mode" "ContainmentMode" NOT NULL,
    "decision_provenance" "ProvenanceClassification" NOT NULL,
    "decided_at" TIMESTAMP(3) NOT NULL,
    "model_enrichment" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deception_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decision_audit_records" (
    "id" UUID NOT NULL,
    "decision_id" UUID NOT NULL,
    "rule_version" VARCHAR(32) NOT NULL,
    "evaluated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_audit_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "intrusion_events_occurred_at_idx" ON "intrusion_events"("occurred_at");

-- CreateIndex
CREATE INDEX "intrusion_events_status_idx" ON "intrusion_events"("status");

-- CreateIndex
CREATE INDEX "intrusion_events_correlation_id_idx" ON "intrusion_events"("correlation_id");

-- CreateIndex
CREATE UNIQUE INDEX "deception_decisions_event_id_key" ON "deception_decisions"("event_id");

-- CreateIndex
CREATE INDEX "deception_decisions_correlation_id_idx" ON "deception_decisions"("correlation_id");

-- CreateIndex
CREATE INDEX "deception_decisions_decided_at_idx" ON "deception_decisions"("decided_at");

-- CreateIndex
CREATE UNIQUE INDEX "decision_audit_records_decision_id_key" ON "decision_audit_records"("decision_id");

-- AddForeignKey
ALTER TABLE "deception_decisions" ADD CONSTRAINT "deception_decisions_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "intrusion_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_audit_records" ADD CONSTRAINT "decision_audit_records_decision_id_fkey" FOREIGN KEY ("decision_id") REFERENCES "deception_decisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraint: Decoy identifier must be present if and only if decoy credentials were used
ALTER TABLE "intrusion_events" ADD CONSTRAINT "chk_intrusion_events_decoy" CHECK (
    ("used_decoy_credential" = TRUE AND "decoy_identifier" IS NOT NULL) OR
    ("used_decoy_credential" = FALSE AND "decoy_identifier" IS NULL)
);

-- AddCheckConstraint: Failed login count must be non-negative
ALTER TABLE "intrusion_events" ADD CONSTRAINT "chk_intrusion_events_failed_login_count" CHECK (
    "failed_login_count" >= 0
);

-- AddCheckConstraint: Assigned false route must be present if and only if action is ASSIGN_FALSE_ROUTE
ALTER TABLE "deception_decisions" ADD CONSTRAINT "chk_deception_decisions_action_route" CHECK (
    ("action" = 'ASSIGN_FALSE_ROUTE' AND "assigned_false_route" IS NOT NULL) OR
    ("action" != 'ASSIGN_FALSE_ROUTE' AND "assigned_false_route" IS NULL)
);
