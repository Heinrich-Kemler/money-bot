#!/usr/bin/env bash
# Grokbot/Life Admin host-widget smoke: MCP request_spend → POST /host/widget-decision
# (Bearer host:<HOST_API_TOKEN>) → APPROVED → handoff.
# Does NOT fetch approveUrl. Requires wrangler already running with .dev.vars.
set -euo pipefail

BASE="${MONEY_BOT_URL:-http://localhost:8787}"
TENANT="${SMOKE_TENANT:-smoke-user}"
AUTH="Authorization: Bearer test:${TENANT}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "${HOST_API_TOKEN:-}" && -f "${ROOT}/.dev.vars" ]]; then
  HOST_API_TOKEN="$(
    awk -F= '/^HOST_API_TOKEN=/{print substr($0, index($0, "=")+1); exit}' "${ROOT}/.dev.vars"
  )"
  export HOST_API_TOKEN
fi

if [[ -z "${HOST_API_TOKEN:-}" ]]; then
  echo "HOST_API_TOKEN is unset. Copy .dev.vars.example → .dev.vars" >&2
  exit 1
fi

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
export HOST_API_TOKEN

exec node --experimental-strip-types "${BASH_SOURCE[0]%/*}/smoke-widget-approve.mjs"
