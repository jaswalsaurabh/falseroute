import { startWorker } from './lifecycle.js';

export {
  evaluateDeceptionPolicy,
  ACTIVE_RULE_VERSION,
  type PolicyEvaluationInput,
} from './domain/policy-engine.js';
export {
  LiveGeminiAdapter,
  type GeminiAdapterOptions,
  type GeminiEnrichmentAdapter,
} from './adapters/gemini-adapter.js';
export {
  FakeGeminiAdapter,
  type FakeAdapterMode,
  type FakeAdapterOptions,
} from './adapters/fake-gemini-adapter.js';
export {
  ConcurrencyLimiter,
  ConcurrencySaturationError,
  type ConcurrencyLimiterOptions,
} from './adapters/concurrency-limiter.js';
export {
  classifyProviderError,
  extractHttpStatus,
  sanitizeErrorMessage,
  type ClassifiedProviderError,
  type ProviderErrorKind,
} from './adapters/error-classifier.js';
export {
  type SimulatedDeceptionAgent,
  DeterministicSimulatedDeceptionAdapter,
  SIMULATED_AGENT_ADAPTER_VERSION,
} from './adapters/simulated-deception-agent.js';
export { PrismaWorkerRepository, type WorkerRepository } from './persistence/worker-repository.js';
export {
  EventProcessor,
  type EventProcessorOptions,
  type ProcessResult,
} from './processor/event-processor.js';
export { WorkerOrchestrator, type OrchestratorOptions } from './processor/worker-orchestrator.js';

export {
  AutonomousWorkflowOrchestrator,
  type AutonomousWorkflowResult,
} from './orchestration/autonomous-workflow.js';
export { ToolGateway, type ToolGatewayOptions } from './tools/tool-gateway.js';
export {
  PubSubPushHandler,
  LocalSharedSecretOidcTokenVerifier,
  GoogleOidcTokenVerifier,
  type OidcTokenVerifier,
  type PushHandlerResponse,
} from './integrations/pubsub-push-handler.js';

export { startWorker, type WorkerInstance, type StartWorkerOptions } from './lifecycle.js';

async function main() {
  await startWorker({ registerSignalHandlers: true });
}

// Run main only when executed directly
if (process.argv[1]?.endsWith('dist/index.js') || process.argv[1]?.endsWith('src/index.ts')) {
  main().catch((err) => {
    const errorType = err instanceof Error ? err.constructor.name : 'UnknownError';
    console.error(`Fatal worker startup error: [${errorType}]`);
    process.exit(1);
  });
}
