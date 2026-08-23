import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { type ApiConfig } from './config/api-config.js';
import {
  type AutonomousWorkflowRepository,
  type ActivityEventRepository,
} from '@false-route/database';
import { type Logger } from '@false-route/observability';
import { type DatabaseClient } from '@false-route/database';
import { EmergencyReleaseService } from './services/emergency-release-service.js';

/** Observable simulated inventory: the service may only report a release it can verify. */
class ObservableFakeInventory {
  private readonly items = new Set<string>();
  public mutations = 0;

  add(key: string): void {
    this.items.add(key);
  }
  has(key: string): boolean {
    return this.items.has(key);
  }
  async hasActiveRoute(sourceIp: string): Promise<boolean> {
    return this.items.has(sourceIp);
  }
  async hasActiveQuarantine(sourceCidr: string): Promise<boolean> {
    return this.items.has(sourceCidr);
  }
  async revokeRoute(sourceIp: string): Promise<{ revoked: boolean; status: 'SIMULATED' }> {
    this.mutations++;
    return { revoked: this.items.delete(sourceIp), status: 'SIMULATED' };
  }
  async releaseQuarantine(sourceCidr: string): Promise<{ released: boolean; status: 'SIMULATED' }> {
    this.mutations++;
    return { released: this.items.delete(sourceCidr), status: 'SIMULATED' };
  }
}

describe('Emergency Release Endpoint', () => {
  const baseConfig: ApiConfig = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PORT: 3000,
    OPERATOR_ACCESS_TOKEN: 'not-a-real-operator-token-for-test-32char',
    OPERATOR_REPLAY_TOKEN: 'not-a-real-replay-token-for-test-32char',
    CORS_ORIGINS: 'http://localhost:5173',
    EVENT_PUBLISHER_MODE: 'MEMORY',
    DATABASE_URL: 'postgresql://not-a-real-user:not-a-real-pass@127.0.0.1:5432/test',
    ENABLE_TELEMETRY: false,
    TRUST_PROXY_HOPS: 0,
  };

  const mockLogger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;

  let mockWorkflowRepo: AutonomousWorkflowRepository;
  let mockActivityRepo: ActivityEventRepository;
  let fakeInventory: ObservableFakeInventory;

  beforeEach(() => {
    fakeInventory = new ObservableFakeInventory();
    fakeInventory.add('198.51.100.25');
    fakeInventory.add('198.51.100.25/32');

    mockWorkflowRepo = {
      claimEmergencyRelease: vi.fn().mockResolvedValue({
        isDuplicate: false,
        record: {
          id: '33333333-3333-4333-8333-333333333333',
          idempotencyKey: 'em-rel-test-key-01',
          principalId: 'operator-principal',
          reason: 'Operator requested emergency rollback of active demonstration',
          status: 'PENDING',
          correlationId: 'corr-em-01',
          requestedCount: 3,
          verifiedCount: 0,
          pendingCount: 1,
          failedCount: 0,
          details: {},
          createdAt: new Date('2026-08-23T10:00:00.000Z'),
          updatedAt: new Date('2026-08-23T10:00:00.000Z'),
          completedAt: null,
        },
        claimedRoutes: [
          {
            id: 'route-1',
            eventId: '11111111-1111-4111-8111-111111111111',
            sourceIp: '198.51.100.25',
            fencingToken: 2,
          },
        ],
        claimedQuarantines: [
          {
            id: 'q-1',
            eventId: '22222222-2222-4222-8222-222222222222',
            sourceCidr: '198.51.100.25/32',
            fencingToken: 2,
          },
        ],
        claimedDecoys: [
          {
            id: 'decoy-1',
            eventId: '11111111-1111-4111-8111-111111111111',
            fencingToken: 2,
          },
        ],
        emergencyOwnerToken: 'emergency-em-rel-test-key-01',
      }),
      markEmergencyRouteReleased: vi.fn().mockResolvedValue({ count: 1 }),
      markEmergencyQuarantineReleased: vi.fn().mockResolvedValue({ count: 1 }),
      completeEmergencyReleaseRecord: vi.fn().mockResolvedValue({
        id: '33333333-3333-4333-8333-333333333333',
        status: 'COMPLETED',
      }),
      settleEmergencyReleaseRecord: vi.fn().mockResolvedValue({
        id: '33333333-3333-4333-8333-333333333333',
        status: 'COMPLETED',
        requestedCount: 3,
        verifiedCount: 2,
        pendingCount: 1,
        failedCount: 0,
        derivedCounts: {
          requestedCount: 3,
          verifiedCount: 2,
          pendingCount: 1,
          failedCount: 0,
          pendingSettlementCount: 0,
        },
      }),
    } as unknown as AutonomousWorkflowRepository;

    mockActivityRepo = {
      recordActivityEvent: vi.fn().mockResolvedValue({ cursor: 1 }),
    } as unknown as ActivityEventRepository;
  });

  function createTestApp() {
    return createApp({
      config: baseConfig,
      db: {} as DatabaseClient,
      logger: mockLogger,
      workflowRepo: mockWorkflowRepo,
      activityRepo: mockActivityRepo,
      emergencyReleaseService: new EmergencyReleaseService(mockWorkflowRepo, mockActivityRepo, {
        falseRouteAdapter: fakeInventory,
        cloudArmorAdapter: fakeInventory,
      }),
    });
  }

  it('successfully triggers emergency release for authenticated operator', async () => {
    const app = createTestApp();

    const response = await request(app)
      .post('/api/v1/operator/emergency-release')
      .set('Authorization', `Bearer ${baseConfig.OPERATOR_ACCESS_TOKEN}`)
      .send({
        idempotencyKey: 'em-rel-test-key-01',
        reason: 'Operator requested emergency rollback of active demonstration',
        confirmed: true,
        requestedBy: 'operator-test',
      });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('RECORDED');
    expect(response.body.containmentMode).toBe('SIMULATED');
    expect(response.body.releasedCount).toEqual({
      falseRoutes: 1,
      quarantines: 1,
      decoys: 0,
    });
    expect(response.body.verifiedCount).toBe(2);
    expect(response.body.pendingCount).toBe(1);
    expect(response.body.message).toContain('Emergency release recorded (SIMULATED mode)');

    expect(mockWorkflowRepo.claimEmergencyRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'em-rel-test-key-01',
        reason: 'Operator requested emergency rollback of active demonstration',
      }),
    );

    expect(mockActivityRepo.recordActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'EMERGENCY_RELEASE_TRIGGERED',
        provenance: 'OPERATOR',
        stage: 'COMPLETED',
      }),
    );
  });

  it('also supports the /api/v1/emergency-release alias', async () => {
    const app = createTestApp();

    const response = await request(app)
      .post('/api/v1/emergency-release')
      .set('Authorization', `Bearer ${baseConfig.OPERATOR_ACCESS_TOKEN}`)
      .send({
        idempotencyKey: 'em-rel-test-key-alias',
        reason: 'Rollback alias test',
        confirmed: true,
      });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('RECORDED');
  });

  it('rejects unauthenticated requests with 401', async () => {
    const app = createTestApp();

    const response = await request(app).post('/api/v1/operator/emergency-release').send({
      idempotencyKey: 'em-rel-test-unauth',
      reason: 'Unauthenticated test',
      confirmed: true,
    });

    expect(response.status).toBe(401);
  });

  it('rejects requests with missing idempotencyKey with 400', async () => {
    const app = createTestApp();

    const response = await request(app)
      .post('/api/v1/operator/emergency-release')
      .set('Authorization', `Bearer ${baseConfig.OPERATOR_ACCESS_TOKEN}`)
      .send({
        reason: 'Missing idempotency key',
        confirmed: true,
      });

    expect(response.status).toBe(400);
  });

  it('rejects requests with invalid or missing confirmation with 400', async () => {
    const app = createTestApp();

    const response = await request(app)
      .post('/api/v1/operator/emergency-release')
      .set('Authorization', `Bearer ${baseConfig.OPERATOR_ACCESS_TOKEN}`)
      .send({
        idempotencyKey: 'em-rel-test-confirm',
        reason: 'Missing confirmation',
        confirmed: false,
      });

    expect(response.status).toBe(400);
  });

  it('rejects requests with empty reason with 400', async () => {
    const app = createTestApp();

    const response = await request(app)
      .post('/api/v1/operator/emergency-release')
      .set('Authorization', `Bearer ${baseConfig.OPERATOR_ACCESS_TOKEN}`)
      .send({
        idempotencyKey: 'em-rel-test-empty-reason',
        reason: '',
        confirmed: true,
      });

    expect(response.status).toBe(400);
  });

  it('is idempotent on duplicate repeated requests returning prior record', async () => {
    vi.mocked(mockWorkflowRepo.claimEmergencyRelease).mockResolvedValueOnce({
      isDuplicate: true,
      record: {
        id: '33333333-3333-4333-8333-333333333333',
        idempotencyKey: 'em-rel-test-dup',
        principalId: 'operator-principal',
        reason: 'Second release call',
        status: 'COMPLETED',
        correlationId: 'corr-em-dup',
        requestedCount: 0,
        verifiedCount: 0,
        pendingCount: 0,
        failedCount: 0,
        details: {},
        claimOwner: null,
        claimExpiresAt: null,
        version: 1,
        createdAt: new Date('2026-08-23T10:00:00.000Z'),
        updatedAt: new Date('2026-08-23T10:00:00.000Z'),
        completedAt: new Date('2026-08-23T10:00:00.000Z'),
      },
      claimedRoutes: [],
      claimedQuarantines: [],
      claimedDecoys: [],
    });

    const app = createTestApp();

    const response = await request(app)
      .post('/api/v1/operator/emergency-release')
      .set('Authorization', `Bearer ${baseConfig.OPERATOR_ACCESS_TOKEN}`)
      .send({
        idempotencyKey: 'em-rel-test-dup',
        reason: 'Second release call',
        confirmed: true,
      });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('RECORDED');
    expect(response.body.releasedCount).toEqual({
      falseRoutes: 0,
      quarantines: 0,
      decoys: 0,
    });
  });

  it('fails closed with 500 if database state cannot be verified', async () => {
    vi.mocked(mockWorkflowRepo.claimEmergencyRelease).mockRejectedValueOnce(
      new Error('Database connectivity failure'),
    );

    const app = createTestApp();

    const response = await request(app)
      .post('/api/v1/operator/emergency-release')
      .set('Authorization', `Bearer ${baseConfig.OPERATOR_ACCESS_TOKEN}`)
      .send({
        idempotencyKey: 'em-rel-test-fail-closed',
        reason: 'Testing persistence failure',
        confirmed: true,
      });

    expect(response.status).toBe(500);
  });

  it('reports a failed route without claiming a release when the durable CAS is lost', async () => {
    vi.mocked(mockWorkflowRepo.markEmergencyRouteReleased).mockResolvedValueOnce({ count: 0 }); // CAS failed
    vi.mocked(mockWorkflowRepo.settleEmergencyReleaseRecord).mockResolvedValueOnce({
      id: '33333333-3333-4333-8333-333333333333',
      status: 'PARTIAL_FAILURE',
      requestedCount: 3,
      verifiedCount: 1,
      pendingCount: 1,
      failedCount: 1,
      derivedCounts: {
        requestedCount: 3,
        verifiedCount: 1,
        pendingCount: 1,
        failedCount: 1,
        pendingSettlementCount: 0,
      },
    } as never);

    const app = createTestApp();

    const response = await request(app)
      .post('/api/v1/operator/emergency-release')
      .set('Authorization', `Bearer ${baseConfig.OPERATOR_ACCESS_TOKEN}`)
      .send({
        idempotencyKey: 'em-rel-test-partial-fail',
        reason: 'Testing partial settlement failure',
        confirmed: true,
      });

    expect(response.status).toBe(200);
    expect(response.body.releasedCount).toEqual({ falseRoutes: 0, quarantines: 1, decoys: 0 });
    expect(response.body.verifiedCount).toBe(1);
    expect(response.body.failedCount).toBe(1);
    expect(mockWorkflowRepo.markEmergencyRouteReleased).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });

  it('derives response counters from durable state instead of attempt-local numbers', async () => {
    vi.mocked(mockWorkflowRepo.claimEmergencyRelease).mockResolvedValueOnce({
      isDuplicate: false,
      record: {
        id: '33333333-3333-4333-8333-333333333333',
        idempotencyKey: 'em-rel-test-resume',
        principalId: 'operator-principal',
        reason: 'Resuming incomplete release',
        status: 'PARTIAL_FAILURE',
        correlationId: 'corr-em-resume',
        requestedCount: 2,
        verifiedCount: 1,
        pendingCount: 0,
        failedCount: 1,
        details: {},
        claimOwner: 'emergency-em-rel-test-resume',
        claimExpiresAt: new Date('2026-08-23T10:01:00.000Z'),
        version: 2,
        createdAt: new Date('2026-08-23T10:00:00.000Z'),
        updatedAt: new Date('2026-08-23T10:00:00.000Z'),
        completedAt: null,
      },
      claimedRoutes: [
        {
          id: 'route-retry-1',
          eventId: '11111111-1111-4111-8111-111111111111',
          sourceIp: '198.51.100.25',
          fencingToken: 3,
        },
      ],
      claimedQuarantines: [],
      claimedDecoys: [],
      emergencyOwnerToken: 'emergency-em-rel-test-resume',
    });
    vi.mocked(mockWorkflowRepo.settleEmergencyReleaseRecord).mockResolvedValueOnce({
      id: '33333333-3333-4333-8333-333333333333',
      status: 'COMPLETED',
      requestedCount: 2,
      verifiedCount: 2,
      pendingCount: 0,
      failedCount: 0,
      derivedCounts: {
        requestedCount: 2,
        verifiedCount: 2,
        pendingCount: 0,
        failedCount: 0,
        pendingSettlementCount: 0,
      },
    } as never);

    const app = createTestApp();

    const response = await request(app)
      .post('/api/v1/operator/emergency-release')
      .set('Authorization', `Bearer ${baseConfig.OPERATOR_ACCESS_TOKEN}`)
      .send({
        idempotencyKey: 'em-rel-test-resume',
        reason: 'Resuming incomplete release',
        confirmed: true,
      });

    expect(response.status).toBe(200);
    // Prior attempt's verified lease is preserved; only the newly settled lease is added.
    expect(response.body.requestedCount).toBe(2);
    expect(response.body.verifiedCount).toBe(2);
    expect(response.body.failedCount).toBe(0);
    expect(mockWorkflowRepo.settleEmergencyReleaseRecord).toHaveBeenCalledWith({
      recordId: '33333333-3333-4333-8333-333333333333',
      emergencyOwnerToken: 'emergency-em-rel-test-resume',
    });
    // Attempt-local counters must never be written.
    expect(mockWorkflowRepo.completeEmergencyReleaseRecord).not.toHaveBeenCalled();
  });

  it('fails closed with 500 when durable settlement persistence fails', async () => {
    vi.mocked(mockWorkflowRepo.settleEmergencyReleaseRecord).mockRejectedValueOnce(
      new Error('Database write failure'),
    );

    const app = createTestApp();

    const response = await request(app)
      .post('/api/v1/operator/emergency-release')
      .set('Authorization', `Bearer ${baseConfig.OPERATOR_ACCESS_TOKEN}`)
      .send({
        idempotencyKey: 'em-rel-test-settle-fail',
        reason: 'Testing settlement persistence failure',
        confirmed: true,
      });

    expect(response.status).toBe(500);
  });
});
