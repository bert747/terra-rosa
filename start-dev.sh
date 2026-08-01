#!/bin/bash
set -e

# Colors for output
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}Terra Rosa — Development Startup${NC}"
echo "================================"

if [ ! -f .env ]; then
  echo -e "${YELLOW}No .env found — copy .env.example to .env first (see README).${NC}"
  exit 1
fi

# Read the DB settings the app will actually use, so the container we
# create/reuse always matches .env instead of a hardcoded value.
set -a
source .env
set +a
POSTGRES_USER="${POSTGRES_USER:-terrarosa}"
POSTGRES_DB="${POSTGRES_DB:-terrarosa}"

# Check if database container is running
DB_CONTAINER="terra-rosa-db"
if podman ps | grep -q "$DB_CONTAINER"; then
  echo -e "${GREEN}✓${NC} Database container is already running"
else
  echo -e "${YELLOW}Starting database container...${NC}"

  # Check if container exists but is stopped
  if podman ps -a | grep -q "$DB_CONTAINER"; then
    echo "  Restarting stopped container..."
    podman start "$DB_CONTAINER"
  else
    echo "  Creating new container..."
    podman run -d --name "$DB_CONTAINER" \
      -e POSTGRES_USER="$POSTGRES_USER" \
      -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
      -e POSTGRES_DB="$POSTGRES_DB" \
      -p 5432:5432 \
      -v terra-rosa-db:/var/lib/postgresql/data \
      postgres:16-alpine
  fi

  # Wait for database to be ready
  echo "  Waiting for database to be ready..."
  for i in {1..30}; do
    if podman exec "$DB_CONTAINER" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
      echo -e "${GREEN}✓${NC} Database is ready"
      break
    fi
    if [ $i -eq 30 ]; then
      echo -e "${YELLOW}Database startup timeout${NC}"
      exit 1
    fi
    sleep 1
  done
fi

# The container's password is only set at first initdb — if .env's password
# was changed/reset since (e.g. by re-running `cp .env.example .env` on an
# existing setup), auth will fail. Catch that here instead of deep inside
# a Next.js request.
echo "  Verifying .env credentials match the running container..."
if ! node -e "
require('postgres')(process.env.DATABASE_URL, { max: 1 })\`select 1\`
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
" >/dev/null 2>&1; then
  echo -e "${YELLOW}✗ POSTGRES_PASSWORD in .env doesn't match the terra-rosa-db container.${NC}"
  echo "  This container's password was set once at creation and won't change"
  echo "  just because .env changed (e.g. after re-running 'cp .env.example .env')."
  echo ""
  echo "  Fix one of these:"
  echo "    a) Set POSTGRES_PASSWORD/DATABASE_URL in .env back to the container's"
  echo "       real password."
  echo "    b) Recreate the container with the current .env password (wipes local"
  echo "       dev data): podman rm -f $DB_CONTAINER && podman volume rm terra-rosa-db"
  echo "       then run this script again."
  exit 1
fi
echo -e "${GREEN}✓${NC} Database credentials OK"

# Push database schema
echo -e "${YELLOW}Pushing database schema...${NC}"
npm run db:push

# Seed database
echo -e "${YELLOW}Seeding database...${NC}"
npm run db:seed

# Start development server
echo -e "${GREEN}✓${NC} Starting Next.js development server..."
echo ""
npm run dev
