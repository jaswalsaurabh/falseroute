import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DevSupervisor,
  loadEnvironment,
  runMigration,
  validateServiceEnvironment,
} from './dev-supervisor.ts';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = resolve(rootDir, 'infrastructure/docker/compose.yml');
const envFile = process.env.HYBRID_ENV_FILE ?? '.env.hybrid';
let infrastructureStarted = false;
let cleanupStarted = false;

function run(command: string, args: string[], env?: Record<string, string>): boolean {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  return result.status === 0;
}

function cleanup(): void {
  if (cleanupStarted) return;
  cleanupStarted = true;
  if (infrastructureStarted) {
    spawnSync('docker', ['compose', '-f', composeFile, 'down'], {
      cwd: rootDir,
      stdio: 'inherit',
    });
  }
}

const loaded = loadEnvironment({ rootDir, envFile });
if (!loaded.hasEnvFile) {
  process.stderr.write(`[hybrid] Missing ${envFile}; copy .env.hybrid.example first.\n`);
  process.exit(1);
}

const validation = validateServiceEnvironment(['web', 'api', 'worker'], loaded.env, true);
if (!validation.valid) {
  for (const error of validation.errors) process.stderr.write(`[hybrid] ${error}\n`);
  process.exit(1);
}

if (!run('docker', ['compose', '-f', composeFile, 'up', '--build', '-d', 'postgres', 'pubsub'])) {
  process.exit(1);
}
infrastructureStarted = true;

const emulatorEnv = {
  ...loaded.env,
  PUBSUB_EMULATOR_HOST: loaded.env.PUBSUB_EMULATOR_HOST ?? '127.0.0.1:8085',
  PUBSUB_PROJECT_ID: loaded.env.PUBSUB_PROJECT_ID ?? 'falseroute-local',
};
if (!run('node', ['scripts/bootstrap-pubsub-emulator.ts'], emulatorEnv)) {
  cleanup();
  process.exit(1);
}

if (!runMigration(rootDir, loaded.env)) {
  cleanup();
  process.exit(1);
}

let geminiKey = process.env.GEMINI_API_KEY;
if (!geminiKey) {
  const secret = spawnSync(
    'gcloud',
    ['secrets', 'versions', 'access', 'latest', '--secret=falseroute-worker-gemini-key'],
    { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  if (secret.status === 0) geminiKey = secret.stdout.trim();
}
if (!geminiKey) {
  process.stderr.write(
    '[hybrid] Gemini key unavailable. Set GEMINI_API_KEY or grant access to falseroute-worker-gemini-key.\n',
  );
  cleanup();
  process.exit(1);
}

const supervisor = new DevSupervisor({
  rootDir,
  services: ['web', 'api', 'worker'],
  env: loaded.env,
  serviceEnv: { worker: { GEMINI_API_KEY: geminiKey } },
  onExit: (code) => {
    cleanup();
    process.exit(code);
  },
});

const onSignal = (signal: NodeJS.Signals) => supervisor.stopAll(signal);
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));
await supervisor.start();
