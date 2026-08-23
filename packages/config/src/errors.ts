import type { z } from 'zod';

export interface ConfigurationIssue {
  readonly variable: string;
  readonly message: string;
}

/**
 * Error thrown when environment configuration validation fails.
 * Identifies the problematic variable names and reasons without exposing
 * raw configuration values or secrets.
 */
export class ConfigurationError extends Error {
  public readonly issues: readonly ConfigurationIssue[];

  constructor(issues: readonly ConfigurationIssue[]) {
    const issueSummary = issues.map((i) => `  - ${i.variable}: ${i.message}`).join('\n');
    super(`Invalid environment configuration:\n${issueSummary}`);
    this.name = 'ConfigurationError';
    this.issues = Object.freeze([...issues]);
    Object.setPrototypeOf(this, ConfigurationError.prototype);
  }

  static fromZodError(error: z.ZodError): ConfigurationError {
    const issues: ConfigurationIssue[] = error.issues.map((issue) => {
      const variable = issue.path.join('.') || 'UNKNOWN_VARIABLE';
      return {
        variable,
        message: issue.message,
      };
    });
    return new ConfigurationError(issues);
  }
}
