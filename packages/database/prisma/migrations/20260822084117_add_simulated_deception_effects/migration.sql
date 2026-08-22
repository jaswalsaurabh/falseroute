-- CreateTable
CREATE TABLE "simulated_deception_effects" (
    "id" UUID NOT NULL,
    "decision_id" UUID NOT NULL,
    "correlation_id" VARCHAR(64) NOT NULL,
    "effect_kind" "DeceptionAction" NOT NULL DEFAULT 'ASSIGN_FALSE_ROUTE',
    "status" VARCHAR(32) NOT NULL,
    "containment_mode" "ContainmentMode" NOT NULL,
    "assigned_false_route" VARCHAR(64) NOT NULL,
    "provenance" "ProvenanceClassification" NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL,
    "adapter_version" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "simulated_deception_effects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "simulated_deception_effects_decision_id_key" ON "simulated_deception_effects"("decision_id");

-- CreateIndex
CREATE INDEX "simulated_deception_effects_correlation_id_idx" ON "simulated_deception_effects"("correlation_id");

-- CreateIndex
CREATE INDEX "simulated_deception_effects_recorded_at_idx" ON "simulated_deception_effects"("recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_deception_decisions_integrity" ON "deception_decisions"("id", "action", "correlation_id", "assigned_false_route", "containment_mode");

-- AddForeignKey
ALTER TABLE "simulated_deception_effects" ADD CONSTRAINT "simulated_deception_effects_decision_id_fkey" FOREIGN KEY ("decision_id") REFERENCES "deception_decisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCompositeForeignKey for cross-row decision and effect integrity
ALTER TABLE "simulated_deception_effects" ADD CONSTRAINT "fk_simulated_effects_decision_integrity" FOREIGN KEY ("decision_id", "effect_kind", "correlation_id", "assigned_false_route", "containment_mode") REFERENCES "deception_decisions"("id", "action", "correlation_id", "assigned_false_route", "containment_mode") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraint: Status must be RECORDED
ALTER TABLE "simulated_deception_effects" ADD CONSTRAINT "chk_simulated_effects_status" CHECK (
    "status" = 'RECORDED'
);

-- AddCheckConstraint: Containment mode must be SIMULATED
ALTER TABLE "simulated_deception_effects" ADD CONSTRAINT "chk_simulated_effects_containment_mode" CHECK (
    "containment_mode" = 'SIMULATED'
);

-- AddCheckConstraint: Assigned false route must be mock-admin-decoy
ALTER TABLE "simulated_deception_effects" ADD CONSTRAINT "chk_simulated_effects_false_route" CHECK (
    "assigned_false_route" = 'mock-admin-decoy'
);

-- AddCheckConstraint: Provenance must be DERIVED
ALTER TABLE "simulated_deception_effects" ADD CONSTRAINT "chk_simulated_effects_provenance" CHECK (
    "provenance" = 'DERIVED'
);

-- AddCheckConstraint: Effect kind must be ASSIGN_FALSE_ROUTE
ALTER TABLE "simulated_deception_effects" ADD CONSTRAINT "chk_simulated_effects_kind" CHECK (
    "effect_kind" = 'ASSIGN_FALSE_ROUTE'
);

-- Function & Deferred Constraint Trigger enforcing simulated effect existence for ASSIGN_FALSE_ROUTE decisions
CREATE OR REPLACE FUNCTION check_decision_simulated_effect_exists()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.action = 'ASSIGN_FALSE_ROUTE' THEN
        IF NOT EXISTS (
            SELECT 1 FROM "simulated_deception_effects"
            WHERE "decision_id" = NEW.id
        ) THEN
            RAISE EXCEPTION 'ASSIGN_FALSE_ROUTE decision % requires a corresponding simulated_deception_effects record', NEW.id
            USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "trg_check_decision_simulated_effect"
AFTER INSERT OR UPDATE ON "deception_decisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION check_decision_simulated_effect_exists();
