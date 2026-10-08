#!/usr/bin/env bash
set -u
failed=0
check() {
  if "$@"; then
    return 0
  else
    printf 'FAILED: %s\n' "$*" >&2
    failed=1
  fi
}
printf 'Basic environment check only; this is not an application test.\n'
check git --version
check python3 --version
check node --version
check npm --version
check docker version
check docker compose version
if command -v node >/dev/null 2>&1; then
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  expected="$(tr -d '\r\n' < "$script_dir/../.nvmrc")"
  actual="$(node -p 'process.versions.node')"
  if [ "$actual" != "$expected" ]; then
    printf 'Node mismatch: expected %s, found %s. Run nvm install and nvm use in the repo.\n' "$expected" "$actual" >&2
    failed=1
  fi
fi
if [ "$failed" -ne 0 ]; then
  printf 'Resolve the failed prerequisite before using this machine for integration.\n' >&2
fi
exit "$failed"
