# Slotbook

A full-stack appointment-booking application built with **TypeScript, React, Fastify, and PostgreSQL**. Hosts define their availability; guests reserve one-on-one appointments or seats in group sessions. PostgreSQL transactions and constraints protect bookings when multiple requests arrive at the same time.

## 1. Setup and run

Choose **Docker** for an isolated, one-command setup or **Manual setup** to use an existing local PostgreSQL installation. Run the commands from the repository root.

### Option A — Docker Compose

**Prerequisites:** Docker Desktop (or Docker Engine with Compose) and free local ports `3000` (app) and `5433` (database forwarding).

```bash
docker compose up --build -d
```

The application starts automatically, applies the SQL migrations, and seeds a demo host and two event types. PostgreSQL data is persisted in a Docker volume.

| Page | URL |
| --- | --- |
| Home | http://localhost:3000 |
| Host dashboard | http://localhost:3000/host |
| Interview booking | http://localhost:3000/demo-ny/interview |
| Group workshop | http://localhost:3000/demo-ny/workshop |
| API health | http://localhost:3000/api/health/ready |

**Demo host credentials (local evaluation only)**

```text
Email:    demo@slotbook.local
Password: DemoPass!2026
```

**Run the PostgreSQL integration tests in the separate Docker test database:**

```bash
docker compose --profile test run --build --rm test
```

**Run the live 50-request contention check** while the application is running:

```bash
docker compose exec app npm run test:concurrency -- --attempts 50
```

Stop the services without removing the database volume:

```bash
docker compose down
```

> Docker uses PostgreSQL inside its own network and forwards its database port to `127.0.0.1:5433`. It does **not** use your manually installed Windows PostgreSQL on port `5432`. Docker support is configured in the repository; the documented Docker commands have not been separately executed as part of the reported Windows validation.

### Option B — Manual setup (Windows, without Docker)

**Prerequisites:** Node.js **22+**, npm, and PostgreSQL **15+**. On Windows, PostgreSQL 18 and Node.js 24 are also supported by the local setup used for validation.

**1. Prepare two separate databases.** Use an existing PostgreSQL login role named `slotbook`, or create it first as a database administrator. In `psql`, run the following statements **only if these databases do not already exist**:

```sql
CREATE DATABASE slotbook_ts OWNER slotbook;
CREATE DATABASE slotbook_ts_test OWNER slotbook;
```

The database role must be able to create the required extensions (`pgcrypto`, `btree_gist`) when migrations first run. **Do not reuse an unrelated existing database.** The Docker and manual setups intentionally use different database names.

**2. Create a private environment file.** In PowerShell:

```powershell
Copy-Item .env.example .env
notepad .env
```

Set the existing PostgreSQL username/password and keep the target database names distinct:

```dotenv
DATABASE_URL=postgresql://slotbook:YOUR_PASSWORD@127.0.0.1:5432/slotbook_ts
TEST_DATABASE_URL=postgresql://slotbook:YOUR_PASSWORD@127.0.0.1:5432/slotbook_ts_test
EXPECTED_DATABASE_NAME=slotbook_ts
PORT=3000
COOKIE_SECURE=false
DEMO_EMAIL=demo@slotbook.local
DEMO_PASSWORD=DemoPass!2026
```

Replace `YOUR_PASSWORD` locally. URL-encode reserved password characters such as `@`, `#`, `%`, `/` and `:`. Never commit `.env` or share credentials in logs/screenshots.

**3. Install dependencies, build, and start:**

```powershell
npm install
npm run build
npm run start:local
```

If `start:local` is not available in your local `package.json`, use the equivalent command:

```powershell
node --env-file=.env dist/server/src/index.js
```

Open the URLs in the table above. Migrations and demo seeding happen at startup without resetting existing bookings.

**4. Run the full local build and PostgreSQL tests** in a separate PowerShell terminal:

```powershell
npm run verify:local
```

This validates the main/test database targets, compiles the backend, typechecks and builds React, and executes the automated tests against `slotbook_ts_test`. The test suite **resets data in the dedicated test database**, not `slotbook_ts`.

If you want just the database/API tests:

```powershell
npm run test:local
```

**Development mode:** Start the backend on port `3000` and run `npm run dev:web` in another terminal. Vite serves the React client on `http://localhost:5173` and proxies `/api` to the backend.

### Automated real-browser testing (Windows)

Browser end-to-end tests use **Playwright + Chromium** and run an isolated server on port **3101**, connected to `slotbook_ts_test`. They do not use or reset your primary `slotbook_ts` database.

```powershell
powershell -ExecutionPolicy Bypass -File .\run-e2e.ps1
```

The launcher checks the environment, installs the browser test dependency if needed, builds the project, starts the isolated test server, and runs guest/host browser scenarios. The first run needs internet access to install Chromium.

To view the generated local results:

```powershell
npx playwright show-report
```

Do not publish `playwright-report/` or `test-results/`: traces/screenshots can include private test booking links. Do not run browser E2E and PostgreSQL integration tests simultaneously against the same test database.

---

## 2. What is Slotbook?

Slotbook provides three surfaces:

- **Host dashboard:** sign in, configure an IANA home time zone, create and manage event types, define weekly availability and special-date overrides, review bookings, cancel with a reason, and inspect notification events.
- **Public guest booking:** browse hosts/events, choose a date and display time zone, place a five-minute hold, confirm a booking, and use a private link to reschedule or cancel. Guest login is not required.
- **JSON API:** TypeScript/Fastify endpoints backed by PostgreSQL transactions, idempotency records, capacity/overlap constraints, and a durable notification outbox.

The seeded host publishes an **Interview** event (30 minutes, one seat) and a **Group Workshop** (60 minutes, four seats). Public event routes follow `/{host}/{event-slug}`.

### 60-second walkthrough

1. Visit `/` and **Browse hosts**; choose the demo host and the **Interview** or **Group Workshop** event.
2. Select a date, switch the displayed time zone if needed, and select an available slot.
3. **Hold** the slot for five minutes; enter a name and email and **Confirm**. The app shows a private management link.
4. Open the private link to **reschedule** or **cancel** the appointment.
5. Visit `/host`, sign in with the demo account, and review **bookings, event types, availability, date overrides, notifications and metrics**.

## 3. Features

| Area | Functionality |
| --- | --- |
| Host authentication | Seeded email/password, hashed passwords, database-backed sessions, HttpOnly cookies and logout |
| Event types | Slug, 15–120-minute duration, capacity, 0–30-minute buffers, minimum notice and booking horizon |
| Availability | Multiple weekly windows per day; host-local closures and custom hours on individual dates |
| Guest booking | Date/time-zone selection, five-minute holds, confirmation and private booking management |
| Booking management | Guest cancellation/rescheduling; host cancellations with reasons |
| Group sessions | Multiple seats within one time slot, without overbooking |
| Notifications | Transactional database outbox for confirm, reschedule and cancel (not real email delivery) |
| Reliability | Idempotency keys, hold expiry, conflict responses, atomic rescheduling, database constraints |
| Operational visibility | Health endpoints, structured request metadata and host metrics |

## 4. Architecture and booking flow

```mermaid
flowchart LR
    G[Guest browser] --> R[React / TypeScript UI]
    H[Authenticated host] --> R
    R --> A[Fastify / TypeScript API]
    A --> T[PostgreSQL transactions]
    T --> B[(Bookings and sessions)]
    T --> I[(Idempotency records)]
    T --> N[(Notification outbox)]
    B --> C[GiST exclusion + unique active seats]
```

**Booking flow**

```mermaid
flowchart TD
    A[Host configures event and availability] --> B[Guest requests available slots]
    B --> C[Guest selects a UTC instant]
    C --> D[PostgreSQL transaction and host lock]
    D --> E{Slot and seat available?}
    E -->|No| X[HTTP 409 conflict]
    E -->|Yes| F[Five-minute HELD booking]
    F -->|Confirm in time| G[CONFIRMED]
    F -->|Deadline passes| H[EXPIRED / seat reusable]
    G -->|Reschedule atomically| G
    G -->|Cancel| I[CANCELLED / seat reusable]
```

**How double-booking is prevented:** the API serializes competing writes for the same host, and PostgreSQL enforces the final invariants. A GiST exclusion constraint prevents overlapping active host sessions (including buffers); group events use numbered seats with a uniqueness constraint preventing two active bookings for the same seat. The transaction that commits successfully wins—request arrival order is not guaranteed.

**How time zones work:** hosts define availability in their IANA time zone; available slots are converted to UTC instants for storage and conflict checking. Guests see times in their selected display zone. Ambiguous/nonexistent local daylight-saving times are rejected rather than silently shifted.

**How failure recovery works:** an idempotency key identifies an operation for safe replay; failed reschedules roll back; a five-minute hold expires according to the database clock; cancellations release capacity. Notifications are written in the same transaction as the corresponding booking change.

## 5. Data model

| Table | Responsibility |
| --- | --- |
| `hosts`, `auth_sessions` | Host identity, timezone and authenticated sessions |
| `event_types` | Host-owned scheduling policies and seat capacity |
| `weekly_availability`, `date_overrides` | Recurring hours and special-day rules |
| `booking_sessions` | UTC start/end, buffers and occupied PostgreSQL time ranges |
| `session_seats` | Numbered capacity for a single session |
| `bookings` | Held/confirmed/expired/cancelled booking status and private token hashes |
| `idempotency_records` | Safe repeated-request detection and stored results |
| `notification_outbox` | Persisted booking lifecycle notifications |
| `schema_migrations` | Applied SQL migration tracking |

SQL migrations are stored in `server/sql/`. The app applies them on startup; **no manual schema import is required**.

## 6. HTTP API

The frontend and external clients use the same JSON API. Selected endpoints:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/public/hosts` | Discover public hosts |
| `GET` | `/api/public/hosts/:host` | Discover a host's active event types |
| `GET` | `/api/hosts/:host/events/:event/slots?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=Asia%2FKolkata` | Retrieve available slots |
| `POST` | `/api/holds` | Reserve a slot temporarily |
| `POST` | `/api/holds/:id/confirm` | Confirm a held appointment |
| `GET` | `/api/bookings/:token` | Read a booking with its private token |
| `POST` | `/api/bookings/:token/reschedule` | Move a confirmed booking |
| `POST` | `/api/bookings/:token/cancel` | Cancel a guest booking |
| `POST` | `/api/auth/login` / `/api/auth/logout` | Host sign-in / sign-out |
| `GET` | `/api/host/me` | Authenticated host profile |
| `GET`, `POST` | `/api/host/events` | Event listing and creation |
| `PATCH` | `/api/host/events/:id` | Update or deactivate an event |
| `GET`, `PUT` | `/api/host/schedule` | Weekly availability |
| `PUT`, `DELETE` | `/api/host/overrides/:day` | Date overrides |
| `GET` | `/api/host/bookings` | Upcoming host bookings |
| `POST` | `/api/host/bookings/:id/cancel` | Host cancellation with reason |
| `GET` | `/api/notifications` | Notification outbox (host only) |
| `GET` | `/api/host/metrics` | Host statistics |
| `GET` | `/api/health`, `/api/health/ready` | Service / database readiness |

Write requests for holds, confirmations, reschedules and cancellations use an `Idempotency-Key` header. Confirming a hold also requires the private `X-Booking-Token` header. Host routes require the authenticated session cookie.

Example (replace the event ID and start time with values from the slots API):

```bash
curl -X POST http://localhost:3000/api/holds \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: sample-request-12345678' \
  -d '{"event_id":"EVENT_UUID_FROM_SLOTS_API","start_at":"2026-12-01T14:00:00.000Z"}'
```

## 7. Automated testing and evidence

The latest supplied **Windows local execution results** were:

| Check | Observed result |
| --- | --- |
| Environment URL validation | Passed; separate main/test databases |
| Backend TypeScript compile | Passed |
| React typecheck and Vite production build | Passed |
| PostgreSQL + HTTP automated tests | **23 / 23 passed** |
| Playwright Chromium browser UAT | **4 / 4 passed** |
| One-on-one contention | **50 simultaneous holds: 1 success (201), 49 conflicts (409)** |
| Group capacity | Four seats accepted; fifth conflicting hold rejected |

The PostgreSQL tests also cover expired holds, private booking tokens, logout, dynamic public discovery, host event changes, date overrides, transactional notifications, DST checks and rollback during failed rescheduling. Browser tests cover authentication/navigation, hold release, guest confirmation/rescheduling/cancellation and group capacity. These results describe the verified Windows runs, **not** a Docker or public-deployment test.

Reproduce with `npm run verify:local` and `powershell -ExecutionPolicy Bypass -File .\run-e2e.ps1` after configuring the separate test database. Browser reports are generated locally and intentionally not committed.

## 8. Optional extensions implemented

The written assignment treats these as optional after the booking core:

- **End-to-end testing and CI:** Playwright browser tests and a GitHub Actions workflow for Node/PostgreSQL build and integration tests. Browser tests passed locally; the remote CI workflow should be checked after the first GitHub push.
- **Observability:** structured HTTP request metadata, health/readiness checks, and authenticated host metrics.
- **Basic abuse protection:** in-process rate limits for login and booking operations. These are suitable for a single demo instance, not a distributed production defense.

Also provided: a separate HTTP contention script in `scripts/concurrency.ts`. The booking engine itself, guest management, group capacity and database notification sink belong to the core implementation.

## 9. Repository layout

```text
.github/workflows/test.yml       GitHub Actions build + PostgreSQL tests
server/sql/                     Database migrations and Docker test-db initializer
server/src/                     Fastify API, auth, booking engine, time and seed logic
web/src/                        React pages, HTTP client and styling
tests/                          HTTP contract, PostgreSQL and timezone tests
tests/e2e/                      Playwright browser tests
scripts/                        Environment checks, HTTP contention and E2E launcher
Dockerfile, compose.yaml         Container-based setup
run-e2e.ps1, playwright.config.mjs   Windows browser-test entry points
package.json                    Dependencies and npm scripts
README.md                       Setup, product, API and architecture
AI_LOG.md                       AI usage, mistakes, corrections and verification
```

## 10. Scope, limitations and submission

The core brief does **not** require calendar-provider synchronization, payments, real email delivery or multi-host round-robin. Accordingly, notifications are persisted to the database rather than delivered to guest inboxes. The public demo account and local HTTP cookie settings are **not production deployment credentials/settings**. In-memory throttling would need a distributed rate limiter for multiple server instances.

The repository contains the source, migrations, seeded demo, tests, setup documentation, optional-extension list and [`AI_LOG.md`](AI_LOG.md). A **separate 6–12-page report** accompanies the public GitHub repository submission, covering architecture, data model, key decisions, failure cases, time zones, tests, AI usage and known gaps. Add the actual repository URL to that report after publishing.

Keep full Git commit history (do not squash). Never publish `.env`, passwords, private booking-management URLs, Playwright traces or local test data.
