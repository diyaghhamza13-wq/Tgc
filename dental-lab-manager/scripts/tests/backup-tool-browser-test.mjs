#!/usr/bin/env node
/**
 * LOCAL test of docs/backup/tools/backup-tool.html in headless Chromium with
 * every network request blocked. Uses a real encrypted run produced by
 * automated-backup-local-test.mjs (WORK_DIR/tool-fixture) and the test key.
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const W = process.env.WORK_DIR;
const TF = path.join(W, 'tool-fixture');
const expected = JSON.parse(fs.readFileSync(path.join(TF, 'expected.json'), 'utf8'));
const testKey = fs.readFileSync(path.join(W, 'k.txt'), 'utf8').split('\n').find((l) => l.startsWith('AGE-SECRET-KEY-1'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let failed = 0; let passed = 0;
const check = (n, ok, d) => { if (ok) passed++; else failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 300) : ''}`); };

const html = path.resolve('docs/backup/tools/backup-tool.html');
const browser = await chromium.launch();
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();
const requests = [];
const errors = [];
await ctx.route('**/*', (route) => { const u = route.request().url(); if (u.startsWith('file://')) return route.continue(); requests.push(u); return route.abort(); });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`file://${html}`);

const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
check("strict CSP: connect-src 'none', no 'unsafe-inline' scripts", /connect-src 'none'/.test(csp) && /default-src 'none'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp), csp);
const blocked = await page.evaluate(async () => { try { await fetch('https://example.com/'); return 'connected'; } catch { return 'blocked'; } });
check('the page itself cannot open a network connection', blocked === 'blocked', blocked);

// 1. key generation
await page.click('#gen');
await page.waitForFunction(() => document.querySelector('#newpub').value.startsWith('age1'));
const pub = await page.inputValue('#newpub');
const priv = await page.inputValue('#newpriv');
check('generates an X25519 key pair in the expected formats', /^age1[0-9a-z]{58}$/.test(pub) && /^AGE-SECRET-KEY-1[0-9A-Z]{58}$/.test(priv));
const kf = path.join(W, 'browser-key.txt'); fs.writeFileSync(kf, priv + '\n', { mode: 0o600 });
check('the age command-line tool derives the same public key from the browser private key', execFileSync('age-keygen', ['-y', kf]).toString().trim() === pub);
const ct = execFileSync('age', ['-r', pub], { input: 'browser-key-roundtrip' });
check('data encrypted to the browser public key decrypts with the browser private key', execFileSync('age', ['-d', '-i', kf], { input: ct }).toString() === 'browser-key-roundtrip');
fs.rmSync(kf);
await page.click('#clearkeys');
check('"Clear" empties both key fields', (await page.inputValue('#newpriv')) === '' && (await page.inputValue('#newpub')) === '');

// 2. verify a real run + restore SQL
await page.setInputFiles('#manifest', path.join(TF, 'manifest.json'));
await page.setInputFiles('#dbfile', path.join(TF, 'db.json.age'));
await page.fill('#privkey', 'AGE-SECRET-KEY-1' + 'Q'.repeat(58));
await page.click('#verify');
await page.waitForFunction(() => document.querySelector('#vermsg').textContent.length > 0);
check('a wrong private key is refused', (await page.textContent('#vermsg')).startsWith('FAILED'), await page.textContent('#vermsg'));
await page.fill('#privkey', testKey);
await page.evaluate(() => { document.querySelector('#vermsg').textContent = ''; });
await page.click('#verify');
await page.waitForFunction(() => document.querySelector('#vermsg').textContent.startsWith('OK') || document.querySelector('#vermsg').textContent.startsWith('FAILED'));
const msg = await page.textContent('#vermsg');
check('the real backup decrypts and matches its manifest (29 tables)', /^OK — 29 tables/.test(msg), msg);
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#sqlbtn')]);
const sqlBytes = fs.readFileSync(await dl.path());
check('restore.sql from the browser is identical to the Node restore.mjs output', sha(sqlBytes) === expected.restoreSqlSha256);
await page.click('#forget');
check('"Forget" clears the key and disables the SQL button', (await page.inputValue('#privkey')) === '' && (await page.isDisabled('#sqlbtn')));

// 3. decrypt a single file (the file map)
await page.fill('#privkey', testKey);
await page.setInputFiles('#agefile', path.join(TF, 'files.json.age'));
const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#decfile')]);
check('single-file decryption gives the exact file map', sha(fs.readFileSync(await dl2.path())) === expected.filemapSha256);

check('no network request was attempted by the page', requests.length === 0, requests);
const unexpected = errors.filter((e) => !e.includes('https://example.com/')); // the deliberate probe above
check('no script errors (other than the blocked probe)', unexpected.length === 0, unexpected);
await browser.close();
console.log(failed ? `\n${failed} FAILED (${passed} passed)` : `\nALL PASSED (${passed})`);
process.exit(failed ? 1 : 0);
