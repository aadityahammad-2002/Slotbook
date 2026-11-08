# AI usage log — Slotbook TypeScript assignment

## Tools and scope

ChatGPT (OpenAI GPT-6) was used as an implementation assistant to translate the provided five-page assignment into a TypeScript full-stack architecture, generate initial code for API/schema/frontend/tests, identify reliability boundaries and draft documentation. Earlier conversations had produced a **separate FastAPI/PostgreSQL prototype** that was validated on Windows using 28 passing tests and a 50-request contention run. That prototype did **not** conform to the original TypeScript language requirement; the new repository is a separate TypeScript implementation.

## Representative engineering requests (paraphrased, not claimed to be raw transcripts)

1. Translate the full written assignment into a requirement-by-requirement implementation plan, including missing host UI and event types.
2. Preserve PostgreSQL as the final consistency authority without Redis locks.
3. Design a capacity-safe session/seat data model that supports both 1:1 appointments and group bookings.
4. Cover expiry based on database time, idempotent retries, DST ambiguity, and atomic rescheduling.
5. Add tests that intentionally compete for the same time and check the database invariant, plus a report that clearly distinguishes measured results from expected outcomes.

## Where AI proposals required correction / critical review

- The earlier Python prototype's one-booking-per-host exclusion constraint could not simply be copied: it would reject legitimate group sessions with capacity above one. The new design uses non-overlapping **host sessions**, and separate uniquely allocated **seats** within one group session.
- A 5-minute recording prompt did **not** replace the requirements of the complete attached take-home brief. The written brief additionally requires TypeScript, host dashboard, event types, notifications, a larger report and an AI usage log.
- A README/demo presentation is not itself evidence of real PostgreSQL test success. The separate Python results cannot be presented as TypeScript results.
- A test fixture can contain errors even when the booking engine is sound (an earlier Python test incorrectly expected a private booking token in a general GET response); secret tokens must not be exposed just to satisfy tests.

## Validation and human review expectations

The submission owner should run `docker compose --profile test run --build --rm test` and the live HTTP contention script on real PostgreSQL, inspect failures, and check the host/guest UI before submitting. Source compilation and DB execution were not possible in the artifact-generation environment because npm-registry DNS access and PostgreSQL runtime were unavailable. Accordingly, **no TypeScript integration test pass count is invented**.

## Known gaps / next steps

Review the architecture as a real candidate would; install dependencies; run migrations/tests; fix any failures; confirm host UI accessibility; publish to GitHub with honest commit history; add the GitHub URL to the report; deploy only after securing demo credentials and implementing appropriate request throttling/monitoring.


## Coordinated product-quality review (release 2)

The user asked for an end-to-end audit rather than another one-off patch. The assistant identified and changed the logout's empty-JSON header mismatch, browser retry idempotency reuse, dynamic host navigation, expiry recovery, host-local display, event controls, override management and database relationship/immutability rules. An earlier attempt to claim completeness based only on static checks was explicitly corrected; no new PostgreSQL test outcomes are invented.

AI contribution: requirements-to-code mapping, SQL migration design, React workflow rewrite, regression-test drafting, report/README updates and automated static/smoke checks. Human validation required: a Windows dependency-aware build, migration on the real test database, functional UI journey, concurrency results and security review before public deployment. The use of seeded login is expressly permitted by the assignment; no unsupported public sign-up feature was invented.
