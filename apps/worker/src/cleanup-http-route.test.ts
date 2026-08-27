import { describe, expect, it, vi } from 'vitest';
import {
  type ActivityEventRepository,
  type AutonomousWorkflowRepository,
  type DatabaseClient,
} from '@false-route/database';
import { type Logger, type TelemetryHandle } from '@false-route/observability';
import { type LeaseCleanupService } from './cleanup/lease-cleanup.js';
import {
  type OidcTokenVerifier,
  type PubSubPushHandler,
} from './integrations/pubsub-push-handler.js';
import { startWorker } from './lifecycle.js';
import { type WorkerRepository } from './persistence/worker-repository.js';

describe('scheduled cleanup HTTP route', () => {
  it('sweeps only for the configured cleanup identity and audience', async () => {
    const audience = 'https://staging.example.com/worker';
    const cleanupIdentity = 'cleanup@example-project.iam.gserviceaccount.com';
    const verifier = {
      verifyToken: vi.fn().mockResolvedValue({ valid: true, audience, email: cleanupIdentity }),
    } as unknown as OidcTokenVerifier;
    const cleanupService = {
      sweepExpiredLeases: vi.fn().mockResolvedValue({ status: 'COMPLETED', totalCleaned: 0 }),
    } as unknown as LeaseCleanupService;
    const repository = {
      claimNextPendingEvent: vi.fn().mockResolvedValue(null),
      checkHealth: vi.fn().mockResolvedValue(true),
    } as unknown as WorkerRepository;
    const instance = await startWorker({
      env: {
        PORT: '0',
        DATABASE_URL:
          'postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public',
        NODE_ENV: 'test',
        AUTONOMOUS_PUSH_MODE: 'OIDC',
        PUBSUB_PROJECT_ID: 'example-project',
        PUBSUB_OIDC_AUDIENCE: audience,
        PUBSUB_OIDC_SERVICE_ACCOUNT: 'push@example-project.iam.gserviceaccount.com',
        CLEANUP_OIDC_SERVICE_ACCOUNT: cleanupIdentity,
        OIDC_VERIFICATION_TIMEOUT_MS: '100',
      },
      db: { $disconnect: vi.fn().mockResolvedValue(undefined) } as unknown as DatabaseClient,
      repository,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as unknown as Logger,
      telemetry: {
        init: vi.fn(),
        shutdown: vi.fn().mockResolvedValue(undefined),
      } as unknown as TelemetryHandle,
      oidcTokenVerifier: verifier,
      pushHandler: { handlePushRequest: vi.fn() } as unknown as PubSubPushHandler,
      leaseCleanupService: cleanupService,
      autonomousWorkflowRepository: {} as AutonomousWorkflowRepository,
      activityEventRepository: {} as ActivityEventRepository,
      registerSignalHandlers: false,
    });
    const address = instance.healthServer?.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      vi.mocked(cleanupService.sweepExpiredLeases).mockClear();
      const accepted = await fetch(`http://127.0.0.1:${port}/cleanup/leases`, {
        method: 'POST',
        headers: { Authorization: 'Bearer not-a-real-cleanup-token' },
      });
      expect(accepted.status).toBe(200);
      expect(cleanupService.sweepExpiredLeases).toHaveBeenCalledTimes(1);

      vi.mocked(cleanupService.sweepExpiredLeases).mockClear();
      vi.mocked(verifier.verifyToken).mockResolvedValueOnce({
        valid: true,
        audience,
        email: 'push@example-project.iam.gserviceaccount.com',
      });
      const rejected = await fetch(`http://127.0.0.1:${port}/cleanup/leases`, {
        method: 'POST',
        headers: { Authorization: 'Bearer not-a-real-push-token' },
      });
      expect(rejected.status).toBe(401);
      expect(cleanupService.sweepExpiredLeases).not.toHaveBeenCalled();
      expect((await fetch(`http://127.0.0.1:${port}/cleanup/leases`)).status).toBe(405);

      vi.mocked(verifier.verifyToken).mockResolvedValueOnce({
        valid: true,
        audience,
        email: cleanupIdentity,
      });
      vi.mocked(cleanupService.sweepExpiredLeases).mockRejectedValueOnce(
        new Error('database unavailable'),
      );
      const unavailable = await fetch(`http://127.0.0.1:${port}/cleanup/leases`, {
        method: 'POST',
        headers: { Authorization: 'Bearer not-a-real-cleanup-token' },
      });
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toMatchObject({ error: 'CLEANUP_UNAVAILABLE' });

      vi.mocked(verifier.verifyToken).mockResolvedValueOnce({
        valid: true,
        audience,
        email: cleanupIdentity,
      });
      vi.mocked(cleanupService.sweepExpiredLeases).mockResolvedValueOnce({
        sweepOwnerToken: 'sweep-skipped',
        status: 'SKIPPED',
        cleanedDecoys: 0,
        cleanedRoutes: 0,
        cleanedQuarantines: 0,
        discoveredOrphans: 0,
        totalCleaned: 0,
        failures: [],
      });
      const skipped = await fetch(`http://127.0.0.1:${port}/cleanup/leases`, {
        method: 'POST',
        headers: { Authorization: 'Bearer not-a-real-cleanup-token' },
      });
      expect(skipped.status).toBe(503);

      vi.mocked(verifier.verifyToken).mockImplementationOnce(() => new Promise(() => {}));
      const timedOut = await fetch(`http://127.0.0.1:${port}/cleanup/leases`, {
        method: 'POST',
        headers: { Authorization: 'Bearer not-a-real-cleanup-token' },
      });
      expect(timedOut.status).toBe(503);
      expect(await timedOut.json()).toMatchObject({ error: 'OIDC_UNAVAILABLE' });
    } finally {
      await instance.stop('test-cleanup');
    }
  });
});
