-- AlterTable
ALTER TABLE "budget_reservation_records" ADD COLUMN "gemini_attempt_outcome" VARCHAR(32);

-- AddConstraint
ALTER TABLE "budget_reservation_records" ADD CONSTRAINT "chk_budget_gemini_attempt_outcome" CHECK ("gemini_attempt_outcome" IS NULL OR "gemini_attempt_outcome" IN ('DISPATCHED', 'PRE_CALL_FAILED'));
