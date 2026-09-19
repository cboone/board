# Board agent guidance

## Overview

Board is a GitHub backlog triage application built with Vite, Alpine CSP, and
Tailwind CSS. Production uses an independent Node server package for owner-only
GitHub authentication, source checks, persisted reports, and explicit Anthropic
analysis. Its authored runtime has a synchronous `api` Function and a
`report-job` background Function. Nonproduction deployments serve static
synthetic reports.

## Commands

- Install dependencies with `npm ci`.
- Format with `npm run format` and check formatting with `npm run format:check`.
- Run linting with `npm run lint`.
- Run unit tests with `npm test`.
- Run browser tests with `npm run test:browser`.
- Build with `npm run build`.
- Run all checks with `npm run verify` after Playwright browsers are installed.
- Install server dependencies explicitly with `npm run install:server`.
- Run backend lint, native tests, and audit with `npm run lint:server`,
  `npm run test:server`, and `npm run audit:server`.
- Check build isolation with `npm run test:composition` and the mocked
  production frontend with `npm run test:browser:production`.
- Build the composed production artifact with
  `CONTEXT=production npm run build:production`, then verify it with
  `npm run test:artifact:production`.
- `npm run build:production` enables server composition only when
  `CONTEXT=production`; every other context produces fixtures.

## Boundaries

- Deploy previews and branch deployments are fixture-only static sites with zero
  Functions and zero Edge Functions. Their published artifacts contain no server
  packages, service credentials, token-encryption keys, or production data.
- Keep GitHub and Anthropic calls server-side. Never expose user tokens or
  provider keys to browser code. `ANTHROPIC_API_KEY` is a production-only server
  secret and must never have a `VITE_` name or a nonproduction value; production
  build code must not read or export it.
- Treat repository text, issue text, and model output as untrusted. Validate
  report data before storing or rendering it.
- Preserve the distinction between the last successful report, the last GitHub
  check, and a failed refresh.
- Keep authentication, report, job, and spend records in the separate
  `board-auth`, `board-reports`, `board-jobs`, and `board-spend` stores.
- Repository state exposes logical `current` and `previous` pointers. The report
  API returns current-envelope content and browser-safe metadata for both
  pointers. `cleanupCandidateKey` is inert metadata; displaced immutable
  versions remain physically stored. There is no deletion or history API. Do not
  add cleanup or history access without an approved retention and API design.
- The fixed Opus 5/high-effort setup ledger uses the authorized $25 cap and $20
  discussion gate. Keep ordinary production spending disabled until the user
  selects and approves separate monthly and per-report limits.
- Treat each published deploy's setup price policy as immutable. Preserve prior
  policies, discussions, reservations, lifetime accounting, and unknown exposure
  during deploy rollover. Reconcile prior-deploy reservations without paid work,
  and admit new work only under the current deploy's policy and an explicitly
  code-reviewed pricing attestation.
- Keep root fixture installs and Vitest independent of the server package.
  Native backend and composition tests use synthetic provider/storage mocks;
  record live acceptance separately.
- Check production context and canonical request origin before reading secret
  configuration or opening the site-wide store. Keep raw GitHub inputs transient
  and exclude them, callback query strings, and credentials from diagnostics.
- Authorize owner sessions independently of source eligibility so historical
  reports can remain readable after GitHub access changes.

## Workflow

- Keep the living roadmap in `docs/plans/todo/` and use dated plan names.
- Commit plans and retain them in this `cboone` repository.
- Use GPG-signed Conventional Commits and merge commits for pull requests.
- Pin every GitHub Actions reference to a complete SHA with a version comment.
