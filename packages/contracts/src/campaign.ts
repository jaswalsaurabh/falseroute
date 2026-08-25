import { z } from 'zod';
import { CorrelationIdSchema, IsoDateTimeSchema, UuidSchema } from './primitives.js';
import { ScenarioKindSchema } from './scenario.js';

export const CampaignDefinitionIdSchema = z.enum(['INITIAL_AUTONOMOUS_CAMPAIGN']);
export type CampaignDefinitionId = z.infer<typeof CampaignDefinitionIdSchema>;

export const CampaignStatusSchema = z.enum([
  'READY',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CLEANED_UP',
]);
export type CampaignStatus = z.infer<typeof CampaignStatusSchema>;

export const CampaignStepSchema = z
  .object({
    step: z.number().int().min(1).max(10),
    scenarioKind: ScenarioKindSchema,
    label: z.string().min(1).max(100),
  })
  .strict();
export type CampaignStep = z.infer<typeof CampaignStepSchema>;

export const CampaignRunSchema = z
  .object({
    campaignId: UuidSchema,
    definitionId: CampaignDefinitionIdSchema,
    definitionVersion: z.string().min(1).max(32),
    status: CampaignStatusSchema,
    currentStep: z.number().int().min(0).max(10),
    totalSteps: z.number().int().min(1).max(10),
    correlationId: CorrelationIdSchema,
    startedAt: IsoDateTimeSchema.optional(),
    completedAt: IsoDateTimeSchema.optional(),
  })
  .strict()
  .superRefine((run, refinement) => {
    if (run.currentStep > run.totalSteps) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['currentStep'],
        message: 'currentStep cannot exceed totalSteps',
      });
    }
    if (run.status === 'READY' && run.startedAt !== undefined) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['startedAt'],
        message: 'READY campaigns cannot have startedAt',
      });
    }
    if (run.status === 'COMPLETED' && run.currentStep !== run.totalSteps) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['currentStep'],
        message: 'COMPLETED campaigns must be at their final step',
      });
    }
  });
export type CampaignRun = z.infer<typeof CampaignRunSchema>;

export const INITIAL_CAMPAIGN_STEPS: readonly CampaignStep[] = [
  { step: 1, scenarioKind: 'ENV_FILE_PROBE', label: 'Environment file probe' },
  { step: 2, scenarioKind: 'PATH_TRAVERSAL_PROBE', label: 'Path traversal probe' },
  { step: 3, scenarioKind: 'SQL_INJECTION_PROBE', label: 'SQL injection probe' },
  { step: 4, scenarioKind: 'DECOY_CREDENTIAL_USE', label: 'Decoy credential use' },
];
