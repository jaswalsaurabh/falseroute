interface CounterLike {
  add(value: number, attributes?: Record<string, string>): void;
}

interface HistogramLike {
  record(value: number, attributes?: Record<string, string>): void;
}

interface MeterLike {
  createCounter(name: string, options?: { description?: string }): CounterLike;
  createHistogram(name: string, options?: { description?: string; unit?: string }): HistogramLike;
}

export interface GeminiMetrics {
  recordOperation(input: {
    readonly model: string;
    readonly status: string;
    readonly latencyMs: number;
  }): void;
}

export function createGeminiMetrics(meter?: MeterLike): GeminiMetrics {
  if (!meter) return { recordOperation: () => {} };
  const operations = meter.createCounter('falseroute.gemini.operations', {
    description: 'Gemini operations by model and outcome',
  });
  const errors = meter.createCounter('falseroute.gemini.errors', {
    description: 'Gemini operations that returned a degraded or unavailable result',
  });
  const latency = meter.createHistogram('falseroute.gemini.latency', {
    description: 'Gemini operation latency',
    unit: 'ms',
  });

  return {
    recordOperation({ model, status, latencyMs }) {
      const attributes = { model, status };
      operations.add(1, attributes);
      latency.record(latencyMs, { model });
      if (status !== 'SUCCESS') errors.add(1, attributes);
    },
  };
}
