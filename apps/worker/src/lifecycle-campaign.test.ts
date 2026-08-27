import { describe, expect, it, vi } from 'vitest';
import {
  type ActivityEventRepository,
  type AutonomousWorkflowRepository,
  type CampaignRepository,
  type DatabaseClient,
} from '@false-route/database';
import { type Logger, type TelemetryHandle } from '@false-route/observability';
import { startWorker } from './lifecycle.js';

function getPort(instance: Awaited<ReturnType<typeof startWorker>>): number {
  const addr = instance.healthServer?.address();
  return typeof addr === 'object' && addr !== null ? addr.port : 0;
}

const baseEnv = {
  PORT: '0',
  DATABASE_URL: 'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
  NODE_ENV: 'test',
};

const campaignPayload = {
  message: {
    data: Buffer.from(
      JSON.stringify({
        eventId: '11111111-1111-4111-8111-111111111111',
        correlationId: 'corr-no-key-test',
        schemaVersion: '1.0.0',
        source: 'OPERATOR',
        scenarioKind: 'ENV_FILE_PROBE',
        occurredAt: '2026-08-22T10:00:00.000Z',
        publishedAt: '2026-08-22T10:00:01.000Z',
        sourceIp: '198.51.100.25',
        evidence: {
          scenarioKind: 'ENV_FILE_PROBE',
          requestedPath: '/.env',
          httpMethod: 'GET',
          userAgent: 'not-a-real-scanner/1.0',
          sourceIp: '198.51.100.25',
          matchedString: '.env',
          isPositiveMatch: true,
        },
        provenance: 'OBSERVED',
      }),
    ).toString('base64'),
    messageId: 'msg-campaign-1',
    publishTime: '2026-08-22T10:00:01.000Z',
  },
  subscription: 'projects/test/subscriptions/test-sub',
};

function createDb(): DatabaseClient {
  return { $disconnect: vi.fn().mockResolvedValue(undefined) } as unknown as DatabaseClient;
}

function createRepo() {
  return {
    claimNextPendingEvent: vi.fn().mockResolvedValue(null),
    checkHealth: vi.fn().mockResolvedValue(true),
    persistDecision: vi.fn().mockResolvedValue(undefined),
    releaseOrFailClaim: vi.fn().mockResolvedValue('REQUEUED'),
  };
}

function createLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function createTelemetry(): TelemetryHandle {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as TelemetryHandle;
}

describe('campaign lifecycle wiring', () => {
  it('wires campaign orchestration into live OIDC push mode', async () => {
    const campaignRepository = {
      ensureInitialStep: vi.fn().mockResolvedValue(true),
      completeAndPrepareNext: vi.fn().mockResolvedValue({
        disposition: 'ADVANCED',
        publication: {
          campaignId: '22222222-2222-4222-8222-222222222222',
          eventId: '33333333-3333-4333-8333-333333333333',
          correlationId: 'corr-oidc-campaign',
          step: 2,
          scenarioKind: 'PATH_TRAVERSAL_PROBE',
          label: 'Path traversal probe',
          sourceIp: '192.0.2.10',
          evidence: {
            scenarioKind: 'PATH_TRAVERSAL_PROBE',
            requestedPath: '/../../etc/passwd',
            httpMethod: 'GET',
            userAgent: 'FalseRoute-campaign/1.0.0',
            sourceIp: '192.0.2.10',
            isPositiveMatch: true,
          },
          occurredAt: new Date('2026-08-22T10:00:02.000Z'),
        },
      }),
      markPublished: vi.fn().mockResolvedValue(true),
      failCampaign: vi.fn(),
    } as unknown as CampaignRepository;
    const campaignPublisher = {
      publish: vi.fn().mockResolvedValue({ transportId: 'campaign-step-2' }),
    };
    const instance = await startWorker({
      env: {
        ...baseEnv,
        AUTONOMOUS_PUSH_MODE: 'OIDC',
        PUBSUB_PROJECT_ID: 'example-project',
        PUBSUB_OIDC_AUDIENCE: 'https://worker.example.com/pubsub/push',
        PUBSUB_OIDC_SERVICE_ACCOUNT: 'pubsub@example-project.iam.gserviceaccount.com',
        CLEANUP_OIDC_SERVICE_ACCOUNT: 'cleanup@example-project.iam.gserviceaccount.com',
      },
      db: createDb(),
      repository: createRepo() as never,
      logger: createLogger(),
      telemetry: createTelemetry(),
      registerSignalHandlers: false,
      autonomousOrchestrator: {
        processEventEnvelope: vi.fn().mockResolvedValue({ status: 'COMPLETED' }),
      } as never,
      campaignRepository,
      campaignPublisher,
      autonomousWorkflowRepository: {
        recordIngestionReceipt: vi.fn().mockResolvedValue({ isDuplicate: false, receipt: {} }),
        recordDeadLetter: vi.fn().mockResolvedValue(undefined),
      } as unknown as AutonomousWorkflowRepository,
      activityEventRepository: {
        recordActivityEvent: vi.fn().mockResolvedValue({ cursor: 1 }),
      } as unknown as ActivityEventRepository,
      oidcTokenVerifier: {
        verifyToken: vi.fn().mockResolvedValue({
          valid: true,
          email: 'pubsub@example-project.iam.gserviceaccount.com',
          audience: 'https://worker.example.com/pubsub/push',
        }),
      },
    });

    try {
      const response = await fetch(`http://127.0.0.1:${getPort(instance)}/pubsub/push`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer not-a-real-oidc-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(campaignPayload),
      });
      expect(response.status).toBe(200);
      expect(campaignRepository.ensureInitialStep).toHaveBeenCalledOnce();
      expect(campaignRepository.completeAndPrepareNext).toHaveBeenCalledOnce();
      expect(campaignPublisher.publish).toHaveBeenCalledOnce();
    } finally {
      await instance.stop('test-cleanup');
    }
  });
});
