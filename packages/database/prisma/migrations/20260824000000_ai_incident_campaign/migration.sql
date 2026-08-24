CREATE TABLE "campaign_runs" (
  "id" UUID NOT NULL,
  "definition_id" VARCHAR(64) NOT NULL,
  "definition_version" VARCHAR(32) NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "current_step" INTEGER NOT NULL,
  "total_steps" INTEGER NOT NULL,
  "correlation_id" VARCHAR(64) NOT NULL,
  "claim_owner" VARCHAR(128),
  "claim_expires_at" TIMESTAMP(3),
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "failure_reason" VARCHAR(512),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "campaign_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "campaign_step_runs" (
  "id" UUID NOT NULL,
  "campaign_id" UUID NOT NULL,
  "step" INTEGER NOT NULL,
  "scenario_kind" VARCHAR(64) NOT NULL,
  "label" VARCHAR(100) NOT NULL,
  "event_id" UUID NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "claim_owner" VARCHAR(128),
  "claim_expires_at" TIMESTAMP(3),
  "published_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "failure_reason" VARCHAR(512),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "campaign_step_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "campaign_runs_definition_id_key" ON "campaign_runs"("definition_id");
CREATE UNIQUE INDEX "campaign_runs_correlation_id_key" ON "campaign_runs"("correlation_id");
CREATE UNIQUE INDEX "campaign_step_runs_event_id_key" ON "campaign_step_runs"("event_id");
CREATE UNIQUE INDEX "campaign_step_runs_campaign_id_step_key" ON "campaign_step_runs"("campaign_id", "step");
CREATE INDEX "campaign_runs_status_claim_expires_at_idx" ON "campaign_runs"("status", "claim_expires_at");
CREATE INDEX "campaign_step_runs_status_claim_expires_at_idx" ON "campaign_step_runs"("status", "claim_expires_at");

ALTER TABLE "campaign_step_runs" ADD CONSTRAINT "campaign_step_runs_campaign_id_fkey"
  FOREIGN KEY ("campaign_id") REFERENCES "campaign_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_step_runs" ADD CONSTRAINT "campaign_step_runs_event_id_fkey"
  FOREIGN KEY ("event_id") REFERENCES "intrusion_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
