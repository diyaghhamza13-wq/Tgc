#!/usr/bin/env node
/**
 * LOCAL TEST HELPER: a recording reverse proxy in front of the LOCAL production
 * stack. The backup runner is configured with this proxy as DLM_PROD_URL, so the
 * test can prove exactly what the runner sends to production: methods, endpoint
 * kinds, and WHICH credential (by SHA-256 fingerprint, never the value).
 * File paths are not logged (they can contain names).
 *   node prod-recording-proxy.mjs <listen-port> <target-origin> <log-file>
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';

const [port, target, logFile] = process.argv.slice(2);
const fp = (v) => (v ? crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 16) : null);
const kind = (p) => (p.startsWith('/rest/v1/rpc/') ? `rpc:${p.slice(13).split('?')[0]}` : p.startsWith('/storage/v1/object/authenticated/') ? 'storage:download' : p.split('/').slice(0, 4).join('/'));
http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    fs.appendFileSync(logFile, JSON.stringify({
      method: req.method, kind: kind(req.url), bodyBytes: body.length,
      apikey: fp(req.headers.apikey), authorization: fp((req.headers.authorization ?? '').replace(/^Bearer /, '')),
      token: fp(req.headers['x-dlm-backup-token']), headerNames: Object.keys(req.headers).sort(),
    }) + '\n');
    const up = http.request(new URL(req.url, target), { method: req.method, headers: { ...req.headers, host: new URL(target).host } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end(); });
    up.end(body);
  });
}).listen(Number(port), '127.0.0.1', () => console.log(`recording proxy on 127.0.0.1:${port} -> ${target}`));
