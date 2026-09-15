# Board agent guidance

## Overview

Board is a GitHub backlog triage application. Its initial foundation is a static fixture preview built with Vite, Alpine CSP, and Tailwind CSS.

## Commands

- Install dependencies with `npm ci`.
- Format with `npm run format` and check formatting with `npm run format:check`.
- Run linting with `npm run lint`.
- Run unit tests with `npm test`.
- Run browser tests with `npm run test:browser`.
- Build with `npm run build`.
- Run all checks with `npm run verify` after Playwright browsers are installed.

## Boundaries

- Deploy previews are fixture-only static sites. Do not add Netlify Functions, database packages, GitHub credentials, Anthropic credentials, token-encryption keys, or production data to them.
- Keep GitHub and Anthropic calls server-side when those capabilities are introduced. Never expose user tokens or provider keys to browser code.
- Treat repository text, issue text, and model output as untrusted. Validate report data before storing or rendering it.
- Preserve the distinction between the last successful report, the last GitHub check, and a failed refresh.

## Workflow

- Keep the living roadmap in `docs/plans/todo/` and use dated plan names.
- Commit plans and retain them in this `cboone` repository.
- Use GPG-signed Conventional Commits and merge commits for pull requests.
- Pin every GitHub Actions reference to a complete SHA with a version comment.
