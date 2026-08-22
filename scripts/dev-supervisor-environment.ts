import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ServiceKey } from './dev-supervisor.ts';

export interface ParsedCliArgs {
  services: ServiceKey[];
  hasExplicitServices: boolean;
  migrate: boolean;
  skipBuild: boolean;
  envFile?: string | undefined;
  help: boolean;
}

export function parseCliArgs(args: readonly string[]): ParsedCliArgs {
  const result: ParsedCliArgs = {
    services: ['web', 'api', 'worker'],
    hasExplicitServices: false,
    migrate: false,
    skipBuild: false,
    help: false,
  };

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--migrate') {
      result.migrate = true;
    } else if (arg === '--no-build' || arg === '--skip-build') {
      result.skipBuild = true;
    } else if (arg.startsWith('--services=')) {
      const list = arg
        .slice('--services='.length)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

      const parsedServices: ServiceKey[] = [];
      for (const item of list) {
        if (item === 'web' || item === 'api' || item === 'worker') {
          if (!parsedServices.includes(item)) parsedServices.push(item);
        } else {
          throw new Error(`Unknown service "${item}". Valid services are: web, api, worker`);
        }
      }
      if (parsedServices.length === 0) {
        throw new Error('At least one valid service must be specified with --services');
      }
      result.services = parsedServices;
      result.hasExplicitServices = true;
    } else if (arg.startsWith('--env-file=')) {
      const file = arg.slice('--env-file='.length).trim();
      if (!file) {
        throw new Error('A path must be specified with --env-file');
      }
      result.envFile = file;
    } else {
      throw new Error(`Unknown option "${arg}". Use --help to view available options.`);
    }
  }

  return result;
}

export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (let line of content.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    if (value.startsWith('"')) {
      const match = /^"((?:[^"\\]|\\.)*)"(?:\s*#.*)?$/.exec(value);
      if (match && match[1] !== undefined) {
        value = match[1]
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      } else {
        // Fallback for unclosed quotes: treat as raw with comment strip
        const hashIndex = value.indexOf('#');
        if (hashIndex !== -1) value = value.slice(0, hashIndex).trim();
      }
    } else if (value.startsWith("'")) {
      const match = /^'([^']*)'(?:\s*#.*)?$/.exec(value);
      if (match && match[1] !== undefined) {
        value = match[1];
      } else {
        const hashIndex = value.indexOf('#');
        if (hashIndex !== -1) value = value.slice(0, hashIndex).trim();
      }
    } else {
      const hashIndex = value.indexOf('#');
      if (hashIndex !== -1) value = value.slice(0, hashIndex).trim();
    }

    result[key] = value;
  }

  return result;
}

export interface LoadedEnvResult {
  env: Record<string, string>;
  hasEnvFile: boolean;
  envFilePath: string;
}

export function loadEnvironment(options: {
  rootDir: string;
  envFile?: string | undefined;
  processEnv?: NodeJS.ProcessEnv | undefined;
}): LoadedEnvResult {
  const envFilePath = resolve(options.rootDir, options.envFile ?? '.env');
  let hasEnvFile = false;
  let fileEnv: Record<string, string> = {};

  try {
    if (existsSync(envFilePath)) {
      fileEnv = parseEnvFile(readFileSync(envFilePath, 'utf8'));
      hasEnvFile = true;
    }
  } catch {
    hasEnvFile = false;
  }

  const merged = { ...fileEnv };
  for (const [key, value] of Object.entries(options.processEnv ?? process.env)) {
    if (value !== undefined) merged[key] = value;
  }

  return { env: merged, hasEnvFile, envFilePath };
}

const LOCAL_DATABASE_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0.0.0.0',
  'host.docker.internal',
]);

export function validateLocalDatabaseUrl(url: string | undefined): string | null {
  if (!url || url.trim().length === 0) {
    return 'Missing required environment variable: DATABASE_URL';
  }
  const trimmed = url.trim();
  if (!trimmed.startsWith('postgresql://') && !trimmed.startsWith('postgres://')) {
    return 'DATABASE_URL must be a valid postgresql:// connection string';
  }
  try {
    const host = new URL(trimmed).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!LOCAL_DATABASE_HOSTS.has(host)) {
      return 'DATABASE_URL must target a local database host (e.g. localhost, 127.0.0.1) for local development';
    }
  } catch {
    return 'DATABASE_URL must be a valid postgresql:// connection string';
  }
  return null;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateMigrationEnvironment(
  env: Record<string, string>,
  hasEnvFile: boolean,
): ValidationResult {
  const errors: string[] = [];
  if (!hasEnvFile && (!env.DATABASE_URL || env.DATABASE_URL.trim().length === 0)) {
    errors.push('Environment file .env was not found. Copy .env.example to .env and configure.');
  }

  const dbError = validateLocalDatabaseUrl(env.DATABASE_URL);
  if (dbError)
    errors.push(
      dbError.replace(
        'required environment variable',
        'required environment variable for migration',
      ),
    );
  return { valid: errors.length === 0, errors };
}

export function validateServiceEnvironment(
  services: readonly ServiceKey[],
  env: Record<string, string>,
  hasEnvFile: boolean,
  requiredEnvVars: Readonly<Record<ServiceKey, readonly string[]>> = {
    web: [],
    api: ['DATABASE_URL', 'OPERATOR_ACCESS_TOKEN'],
    worker: ['DATABASE_URL'],
  },
): ValidationResult {
  const errors: string[] = [];
  const neededVars = new Set(services.flatMap((service) => requiredEnvVars[service]));

  if (neededVars.size > 0 && !hasEnvFile) {
    const allPresent = [...neededVars].every((key) => env[key]?.trim());
    if (!allPresent) {
      errors.push('Environment file .env was not found. Copy .env.example to .env and configure.');
    }
  }

  const validatedVars = new Set<string>();

  for (const service of services) {
    for (const key of requiredEnvVars[service]) {
      const value = env[key];
      if (!value?.trim()) {
        errors.push(`Missing required environment variable for ${service}: ${key}`);
      } else if (!validatedVars.has(key)) {
        validatedVars.add(key);
        if (key === 'DATABASE_URL') {
          const dbError = validateLocalDatabaseUrl(value);
          if (dbError) errors.push(dbError);
        } else if (key === 'OPERATOR_ACCESS_TOKEN' && value.length < 8) {
          errors.push('OPERATOR_ACCESS_TOKEN must be at least 8 characters long');
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
