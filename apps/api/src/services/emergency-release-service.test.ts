import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  type AutonomousWorkflowRepository,
  type ActivityEventRepository,
} from '@false-route/database';
import {
  EmergencyReleaseService,
  type FakeQuarantineReleaser,
  type FakeRouteRevoker,
} from './emergency-release-service.js';

const ROUTE_IP = '198.51.100.25';
const QUARANTINE_CIDR = '198.51.100.25/32';
const RECORD_ID = '33333333-3333-4333-8333-333333333333';
const EVENT_ID = '11111111-1111-4111-8111-111111111111';

/**
 * Single simulated inventory that can be observed. `revokeSucceeds: false` models a provider
 * mutation that reports failure while the resource remains present.
 */
class ObservableFake implements FakeRouteRevoker, FakeQuarantineReleaser {
  private readonly items = new Set<string>();
  public mutations = 0;
  public observationError: Error | undefined;

  constructor(
    initial: readonly string[] = [],
    private readonly revokeSucceeds = true,
  ) {
    for (const item of initial) this.items.add(item);
  }

  private async observe(key: string): Promise<boolean> {
    if (this.observationError) throw this.observationError;
    return this.items.has(key);
  }

  private mutate(key: string): boolean {
    this.mutations++;
    if (!this.revokeSucceeds) return false;
    return this.items.delete(key);
  }

  async hasActiveRoute(sourceIp: string): Promise<boolean> {
    return this.observe(sourceIp);
  }
  async hasActiveQuarantine(sourceCidr: string): Promise<boolean> {
    return this.observe(sourceCidr);
  }
  async revokeRoute(sourceIp: string): Promise<{ revoked: boolean; status: 'SIMULATED' }> {
    return { revoked: this.mutate(sourceIp), status: 'SIMULATED' };
  }
  async releaseQuarantine(sourceCidr: string): Promise<{ released: boolean; status: 'SIMULATED' }> {
    return { released: this.mutate(sourceCidr), status: 'SIMULATED' };
  }
}

function settledRecord(overrides: Partial<Record<string, number | string>> = {}) {
  const base = {
    requestedCount: 1,
    verifiedCount: 1,
    pendingCount: 0,
    failedCount: 0,
    status: 'COMPLETED',
    ...overrides,
  };
  return {
    id: RECORD_ID,
    ...base,
    derivedCounts: {
      requestedCount: base.requestedCount,
      verifiedCount: base.verifiedCount,
      pendingCount: base.pendingCount,
      failedCount: base.failedCount,
      pendingSettlementCount: 0,
    },
  };
}

function run(service: EmergencyReleaseService) {
  return service.executeEmergencyRelease(
    { idempotencyKey: 'key-01', reason: 'Operator emergency rollback', confirmed: true },
    'corr-01',
  );
}

describe('EmergencyReleaseService simulated-provider observation', () => {
  let repo: AutonomousWorkflowRepository;
  let activityRepo: ActivityEventRepository;

  function claimWith(overrides: Record<string, unknown> = {}) {
    return {
      isDuplicate: false,
      record: { id: RECORD_ID, requestedCount: 1 },
      claimedRoutes: [{ id: 'route-1', eventId: EVENT_ID, sourceIp: ROUTE_IP, fencingToken: 2 }],
      claimedQuarantines: [],
      claimedDecoys: [],
      emergencyOwnerToken: 'emergency-key-01',
      ...overrides,
    };
  }

  beforeEach(() => {
    repo = {
      claimEmergencyRelease: vi.fn().mockResolvedValue(claimWith()),
      markEmergencyRouteReleased: vi.fn().mockResolvedValue({ count: 1 }),
      markEmergencyQuarantineReleased: vi.fn().mockResolvedValue({ count: 1 }),
      settleEmergencyReleaseRecord: vi.fn().mockResolvedValue(settledRecord()),
      completeEmergencyReleaseRecord: vi.fn(),
    } as unknown as AutonomousWorkflowRepository;

    activityRepo = {
      recordActivityEvent: vi.fn().mockResolvedValue({ cursor: 1 }),
    } as unknown as ActivityEventRepository;
  });

  it('reports a released route when the adapter succeeds and the durable CAS succeeds', async () => {
    const fake = new ObservableFake([ROUTE_IP]);
    const response = await run(
      new EmergencyReleaseService(repo, activityRepo, { falseRouteAdapter: fake }),
    );

    expect(response.releasedCount.falseRoutes).toBe(1);
    expect(fake.mutations).toBe(1);
    expect(await fake.hasActiveRoute(ROUTE_IP)).toBe(false);
    expect(repo.markEmergencyRouteReleased).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it('reconciles an already-absent route as complete without repeating the provider mutation', async () => {
    const fake = new ObservableFake([]);
    const response = await run(
      new EmergencyReleaseService(repo, activityRepo, { falseRouteAdapter: fake }),
    );

    expect(fake.mutations).toBe(0);
    expect(response.releasedCount.falseRoutes).toBe(1);
    expect(repo.markEmergencyRouteReleased).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it('reports failure when the adapter fails and the route is still observed active', async () => {
    const fake = new ObservableFake([ROUTE_IP], false);
    vi.mocked(repo.settleEmergencyReleaseRecord).mockResolvedValue(
      settledRecord({ verifiedCount: 0, failedCount: 1, status: 'PARTIAL_FAILURE' }) as never,
    );

    const response = await run(
      new EmergencyReleaseService(repo, activityRepo, { falseRouteAdapter: fake }),
    );

    expect(response.releasedCount.falseRoutes).toBe(0);
    expect(response.failedCount).toBe(1);
    expect(repo.markEmergencyRouteReleased).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
    expect(repo.markEmergencyRouteReleased).not.toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it('does not repeat the provider mutation when a retry follows a failed durable write', async () => {
    const fake = new ObservableFake([ROUTE_IP]);
    // First attempt: provider mutation succeeds, durable write is lost.
    vi.mocked(repo.markEmergencyRouteReleased).mockResolvedValueOnce({ count: 0 });
    vi.mocked(repo.settleEmergencyReleaseRecord).mockResolvedValueOnce(
      settledRecord({ verifiedCount: 0, failedCount: 1, status: 'PARTIAL_FAILURE' }) as never,
    );

    const service = new EmergencyReleaseService(repo, activityRepo, { falseRouteAdapter: fake });
    const first = await run(service);
    expect(first.releasedCount.falseRoutes).toBe(0);
    expect(fake.mutations).toBe(1);

    // Retry observes the already-absent route and reconciles without mutating again.
    const second = await run(service);
    expect(second.releasedCount.falseRoutes).toBe(1);
    expect(fake.mutations).toBe(1);
  });

  it('defers to worker cleanup instead of inventing success when no adapter is wired', async () => {
    vi.mocked(repo.settleEmergencyReleaseRecord).mockResolvedValue(
      settledRecord({ verifiedCount: 0, pendingCount: 1, status: 'PENDING' }) as never,
    );

    const response = await run(new EmergencyReleaseService(repo, activityRepo));

    expect(response.releasedCount).toEqual({ falseRoutes: 0, quarantines: 0, decoys: 0 });
    expect(repo.markEmergencyRouteReleased).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, deferToCleanup: true }),
    );
  });

  it('fails closed when route cleanup deferral loses its durable fence', async () => {
    vi.mocked(repo.markEmergencyRouteReleased).mockResolvedValueOnce({ count: 0 });

    await expect(run(new EmergencyReleaseService(repo, activityRepo))).rejects.toThrow(
      'Emergency route cleanup deferral fence was lost',
    );
    expect(repo.settleEmergencyReleaseRecord).not.toHaveBeenCalled();
  });

  it('fails closed when quarantine cleanup deferral loses its durable fence', async () => {
    vi.mocked(repo.claimEmergencyRelease).mockResolvedValue(
      claimWith({
        claimedRoutes: [],
        claimedQuarantines: [
          { id: 'q-1', eventId: EVENT_ID, sourceCidr: QUARANTINE_CIDR, fencingToken: 2 },
        ],
      }) as never,
    );
    vi.mocked(repo.markEmergencyQuarantineReleased).mockResolvedValueOnce({ count: 0 });

    await expect(run(new EmergencyReleaseService(repo, activityRepo))).rejects.toThrow(
      'Emergency quarantine cleanup deferral fence was lost',
    );
    expect(repo.settleEmergencyReleaseRecord).not.toHaveBeenCalled();
  });

  it('defers rather than reporting success or failure when provider state is unknown', async () => {
    const fake = new ObservableFake([ROUTE_IP]);
    fake.observationError = new Error('simulated inventory unreachable');
    vi.mocked(repo.settleEmergencyReleaseRecord).mockResolvedValue(
      settledRecord({ verifiedCount: 0, pendingCount: 1, status: 'PENDING' }) as never,
    );

    const response = await run(
      new EmergencyReleaseService(repo, activityRepo, { falseRouteAdapter: fake }),
    );

    expect(response.releasedCount.falseRoutes).toBe(0);
    expect(response.failedCount).toBe(0);
    expect(fake.mutations).toBe(0);
    expect(repo.markEmergencyRouteReleased).toHaveBeenCalledWith(
      expect.objectContaining({ deferToCleanup: true }),
    );
  });

  it('keeps decoys pending with a zero released decoy count', async () => {
    vi.mocked(repo.claimEmergencyRelease).mockResolvedValue(
      claimWith({
        claimedRoutes: [],
        claimedDecoys: [{ id: 'decoy-1', eventId: EVENT_ID, fencingToken: 2 }],
      }) as never,
    );
    vi.mocked(repo.settleEmergencyReleaseRecord).mockResolvedValue(
      settledRecord({ verifiedCount: 0, pendingCount: 1, status: 'COMPLETED' }) as never,
    );

    const response = await run(new EmergencyReleaseService(repo, activityRepo));

    expect(response.releasedCount.decoys).toBe(0);
    expect(response.pendingCount).toBe(1);
  });

  it('settles a retry with no remaining leases from durable state alone', async () => {
    vi.mocked(repo.claimEmergencyRelease).mockResolvedValue(
      claimWith({ claimedRoutes: [], claimedQuarantines: [], claimedDecoys: [] }) as never,
    );
    vi.mocked(repo.settleEmergencyReleaseRecord).mockResolvedValue(
      settledRecord({ requestedCount: 2, verifiedCount: 2 }) as never,
    );

    const response = await run(new EmergencyReleaseService(repo, activityRepo));

    expect(response.releasedCount).toEqual({ falseRoutes: 0, quarantines: 0, decoys: 0 });
    expect(response.verifiedCount).toBe(2);
    expect(response.requestedCount).toBe(2);
    expect(repo.markEmergencyRouteReleased).not.toHaveBeenCalled();
  });

  it('releases quarantines through the same observation boundary', async () => {
    const fake = new ObservableFake([QUARANTINE_CIDR]);
    vi.mocked(repo.claimEmergencyRelease).mockResolvedValue(
      claimWith({
        claimedRoutes: [],
        claimedQuarantines: [
          { id: 'q-1', eventId: EVENT_ID, sourceCidr: QUARANTINE_CIDR, fencingToken: 2 },
        ],
      }) as never,
    );

    const response = await run(
      new EmergencyReleaseService(repo, activityRepo, { cloudArmorAdapter: fake }),
    );

    expect(response.releasedCount.quarantines).toBe(1);
    expect(await fake.hasActiveQuarantine(QUARANTINE_CIDR)).toBe(false);
  });

  it('joins an in-progress same-key operation without repeating provider work', async () => {
    vi.mocked(repo.claimEmergencyRelease).mockResolvedValue({
      isDuplicate: true,
      record: {
        id: RECORD_ID,
        idempotencyKey: 'key-01',
        status: 'PENDING',
        requestedCount: 1,
        verifiedCount: 0,
        pendingCount: 1,
        failedCount: 0,
        createdAt: new Date('2026-08-23T10:00:00.000Z'),
      },
      claimedRoutes: [],
      claimedQuarantines: [],
      claimedDecoys: [],
    } as never);
    const fake = new ObservableFake([ROUTE_IP]);

    const response = await run(
      new EmergencyReleaseService(repo, activityRepo, { falseRouteAdapter: fake }),
    );

    expect(response.message).toContain('already in progress');
    expect(fake.mutations).toBe(0);
    expect(repo.settleEmergencyReleaseRecord).not.toHaveBeenCalled();
  });
});
