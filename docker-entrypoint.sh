#!/bin/sh
# Runs once per container start:
# 1. Syncs the database schema (safe to re-run — no-op if nothing changed).
# 2. Seeds baseline data (rooms + first admin user) only if the database is empty.
# 3. Starts the app.
set -e

echo "Terra Rosa app: syncing database schema..."
npm run db:push -- --force

echo "Terra Rosa app: checking baseline data..."
npm run db:seed

echo "Terra Rosa app: starting server..."
exec npm run start
