#!/bin/bash
set -e

# Colors for output
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}Terra Rosa — Development Startup${NC}"
echo "================================"

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
      -e POSTGRES_USER=terrarosa \
      -e POSTGRES_PASSWORD=devpass \
      -e POSTGRES_DB=terrarosa \
      -p 5432:5432 \
      -v terra-rosa-db:/var/lib/postgresql/data \
      postgres:16-alpine
  fi
  
  # Wait for database to be ready
  echo "  Waiting for database to be ready..."
  for i in {1..30}; do
    if podman exec "$DB_CONTAINER" pg_isready -U terrarosa -d terrarosa >/dev/null 2>&1; then
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
