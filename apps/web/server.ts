import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);

const PORT = parseInt(process.env.PORT || '8080', 10);
const DIST_DIR = path.resolve(currentDirPath, 'dist');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self';",
};

export function createStaticServer(staticDir = DIST_DIR): http.Server {
  return http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0] || '/';

    // Fast-fail API requests: static server must never return HTML or 405 for /api/*
    if (urlPath === '/api' || urlPath.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
      res.end(
        JSON.stringify({
          error: 'NOT_FOUND',
          message: 'API endpoint not served by static frontend server',
        }),
      );
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
      res.end('Method Not Allowed');
      return;
    }

    if (urlPath === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
      return;
    }

    const filePath = path.join(staticDir, urlPath);

    // Prevent path traversal outside staticDir
    const normalized = path.normalize(filePath);
    if (!normalized.startsWith(staticDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    fs.stat(normalized, (err, stats) => {
      let finalPath = normalized;
      if (err || !stats.isFile()) {
        // SPA routing fallback to index.html
        finalPath = path.join(staticDir, 'index.html');
      }

      fs.readFile(finalPath, (readErr, content) => {
        if (readErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }

        const ext = path.extname(finalPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const headers: Record<string, string | number> = {
          'Content-Type': contentType,
          'Content-Length': Buffer.byteLength(content),
          ...SECURITY_HEADERS,
        };

        if (ext === '.html') {
          headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
        } else {
          headers['Cache-Control'] = 'public, max-age=31536000, immutable';
        }

        res.writeHead(200, headers);
        if (req.method === 'HEAD') {
          res.end();
        } else {
          res.end(content);
        }
      });
    });
  });
}

export function startServer(port = PORT, staticDir = DIST_DIR): http.Server {
  const server = createStaticServer(staticDir);
  server.listen(port, () => {
    console.log(`[falseroute-web] Static server listening on port ${port}`);
  });

  const shutdown = (signal: string) => {
    console.log(`[falseroute-web] Received ${signal}; shutting down`);
    server.close(() => {
      console.log('[falseroute-web] Static server closed cleanly');
      process.exit(0);
    });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

if (process.argv[1] === currentFilePath) {
  startServer();
}
