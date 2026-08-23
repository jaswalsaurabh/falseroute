import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LeaseCleanupService } from './lease-cleanup.js';
import {
  type AutonomousWorkflowRepository,
  type ActivityEventRepository,
} from '@false-route/database';
import {
  FakeCloudRunAdapter,
  FakeFalseRouteAdapter,
  FakeCloudArmorAdapter,
} from '../tools/fake-cloud-adapters.js';

describe('LeaseCleanupService', () => {
  let mockWorkflowRepo: AutonomousWorkflowRepository;
  let mockActivityRepo: ActivityEventRepository;
  let fakeCloudRun: FakeCloudRunAdapter;
  let fakeFalseRoute: FakeFalseRouteAdapter;
  let fakeCloudArmor: FakeCloudArmorAdapter;
  let cleanupService: LeaseCleanupService;

  beforeEach(async () => {
    fakeCloudRun = new FakeCloudRunAdapter();
    fakeFalseRoute = new FakeFalseRouteAdapter();
    fakeCloudArmor = new FakeCloudArmorAdapter();

    await fakeCloudRun.deployDecoy({
      templateName: 'mock-admin-decoy',
      region: 'us-central1',
      ttlSeconds: 60,
      operationKey: 'idem-request_decoy_deployment-11111111-1111-4111-8111-111111111111',
    });
    await fakeFalseRoute.assignRoute({
      sourceIp: '198.51.100.25',
      targetService: 'fake-target',
      operationKey: 'idem-request_false_route_assignment-22222222-2222-4222-8222-222222222222',
    });
    await fakeCloudArmor.applyQuarantine({
      sourceCidr: '198.51.100.27/32',
      operationKey: 'idem-request_source_quarantine-33333333-3333-4333-8333-333333333333',
    });

    mockWorkflowRepo = {
      acquireCleanupSweepLock: vi.fn().mockResolvedValue({
        acquired: true,
        sweepId: 'sweep-lock-01',
      }),
      claimLeasesForCleanup: vi.fn().mockResolvedValue({
        claimedDecoys: [
          {
            id: 'decoy-lease-1',
            eventId: '11111111-1111-4111-8111-111111111111',
            templateName: 'mock-admin-decoy',
            fencingToken: 2,
          },
        ],
        claimedRoutes: [
          {
            id: 'route-lease-1',
            eventId: '22222222-2222-4222-8222-222222222222',
            sourceIp: '198.51.100.25',
            fencingToken: 2,
          },
        ],
        claimedQuarantines: [
          {
            id: 'quarantine-lease-1',
            eventId: '33333333-3333-4333-8333-333333333333',
            sourceCidr: '198.51.100.27/32',
            fencingToken: 2,
          },
        ],
      }),
      findLeaseOwnershipKeys: vi.fn().mockResolvedValue({
        decoyOperationKeys: new Set(),
        routeOperationKeys: new Set(),
        quarantineOperationKeys: new Set(),
      }),
      markDecoyCleanedUp: vi.fn().mockResolvedValue({ count: 1 }),
      markRouteRevoked: vi.fn().mockResolvedValue({ count: 1 }),
      markQuarantineReleased: vi.fn().mockResolvedValue({ count: 1 }),
      recordLeaseCleanupFailure: vi.fn().mockResolvedValue(undefined),
      completeCleanupSweepRecord: vi.fn().mockResolvedValue({}),
      findAllUnsettledLeases: vi.fn().mockResolvedValue({
        activeDecoys: 0,
        pendingDecoys: 0,
        failedDecoys: 0,
        activeRoutes: 0,
        pendingRoutes: 0,
        failedRoutes: 0,
        activeQuarantines: 0,
        pendingQuarantines: 0,
        failedQuarantines: 0,
        ambiguousIntents: 0,
        totalUnsettled: 0,
      }),
      reconcileExpiredReservations: vi.fn().mockResolvedValue(2),
    } as unknown as AutonomousWorkflowRepository;

    mockActivityRepo = {
      recordActivityEvent: vi.fn().mockResolvedValue({ cursor: 1 }),
    } as unknown as ActivityEventRepository;

    cleanupService = new LeaseCleanupService(mockWorkflowRepo, mockActivityRepo, {
      cloudRunAdapter: fakeCloudRun,
      falseRouteAdapter: fakeFalseRoute,
      cloudArmorAdapter: fakeCloudArmor,
    });
  });

  it('sweeps and cleans up expired decoy, false-route, and quarantine leases', async () => {
    const spyCloudRun = vi.spyOn(fakeCloudRun, 'deleteDecoyByOperation');
    const spyFalseRoute = vi.spyOn(fakeFalseRoute, 'revokeRouteByOperation');
    const spyCloudArmor = vi.spyOn(fakeCloudArmor, 'releaseQuarantineByOperation');

    const result = await cleanupService.sweepExpiredLeases({ sweepOwnerId: 'sweep-custom-01' });

    expect(result.status).toBe('COMPLETED');
    expect(result.cleanedDecoys).toBe(1);
    expect(result.cleanedRoutes).toBe(1);
    expect(result.cleanedQuarantines).toBe(1);
    expect(result.totalCleaned).toBe(3);
    expect(result.failures).toHaveLength(0);

    expect(spyCloudRun).toHaveBeenCalledWith(
      'idem-request_decoy_deployment-11111111-1111-4111-8111-111111111111',
    );
    expect(spyFalseRoute).toHaveBeenCalledWith(
      'idem-request_false_route_assignment-22222222-2222-4222-8222-222222222222',
    );
    expect(spyCloudArmor).toHaveBeenCalledWith(
      'idem-request_source_quarantine-33333333-3333-4333-8333-333333333333',
    );

    expect(mockWorkflowRepo.markDecoyCleanedUp).toHaveBeenCalledWith({
      leaseId: 'decoy-lease-1',
      ownerId: 'sweep-custom-01',
      fencingToken: 2,
    });
    expect(mockWorkflowRepo.markRouteRevoked).toHaveBeenCalledWith({
      leaseId: 'route-lease-1',
      ownerId: 'sweep-custom-01',
      fencingToken: 2,
    });
    expect(mockWorkflowRepo.markQuarantineReleased).toHaveBeenCalledWith({
      leaseId: 'quarantine-lease-1',
      ownerId: 'sweep-custom-01',
      fencingToken: 2,
    });

    expect(mockWorkflowRepo.reconcileExpiredReservations).toHaveBeenCalled();
  });

  it('records failure and transitions attempts when fencing token was lost', async () => {
    vi.mocked(mockWorkflowRepo.markDecoyCleanedUp).mockRejectedValueOnce(
      new Error('Decoy lease cleanup fence was lost'),
    );

    const result = await cleanupService.sweepExpiredLeases({ sweepOwnerId: 'sweep-fenced' });

    expect(result.status).toBe('PARTIAL_FAILURE');
    expect(result.cleanedDecoys).toBe(0);
    expect(result.cleanedRoutes).toBe(1);
    expect(result.cleanedQuarantines).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toEqual({
      leaseId: 'decoy-lease-1',
      kind: 'DECOY',
      error: 'Decoy lease cleanup fence was lost',
    });
    expect(mockWorkflowRepo.recordLeaseCleanupFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseId: 'decoy-lease-1',
        kind: 'DECOY',
      }),
    );
  });

  it('proves rollbackComplete is false when active unexpired or unreleased leases remain', async () => {
    vi.mocked(mockWorkflowRepo.findAllUnsettledLeases).mockResolvedValueOnce({
      activeDecoys: 1,
      pendingDecoys: 0,
      failedDecoys: 0,
      activeRoutes: 0,
      pendingRoutes: 0,
      failedRoutes: 0,
      activeQuarantines: 0,
      pendingQuarantines: 0,
      failedQuarantines: 0,
      ambiguousIntents: 0,
      totalUnsettled: 1,
    });

    const status = await cleanupService.verifyRollbackState();

    expect(status.rollbackComplete).toBe(false);
    expect(status.activeDecoyCount).toBe(1);
    expect(status.details).toContain('Rollback incomplete');
  });

  it('verifies rollback complete only after zero active leases and zero provider resources exist', async () => {
    fakeCloudRun.clear();
    fakeFalseRoute.clear();
    fakeCloudArmor.clear();

    vi.mocked(mockWorkflowRepo.findAllUnsettledLeases).mockResolvedValueOnce({
      activeDecoys: 0,
      pendingDecoys: 0,
      failedDecoys: 0,
      activeRoutes: 0,
      pendingRoutes: 0,
      failedRoutes: 0,
      activeQuarantines: 0,
      pendingQuarantines: 0,
      failedQuarantines: 0,
      ambiguousIntents: 0,
      totalUnsettled: 0,
    });

    const status = await cleanupService.verifyRollbackState();

    expect(status.rollbackComplete).toBe(true);
    expect(status.activeDecoyCount).toBe(0);
    expect(status.activeRouteCount).toBe(0);
    expect(status.activeQuarantineCount).toBe(0);
    expect(status.details).toContain('Rollback verified: zero active');
  });

  it('treats already absent provider resource as reconciled success during cleanup sweep', async () => {
    // Provider inventory has no decoy/route/quarantine
    fakeCloudRun.clear();
    fakeFalseRoute.clear();
    fakeCloudArmor.clear();

    const claimedDecoys = [
      {
        id: 'decoy-absent-1',
        eventId: '11111111-1111-4111-8111-111111111111',
        templateName: 'mock-admin-decoy',
        leaseStatus: 'CLEANUP_PENDING',
        desiredState: 'DELETED',
        ownerId: 'sweep-token-1',
        fencingToken: 2,
        version: 2,
        expiresAt: new Date(Date.now() - 1000),
      },
    ];

    vi.mocked(mockWorkflowRepo.claimLeasesForCleanup).mockResolvedValueOnce({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      claimedDecoys: claimedDecoys as any,
      claimedRoutes: [],
      claimedQuarantines: [],
    });

    const result = await cleanupService.sweepExpiredLeases();

    expect(result.status).toBe('COMPLETED');
    expect(result.cleanedDecoys).toBe(1);
    expect(result.failures).toHaveLength(0);
    expect(mockWorkflowRepo.markDecoyCleanedUp).toHaveBeenCalledWith({
      leaseId: 'decoy-absent-1',
      ownerId: expect.stringMatching(/^sweep-/),
      fencingToken: 2,
    });
  });

  it('detects and removes provider resources that have no active lease', async () => {
    vi.mocked(mockWorkflowRepo.claimLeasesForCleanup).mockResolvedValueOnce({
      claimedDecoys: [],
      claimedRoutes: [],
      claimedQuarantines: [],
    });

    const result = await cleanupService.sweepExpiredLeases({
      sweepOwnerId: 'sweep-orphan-reconciliation',
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.discoveredOrphans).toBe(3);
    expect(result.totalCleaned).toBe(0);
    expect(fakeCloudRun.listDecoys()).toHaveLength(0);
    expect(fakeFalseRoute.listRoutes()).toHaveLength(0);
    expect(fakeCloudArmor.listQuarantines()).toHaveLength(0);
  });

  it('cleans only the exact operation resource when another event shares provider keys', async () => {
    const newerDecoyKey = 'idem-request_decoy_deployment-44444444-4444-4444-8444-444444444444';
    const newerRouteKey =
      'idem-request_false_route_assignment-55555555-5555-4555-8555-555555555555';
    const newerQuarantineKey =
      'idem-request_source_quarantine-66666666-6666-4666-8666-666666666666';

    const newerDecoy = await fakeCloudRun.deployDecoy({
      templateName: 'mock-admin-decoy',
      region: 'us-central1',
      ttlSeconds: 60,
      operationKey: newerDecoyKey,
    });
    await fakeFalseRoute.assignRoute({
      sourceIp: '198.51.100.25',
      targetService: 'newer-target',
      operationKey: newerRouteKey,
    });
    await fakeCloudArmor.applyQuarantine({
      sourceCidr: '198.51.100.27/32',
      operationKey: newerQuarantineKey,
    });
    vi.mocked(mockWorkflowRepo.findLeaseOwnershipKeys).mockResolvedValue({
      decoyOperationKeys: new Set([newerDecoyKey]),
      routeOperationKeys: new Set([newerRouteKey]),
      quarantineOperationKeys: new Set([newerQuarantineKey]),
    });

    const result = await cleanupService.sweepExpiredLeases({ sweepOwnerId: 'sweep-exact-op' });

    expect(result.status).toBe('COMPLETED');
    expect(result.totalCleaned).toBe(3);
    expect(fakeCloudRun.getDecoyByOperation(newerDecoyKey)).toBeDefined();
    expect(fakeCloudRun.getDecoy('mock-admin-decoy')?.serviceId).toBe(newerDecoy.serviceId);
    expect(fakeCloudRun.listDecoys()).toHaveLength(1);
    expect(fakeFalseRoute.getRouteByOperation(newerRouteKey)).toBeDefined();
    expect(fakeCloudArmor.getQuarantineByOperation(newerQuarantineKey)).toBeDefined();
  });

  it('does not treat resources represented by terminal lease rows as orphans', async () => {
    vi.mocked(mockWorkflowRepo.claimLeasesForCleanup).mockResolvedValueOnce({
      claimedDecoys: [],
      claimedRoutes: [],
      claimedQuarantines: [],
    });
    vi.mocked(mockWorkflowRepo.findLeaseOwnershipKeys).mockResolvedValue({
      decoyOperationKeys: new Set([
        'idem-request_decoy_deployment-11111111-1111-4111-8111-111111111111',
      ]),
      routeOperationKeys: new Set([
        'idem-request_false_route_assignment-22222222-2222-4222-8222-222222222222',
      ]),
      quarantineOperationKeys: new Set([
        'idem-request_source_quarantine-33333333-3333-4333-8333-333333333333',
      ]),
    });

    const result = await cleanupService.sweepExpiredLeases({
      sweepOwnerId: 'sweep-terminal-ownership',
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.discoveredOrphans).toBe(0);
    expect(fakeCloudRun.listDecoys()).toHaveLength(1);
    expect(fakeFalseRoute.listRoutes()).toHaveLength(1);
    expect(fakeCloudArmor.listQuarantines()).toHaveLength(1);
  });

  it('reconciles provider success after the first database persistence attempt fails', async () => {
    fakeFalseRoute.clear();
    fakeCloudArmor.clear();
    vi.mocked(mockWorkflowRepo.claimLeasesForCleanup)
      .mockResolvedValueOnce({
        claimedDecoys: [
          {
            id: 'decoy-db-failure-1',
            eventId: '11111111-1111-4111-8111-111111111111',
            templateName: 'mock-admin-decoy',
            fencingToken: 2,
          } as never,
        ],
        claimedRoutes: [],
        claimedQuarantines: [],
      })
      .mockResolvedValueOnce({
        claimedDecoys: [
          {
            id: 'decoy-db-failure-1',
            eventId: '11111111-1111-4111-8111-111111111111',
            templateName: 'mock-admin-decoy',
            fencingToken: 3,
          } as never,
        ],
        claimedRoutes: [],
        claimedQuarantines: [],
      });
    vi.mocked(mockWorkflowRepo.markDecoyCleanedUp)
      .mockRejectedValueOnce(new Error('Simulated DB persistence failure'))
      .mockResolvedValueOnce({ count: 1 });

    const first = await cleanupService.sweepExpiredLeases({ sweepOwnerId: 'sweep-db-first' });
    expect(first.status).toBe('PARTIAL_FAILURE');
    expect(first.cleanedDecoys).toBe(0);
    expect(fakeCloudRun.listDecoys()).toHaveLength(0);
    expect(mockWorkflowRepo.recordLeaseCleanupFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseId: 'decoy-db-failure-1',
        error: 'Simulated DB persistence failure',
      }),
    );

    const second = await cleanupService.sweepExpiredLeases({ sweepOwnerId: 'sweep-db-second' });
    expect(second.status).toBe('COMPLETED');
    expect(second.cleanedDecoys).toBe(1);
    expect(mockWorkflowRepo.markDecoyCleanedUp).toHaveBeenLastCalledWith({
      leaseId: 'decoy-db-failure-1',
      ownerId: 'sweep-db-second',
      fencingToken: 3,
    });
    expect(fakeCloudRun.deleteCount).toBe(1);
  });

  it('truthfully reports PARTIAL_FAILURE when completeCleanupSweepRecord write fails', async () => {
    fakeCloudRun.clear();
    fakeFalseRoute.clear();
    fakeCloudArmor.clear();

    vi.mocked(mockWorkflowRepo.claimLeasesForCleanup).mockResolvedValueOnce({
      claimedDecoys: [],
      claimedRoutes: [],
      claimedQuarantines: [],
    });

    vi.mocked(mockWorkflowRepo.completeCleanupSweepRecord).mockRejectedValueOnce(
      new Error('DB write failure on sweep record completion'),
    );

    const result = await cleanupService.sweepExpiredLeases();

    expect(result.status).toBe('PARTIAL_FAILURE');
    expect(result.failures).toContainEqual(
      expect.objectContaining({
        kind: 'SWEEP_PERSISTENCE',
        error: 'DB write failure on sweep record completion',
      }),
    );
  });

  it('leaves no active simulated resources after settling emergency-deferred leases', async () => {
    // An API emergency release deferred these route and quarantine leases to cleanup: they are
    // owned by the emergency token, immediately eligible, and still present in the inventory.
    fakeCloudRun.clear();
    vi.mocked(mockWorkflowRepo.claimLeasesForCleanup).mockResolvedValueOnce({
      claimedDecoys: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      claimedRoutes: [
        {
          id: 'route-emergency-1',
          eventId: '22222222-2222-4222-8222-222222222222',
          sourceIp: '198.51.100.25',
          fencingToken: 3,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ],
      claimedQuarantines: [
        {
          id: 'quarantine-emergency-1',
          eventId: '33333333-3333-4333-8333-333333333333',
          sourceCidr: '198.51.100.27/32',
          fencingToken: 3,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ],
    });

    const result = await cleanupService.sweepExpiredLeases({
      sweepOwnerId: 'sweep-post-emergency',
    });

    expect(result.cleanedRoutes).toBe(1);
    expect(result.cleanedQuarantines).toBe(1);
    expect(result.failures).toHaveLength(0);
    expect(await fakeFalseRoute.hasActiveRoute('198.51.100.25')).toBe(false);
    expect(await fakeCloudArmor.hasActiveQuarantine('198.51.100.27/32')).toBe(false);

    const status = await cleanupService.verifyRollbackState();
    expect(status.rollbackComplete).toBe(true);
    expect(status.details).toContain('Rollback verified: zero active');
  });

  it('observes the simulated inventory truthfully through the new observation methods', async () => {
    expect(await fakeFalseRoute.hasActiveRoute('198.51.100.25')).toBe(true);
    expect(await fakeCloudArmor.hasActiveQuarantine('198.51.100.27/32')).toBe(true);
    await fakeFalseRoute.revokeRoute('198.51.100.25');
    await fakeCloudArmor.releaseQuarantine('198.51.100.27/32');
    expect(await fakeFalseRoute.hasActiveRoute('198.51.100.25')).toBe(false);
    expect(await fakeCloudArmor.hasActiveQuarantine('198.51.100.27/32')).toBe(false);
  });
});
