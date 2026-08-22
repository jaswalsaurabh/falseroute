-- CreateTable
CREATE TABLE "simulated_deception_effects" (
    "id" UUID NOT NULL,
    "decision_id" UUID NOT NULL,
    "correlation_id" VARCHAR(64) NOT NULL,
    "effect_kind" VARCHAR(64) NOT NULL,
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

-- AddForeignKey
ALTER TABLE "simulated_deception_effects" ADD CONSTRAINT "simulated_deception_effects_decision_id_fkey" FOREIGN KEY ("decision_id") REFERENCES "deception_decisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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

