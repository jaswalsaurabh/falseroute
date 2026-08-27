import { metrics, trace, type Meter, type Tracer } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export interface TelemetryOptions {
  readonly serviceName: string;
  readonly environment?: string;
  readonly enabled?: boolean;
}

export interface TelemetryHandle {
  readonly tracer: Tracer;
  readonly meter: Meter;
  readonly isEnabled: boolean;
  init(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Creates an OpenTelemetry runtime handle.
 * When enabled is false (default in test/dev without exporters), returns a safe no-op implementation.
 * Never starts background telemetry during module import.
 */
export function createTelemetry(options: TelemetryOptions): TelemetryHandle {
  const { serviceName, environment = 'development', enabled = false } = options;

  if (!enabled) {
    return {
      tracer: trace.getTracer(serviceName),
      meter: metrics.getMeter(serviceName),
      isEnabled: false,
      init: async () => {},
      shutdown: async () => {},
    };
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    'service.environment': environment,
  });

  const sdk = new NodeSDK({
    resource,
  });

  let isStarted = false;

  return {
    tracer: trace.getTracer(serviceName),
    meter: metrics.getMeter(serviceName),
    isEnabled: true,
    async init() {
      if (!isStarted) {
        await sdk.start();
        isStarted = true;
      }
    },
    async shutdown() {
      if (isStarted) {
        await sdk.shutdown();
        isStarted = false;
      }
    },
  };
}
