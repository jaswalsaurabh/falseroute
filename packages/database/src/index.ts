export {
  createDatabaseClient,
  validateTestDatabaseUrl,
  type DatabaseClient,
  type DatabaseClientOptions,
} from './client.js';

export {
  PrismaClient,
  Prisma,
  type IntrusionEvent,
  type DeceptionDecision,
  type DecisionAuditRecord,
  type SimulatedDeceptionEffect,
  ProcessingStatus,
  ContainmentMode,
  EventType,
  DeceptionAction,
  ProvenanceClassification,
} from './generated/client/client.js';
