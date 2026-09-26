#!/usr/bin/env node
// ===================================================================
// Minimal static file server, Node built-ins only (no npm install, no
// internet access needed) -- serves this repo's own files over
// http://localhost, so index.html can fetch('./data/...') successfully.
//
// WHY THIS EXISTS: opening index.html directly (double-clicking the file,
// or a file:///... URL) makes the browser treat the page as coming from
// origin "null". Every browser blocks fetch() of local files from that
// origin as a hardcoded security rule -- there is no way to fix this from
// the app's own code. Auto Scan's data/latest.json and Manual Lookup's
// data/squeeze_scores.json both fail silently (or with a console CORS
// error) under file://, every time, on every browser. Serving over
// http://localhost sidesteps the restriction entirely.
//
// Usage:
//   node scripts/serve.mjs [port]
//   then open http://localhost:8080/index.html (or your chosen port)
// ===================================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2] || 8080);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  // Strip query string, decode percent-encoding, block path traversal
  // outside ROOT -- this is a local dev convenience server, not meant to
  // be exposed beyond localhost, but staying defensive is cheap.
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`Not found: ${urlPath}`);
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Server error: ${err.message}`);
      }
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`Serving ${ROOT} at:`);
  console.log(`  http://localhost:${PORT}/index.html`);
  console.log(`\nOpen that URL in your browser (not the index.html file directly).`);
  console.log(`Ctrl+C to stop.`);
});
