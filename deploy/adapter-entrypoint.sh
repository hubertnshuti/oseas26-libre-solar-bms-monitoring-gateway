#!/bin/sh
set -eu
if [ ! -s /run/secrets/adapter.key ]; then
  echo "Adapter key missing: complete the documented company provisioning first." >&2
  exit 1
fi
MPM_API_KEY=$(cat /run/secrets/adapter.key)
export MPM_API_KEY
exec node --import tsx app/mpm-ingest/main.ts
