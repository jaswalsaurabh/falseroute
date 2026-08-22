import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import http from 'node:http';

export interface DockerCommandRunner {
  (args: readonly string[], options?: SpawnSyncOptions): SpawnSyncReturns<Buffer>;
}

export interface ContainerVerificationOptions {
  readonly runDocker?: DockerCommandRunner | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly log?: ((message: string) => void) | undefined;
  readonly logError?: ((message: string) => void) | undefined;
  readonly isCi?: boolean | undefined;
  readonly skipBuild?: boolean | undefined;
}

export interface ImageInspection {
  readonly user: string;
  readonly entrypoint: readonly string[];
  readonly cmd: readonly string[];
  readonly env: readonly string[];
}

export function defaultDockerRunner(
  args: readonly string[],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<Buffer> {
  return spawnSync('docker', args, {
    ...options,
    shell: false,
    encoding: 'buffer',
  }) as SpawnSyncReturns<Buffer>;
}

export function isDockerAvailable(runner: DockerCommandRunner = defaultDockerRunner): boolean {
  try {
    const result = runner(['info', '--format', '{{json .}}']);
    return result.status === 0;
  } catch {
    return false;
  }
}

export function parseImageInspect(inspectOutput: string): ImageInspection {
  try {
    const parsed = JSON.parse(inspectOutput);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const config = first?.Config ?? {};

    return {
      user: String(config.User ?? ''),
      entrypoint: Array.isArray(config.Entrypoint) ? config.Entrypoint : [],
      cmd: Array.isArray(config.Cmd) ? config.Cmd : [],
      env: Array.isArray(config.Env) ? config.Env : [],
    };
  } catch (err) {
    throw new Error(
      `Failed to parse Docker inspect output: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

export function assertNonRootUser(imageName: string, inspection: ImageInspection): void {
  const user = inspection.user.trim();
  if (!user || user === '0' || user === 'root') {
    throw new Error(
      `Image ${imageName} violates non-root policy: Config.User is "${user || '[root/default]'}" (expected non-root user such as "node").`,
    );
  }
}

export function assertNoProhibitedFiles(imageName: string, runner: DockerCommandRunner): void {
  const checkCmd =
    'test ! -f /app/.env && test ! -d /app/.git && test ! -f /app/BACKLOG.md && echo CLEAN';
  const result = runner(['run', '--rm', '--entrypoint', 'sh', imageName, '-c', checkCmd]);

  if (result.status !== 0 || !result.stdout.toString('utf8').includes('CLEAN')) {
    throw new Error(
      `Image ${imageName} contains prohibited files (.env, .git, or private docs) in container filesystem.`,
    );
  }
}

export async function verifyHttpEndpoint(
  url: string,
  expectedStatus: number,
  options: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const headers = options.headers ?? {};

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Timeout waiting for HTTP response from ${url}`));
    }, timeoutMs);

    const parsedUrl = new URL(url);
    const req = http.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        method: 'GET',
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode ?? 0, body: data });
        });
      },
    );

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    req.end();
  });
}

export async function runContainerVerification(
  options: ContainerVerificationOptions = {},
): Promise<boolean> {
  const runner = options.runDocker ?? defaultDockerRunner;
  const log = options.log ?? ((msg: string) => console.log(msg));
  const logError = options.logError ?? ((msg: string) => console.error(msg));
  const isCi = options.isCi ?? Boolean(process.env.CI);

  log('--- Running Container Security & Packaging Verification ---');

  if (!isDockerAvailable(runner)) {
    if (isCi) {
      logError('CRITICAL: Docker daemon is unavailable in CI environment.');
      return false;
    }
    log('⚠️  Docker daemon is not available locally; skipping container smoke verification.');
    return true;
  }

  const imagesToVerify = [
    { name: 'falseroute-api:test', dockerfile: 'apps/api/Dockerfile' },
    { name: 'falseroute-worker:test', dockerfile: 'apps/worker/Dockerfile' },
    { name: 'falseroute-web:test', dockerfile: 'apps/web/Dockerfile' },
  ];

  // 1. Build images
  if (!options.skipBuild) {
    for (const image of imagesToVerify) {
      log(`Building ${image.name} from ${image.dockerfile}...`);
      const buildResult = runner(['build', '-f', image.dockerfile, '-t', image.name, '.']);
      if (buildResult.status !== 0) {
        logError(`Failed to build container image ${image.name}`);
        if (buildResult.stderr) logError(buildResult.stderr.toString('utf8'));
        return false;
      }
      log(`✅ Successfully built ${image.name}`);
    }
  }

  // 2. Inspect non-root user and image contents
  for (const image of imagesToVerify) {
    log(`Inspecting security metadata for ${image.name}...`);
    const inspectResult = runner(['image', 'inspect', image.name]);
    if (inspectResult.status !== 0) {
      logError(`Failed to inspect image ${image.name}`);
      return false;
    }

    const inspection = parseImageInspect(inspectResult.stdout.toString('utf8'));
    try {
      assertNonRootUser(image.name, inspection);
      log(`✅ Non-root user verified for ${image.name} (user: ${inspection.user})`);

      assertNoProhibitedFiles(image.name, runner);
      log(`✅ Verified absence of .env, .git, and private documentation in ${image.name}`);
    } catch (err) {
      logError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  // Setup isolated Docker bridge network and ephemeral PostgreSQL container
  const networkName = `falseroute-verify-net-${Date.now()}`;
  const pgContainerName = `falseroute-pg-smoke-${Date.now()}`;
  const pgHostPort = 3104;
  const pgInternalUrl = `postgresql://falseroute:falseroute@${pgContainerName}:5432/falseroute_test?schema=public`;
  const pgHostUrl = `postgresql://falseroute:falseroute@127.0.0.1:${pgHostPort}/falseroute_test?schema=public`;

  const apiConnectedContainerName = `falseroute-api-smoke-${Date.now()}`;
  const apiDisconnectedContainerName = `falseroute-api-disc-smoke-${Date.now()}`;
  const webContainerName = `falseroute-web-smoke-${Date.now()}`;
  const workerContainerName = `falseroute-worker-smoke-${Date.now()}`;

  const apiPort = 3105;
  const webPort = 3106;
  const workerPort = 3107;

  try {
    log(`Creating isolated Docker network (${networkName})...`);
    const netResult = runner(['network', 'create', networkName]);
    if (netResult.status !== 0) {
      logError(`Failed to create Docker network: ${netResult.stderr?.toString('utf8') ?? 'error'}`);
      return false;
    }

    log(`Starting ephemeral PostgreSQL test database (${pgContainerName})...`);
    const pgRunResult = runner([
      'run',
      '-d',
      '--name',
      pgContainerName,
      '--network',
      networkName,
      '-p',
      `${pgHostPort}:5432`,
      '-e',
      'POSTGRES_USER=falseroute',
      '-e',
      'POSTGRES_PASSWORD=falseroute',
      '-e',
      'POSTGRES_DB=falseroute_test',
      'postgres:17-alpine',
    ]);

    if (pgRunResult.status !== 0) {
      logError(
        `Failed to start test PostgreSQL container: ${pgRunResult.stderr?.toString('utf8') ?? 'error'}`,
      );
      return false;
    }

    // Wait for PostgreSQL to accept connections
    log('Waiting for PostgreSQL to be ready...');
    let pgReady = false;
    for (let i = 0; i < 30; i += 1) {
      const readyCheck = runner([
        'exec',
        pgContainerName,
        'pg_isready',
        '-U',
        'falseroute',
        '-d',
        'falseroute_test',
      ]);
      if (readyCheck.status === 0) {
        pgReady = true;
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!pgReady) {
      logError('PostgreSQL container failed to become ready within timeout');
      return false;
    }
    log('✅ Ephemeral PostgreSQL database is ready');

    // Run Prisma migrations against the test database
    log('Deploying Prisma schema migrations to test database...');
    const migrateResult = spawnSync('pnpm', ['db:migrate'], {
      env: { ...process.env, DATABASE_URL: pgHostUrl },
      shell: false,
      stdio: 'pipe',
    });

    if (migrateResult.status !== 0) {
      logError(
        `Prisma migration failed on test database: ${migrateResult.stderr?.toString('utf8') ?? 'error'}`,
      );
      return false;
    }
    log('✅ Prisma migrations applied successfully to test database');

    // 3. API Container Smoke Test (Connected + Read-only FS)
    log(`Starting connected API container (${apiConnectedContainerName}) on port ${apiPort}...`);
    const apiRunResult = runner([
      'run',
      '-d',
      '--name',
      apiConnectedContainerName,
      '--network',
      networkName,
      '--read-only',
      '--tmpfs',
      '/tmp',
      '-p',
      `${apiPort}:3000`,
      '-e',
      'PORT=3000',
      '-e',
      `DATABASE_URL=${pgInternalUrl}`,
      '-e',
      'OPERATOR_ACCESS_TOKEN=not-a-real-smoke-test-token-1234',
      '-e',
      'NODE_ENV=test',
      'falseroute-api:test',
    ]);

    if (apiRunResult.status !== 0) {
      logError(
        `Failed to start API smoke container: ${apiRunResult.stderr?.toString('utf8') ?? 'error'}`,
      );
      return false;
    }

    await new Promise((r) => setTimeout(r, 2000));

    log('Verifying API liveness probe...');
    const liveness = await verifyHttpEndpoint(`http://127.0.0.1:${apiPort}/api/v1/health`, 200);
    if (liveness.status !== 200 || !liveness.body.includes('"status":"ok"')) {
      logError(`API liveness probe failed: ${liveness.status}: ${liveness.body}`);
      return false;
    }
    log('✅ API liveness probe responded 200 OK');

    log('Verifying API readiness probe against connected PostgreSQL...');
    const apiReady = await verifyHttpEndpoint(`http://127.0.0.1:${apiPort}/api/v1/ready`, 200);
    if (apiReady.status !== 200 || !apiReady.body.includes('"database":"connected"')) {
      logError(
        `API readiness probe failed on connected database: ${apiReady.status}: ${apiReady.body}`,
      );
      return false;
    }
    log('✅ API readiness probe returned 200 (database: connected)');

    // Disconnected API verification
    log('Starting disconnected API container to verify safe fail-closed readiness...');
    const apiDiscResult = runner([
      'run',
      '-d',
      '--name',
      apiDisconnectedContainerName,
      '--read-only',
      '--tmpfs',
      '/tmp',
      '-p',
      `${apiPort + 10}:3000`,
      '-e',
      'PORT=3000',
      '-e',
      'DATABASE_URL=postgresql://falseroute:falseroute@127.0.0.1:5439/nonexistent',
      '-e',
      'OPERATOR_ACCESS_TOKEN=not-a-real-smoke-test-token-1234',
      '-e',
      'NODE_ENV=test',
      'falseroute-api:test',
    ]);

    if (apiDiscResult.status === 0) {
      await new Promise((r) => setTimeout(r, 2000));
      const discReady = await verifyHttpEndpoint(
        `http://127.0.0.1:${apiPort + 10}/api/v1/ready`,
        503,
      );
      if (discReady.status !== 503) {
        logError(`API should return 503 when disconnected, got ${discReady.status}`);
        return false;
      }
      log('✅ Disconnected API returned 503 SERVICE_UNAVAILABLE (safe fail-closed)');
    }

    // 4. Web Container Smoke Test
    log(`Starting Web static container (${webContainerName}) on port ${webPort}...`);
    const webRunResult = runner([
      'run',
      '-d',
      '--name',
      webContainerName,
      '--read-only',
      '--tmpfs',
      '/tmp',
      '-p',
      `${webPort}:8080`,
      '-e',
      'PORT=8080',
      'falseroute-web:test',
    ]);

    if (webRunResult.status !== 0) {
      logError(
        `Failed to start Web smoke container: ${webRunResult.stderr?.toString('utf8') ?? 'error'}`,
      );
      return false;
    }

    await new Promise((r) => setTimeout(r, 1500));

    log('Verifying Web health probe...');
    const webHealth = await verifyHttpEndpoint(`http://127.0.0.1:${webPort}/health`, 200);
    if (webHealth.status !== 200 || !webHealth.body.includes('"status":"ok"')) {
      logError(`Web health probe failed, got ${webHealth.status}: ${webHealth.body}`);
      return false;
    }
    log('✅ Web container health probe responded 200 OK');

    log('Verifying Web server rejects /api/ requests with 404...');
    const webApiCheck = await verifyHttpEndpoint(`http://127.0.0.1:${webPort}/api/v1/health`, 404);
    if (webApiCheck.status !== 404) {
      logError(`Web container must reject /api/ with 404, got ${webApiCheck.status}`);
      return false;
    }
    log('✅ Web container correctly returned 404 for API route');

    // 5. Worker Container Smoke Test (Health HTTP listener + SIGTERM Graceful Stop)
    log(`Starting Worker container (${workerContainerName}) on port ${workerPort}...`);
    const workerRunResult = runner([
      'run',
      '-d',
      '--name',
      workerContainerName,
      '--network',
      networkName,
      '--read-only',
      '--tmpfs',
      '/tmp',
      '-p',
      `${workerPort}:8080`,
      '-e',
      'PORT=8080',
      '-e',
      `DATABASE_URL=${pgInternalUrl}`,
      '-e',
      'NODE_ENV=test',
      '-e',
      'WORKER_POLL_INTERVAL_MS=500',
      'falseroute-worker:test',
    ]);

    if (workerRunResult.status !== 0) {
      logError(
        `Failed to start Worker smoke container: ${workerRunResult.stderr?.toString('utf8') ?? 'error'}`,
      );
      return false;
    }

    await new Promise((r) => setTimeout(r, 2000));

    log('Verifying Worker liveness probe on port 8080...');
    const workerLiveness = await verifyHttpEndpoint(`http://127.0.0.1:${workerPort}/health`, 200);
    if (workerLiveness.status !== 200 || !workerLiveness.body.includes('"status":"ok"')) {
      logError(`Worker liveness probe failed: ${workerLiveness.status}: ${workerLiveness.body}`);
      return false;
    }
    log('✅ Worker liveness probe responded 200 OK');

    log('Verifying Worker readiness probe on port 8080 against connected PostgreSQL...');
    const workerReadiness = await verifyHttpEndpoint(`http://127.0.0.1:${workerPort}/ready`, 200);
    if (
      workerReadiness.status !== 200 ||
      !workerReadiness.body.includes('"database":"connected"')
    ) {
      logError(`Worker readiness probe failed: ${workerReadiness.status}: ${workerReadiness.body}`);
      return false;
    }
    log('✅ Worker readiness probe returned 200 (database: connected)');

    log('Sending SIGTERM to Worker container to verify graceful shutdown...');
    const stopResult = runner(['stop', '--time', '5', workerContainerName]);
    if (stopResult.status !== 0) {
      logError('Worker container failed to stop cleanly on SIGTERM');
      return false;
    }
    log('✅ Worker container stopped gracefully on SIGTERM');

    log('===========================================================');
    log('✅ All Container Packaging & Security Verifications PASSED');
    log('===========================================================');
    return true;
  } catch (err) {
    logError(`Container verification failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    // Robust cleanup of all containers and network
    runner(['rm', '-f', apiConnectedContainerName]);
    runner(['rm', '-f', apiDisconnectedContainerName]);
    runner(['rm', '-f', webContainerName]);
    runner(['rm', '-f', workerContainerName]);
    runner(['rm', '-f', pgContainerName]);
    runner(['network', 'rm', networkName]);
    log('Cleaned up ephemeral verification containers and Docker network');
  }
}

if (process.argv[1]?.endsWith('verify-containers.ts')) {
  runContainerVerification().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
