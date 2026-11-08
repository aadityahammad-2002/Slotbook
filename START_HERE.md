# Slotbook TypeScript - start here

This is a **new TypeScript full-stack implementation**, not a modification of the earlier Python/FastAPI backend. It follows the complete five-page written take-home PDF.

## Windows / Docker Desktop

1. Open PowerShell inside this project directory.
2. Run `docker compose up --build -d`.
3. Open `http://localhost:3000` (guest) and `http://localhost:3000/host` (host).
4. Host login: `demo@slotbook.local` / `DemoPass!2026` (local only).
5. Run `docker compose --profile test run --build --rm test`.
6. Run `docker compose exec app npm run test:concurrency -- --attempts 50`.

**Do not submit an unverified test claim.** These TypeScript DB tests have not been run in the authoring environment. Their results on your machine are the evidence that matters. The older Python 28/28 and 1/49 results apply to another codebase.

## Submission files

- `README.md`: application overview and run instructions with diagrams.
- `AI_LOG.md`: AI usage transparency.
- `Slotbook_Assignment_Report.pdf`: 10-page written report, includes a placeholder for the GitHub URL.
- `docs/REQUIREMENT_MATRIX.md`: original brief requirement mapping.
- `docs/VALIDATION_STATUS.md`: honest verification status.

Before submitting, publish the repo, add its real URL to the report, retain unsquashed commits, run the tests, and attach real logs. Never check secrets or `.env` into Git.
