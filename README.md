# Terra Rosa — Room Management App

Internal tool for tracking room occupancy and bookings. Built to replace a
spreadsheet, not to become an enterprise system.

Stack: Next.js (App Router, TypeScript) + plain CSS (`app/globals.css`, no
Tailwind despite the devDependency) + Drizzle ORM + PostgreSQL, deployed as
three Docker Compose services (`app`, `db`, `caddy`) on a single GCP
`e2-micro` VM (free tier).

## Data model

Physical layout is independent of bookings — a bed's room, its pairing with
another bed, and its solo/couple mode can all change over time regardless of
whether it currently has a booking:

- **`floors`** → **`rooms`** (each room belongs to one floor).
- **`beds`** — no name or number, just a `type` (free text, e.g. "Single",
  "Queen", "1.5"). The id alone distinguishes beds for bookings.
- **`bed_locations`** — one row per stint a bed spends in a room
  (`start_date`/`end_date`, `end_date` null = currently there). A bed's
  "room" at any point in time is derived from this, never stored directly on
  the bed.
- **`joined_beds`** — two *Single* beds pushed together for a date range,
  either `mode: "double"` (sleeps 2, both independently bookable) or
  `mode: "solo"` (pushed together for comfort, sold as one spot).
- **`bed_solo_periods`** — the equivalent concept for a single physical
  two-person bed (anything `bedCapacity()` in `src/lib/bed-types.ts` treats
  as capacity 2 — currently "1.5", "double", or "queen" in the type string).
  A covering row here sells that bed as one spot instead of two for that
  range; no row means it's selling as a couple (the default for these bed
  types).
- **`bookings`** — minimal: `guest_name`, `arrival_date`/`departure_date`,
  optional `group_id`, nullable `bed_id` (an unassigned booking still exists,
  it just isn't placed on the grid yet), and `dietaries_tags` (jsonb).
- **`events`** — independent multi-day bands (retreats etc.) shown across the
  top of the grid; not tied to rooms or bookings.
- **`users`** — `editor` (full CRUD) or `viewer` (read-only) role.

`daily_meal_notes` is still declared in `src/db/schema.ts` but unused by the
app — kept only so `drizzle-kit push` doesn't treat it as an orphaned table
to drop.

## Project layout

```
app/
  page.tsx              Redirects to /grid (or /login if not signed in)
  login/                 Login form
  grid/                  The main occupancy grid (see "The grid" below)
  bookings/              Bookings list, new-booking form, per-booking page
  events/                Events / retreat periods
  settings/layout/       Property Layout: floors/rooms/beds CRUD, bed
                          placement, and manual bed-join management
  users/                 User list (admin)
  api/                   Route handlers backing the pages above — each write
                          route starts with requireEditor(), reads are open
                          to any authed user
src/
  db/                    Drizzle schema (schema.ts), DB client
  lib/                   auth.ts, occupancy/date math, bed-types.ts
                          (bedCapacity()), grid.ts + grid-data.ts (the grid's
                          date-exact rendering engine), event-lanes.ts,
                          room-colours.ts
  components/            GridCanvas.tsx (the grid itself), ContextMenu.tsx,
                          ToastStack.tsx, Nav.tsx / NavTabs.tsx, BackButton.tsx,
                          DietaryTagInput.tsx
scripts/
  seed.ts                Idempotent baseline seed — creates the first admin
                          user only if the users table is empty
  create-user.ts          Add further users after that (no signup route by
                          design): CREATE_USER_PASSWORD='...' npm run
                          user:create -- --name X --email x@y.com --role editor
drizzle/*.sql             Hand-written migrations, applied manually (see
                          below) — not run automatically by db:push
docker-compose.yml        app + db (Postgres 16) + caddy (reverse proxy / TLS)
Dockerfile                Single-stage Next.js production image
Caddyfile                 Reverse proxy config, auto-HTTPS via Let's Encrypt
docker-entrypoint.sh      Runs schema sync + seed + `next start` on container boot
```

## Local development (no Docker)

Requires Node 20+.

### Quick start (one command)

```bash
npm install
cp .env.example .env      # edit if needed
npm run start-dev         # starts DB, pushes schema, seeds, runs dev server
```

Run this in a normal foreground terminal, not backgrounded/piped: the schema
push step (`drizzle-kit push`) can occasionally show an interactive
confirmation prompt if it detects an ambiguous schema change, and it needs a
real terminal to show/answer that.

### Manual setup

```bash
npm install
cp .env.example .env      # edit DATABASE_URL to point at a local/dev Postgres
npm run db:push           # sync schema
npm run db:seed           # creates the first admin user (SEED_ADMIN_* in .env)
npm run dev                # http://localhost:3000
```

You need a Postgres instance reachable at the `DATABASE_URL` in `.env`. Easiest
local option if you don't already have one running:

```bash
docker run --name terrarosa-dev -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=terrarosa \
  -p 5432:5432 -d postgres:16-alpine
```

Then set `DATABASE_URL=postgres://postgres:devpass@localhost:5432/terrarosa` in `.env`.

`npm run db:push` (drizzle-kit push) syncs table/column shape from
`src/db/schema.ts`. It does **not** apply the hand-written migrations under
`drizzle/*.sql` (index/constraint definitions, and any structural change that
predates the current schema.ts) — apply those manually against the DB, e.g.:

```bash
psql "$DATABASE_URL" -f drizzle/0004_bed_solo_periods.sql
```

or, against the Docker Compose Postgres container:

```bash
docker compose exec -T db psql -U terrarosa -d terrarosa -f - < drizzle/0004_bed_solo_periods.sql
```

There is no floor/room/bed seed data — set up your property layout in
**Property Layout** (`/settings/layout`) after logging in.

## Running the whole stack locally with Docker Compose

```bash
cp .env.example .env      # fill in real values, especially SESSION_SECRET
                           #   (generate with: openssl rand -hex 32)
docker compose up -d --build
```

- App: http://localhost (via Caddy) or http://localhost:3000 directly.
- First run auto-creates the admin user from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` in `.env`.

## Deploying to GCP

These steps use the Google Cloud Console (console.cloud.google.com) directly —
no `gcloud` CLI required. Everything from step 5 onward happens in a terminal
on the VM itself, which the Console gives you a browser button for (no SSH
client to install locally either).

### 1. Project and billing

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and,
   top-left project picker, **New Project**. Name it (e.g. `terra-rosa`) and
   create it.
2. If this Google account has never used Cloud before, you'll be prompted to
   set up **Billing** (a billing account is required even for Always Free
   tier resources — you won't be charged as long as you stay within the free
   e2-micro limits described below). Follow the prompt, then make sure the
   new project is linked to that billing account (**Billing** in the left
   nav → **Link a billing account** if it isn't already).

### 2. Create the VM

1. Left nav (hamburger menu, top-left) → **Compute Engine** → **VM instances**.
   First visit prompts you to enable the Compute Engine API — click **Enable**
   and wait a minute for it to activate.
2. **Create instance**.
3. **Name**: `terra-rosa` (or anything).
4. **Region**: `us-central1`, `us-west1`, or `us-east1` — these are the
   regions covered by the Compute Engine Always Free tier. **Zone**: any
   zone within it.
5. **Machine configuration** → **Machine family: E2** → **Series: E2** →
   **Machine type: e2-micro** (the free-tier size — anything larger will be
   billed).
6. **Boot disk** → **Change** → **Operating system: Ubuntu**, **Version:
   Ubuntu 24.04 LTS (or 22.04 LTS)**, **Boot disk type: Standard persistent
   disk**, size **30 GB** (the free-tier limit) → **Select**.
7. **Firewall** section (same page): tick **Allow HTTP traffic** and **Allow
   HTTPS traffic**. This auto-creates firewall rules tagged `http-server` /
   `https-server` that this VM picks up — Caddy needs both ports open to get
   a Let's Encrypt certificate and serve the app.
8. **Create**. The instance appears in the VM instances list with an
   **External IP** — note it down.

### 3. Lock down SSH

By default the project's `default-allow-ssh` firewall rule (VPC network →
**Firewall**, in the left nav) allows port 22 from anywhere (`0.0.0.0/0`).
Tighten this before doing anything else:

1. **VPC network** → **Firewall** → open `default-allow-ssh`.
2. **Edit** → change **Source IPv4 ranges** from `0.0.0.0/0` to your own
   public IP with `/32` (look up "what is my ip"), or your Tailscale CIDR if
   you access the VM over Tailscale instead → **Save**.

(Optional but recommended) **VPC network** → **IP addresses** → **Reserve
external static address**, attach it to this VM. Without this, the VM's
external IP can change if you ever stop/start it, breaking DNS.

### 4. DNS

Point an `A` record for your domain at the VM's external (ideally now
static) IP, at whichever DNS provider hosts the domain.

### 5. SSH in and install Docker

From the VM instances list, click the **SSH** button next to the instance —
this opens a full terminal in your browser, no local SSH client or key setup
needed.

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log out/in (close and reopen the SSH tab) after this
```

### 6. Deploy the app

```bash
git clone <this repo's URL>
cd terra-rosa
cp .env.example .env
nano .env   # fill in production secrets (SESSION_SECRET, POSTGRES_PASSWORD,
            # SEED_ADMIN_EMAIL/PASSWORD) and set DOMAIN=yourdomain.org
docker compose up -d --build
```

`.env` is created **on the VM only** and is already gitignored — never commit
it.

Apply any migrations under `drizzle/*.sql` that haven't been applied yet
(`docker compose up` only runs `db:push` + `db:seed`, not these):

```bash
docker compose exec -T db psql -U terrarosa -d terrarosa -f - < drizzle/0004_bed_solo_periods.sql
```

Caddy requests its Let's Encrypt certificate automatically on first request
to your domain over ports 80/443 — give it a minute after `docker compose up`
before it's reachable over HTTPS.

### 7. Ongoing

- **Backups**: a cron job running
  `docker compose exec -T db pg_dump -U terrarosa terrarosa | gzip > backup-$(date +%F).sql.gz`
  and uploading the result somewhere with retention (a Cloud Storage bucket,
  set up via **Cloud Storage** → **Buckets** → **Create** in the Console).
- **Updates**: `git pull && docker compose up -d --build`, then apply any new
  `drizzle/*.sql` migrations manually (same command as step 6).
- **Monitoring** (optional): **Monitoring** → **Uptime checks** in the
  Console, pointed at `https://yourdomain.org/api/health`, plus a budget
  alert (**Billing** → **Budgets & alerts**, e.g. $5) as a safety net against
  accidentally leaving a billable resource running.

## Known placeholders to replace before real use

- **First admin user**: set `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` in `.env`
  before first boot. Change the password after logging in for real use.
- **`SESSION_SECRET`, `POSTGRES_PASSWORD`**: placeholder values in
  `.env.example` — generate real ones before deploying anywhere reachable.
- `docker-compose.yml` still passes a `HOUSEKEEPING_PIN` environment variable
  through to the app container; nothing currently reads it (the housekeeping
  view was removed). Harmless to leave, safe to delete if you want to tidy it
  up.

## The grid

One row per bed (or per bed-pair row, for a bed that shares a 2-row block —
see below), one column per night, rendered at `/grid` by
`src/components/GridCanvas.tsx` using `src/lib/grid.ts` /
`src/lib/grid-data.ts` for the underlying per-date computation.

- **Infinite horizontal scroll**, not pagination: columns are virtualized
  (`@tanstack/react-virtual`), the loaded ~60-day data window shifts as you
  scroll near its edge, and you can click-and-drag to pan (Google Maps
  style) or use "Jump to Date" to snap to a specific day.
- **Date-exact**: every cell's state — which room a bed is in, whether it's
  joined/solo, whether it's booked — is computed fresh per date column from
  the underlying segment tables (`bed_locations`, `joined_beds`,
  `bed_solo_periods`), never from a "current state" snapshot. A bed that
  moves rooms or changes join state mid-window shows the change exactly on
  the date it took effect, with no "ghost" rows either side.
- **Bed states & divider lines** — two kinds of bed get a 2-row block instead
  of one plain row, both using the same visual language:
  - **Two adjacent Single beds**: solid divider by default (independent,
    unjoined). Right-click either row to join them as a **Couple Double**
    (dashed divider, both rows stay independent, capacity 2) or a **Solo
    Double** (the two rows merge into one cell via `rowSpan`, capacity 1).
  - **A native two-person bed** (anything `bedCapacity()` treats as capacity
    2 — Queen, 1.5, Double): dashed divider by default (**Couple** mode, 2
    rows, capacity 2, since the bed physically holds 2). Right-click to
    switch to **Solo** mode (merges into one row via `rowSpan`, capacity 1).
  - Right-clicking any merged/joined cell offers switching mode or
    **Split into Singles / reset to default**, which instantly restores
    independent rows with a solid divider.
  - If a state change conflicts with an existing booking (e.g. switching to
    Solo would leave two people in a one-spot bed), the conflicting
    booking(s) are automatically unassigned (`bed_id` set to null, not
    deleted) and a toast reports what happened.
- **Events** from the Events page appear as bands across the top, packed into
  lanes so overlapping retreats stack instead of colliding
  (`src/lib/event-lanes.ts`). A band with `‹` or `›` continues outside the
  visible window.
- **Room colours**: every room's bed rows share a background tint from a
  palette (`src/lib/room-colours.ts`) so you can see where one room ends and
  the next begins scanning down any column.
- **Clicking a free cell** opens the new-booking form with that bed and
  night's dates already filled in.

## Adding new pages/routes as a developer

Everything here is plain Next.js App Router + Drizzle — no framework magic
beyond that. To add a page: create `app/<name>/page.tsx` (and a `layout.tsx`
with `<Nav />` if it's an interactive/client page, following the pattern in
`app/bookings/layout.tsx`). To add a data operation: add a route handler
under `app/api/<name>/route.ts` following the existing ones (each starts with
`requireEditor()` for writes, no auth check for reads within an authed page).

Occupancy/date math lives in `src/lib/occupancy.ts` and `src/lib/dates.ts`;
the grid's per-date-column computation lives entirely in `src/lib/grid.ts` —
keep both single-sourced rather than re-deriving date logic in a component.
