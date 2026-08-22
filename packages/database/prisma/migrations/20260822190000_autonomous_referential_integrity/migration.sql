-- Complete autonomous persistence integrity before this migration family is released.

CREATE TABLE "dead_letter_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "original_message_id" VARCHAR(128) NOT NULL,
    "original_event_id" UUID,
    "failure_reason" VARCHAR(512) NOT NULL,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "replay_status" VARCHAR(32) NOT NULL DEFAULT 'AVAILABLE',
    "quarantined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dead_letter_records_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "dead_letter_records_original_message_id_key" ON "dead_letter_records"("original_message_id");
CREATE INDEX "dead_letter_records_original_message_id_idx" ON "dead_letter_records"("original_message_id");
CREATE INDEX "dead_letter_records_original_event_id_idx" ON "dead_letter_records"("original_event_id");
CREATE INDEX "dead_letter_records_replay_status_idx" ON "dead_letter_records"("replay_status");

ALTER TABLE "provider_intent_records" ADD COLUMN "event_id" UUID NOT NULL;
ALTER TABLE "provider_intent_records" ADD COLUMN "claim_owner" VARCHAR(128);
ALTER TABLE "provider_intent_records" ADD COLUMN "claim_token" UUID;
ALTER TABLE "provider_intent_records" ADD COLUMN "claim_expires_at" TIMESTAMP(3);
ALTER TABLE "provider_intent_records" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
CREATE INDEX "provider_intent_records_event_id_idx" ON "provider_intent_records"("event_id");
ALTER TABLE "tool_operation_ledger" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "decoy_deployment_leases" ADD COLUMN "ownership_key" VARCHAR(256) NOT NULL;
ALTER TABLE "decoy_deployment_leases" ADD COLUMN "owner_id" VARCHAR(128) NOT NULL;
ALTER TABLE "decoy_deployment_leases" ADD COLUMN "fencing_token" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "decoy_deployment_leases" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX "decoy_deployment_leases_ownership_key_key" ON "decoy_deployment_leases"("ownership_key");
ALTER TABLE "false_route_leases" ADD COLUMN "ownership_key" VARCHAR(256) NOT NULL;
ALTER TABLE "false_route_leases" ADD COLUMN "owner_id" VARCHAR(128) NOT NULL;
ALTER TABLE "false_route_leases" ADD COLUMN "fencing_token" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "false_route_leases" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX "false_route_leases_ownership_key_key" ON "false_route_leases"("ownership_key");
ALTER TABLE "quarantine_leases" ADD COLUMN "ownership_key" VARCHAR(256) NOT NULL;
ALTER TABLE "quarantine_leases" ADD COLUMN "owner_id" VARCHAR(128) NOT NULL;
ALTER TABLE "quarantine_leases" ADD COLUMN "fencing_token" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "quarantine_leases" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX "quarantine_leases_ownership_key_key" ON "quarantine_leases"("ownership_key");

ALTER TABLE "replay_attempts" ADD COLUMN "dead_letter_id" UUID NOT NULL;
ALTER TABLE "replay_attempts" ALTER COLUMN "new_transport_id" DROP NOT NULL;
ALTER TABLE "replay_attempts" ADD COLUMN "status" VARCHAR(32) NOT NULL DEFAULT 'CLAIMED';
ALTER TABLE "replay_attempts" ADD COLUMN "failure_reason" VARCHAR(512);
ALTER TABLE "replay_attempts" RENAME COLUMN "replayed_at" TO "claimed_at";
ALTER TABLE "replay_attempts" ADD COLUMN "completed_at" TIMESTAMP(3);
CREATE UNIQUE INDEX "replay_attempts_dead_letter_id_status_key" ON "replay_attempts"("dead_letter_id", "status");
CREATE INDEX "replay_attempts_dead_letter_id_idx" ON "replay_attempts"("dead_letter_id");

ALTER TABLE "ingestion_receipts" ADD CONSTRAINT "ingestion_receipts_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "intrusion_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "intrusion_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "replay_attempts" ADD CONSTRAINT "replay_attempts_dead_letter_id_fkey" FOREIGN KEY ("dead_letter_id") REFERENCES "dead_letter_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "replay_attempts" ADD CONSTRAINT "replay_attempts_original_event_id_fkey" FOREIGN KEY ("original_event_id") REFERENCES "intrusion_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tool_operation_ledger" ADD CONSTRAINT "tool_operation_ledger_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "intrusion_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "activity_event_records" ADD CONSTRAINT "activity_event_records_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "intrusion_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "decoy_deployment_leases" ADD CONSTRAINT "decoy_deployment_leases_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "intrusion_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "false_route_leases" ADD CONSTRAINT "false_route_leases_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "intrusion_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quarantine_leases" ADD CONSTRAINT "quarantine_leases_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "intrusion_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provider_intent_records" ADD CONSTRAINT "provider_intent_records_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "intrusion_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dead_letter_records" ADD CONSTRAINT "dead_letter_records_original_event_id_fkey" FOREIGN KEY ("original_event_id") REFERENCES "intrusion_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
