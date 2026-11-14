/**
 * Shared, security-critical helpers for the backup scripts.
 *
 *  - parseDbUrl():   strict DB_URL validation (F1, F2)
 *  - psqlJson():     runs psql with -X (no ~/.psqlrc), a sanitized environment
 *                    and redacted errors (F1, F4, F6)
 *  - redact():       removes passwords / connection strings from any text (F4)
 *  - LOGIN_CHECK_SQL + evaluateLogin(): what the connected login can do, read
 *                    from the ESTABLISHED connection (real TLS, privileges in
 *                    every accessible schema, RLS bypass) (F1, F5, review)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
// Only these URL parameters are accepted; anything else (host, hostaddr,
// service, options, sslcert, …) could redirect or weaken the connection.
const ALLOWED_PARAMS = new Set(['sslmode', 'sslrootcert', 'connect_timeout', 'application_name']);
// libpq environment variables that could override or weaken the URL.
const STRIP_ENV = ['PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGSERVICE', 'PGSERVICEFILE',
  'PGSSLMODE', 'PGSSLROOTCERT', 'PGSSLCERT', 'PGSSLKEY', 'PGSSLCRL', 'PGSSLCRLDIR', 'PGREQUIRESSL', 'PGGSSENCMODE',
  'PGOPTIONS', 'PGSYSCONFDIR', 'PGTARGETSESSIONATTRS', 'PGLOCALEDIR', 'PSQLRC', 'PGSSLNEGOTIATION'];

export class UrlError extends Error {}

/**
 * Validates DB_URL. Rules:
 *  - postgresql:// or postgres:// with exactly one host, no host lists;
 *  - only the parameters in ALLOWED_PARAMS, each at most once;
 *  - remote hosts: sslmode=verify-full AND sslrootcert=<existing readable file>
 *    (TLS with certificate and host-name verification);
 *  - loopback hosts (local tests): TLS optional.
 */
export function parseDbUrl(raw) {
  if (!raw) throw new UrlError('DB_URL is required');
  let u;
  try { u = new URL(raw); } catch { throw new UrlError('DB_URL is not a valid postgresql:// URL'); }
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') throw new UrlError('DB_URL must start with postgresql://');
  if (!u.hostname || /[,]/.test(u.host)) throw new UrlError('DB_URL must name exactly one host');
  const seen = new Set();
  for (const key of u.searchParams.keys()) {
    if (!ALLOWED_PARAMS.has(key)) throw new UrlError(`DB_URL parameter "${key}" is not allowed`);
    if (seen.has(key)) throw new UrlError(`DB_URL parameter "${key}" appears more than once`);
    seen.add(key);
  }
  const local = LOOPBACK.has(u.hostname);
  const sslmode = u.searchParams.get('sslmode');
  const rootcert = u.searchParams.get('sslrootcert');
  if (!local) {
    if (sslmode !== 'verify-full') throw new UrlError('remote DB_URL must use sslmode=verify-full (certificate and host-name verification)');
    if (!rootcert) throw new UrlError('remote DB_URL must set sslrootcert=<path to the Supabase CA certificate>');
    try { fs.accessSync(rootcert, fs.constants.R_OK); } catch { throw new UrlError('sslrootcert file not found or not readable'); }
  }
  return { url: raw, host: u.hostname, local, hasPassword: u.password !== '', sslmode, rootcert };
}

/** Environment for psql: no libpq overrides, no ~/.psqlrc influence. */
export function sanitizedEnv() {
  const env = { ...process.env };
  for (const k of STRIP_ENV) delete env[k];
  return env;
}

/** Removes passwords and connection strings from text. */
export function redact(text, secrets = []) {
  let s = String(text ?? '');
  s = s.replace(/postgres(ql)?:\/\/[^\s'"]*/gi, '<connection string>');
  s = s.replace(/(password\s*=\s*)('[^']*'|"[^"]*"|\S+)/gi, '$1***');
  const pw = process.env.PGPASSWORD;
  for (const v of [pw, ...secrets]) if (v && v.length >= 4) s = s.split(v).join('***');
  return s;
}

/** Runs one SQL text through psql (-X, sanitized env) and parses the single JSON result. */
export function psqlJson(db, sql) {
  let out;
  try {
    out = execFileSync('psql', ['-X', '-At', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db.url],
      { input: sql, env: sanitizedEnv(), stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 30 });
  } catch (e) {
    const first = String(e.stderr ?? '').split('\n').find((l) => l.trim()) ?? 'psql failed';
    throw new Error(redact(first, [db.url]));
  }
  try {
    return JSON.parse(out.toString().trim());
  } catch {
    throw new Error('unexpected psql output (not JSON)');
  }
}

/**
 * Facts about the login, read from the established connection itself.
 * "accessible schemas" = every schema where the login has USAGE, except the
 * system catalogs (pg_catalog, information_schema), whose PUBLIC grants are
 * standard PostgreSQL (e.g. session settings via pg_settings).
 */
export const LOGIN_CHECK_SQL = `begin transaction read only;
with s as (
  select n.oid, n.nspname from pg_namespace n
  where has_schema_privilege(n.oid, 'USAGE')
    and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'
    -- pg_net's schema: Supabase grants PUBLIC write access to its queue when the
    -- extension is installed (not revocable by postgres) — see SECURITY-REVIEW.md
    and n.nspname <> 'net'
)
select json_build_object(
  'user', current_user,
  'server_version', current_setting('server_version'),
  'tls', coalesce((select ssl from pg_stat_ssl where pid = pg_backend_pid()), false),
  'tls_version', (select version from pg_stat_ssl where pid = pg_backend_pid()),
  'default_read_only', current_setting('default_transaction_read_only'),
  'superuser', (select rolsuper from pg_roles where rolname = current_user),
  'bypass_rls', (select rolbypassrls from pg_roles where rolname = current_user),
  'role_attrs', (select json_build_object('createdb', rolcreatedb, 'createrole', rolcreaterole, 'replication', rolreplication)
                 from pg_roles where rolname = current_user),
  'member_of', (select coalesce(json_agg(r.rolname order by r.rolname), '[]'::json) from pg_auth_members m join pg_roles r on r.oid = m.roleid
                where m.member = (select oid from pg_roles where rolname = current_user)),
  'db_create', has_database_privilege(current_database(), 'CREATE'),
  'schemas', (select coalesce(json_agg(nspname order by nspname), '[]'::json) from s),
  'create_in_schemas', (select coalesce(json_agg(nspname order by nspname), '[]'::json) from s where has_schema_privilege(s.oid, 'CREATE')),
  'writable_relations', (select coalesce(json_agg(s.nspname || '.' || c.relname order by 1), '[]'::json)
      from pg_class c join s on s.oid = c.relnamespace
      where c.relkind in ('r', 'p', 'v', 'm', 'f')
        and (has_table_privilege(c.oid, 'INSERT') or has_table_privilege(c.oid, 'UPDATE')
          or has_table_privilege(c.oid, 'DELETE') or has_table_privilege(c.oid, 'TRUNCATE')
          or has_table_privilege(c.oid, 'TRIGGER'))),
  'writable_sequences', (select coalesce(json_agg(s.nspname || '.' || c.relname order by 1), '[]'::json)
      from pg_class c join s on s.oid = c.relnamespace
      where c.relkind = 'S' and case when c.relkind = 'S' then has_sequence_privilege(c.oid, 'UPDATE') else false end),
  'definer_functions', (select coalesce(json_agg(s.nspname || '.' || p.proname order by 1), '[]'::json)
      from pg_proc p join s on s.oid = p.pronamespace
      where p.prosecdef and has_function_privilege(p.oid, 'EXECUTE')),
  'public_tables', (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')),
  'readable_public_tables', (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
      and has_table_privilege(c.oid, 'SELECT')),
  'migrations_readable', has_table_privilege('supabase_migrations.schema_migrations', 'SELECT'),
  'storage_list_readable', has_table_privilege('storage.objects', 'SELECT'),
  'auth_access', has_schema_privilege('auth', 'USAGE'),
  'vault_access', coalesce((select has_schema_privilege(oid, 'USAGE') from pg_namespace where nspname = 'vault'), false),
  'sees_rows', (select exists (select 1 from public.laboratories))
);
commit;`;

/**
 * Turns the facts into named checks. A privileged login (the full postgres
 * login) is only tolerated for LOCAL tests with allowPrivileged.
 */
export function evaluateLogin(r, db, { allowPrivileged = false } = {}) {
  const priv = allowPrivileged && db.local;
  const checks = [
    ['encrypted connection (TLS) on the established session', r.tls || db.local, r.tls ? r.tls_version : db.local ? 'local test, TLS not required' : 'NOT ENCRYPTED'],
    ['certificate and host name verified (sslmode=verify-full)', db.local || db.sslmode === 'verify-full', db.sslmode ?? ''],
    ['not a superuser', priv || !r.superuser],
    ['no CREATEDB / CREATEROLE / REPLICATION', priv || (!r.role_attrs.createdb && !r.role_attrs.createrole && !r.role_attrs.replication)],
    ['not a member of any other role', priv || r.member_of.length === 0, r.member_of.join(', ')],
    ['read-only by default', priv || r.default_read_only === 'on'],
    ['cannot create objects (database or any schema)', priv || (!r.db_create && r.create_in_schemas.length === 0), r.create_in_schemas.join(', ')],
    ['cannot write, truncate or add triggers to any table or view in any accessible schema', priv || r.writable_relations.length === 0, r.writable_relations.slice(0, 5).join(', ')],
    ['cannot change any sequence', priv || r.writable_sequences.length === 0, r.writable_sequences.slice(0, 5).join(', ')],
    ['cannot execute any SECURITY DEFINER function', priv || r.definer_functions.length === 0, r.definer_functions.slice(0, 5).join(', ')],
    ['no access to login accounts (auth) or secrets (vault)', !r.auth_access && !r.vault_access || priv],
    ['bypasses row-level security, so the backup is complete', (r.bypass_rls || r.superuser) && r.sees_rows],
    ['can read every public table', r.readable_public_tables === r.public_tables, `${r.readable_public_tables}/${r.public_tables}`],
    ['can read the migration history', r.migrations_readable],
    ['can read the storage file list', r.storage_list_readable],
  ];
  return checks.map(([name, ok, info]) => ({ name, ok: !!ok, info: info ?? '' }));
}
