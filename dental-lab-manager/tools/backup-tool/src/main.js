// Offline Dental Lab Manager backup tool (runs entirely in the browser).
// No network: the page's Content-Security-Policy forbids every connection.
import * as age from 'age-encryption';
import { buildRestoreSql, verifyAgainstManifest } from '../../../scripts/backup/restore-core.mjs';

const $ = (id) => document.getElementById(id);
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256hex = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));
const readFile = (input) => new Promise((resolve, reject) => {
  const f = input.files?.[0];
  if (!f) return reject(new Error('choose a file first'));
  const r = new FileReader();
  r.onload = () => resolve({ name: f.name, bytes: new Uint8Array(r.result) });
  r.onerror = () => reject(new Error('could not read the file'));
  r.readAsArrayBuffer(f);
});
const say = (id, text, ok = true) => { const el = $(id); el.textContent = text; el.className = ok ? 'ok' : 'bad'; };
const download = (name, bytes, type = 'application/octet-stream') => {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const identity = () => {
  const k = $('privkey').value.trim();
  if (!/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/.test(k)) throw new Error('paste a private key starting with AGE-SECRET-KEY-1');
  return k;
};
const decrypt = async (bytes) => { const d = new age.Decrypter(); d.addIdentity(identity()); return await d.decrypt(bytes); };

// 1. key generation
$('gen').onclick = async () => {
  const id = await age.generateX25519Identity();
  $('newpriv').value = id;
  $('newpub').value = await age.identityToRecipient(id);
  say('genmsg', 'New key pair created in this browser. Save the PRIVATE key now (password manager and paper). It is not stored anywhere and is lost when you close this page.');
};
// 1b. Backup Runner token: the token goes to the runner project, only its HASH to production
$('gentoken').onclick = async () => {
  const token = `dlmbk1_${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
  const hash = await sha256hex(new TextEncoder().encode(token));
  const label = `runner ${new Date().toISOString().slice(0, 10)}`;
  $('newtoken').value = token;
  $('tokenhash').value = hash;
  $('tokensql').value = `select dlm_backup.register_token('${hash}', '${label}');`;
  say('tokenmsg', 'New token created in this browser. Put the TOKEN into the runner project secret DLM_PROD_BACKUP_TOKEN; run the SQL line in the PRODUCTION SQL editor (it contains only the hash).');
};
$('cleartoken').onclick = () => { $('newtoken').value = ''; $('tokenhash').value = ''; $('tokensql').value = ''; say('tokenmsg', 'Cleared.'); };
$('clearkeys').onclick = () => { $('newpriv').value = ''; $('newpub').value = ''; $('privkey').value = ''; say('genmsg', 'Cleared.'); };

// 2. verify a backup run (+ optional restore SQL)
let lastBackup = null;
$('verify').onclick = async () => {
  lastBackup = null;
  $('sqlbtn').disabled = true;
  try {
    const man = JSON.parse(new TextDecoder().decode((await readFile($('manifest'))).bytes));
    const db = (await readFile($('dbfile'))).bytes;
    if (man.db?.cipher_sha256 && (await sha256hex(db)) !== man.db.cipher_sha256) throw new Error('the encrypted snapshot does not match the manifest (wrong or damaged file)');
    const plain = await decrypt(db);
    const b = JSON.parse(new TextDecoder().decode(plain));
    plain.fill(0);
    const r = await verifyAgainstManifest(b, man, sha256hex);
    if (!r.ok) throw new Error(`mismatch in: ${r.problems.join(', ')}`);
    lastBackup = b;
    $('sqlbtn').disabled = false;
    // which public keys was this run encrypted to?
    let who = '';
    if (Array.isArray(man.recipients)) {
      const mine = await age.identityToRecipient(identity());
      const others = man.recipients.filter((x) => x !== mine).length;
      who = others ? ` WARNING: also encrypted to ${others} other key(s) — check they are yours.` : ' Encrypted to your key only.';
    }
    say('vermsg', `OK — ${r.tables} tables, ${r.rows} rows, exported ${man.exported_at}. The backup decrypts and matches its manifest.${who}`, !who.includes('WARNING'));
  } catch (e) {
    say('vermsg', `FAILED — ${e.message}`, false);
  }
};
$('sqlbtn').onclick = () => {
  if (!lastBackup) return;
  const rnd = () => hex(crypto.getRandomValues(new Uint8Array(2)));
  download('restore.sql', new TextEncoder().encode(buildRestoreSql(lastBackup, rnd).sql), 'application/sql');
  say('vermsg', 'restore.sql downloaded. It contains all data in plain text: run it in the SQL editor, then delete it.');
};
$('forget').onclick = () => { lastBackup = null; $('sqlbtn').disabled = true; $('privkey').value = ''; say('vermsg', 'Decrypted data and key removed from this page.'); };

// 3. decrypt any .age file (file map or a stored file)
$('decfile').onclick = async () => {
  try {
    const f = await readFile($('agefile'));
    const plain = await decrypt(f.bytes);
    download(f.name.replace(/\.age$/, '') || 'decrypted', plain);
    say('decmsg', `Decrypted ${plain.length} bytes and downloaded. Delete the file when you no longer need it.`);
  } catch (e) {
    say('decmsg', `FAILED — ${e.message}`, false);
  }
};
