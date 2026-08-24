import { describe, expect, it, vi } from 'vitest';
import { type DatabaseClient } from '@false-route/database';
import { PrismaApiRepository } from './api-repository.js';

const databaseRow = {
  id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  occurredAt: new Date('2026-08-22T00:00:00.000Z'),
  receivedAt: new Date('2026-08-22T00:00:01.000Z'),
  correlationId: 'corr-repository-query-1',
  sourceIp: '198.51.100.25',
  targetAsset: 'mock-admin-portal',
  eventType: 'SUSPICIOUS_LOGIN',
  failedLoginCount: 3,
  riskIndicators: ['SUSPICIOUS_UA'],
  containmentMode: 'SIMULATED',
  usedDecoyCredential: false,
  decoyIdentifier: null,
  status: 'DECIDED',
  provenance: 'OBSERVED',
};

function createRepository() {
  const findMany = vi.fn().mockResolvedValue([databaseRow]);
  const count = vi.fn().mockResolvedValue(1);
  const db = { intrusionEvent: { findMany, count } } as unknown as DatabaseClient;
  return { repository: new PrismaApiRepository(db), findMany, count };
}

describe('PrismaApiRepository listEvents', () => {
  it('combines bounded text search and status filtering with stable default ordering', async () => {
    const { repository, findMany, count } = createRepository();

    const result = await repository.listEvents({
      limit: 25,
      offset: 50,
      status: 'DECIDED',
      search: 'configuration probe',
    });

    const where = {
      status: 'DECIDED',
      OR: [
        { correlationId: { contains: 'configuration probe', mode: 'insensitive' } },
        { targetAsset: { contains: 'configuration probe', mode: 'insensitive' } },
        { scenarioKind: { contains: 'configuration probe', mode: 'insensitive' } },
      ],
    };
    expect(findMany).toHaveBeenCalledWith({
      where,
      take: 25,
      skip: 50,
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    });
    expect(count).toHaveBeenCalledWith({ where });
    expect(result).toMatchObject({ total: 1, events: [{ id: databaseRow.id }] });
  });

  it('searches recognized event types and honors allowlisted ordering', async () => {
    const { repository, findMany } = createRepository();

    await repository.listEvents({
      limit: 10,
      offset: 0,
      search: 'suspicious login',
      sortBy: 'occurredAt',
      sortDirection: 'asc',
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([{ eventType: 'SUSPICIOUS_LOGIN' }]),
        }),
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      }),
    );
  });
});
