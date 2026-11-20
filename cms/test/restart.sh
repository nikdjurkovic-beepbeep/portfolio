#!/bin/bash
# Fresh local environment: mock GitHub/Pages/checker + wrangler dev with an empty local D1.
pkill -f mock-github.mjs; pkill -f "wrangler dev"; pkill -f workerd; sleep 1
cd "$(dirname "$0")/.."
node test/mock-github.mjs "$(cd .. && pwd)" > /tmp/mock.log 2>&1 &
cd worker && rm -rf .wrangler/state && npx wrangler d1 migrations apply nikolaseo-cms --local > /tmp/migrate.log 2>&1
npx wrangler dev --local --port 8787 --test-scheduled > /tmp/wrangler.log 2>&1 &
for i in $(seq 1 30); do curl -s localhost:8787/cms-api/setup >/dev/null 2>&1 && break; sleep 1; done
echo ready
