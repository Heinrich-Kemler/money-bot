#!/usr/bin/env bash
# First-testable Approve smoke: MCP request_spend → browser assertion → APPROVED → handoff.
# Requires `npm start` (wrangler dev) already running with .dev.vars from .dev.vars.example.
set -euo pipefail

BASE="${MONEY_BOT_URL:-http://localhost:8787}"
TENANT="${SMOKE_TENANT:-smoke-user}"
AUTH="Authorization: Bearer test:${TENANT}"

if ! command -v node >/dev/null; then
  echo "node is required" >&2
  exit 1
fi

echo "Checking ${BASE} …"
if ! curl -fsS "${BASE}/" >/dev/null; then
  echo "Money Bot is not reachable at ${BASE}. Start it with: cp .dev.vars.example .dev.vars && npm start" >&2
  exit 1
fi

export MONEY_BOT_URL="${BASE}"
export SMOKE_TENANT="${TENANT}"
export AUTH_HEADER="${AUTH}"

exec node --experimental-strip-types "${BASH_SOURCE[0]%/*}/smoke-approve.mjs"
