#!/usr/bin/env bash
# ==============================================================================
# SakkuPay Staging Server Launcher (Linux / POSIX)
# Runs isolated staging server on port 3001 using environment file staging/.env.staging
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "$SCRIPT_DIR/.env.staging" ]; then
  echo "Error: staging/.env.staging not found."
  echo "Please create staging/.env.staging with required staging secrets before running."
  exit 1
fi

echo "Starting SakkuPay Staging using staging/.env.staging..."
exec node --env-file="$SCRIPT_DIR/.env.staging" server.js
