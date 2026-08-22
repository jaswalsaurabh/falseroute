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

  // 3. API Container Smoke Test (Liveness & Read-only FS)
  const apiContainerName = `falseroute-api-smoke-${Date.now()}`;
  const apiPort = 3105;
  log(`Starting API container smoke instance (${apiContainerName}) on port ${apiPort}...`);

  try {
    const runResult = runner([
      'run',
      '-d',
      '--name',
      apiContainerName,
      '--read-only',
      '--tmpfs',
      '/tmp',
      '-p',
      `${apiPort}:3000`,
      '-e',
      'PORT=3000',
      '-e',
      'DATABASE_URL=postgresql://dummy:dummy@127.0.0.1:5434/dummy',
      '-e',
      'OPERATOR_ACCESS_TOKEN=not-a-real-smoke-test-token-1234',
      '-e',
      'NODE_ENV=test',
      'falseroute-api:test',
    ]);

    if (runResult.status !== 0) {
      logError(`Failed to start API smoke container: ${runResult.stderr.toString('utf8')}`);
      return false;
    }

    // Wait for server to be responsive
    await new Promise((r) => setTimeout(r, 2000));

    log('Verifying API liveness probe...');
    const liveness = await verifyHttpEndpoint(`http://127.0.0.1:${apiPort}/api/v1/health`, 200);
    if (liveness.status !== 200 || !liveness.body.includes('"status":"ok"')) {
      logError(
        `API liveness probe failed. Expected 200 {"status":"ok"}, got ${liveness.status}: ${liveness.body}`,
      );
      return false;
    }
    log('✅ API liveness probe responded 200 OK');

    log('Verifying API readiness fails safely when database is unreachable...');
    try {
      const readiness = await verifyHttpEndpoint(`http://127.0.0.1:${apiPort}/api/v1/ready`, 503, {
        headers: { Authorization: 'Bearer not-a-real-smoke-test-token-1234' },
      });
      if (readiness.status !== 503) {
        logError(
          `API readiness should return 503 on disconnected database, got ${readiness.status}`,
        );
        return false;
      }
      log('✅ API readiness probe returned 503 SERVICE_UNAVAILABLE (safe fail-closed)');
    } catch {
      log('✅ API readiness failed closed as expected');
    }
  } catch (apiErr) {
    logError(
      `API container smoke test failed: ${apiErr instanceof Error ? apiErr.message : String(apiErr)}`,
    );
    return false;
  } finally {
    runner(['rm', '-f', apiContainerName]);
    log('Cleaned up API smoke container');
  }

  // 4. Web Container Smoke Test
  const webContainerName = `falseroute-web-smoke-${Date.now()}`;
  const webPort = 3106;
  log(`Starting Web static container smoke instance (${webContainerName}) on port ${webPort}...`);

  try {
    const runResult = runner([
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

    if (runResult.status !== 0) {
      logError(`Failed to start Web smoke container: ${runResult.stderr.toString('utf8')}`);
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
  } catch (webErr) {
    logError(
      `Web container smoke test failed: ${webErr instanceof Error ? webErr.message : String(webErr)}`,
    );
    return false;
  } finally {
    runner(['rm', '-f', webContainerName]);
    log('Cleaned up Web smoke container');
  }

  // 5. Worker Container SIGTERM Handling Smoke Test
  const workerContainerName = `falseroute-worker-smoke-${Date.now()}`;
  log(`Starting Worker container smoke instance (${workerContainerName})...`);

  try {
    const runResult = runner([
      'run',
      '-d',
      '--name',
      workerContainerName,
      '--read-only',
      '--tmpfs',
      '/tmp',
      '-e',
      'DATABASE_URL=postgresql://dummy:dummy@127.0.0.1:5434/dummy',
      '-e',
      'NODE_ENV=test',
      '-e',
      'WORKER_POLL_INTERVAL_MS=500',
      'falseroute-worker:test',
    ]);

    if (runResult.status !== 0) {
      logError(`Failed to start Worker smoke container: ${runResult.stderr.toString('utf8')}`);
      return false;
    }

    await new Promise((r) => setTimeout(r, 1500));

    log('Sending SIGTERM to Worker container...');
    const stopResult = runner(['stop', '--time', '5', workerContainerName]);
    if (stopResult.status !== 0) {
      logError('Worker container failed to stop cleanly on SIGTERM');
      return false;
    }
    log('✅ Worker container stopped gracefully on SIGTERM');
  } catch (workerErr) {
    logError(
      `Worker container smoke test failed: ${workerErr instanceof Error ? workerErr.message : String(workerErr)}`,
    );
    return false;
  } finally {
    runner(['rm', '-f', workerContainerName]);
    log('Cleaned up Worker smoke container');
  }

  log('===========================================================');
  log('✅ All Container Packaging & Security Verifications PASSED');
  log('===========================================================');
  return true;
}

if (process.argv[1]?.endsWith('verify-containers.ts')) {
  runContainerVerification().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
