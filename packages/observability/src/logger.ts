import pino from 'pino';
import {
  DEFAULT_REDACTION_PATHS,
  REDACTED_PLACEHOLDER,
  sanitizeLogData,
  sanitizeUrlCredentials,
} from './redaction.js';

export interface LoggerOptions {
  readonly serviceName: string;
  readonly environment?: string;
  readonly level?: string;
  readonly destination?: pino.DestinationStream;
}

export type Logger = pino.Logger;

/**
 * Creates a structured Pino logger configured with standard service attributes
 * and strict redaction rules for secrets, tokens, URLs, and nested structures.
 */
export function createLogger(options: LoggerOptions): Logger {
  const { serviceName, environment = 'development', level = 'info', destination } = options;

  const pinoOptions: pino.LoggerOptions = {
    name: serviceName,
    level,
    base: {
      service: serviceName,
      env: environment,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [...DEFAULT_REDACTION_PATHS],
      censor: REDACTED_PLACEHOLDER,
    },
    formatters: {
      level: (label: string) => ({ level: label }),
      log: (object: Record<string, unknown>) => sanitizeLogData(object) as Record<string, unknown>,
    },
    hooks: {
      logMethod(inputArgs, method) {
        if (typeof inputArgs[0] === 'string') {
          inputArgs[0] = sanitizeUrlCredentials(inputArgs[0]);
        } else if (inputArgs[0] && typeof inputArgs[0] === 'object') {
          inputArgs[0] = sanitizeLogData(inputArgs[0]);
        }
        if (typeof inputArgs[1] === 'string') {
          inputArgs[1] = sanitizeUrlCredentials(inputArgs[1]);
        }
        return method.apply(this, inputArgs);
      },
    },
  };

  if (destination) {
    return pino(pinoOptions, destination);
  }

  return pino(pinoOptions);
}

/**
 * Creates a child logger with bound correlation and event context.
 */
export function withCorrelationContext(
  logger: Logger,
  context: { readonly correlationId?: string; readonly eventId?: string },
): Logger {
  const bindings: Record<string, string> = {};
  if (context.correlationId) {
    bindings.correlationId = context.correlationId;
  }
  if (context.eventId) {
    bindings.eventId = context.eventId;
  }
  return logger.child(bindings);
}
