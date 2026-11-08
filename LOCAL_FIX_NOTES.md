# Coordinated Release 2 - Windows source update

Unlike the earlier point-fix patches, this bundle includes full TypeScript source changes, a forward-only SQL migration and extended tests. It does not contain `.env`, any database, actual passwords or a personal video speaking script.

## Backend
- Bodyless logout now works; session invalidation is database-backed. Added single-instance login/hold throttling and private-token-redacted request metadata.
- New `002_booking_integrity.sql` enforces event ownership and booking session immutability. No tables are dropped or reset during app migrations.
- Booking reads use PostgreSQL clock for held-state expiry; availability excludes stale holds without holding a host write lock.
- Event edit/deactivate, override delete, private host metrics and time-zone acknowledgement are implemented.

## Browser
- Real public host/event navigation and responsive menu; guest hold release and retry-safe recovery; host display zone; event editing, cancellation dialog and outbox details.
- `web/src/http.ts` avoids sending JSON content type for bodyless requests and preserves API status details.

## Testing and safety
- Authoring environment: 3 pure HTTP tests and 4 time-zone assertions passed; parsing succeeded.
- Windows/real PostgreSQL tests for this exact release have not been run by the author. See `docs/VALIDATION_STATUS.md`.
- The `_test` database safety check is enforced in the integration runner. Do not run tests on the live `slotbook_ts` database.
