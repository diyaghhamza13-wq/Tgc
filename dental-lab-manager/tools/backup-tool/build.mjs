// Builds the single self-contained offline page docs/backup/tools/backup-tool.html.
//   cd tools/backup-tool && npm ci && npm run build
import * as esbuild from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs';

const out = await esbuild.build({
  entryPoints: ['src/main.js'], bundle: true, format: 'iife', minify: true, write: false,
  target: ['chrome100', 'firefox100', 'safari15'], legalComments: 'none',
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const scriptHash = crypto.createHash('sha256').update(js).digest('base64');
const csp = `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'`;
const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Dental Lab Manager — offline backup tool</title>
<style>
body{font-family:system-ui,sans-serif;max-width:720px;margin:0 auto;padding:16px;background:#0b1726;color:#e8edf3}
h1{font-size:20px;color:#d6ad55}h2{font-size:17px;color:#d6ad55;margin-top:28px}
section{border:1px solid #2a3a52;border-radius:10px;padding:14px;margin:12px 0}
textarea,input[type=file]{width:100%;box-sizing:border-box;margin:6px 0;font-family:monospace;font-size:13px}
textarea{min-height:58px;background:#101e30;color:#e8edf3;border:1px solid #2a3a52;border-radius:6px;padding:6px}
button{background:#d6ad55;color:#1a1206;border:0;border-radius:6px;padding:10px 14px;font-weight:700;margin:4px 4px 4px 0}
button:disabled{opacity:.4}.ok{color:#5fd38d}.bad{color:#ff6b6b}.note{color:#9fb0c4;font-size:13px}
</style></head><body>
<h1>Dental Lab Manager — offline backup tool</h1>
<p class="note">Everything happens in this browser. The page cannot connect to the internet (its security policy forbids it). Nothing is saved: closing the page erases keys and decrypted data.</p>

<h2>1. Create your key pair (once)</h2>
<section>
<button id="gen">Create a new key pair</button> <button id="clearkeys">Clear</button>
<p id="genmsg" class="note"></p>
<label>PUBLIC key — goes into the Supabase function secret <code>DLM_BACKUP_AGE_RECIPIENTS</code> (not secret):</label>
<textarea id="newpub" readonly></textarea>
<label>PRIVATE key — save in your password manager and on paper. Never send it to anyone, including Claude:</label>
<textarea id="newpriv" readonly></textarea>
</section>

<h2>2. Verify a backup (quarterly drill) and, if needed, create the restore SQL</h2>
<section>
<label>manifest.json of the run:</label><input type="file" id="manifest" accept=".json">
<label>db.json.age of the same run:</label><input type="file" id="dbfile" accept=".age">
<label>Your PRIVATE key (paste from your password manager):</label>
<textarea id="privkey" autocomplete="off" spellcheck="false"></textarea>
<button id="verify">Decrypt and verify</button> <button id="sqlbtn" disabled>Download restore.sql</button> <button id="forget">Forget data and key</button>
<p id="vermsg" class="note"></p>
</section>

<h2>3. Decrypt a single file (file map or a stored file)</h2>
<section>
<input type="file" id="agefile" accept=".age"> <button id="decfile">Decrypt and download</button>
<p id="decmsg" class="note"></p>
<p class="note">Uses the private key pasted in section 2.</p>
</section>
<script>${js}</script>
</body></html>
`;
fs.writeFileSync('../../docs/backup/tools/backup-tool.html', html);
console.log(`built docs/backup/tools/backup-tool.html (${html.length} bytes, script sha256-${scriptHash})`);
