-- AlterTable: Add scenario_kind and evidence to intrusion_events
ALTER TABLE "intrusion_events" ADD COLUMN "scenario_kind" VARCHAR(64);
ALTER TABLE "intrusion_events" ADD COLUMN "evidence" JSONB;

-- CreateTable: ingestion_receipts
CREATE TABLE "ingestion_receipts" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "transport_id" VARCHAR(128) NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_receipts_event_id_transport_id_key" ON "ingestion_receipts"("event_id", "transport_id");
CREATE INDEX "ingestion_receipts_transport_id_idx" ON "ingestion_receipts"("transport_id");
CREATE INDEX "ingestion_receipts_received_at_idx" ON "ingestion_receipts"("received_at");

-- CreateTable: delivery_attempts
CREATE TABLE "delivery_attempts" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "transport_id" VARCHAR(128) NOT NULL,
    "worker_id" VARCHAR(128) NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "error_message" VARCHAR(512),
    "attempted_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delivery_attempts_event_id_idx" ON "delivery_attempts"("event_id");
CREATE INDEX "delivery_attempts_transport_id_idx" ON "delivery_attempts"("transport_id");

-- CreateTable: replay_attempts
CREATE TABLE "replay_attempts" (
    "id" UUID NOT NULL,
    "original_event_id" UUID NOT NULL,
    "original_transport_id" VARCHAR(128) NOT NULL,
    "new_transport_id" VARCHAR(128) NOT NULL,
    "requested_by" VARCHAR(128) NOT NULL,
    "rationale" VARCHAR(512) NOT NULL,
    "replayed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "replay_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "replay_attempts_original_event_id_idx" ON "replay_attempts"("original_event_id");

-- CreateTable: tool_operation_ledger
CREATE TABLE "tool_operation_ledger" (
    "id" UUID NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "event_id" UUID NOT NULL,
    "tool_name" VARCHAR(64) NOT NULL,
    "input_hash" VARCHAR(64) NOT NULL,
    "stage" VARCHAR(32) NOT NULL,
    "authorized" BOOLEAN NOT NULL,
    "policy_reason" VARCHAR(500) NOT NULL,
    "provider_resource_id" VARCHAR(256),
    "observed_state" VARCHAR(32),
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tool_operation_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tool_operation_ledger_idempotency_key_key" ON "tool_operation_ledger"("idempotency_key");
CREATE INDEX "tool_operation_ledger_event_id_idx" ON "tool_operation_ledger"("event_id");

-- CreateTable: activity_event_records
CREATE TABLE "activity_event_records" (
    "cursor" SERIAL NOT NULL,
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "correlation_id" VARCHAR(64) NOT NULL,
    "stage" VARCHAR(32) NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "summary" VARCHAR(500) NOT NULL,
    "provenance" "ProvenanceClassification" NOT NULL,
    "payload" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_event_records_pkey" PRIMARY KEY ("cursor")
);

-- CreateIndex
CREATE INDEX "activity_event_records_event_id_idx" ON "activity_event_records"("event_id");
CREATE INDEX "activity_event_records_correlation_id_idx" ON "activity_event_records"("correlation_id");
CREATE INDEX "activity_event_records_occurred_at_idx" ON "activity_event_records"("occurred_at");

-- CreateTable: decoy_deployment_leases
CREATE TABLE "decoy_deployment_leases" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "template_name" VARCHAR(64) NOT NULL,
    "image_digest" VARCHAR(128) NOT NULL,
    "desired_state" VARCHAR(32) NOT NULL,
    "observed_state" VARCHAR(32) NOT NULL,
    "service_url" VARCHAR(256),
    "health_status" VARCHAR(32) NOT NULL,
    "lease_status" VARCHAR(32) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "cleaned_up_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "decoy_deployment_leases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "decoy_deployment_leases_event_id_idx" ON "decoy_deployment_leases"("event_id");
CREATE INDEX "decoy_deployment_leases_lease_status_expires_at_idx" ON "decoy_deployment_leases"("lease_status", "expires_at");

-- CreateTable: false_route_leases
CREATE TABLE "false_route_leases" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "source_ip" INET NOT NULL,
    "assigned_route" VARCHAR(128) NOT NULL,
    "desired_state" VARCHAR(32) NOT NULL,
    "observed_state" VARCHAR(32) NOT NULL,
    "lease_status" VARCHAR(32) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "false_route_leases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "false_route_leases_event_id_idx" ON "false_route_leases"("event_id");
CREATE INDEX "false_route_leases_source_ip_idx" ON "false_route_leases"("source_ip");
CREATE INDEX "false_route_leases_lease_status_expires_at_idx" ON "false_route_leases"("lease_status", "expires_at");

-- CreateTable: quarantine_leases
CREATE TABLE "quarantine_leases" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "source_cidr" VARCHAR(64) NOT NULL,
    "policy_name" VARCHAR(64) NOT NULL,
    "rule_priority" INTEGER NOT NULL,
    "desired_state" VARCHAR(32) NOT NULL,
    "observed_state" VARCHAR(32) NOT NULL,
    "lease_status" VARCHAR(32) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quarantine_leases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quarantine_leases_event_id_idx" ON "quarantine_leases"("event_id");
CREATE INDEX "quarantine_leases_source_cidr_idx" ON "quarantine_leases"("source_cidr");
CREATE INDEX "quarantine_leases_lease_status_expires_at_idx" ON "quarantine_leases"("lease_status", "expires_at");

-- CreateTable: provider_intent_records
CREATE TABLE "provider_intent_records" (
    "id" UUID NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "operation_type" VARCHAR(64) NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "payload" JSONB,
    "result" JSONB,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_intent_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "provider_intent_records_idempotency_key_key" ON "provider_intent_records"("idempotency_key");
