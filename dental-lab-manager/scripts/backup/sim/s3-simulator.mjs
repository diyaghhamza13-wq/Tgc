#!/usr/bin/env node
/**
 * LOCAL TEST SIMULATOR of an S3-compatible, immutable backup bucket
 * (stands in for Backblaze B2 / Cloudflare R2 in tests; NOT a real provider).
 *
 * Implements, independently of the client library:
 *  - AWS Signature V4 verification (header auth), clock-skew check, and
 *    x-amz-content-sha256 verification against the received body
 *    (UNSIGNED-PAYLOAD refused for uploads);
 *  - per-key permissions: put | get | head | list (incl. ListObjectVersions) | delete | admin;
 *  - versioning (a PUT to an existing key creates a new version);
 *  - If-None-Match: * (412 if the key already exists);
 *  - object lock in COMPLIANCE mode: each version is retained until
 *    created + lockDays; nobody (not even admin) can delete a locked version;
 *  - lifecycle: versions older than expireDays are deleted, unless locked;
 *  - a simulated clock (admin endpoint) for retention tests.
 * Assumed semantics follow the S3 documentation; real B2/R2 behaviour is
 * UNVERIFIED until checked against the provider.
 *
 * Config (JSON file in argv[2]): { port, region, bucket, lockDays, expireDays,
 *   keys: { <id>: { secret, perms: [...] } } }
 * Test-only admin endpoints (no auth, loopback only): POST /__sim/clock {"advanceDays":n},
 * POST /__sim/lifecycle, GET /__sim/state, POST /__sim/corrupt {"key":k}.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';

const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const DAY = 86400000;
let offset = 0;
const now = () => Date.now() + offset;
/** key -> [{ versionId, body, sha256, md5, created, retainUntil, deleteMarker }] (oldest first) */
const store = new Map();
const audit = [];

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function send(res, code, body = '', headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/xml', ...headers });
  res.end(body);
}
const xmlErr = (code) => `<?xml version="1.0"?><Error><Code>${code}</Code></Error>`;

/** Verifies SigV4; returns the key id or throws [status, code]. */
function verify(req, url, body) {
  const auth = req.headers.authorization ?? '';
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m) throw [403, 'AccessDenied'];
  const [, keyId, date, region, signedHeaders, signature] = m;
  const key = cfg.keys[keyId];
  if (!key) throw [403, 'InvalidAccessKeyId'];
  const amzDate = req.headers['x-amz-date'] ?? '';
  if (!amzDate.startsWith(date)) throw [403, 'SignatureDoesNotMatch'];
  const t = Date.parse(amzDate.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'));
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > 15 * 60000) throw [403, 'RequestTimeTooSkewed'];
  const payloadHash = req.headers['x-amz-content-sha256'];
  if (!payloadHash) throw [400, 'MissingContentSha256'];
  if (payloadHash !== 'UNSIGNED-PAYLOAD' && payloadHash !== sha256(body)) throw [400, 'XAmzContentSHA256Mismatch'];
  if (payloadHash === 'UNSIGNED-PAYLOAD' && req.method === 'PUT') throw [400, 'SignedPayloadRequired'];
  const names = signedHeaders.split(';');
  if (!names.includes('host') || !names.includes('x-amz-date') || !names.includes('x-amz-content-sha256')) throw [403, 'SignatureDoesNotMatch'];
  const canonHeaders = names.map((h) => `${h}:${String(req.headers[h] ?? '').trim().replace(/\s+/g, ' ')}\n`).join('');
  const query = [...url.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonPath = url.pathname.split('/').map((s) => enc(decodeURIComponent(s))).join('/');
  const canonical = [req.method, canonPath, query, canonHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + key.secret, date), region), 's3'), 'aws4_request');
  const expected = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) throw [403, 'SignatureDoesNotMatch'];
  return keyId;
}
const can = (keyId, perm) => cfg.keys[keyId].perms.includes(perm) || cfg.keys[keyId].perms.includes('admin');
const current = (k) => { const v = store.get(k); const last = v?.[v.length - 1]; return last && !last.deleteMarker ? last : null; };
const locked = (v) => v.retainUntil > now();

function lifecycle() {
  let deleted = 0; let blocked = 0;
  for (const [k, versions] of store) {
    const keep = [];
    for (const v of versions) {
      if (v.created + cfg.expireDays * DAY <= now()) {
        if (locked(v)) { blocked++; keep.push(v); } else deleted++;
      } else keep.push(v);
    }
    if (keep.length) store.set(k, keep); else store.delete(k);
  }
  return { deleted, blocked };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://sim');
    // ---- test-only admin endpoints (loopback) ----
    if (url.pathname.startsWith('/__sim/')) {
      const p = body.length ? JSON.parse(body) : {};
      if (url.pathname === '/__sim/clock') { offset += (p.advanceDays ?? 0) * DAY; return send(res, 200, JSON.stringify({ now: new Date(now()).toISOString() }), { 'Content-Type': 'application/json' }); }
      if (url.pathname === '/__sim/lifecycle') return send(res, 200, JSON.stringify(lifecycle()), { 'Content-Type': 'application/json' });
      if (url.pathname === '/__sim/state') {
        const out = {};
        for (const [k, vs] of store) out[k] = vs.map((v) => ({ versionId: v.versionId, size: v.body?.length ?? 0, sha256: v.sha256, created: new Date(v.created).toISOString(), retainUntil: new Date(v.retainUntil).toISOString(), deleteMarker: !!v.deleteMarker }));
        return send(res, 200, JSON.stringify({ now: new Date(now()).toISOString(), objects: out, audit }), { 'Content-Type': 'application/json' });
      }
      if (url.pathname === '/__sim/corrupt') { const v = current(p.key); if (v) { v.body = Buffer.from(v.body); v.body[v.body.length - 1] ^= 1; } return send(res, v ? 200 : 404, '{}'); }
      if (url.pathname === '/__sim/raw') { const v = current(url.searchParams.get('key')); return v ? send(res, 200, v.body, { 'Content-Type': 'application/octet-stream' }) : send(res, 404); }
      return send(res, 404);
    }
    let keyId;
    try { keyId = verify(req, url, body); } catch (e) { audit.push({ op: req.method, ok: false, reason: e[1] }); return send(res, e[0], xmlErr(e[1])); }
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== cfg.bucket) return send(res, 404, xmlErr('NoSuchBucket'));
    const key = parts.slice(1).join('/');
    const deny = (op) => { audit.push({ op, keyId, ok: false, reason: 'AccessDenied' }); send(res, 403, xmlErr('AccessDenied')); };
    const ok = (op) => audit.push({ op, keyId, ok: true, key });
    // bucket-level configuration changes (lifecycle, lock, policy): admin only
    if (!key && req.method === 'PUT') { if (!cfg.keys[keyId].perms.includes('admin')) return deny('PutBucketConfig'); ok('PutBucketConfig'); return send(res, 200); }
    if (!key && req.method === 'GET') {
      if (!can(keyId, 'list')) return deny(url.searchParams.has('versions') ? 'ListObjectVersions' : 'ListObjects');
      if (url.searchParams.has('versions')) {
        ok('ListObjectVersions');
        const prefix = url.searchParams.get('prefix') ?? '';
        const xml = [];
        for (const [k, vs] of store) {
          if (!k.startsWith(prefix)) continue;
          // S3 order: newest first per key
          for (const v of [...vs].reverse()) {
            const tag = v.deleteMarker ? 'DeleteMarker' : 'Version';
            xml.push(`<${tag}><Key>${k}</Key><VersionId>${v.versionId}</VersionId><LastModified>${new Date(v.created).toISOString()}</LastModified>${v.deleteMarker ? '' : `<Size>${v.body.length}</Size><ETag>"${v.md5}"</ETag>`}</${tag}>`);
          }
        }
        return send(res, 200, `<?xml version="1.0"?><ListVersionsResult>${xml.join('')}</ListVersionsResult>`);
      }
      ok('List');
      const items = [...store.keys()].filter((k) => current(k)).map((k) => `<Contents><Key>${k}</Key><Size>${current(k).body.length}</Size></Contents>`).join('');
      return send(res, 200, `<?xml version="1.0"?><ListBucketResult>${items}</ListBucketResult>`);
    }
    if (req.method === 'PUT') {
      if (!can(keyId, 'put')) return deny('PutObject');
      if (req.headers['if-none-match'] === '*' && current(key)) { audit.push({ op: 'PutObject', keyId, ok: false, reason: 'PreconditionFailed' }); return send(res, 412, xmlErr('PreconditionFailed')); }
      const v = { versionId: crypto.randomUUID(), body, sha256: sha256(body), md5: crypto.createHash('md5').update(body).digest('hex'), created: now(), retainUntil: now() + cfg.lockDays * DAY };
      store.set(key, [...(store.get(key) ?? []), v]);
      ok('PutObject');
      return send(res, 200, '', { ETag: `"${v.md5}"`, 'x-amz-version-id': v.versionId });
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const op = req.method === 'GET' ? 'get' : 'head';
      if (!can(keyId, op) && !(op === 'head' && can(keyId, 'get'))) return deny(req.method === 'GET' ? 'GetObject' : 'HeadObject');
      const vid = url.searchParams.get('versionId');
      const v = vid ? (store.get(key) ?? []).find((x) => x.versionId === vid && !x.deleteMarker) : current(key);
      if (!v) return send(res, 404, xmlErr('NoSuchKey'));
      ok(req.method === 'GET' ? 'GetObject' : 'HeadObject');
      return send(res, 200, req.method === 'GET' ? v.body : '', { 'Content-Type': 'application/octet-stream', ETag: `"${v.md5}"`, 'Content-Length': v.body.length, 'x-amz-version-id': v.versionId });
    }
    if (req.method === 'DELETE') {
      if (!can(keyId, 'delete')) return deny('DeleteObject');
      const vid = url.searchParams.get('versionId');
      const versions = store.get(key) ?? [];
      if (vid) {
        const v = versions.find((x) => x.versionId === vid);
        if (!v) return send(res, 404, xmlErr('NoSuchVersion'));
        if (locked(v)) { audit.push({ op: 'DeleteObjectVersion', keyId, ok: false, reason: 'ObjectLocked' }); return send(res, 403, xmlErr('AccessDenied')); }
        store.set(key, versions.filter((x) => x !== v));
        ok('DeleteObjectVersion');
        return send(res, 204);
      }
      // versioned bucket: a delete without versionId only adds a delete marker; data versions stay
      store.set(key, [...versions, { versionId: crypto.randomUUID(), deleteMarker: true, created: now(), retainUntil: 0 }]);
      ok('DeleteMarker');
      return send(res, 204);
    }
    return send(res, 405);
  });
});
server.listen(cfg.port, '127.0.0.1', () => console.log(`s3-simulator listening on 127.0.0.1:${cfg.port} (bucket ${cfg.bucket}, lock ${cfg.lockDays} d, lifecycle ${cfg.expireDays} d)`));
