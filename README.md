# Terra Rosa — Room Management App

Internal tool for tracking room occupancy, bookings, meal counts and housekeeping
instructions. Built to replace a spreadsheet, not to become an enterprise system —
see `terra_rosa_architecture_proposal.md` (delivered separately) for the full
reasoning behind these choices.

Stack: Next.js (App Router, TypeScript) + Tailwind (utilitarian styling only) +
Drizzle ORM + PostgreSQL, deployed as three Docker Compose services (`app`, `db`,
`caddy`) on a single GCP `e2-micro` VM (free tier).

## Project layout

```
app/                  Next.js App Router pages + API routes
  dashboard/           Today's summary (occupancy, arrivals/departures, meals)
  grid/                 Bed grid: 1/2/4-week occupancy view with event bands
  bookings/             Bookings list, new-booking form, room-move editor,
                        named people + their dietary requirements
  rooms/                Room list + capacity override editor
  housekeeping/         Unlisted, PIN-gated, read-only, mobile-first view
  meals/                Meal counts, per-day dietary requirements, adjustment notes
  events/               Events / retreat periods
  api/                  REST-ish route handlers backing the pages above
src/
  db/                   Drizzle schema, DB client
  lib/                  Auth, occupancy/meal-count math, housekeeping logic,
                        per-person dietary lookups, the room list, grid
                        colour palettes and event-band lane packing
  components/           Shared UI (nav tab strip)
scripts/seed.ts         Idempotent baseline seed (real room list + first admin user)
scripts/import-rooms.ts Applies the room list to a database that already has rooms
docker-compose.yml      app + db (Postgres 16) + caddy (reverse proxy / TLS)
Dockerfile              Single-stage Next.js production image
Caddyfile               Reverse proxy config, auto-HTTPS via Let's Encrypt
docker-entrypoint.sh    Runs schema sync + seed + `next start` on container boot
```

## Local development (no Docker)

Requires Node 20+.

### Quick start (one command)

```bash
npm install
cp .env.example .env      # edit if needed
npm run start-dev         # starts DB, pushes schema, seeds, runs dev server
```

### Manual setup

```bash
npm install
cp .env.example .env      # edit DATABASE_URL to point at a local/dev Postgres
npm run db:push           # sync schema
npm run db:seed           # seed placeholder rooms + first admin user
npm run dev                # http://localhost:3000
```

You need a Postgres instance reachable at the `DATABASE_URL` in `.env`. Easiest
local option if you don't already have one running:

```bash
docker run --name terrarosa-dev -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=terrarosa \
  -p 5432:5432 -d postgres:16-alpine
```

Then set `DATABASE_URL=postgres://postgres:devpass@localhost:5432/terrarosa` in `.env`.

## Running the whole stack locally with Docker Compose

```bash
cp .env.example .env      # fill in real values, especially SESSION_SECRET
                           #   (generate with: openssl rand -hex 32)
docker compose up -d --build
```

- App: http://localhost (via Caddy) or http://localhost:3000 directly.
- First run auto-creates the admin user from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` in `.env`.
- Housekeeping view: http://localhost/housekeeping — unlisted, PIN from `HOUSEKEEPING_PIN`.

> This sandbox environment used to scaffold this project does not have Docker
> installed, so `docker compose up` itself has not been executed/tested here.
> The Next.js app was built and compiled independently (`npm run build`) to
> catch code-level errors. Please run `docker compose up -d --build` yourself
> locally or on the VM before relying on it, and report back anything that
> doesn't come up cleanly.

## Deploying to GCP (matches architecture proposal §12)

1. Create an `e2-micro` VM (Ubuntu 22.04/24.04) in `us-central1`, `us-west1`, or
   `us-east1` — these regions are covered by the Compute Engine Always Free tier.
2. Restrict the firewall to ports 80/443 (public) and SSH only via your own IP
   or Tailscale — do not leave 22 open to the world.
3. Point a Cloudflare DNS record at the VM's external IP.
4. SSH in, install Docker + Docker Compose plugin:
   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER   # log out/in after this
   ```
5. Clone this repo onto the VM (e.g. into `/srv/websites/terra-rosa/`, matching
   your existing `/srv/websites` convention).
6. Create `.env` **on the VM only** (never commit it) with production secrets
   and `DOMAIN=terrarosa.org`.
7. `docker compose up -d --build`
8. Set up nightly backups: a cron job running
   `docker compose exec -T db pg_dump -U terrarosa terrarosa | gzip > backup-$(date +%F).sql.gz`
   and uploading the result to a Cloud Storage bucket (30-60 day retention).
9. Optional: Cloud Monitoring free agent + a free uptime check on `/api/health`
   + a small budget alert (e.g. $5) as a safety net.
10. To deploy updates later: `git pull && docker compose up -d --build`.

## The room list

`src/lib/room-list.ts` holds the real room list, transcribed from the occupancy
spreadsheet: the 1st floor (Ensuite 1, Sea 1, Courtyard 1, Back Room), floor 2
(Ensuite 2, Sea 2, Courtyard 2, Dorm 2), the seven monk cells, the outside
spaces (Bunker, Van / Caravan, Infirmary, Ashram Room, Camping), and one room
per permanent guardian / resident / worker.

**Bed counts in that file are estimates and need checking.** The spreadsheet has
no bed-count column — it uses one row per room and annotates the occupant
instead ("(twin)", "(double)", "(couple)") — so the numbers were inferred from
those annotations and from room type. Rooms whose count is a guess carry
`ESTIMATE: bed count` in their notes, which shows in the Notes column on the
Rooms page. Correcting one is a single edit in the "Default beds" box there.

Two ways to get the list into a database:

```bash
npm run db:seed        # empty rooms table only — runs automatically on container boot
npm run rooms:import   # a database that already has rooms in it
```

`rooms:import` inserts what's missing, refreshes areas/notes, and **deactivates**
(never deletes) any room not in the list — deleting would cascade to
`stay_room_segments` and take bookings with it. It leaves existing bed counts
alone so it can't stamp estimates back over numbers someone has corrected; pass
`-- --reset-beds` if you do want them overwritten. It's safe to re-run.

Rooms sort by house area (in spreadsheet order), then by name — see
`src/lib/rooms.ts`. A new area added via the Rooms page sorts after the known
ones rather than jumping to the top.

## Known placeholders to replace before real use

- **First admin user**: set `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` in `.env`
  before first boot. Change the password after logging in for real use.
- **`SESSION_SECRET`, `HOUSEKEEPING_PIN`, `POSTGRES_PASSWORD`**: all placeholder
  values in `.env.example` — generate real ones before deploying anywhere reachable.
- **Database constraints not yet expressed in Drizzle**: the overlapping-override
  exclusion constraint and the CHECK constraints on enum-like text columns are
  documented as raw SQL comments at the top of `src/db/schema.ts`. `db:push`
  creates the tables/columns; add those constraints manually (via `psql` or a
  follow-up migration) if you want the database itself to enforce them.

## The grid

One row per bed, one column per night. Beyond the occupancy itself:

- **Window**: 1, 2 or 4 weeks (`?weeks=`), stepped by week or by calendar month.
  Month stepping is clamped to the end of the target month, so 31 Jan + 1 month
  is 28 Feb — stepping by 30 days instead would drift off month boundaries.
- **Events** from the Events page appear as bands across the top, packed into
  lanes so overlapping retreats stack instead of colliding (`src/lib/event-lanes.ts`).
  A band with `‹` or `›` continues outside the visible window. Note that an
  event's `end_date` is **inclusive**, unlike `stay_room_segments.end_date`,
  which is exclusive because it marks a check-out morning.
- **Room colours**: every room's bed rows share a background tint from an
  8-colour palette (`src/lib/room-colours.ts`) so you can see where one room
  ends and the next begins scanning down any column. Occupied, arrival,
  over-capacity and unavailable states still override the tint — what's in the
  bed matters more than which room it is.
- **Clicking a free cell** opens the new-booking form with that room and that
  night's dates already filled in.

## Adding new pages/routes as a developer

Everything here is plain Next.js App Router + Drizzle — no framework magic
beyond that. To add a page: create `app/<name>/page.tsx` (and a `layout.tsx`
with `<Nav />` if it's an interactive/client page, following the pattern in
`app/rooms/layout.tsx`). To add a data operation: add a route handler under
`app/api/<name>/route.ts` following the existing ones (each starts with
`requireEditor()` for writes, no auth check for reads within an authed page).

Occupancy and meal-count math lives in one place — `src/lib/occupancy.ts` —
specifically so it never has to be reasoned about in more than one file.

## People, contact details and dietary requirements

A booking's `guest_count` remains the only number that feeds occupancy, capacity
and meal totals. Alongside it, `booking_guests` holds one optional row per named
person on the booking (`name`, free-text `dietary_requirements`, and optional
`phone` / `email`) — you can name none, some or all of a party of twelve without
any of it affecting the maths.

Contact details exist at two levels, both optional:

- `bookings.contact_phone` / `bookings.contact_email` — the booking's main
  contact, i.e. whoever made it. This is the one you'll fill in most of the time.
- `booking_guests.phone` / `booking_guests.email` — per person, for parties where
  individuals booked separately or need reaching directly. Blank means the
  booking-level contact applies.

Emails are validated leniently (`isPlausibleEmail` in `src/lib/guests.ts`): the
check catches a missing `@` or domain without rejecting unusual-but-valid
addresses, on the grounds that for internal records a false rejection is worse
than a typo. Phone numbers are free text — international formats, extensions and
"mum's mobile" all need to fit.

- Enter them inline on the new-booking form, or add/edit/remove them later in the
  "People & dietary requirements" card on a booking's page. Fields on that page
  save on blur, matching the existing segment end-date editor.
- The meals page shows, per night, everyone in-house with a recorded requirement.
  That list comes from `src/lib/guests.ts` and counts a person on the nights
  `check_in <= night < check_out` (open-ended stays never expire), for confirmed
  bookings with `counts_toward_meals = true`. It's keyed off the booking's own
  dates rather than stay segments, so a booking with no room assigned yet still
  reaches the kitchen.
- The pre-existing per-day "manual adjustments" count on the meals page is
  untouched and still independent — use it for anything not tied to a booking.

`booking_guests` is a new table, and `bookings` gained two new columns: run
`npm run db:push` against an existing database before deploying this, or the
bookings pages will error. The Docker entrypoint does this automatically on
container boot.
