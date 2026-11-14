#!/usr/bin/env node
/**
 * Tests the database connection for the backup WITHOUT exporting data.
 * It reads only metadata (role, privileges, TLS, server version) and one
 * true/false answer per check. No row contents, no counts of patients or cases.
 *
 *   read -rs PGPASSWORD; export PGPASSWORD
 *   DB_URL='postgresql://dlm_backup_reader@<host>:5432/postgres?sslmode=require' node scripts/backup/check-connection.mjs
 */
import { execFileSync } from 'node:child_process';

const { DB_URL } = process.env;
if (!DB_URL) {
  console.error('DB_URL is required');
  process.exit(2);
}
let u;
try { u = new URL(DB_URL); } catch { console.error('DB_URL is not a valid postgresql:// URL'); process.exit(2); }
const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);

const sql = `begin transaction read only;
select json_build_object(
  'user', current_user,
  'server_version', current_setting('server_version'),
  'tls', coalesce((select ssl from pg_stat_ssl where pid = pg_backend_pid()), false),
  'default_read_only', current_setting('default_transaction_read_only'),
  'bypass_rls', (select rolbypassrls from pg_roles where rolname = current_user),
  'superuser', (select rolsuper from pg_roles where rolname = current_user),
  'public_tables', (select count(*) from pg_tables where schemaname = 'public'),
  'readable_tables', (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and has_table_privilege(c.oid, 'SELECT')),
  'writable_tables', (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
      and (has_table_privilege(c.oid, 'INSERT') or has_table_privilege(c.oid, 'UPDATE')
        or has_table_privilege(c.oid, 'DELETE') or has_table_privilege(c.oid, 'TRUNCATE'))),
  'migrations_readable', has_table_privilege('supabase_migrations.schema_migrations', 'SELECT'),
  'storage_list_readable', has_table_privilege('storage.objects', 'SELECT'),
  'auth_access', has_schema_privilege('auth', 'USAGE'),
  'sees_rows', (select exists (select 1 from public.laboratories))
);
commit;`;
let r;
try {
  r = JSON.parse(execFileSync('psql', [DB_URL, '-At', '-q', '-v', 'ON_ERROR_STOP=1'], { input: sql, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim());
} catch (e) {
  const msg = String(e.stderr ?? e.message).split('\n').find((l) => l.trim()) ?? 'connection failed';
  console.error(`✗ could not connect or query: ${msg.replace(/password=[^ ]+/g, 'password=***')}`);
  process.exit(1);
}
let bad = 0;
const check = (name, ok, info = '') => { if (!ok) bad++; console.log(`  ${ok ? '✓' : '✗'} ${name}${info ? ` (${info})` : ''}`); };
console.log(`connected as ${r.user}, PostgreSQL ${r.server_version}`);
check('encrypted connection (TLS)', r.tls || local, local && !r.tls ? 'local test, TLS not required' : '');
check('not a superuser', !r.superuser);
check('read-only by default', r.default_read_only === 'on');
check('cannot write any public table', r.writable_tables === 0, `${r.writable_tables} writable`);
check('can read every public table', r.readable_tables === r.public_tables, `${r.readable_tables}/${r.public_tables}`);
check('can bypass row-level security (needed to see all labs)', r.bypass_rls && r.sees_rows);
check('can read the migration history', r.migrations_readable);
check('can read the storage file list', r.storage_list_readable);
check('no access to login accounts (auth schema)', !r.auth_access);
console.log(bad ? `\n${bad} CHECK(S) FAILED — do not export with this login` : '\nREADY: this login is suitable for the backup export');
process.exit(bad ? 1 : 0);
