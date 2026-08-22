import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { createStaticServer } from '../server.ts';

describe('Web Production Static Server', () => {
  let tempDir: string;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'falseroute-web-test-'));
    fs.writeFileSync(path.join(tempDir, 'index.html'), '<html><body>FalseRoute UI</body></html>');
    fs.writeFileSync(path.join(tempDir, 'bundle.js'), 'console.log("hello");');
    fs.writeFileSync(path.join(tempDir, 'style.css'), 'body { margin: 0; }');

    server = createStaticServer(tempDir);
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr !== null ? addr.port : 0;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('serves /health endpoint with 200 and security headers', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'self'");
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('serves static files with correct content type and cache headers', async () => {
    const jsRes = await fetch(`http://127.0.0.1:${port}/bundle.js`);
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get('content-type')).toContain('application/javascript');
    expect(jsRes.headers.get('cache-control')).toContain('immutable');

    const cssRes = await fetch(`http://127.0.0.1:${port}/style.css`);
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get('content-type')).toContain('text/css');
  });

  it('falls back to index.html for SPA client-side routes', async () => {
    const routeRes = await fetch(`http://127.0.0.1:${port}/dashboard/events/some-id`);
    expect(routeRes.status).toBe(200);
    expect(routeRes.headers.get('content-type')).toContain('text/html');
    const text = await routeRes.text();
    expect(text).toContain('FalseRoute UI');
  });

  it('does not capture /api/* with SPA fallback and returns 404 JSON for GET and POST', async () => {
    // GET API path
    const getRes = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    expect(getRes.status).toBe(404);
    expect(getRes.headers.get('content-type')).toContain('application/json');
    const getBody = (await getRes.json()) as { error: string; message: string };
    expect(getBody.error).toBe('NOT_FOUND');

    // POST API path
    const postRes = await fetch(`http://127.0.0.1:${port}/api/v1/intrusion-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(postRes.status).toBe(404);
    expect(postRes.headers.get('content-type')).toContain('application/json');
    const postBody = (await postRes.json()) as { error: string; message: string };
    expect(postBody.error).toBe('NOT_FOUND');
  });

  it('rejects unsupported HTTP methods on static routes with 405 and security headers', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/bundle.js`, { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('rejects path traversal attempts', async () => {
    const traversalRes = await fetch(`http://127.0.0.1:${port}/../../etc/passwd`);
    // Node URL normalizer and server resolve path safely
    expect([200, 403, 404]).toContain(traversalRes.status);
    const text = await traversalRes.text();
    expect(text).not.toContain('root:');
  });
});
