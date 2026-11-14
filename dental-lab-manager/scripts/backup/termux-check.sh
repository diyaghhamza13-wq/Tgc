#!/usr/bin/env bash
# Checks that the phone (Termux) has everything the backup needs.
# It touches no database and no backup. Optional: pass your key file to also
# check that it can encrypt and decrypt:  bash scripts/backup/termux-check.sh ~/dlm-backup-key.txt
set -u
ok=0; bad=0
pass() { echo "  ✓ $1"; ok=$((ok+1)); }
fail() { echo "  ✗ $1"; bad=$((bad+1)); }

echo "1. tools"
for c in psql node age age-keygen git; do
  if command -v "$c" >/dev/null 2>&1; then pass "$c found: $("$c" --version 2>&1 | head -1)"; else fail "$c missing (pkg install postgresql nodejs age git)"; fi
done
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$major" -ge 18 ]; then pass "node $major supports built-in fetch"; else fail "node $major is too old (need 18+)"; fi
fi

echo "2. encryption round trip (in memory, no files kept)"
if command -v age >/dev/null 2>&1 && command -v age-keygen >/dev/null 2>&1; then
  if [ "${1:-}" != "" ]; then
    key="$1"
    if [ ! -f "$key" ]; then fail "key file $key not found"; else
      perms=$(stat -c %a "$key" 2>/dev/null || echo "?")
      [ "$perms" = "600" ] && pass "key file permissions 600" || fail "key file permissions are $perms (run: chmod 600 $key)"
      pub=$(age-keygen -y "$key") && pass "public key: $pub"
      out=$(echo dlm-check | age -r "$pub" | age -d -i "$key") && [ "$out" = "dlm-check" ] && pass "your key encrypts and decrypts" || fail "your key round trip failed"
    fi
  else
    tmp=$(mktemp -d); age-keygen -o "$tmp/k" 2>/dev/null
    out=$(echo dlm-check | age -r "$(age-keygen -y "$tmp/k")" | age -d -i "$tmp/k")
    rm -rf "$tmp"
    [ "$out" = "dlm-check" ] && pass "age works (throwaway key, deleted)" || fail "age round trip failed"
  fi
fi

echo "3. repository scripts"
for f in scripts/backup/export.mjs scripts/backup/verify.mjs scripts/backup/upload.mjs scripts/backup/check-connection.mjs scripts/backup/restore.mjs; do
  [ -f "$f" ] && node --check "$f" 2>/dev/null && pass "$f" || fail "$f missing or invalid (run from tgc/dental-lab-manager)"
done

echo
[ $bad -eq 0 ] && echo "ALL CHECKS PASSED ($ok)" || echo "$bad CHECK(S) FAILED"
exit $bad
