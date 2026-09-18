# Board foundation

## Status and scope

Reviewed on 2026-09-18 against `main` at
`800342dba1980c460812b15205cb41249a6ac584` and the original
[project prompt](../project-prompt.md).

The static application and tooling foundation landed in
[PR #18](https://github.com/cboone/board/pull/18). This document records that
limited phase. It is not the complete product roadmap. The living
[product roadmap](2026-09-18-board-product-roadmap.md) covers the remaining work
and the requirements interview.

## Goal

Establish the buildable, testable static foundation for Board without connecting
to GitHub, an analysis provider, or production data. Production deployment is a
separate outcome requiring deployed evidence.

## Decisions

- Use Vite, Alpine CSP, Tailwind CSS, JavaScript modules, and npm.
- Build a static fixture-preview application shell with no server packages, credentials, database connection, or background functions.
- Reserve production and integration application configuration for later phases; do not provision or register external services in this phase.
- Use GitHub Actions with SHA-pinned actions, linting, unit tests, browser tests, dependency checks, and secret scanning.

## Work

1. Add the project package manifest, Vite application shell, Tailwind styling,
   Alpine component setup, a fixture domain helper, and an accessible welcome
   screen. A rendered fixture report remains to be implemented.
1. Add unit and browser test harnesses, formatting and lint configuration, editor settings, Node version pin, and project commands.
1. Add Netlify configuration for static fixture previews and production build output, while preventing application functions and credentials from entering previews.
1. Add repository documentation, agent guidance, community files, Dependabot, CI, and secret-scanning workflows.

## Acceptance criteria

- `npm run build`, lint, unit tests, browser tests, and automated accessibility
  checks passed for the foundation PR. This is historical validation of that
  phase, rather than a current rerun or verification of the complete product.
- The preview artifact is static and contains no application credentials, functions, or database dependency.
- The application shell supports light and dark color schemes, keyboard navigation, and narrow screens.
- The README explains the current fixture preview and distinguishes it from the later authenticated product.

## Remaining foundation gaps

- There is no report renderer, sample board, repository picker, authentication,
  persistence, or application API in the current implementation.
- Browser tests cover the welcome screen and theme control. Report behavior,
  narrow-screen behavior, application routes, and deployed behavior need their
  own validation.
- Netlify build configuration exists, but a successful production deployment
  has not been established by the evidence reviewed for this plan.
- Preview and branch deployment configuration sets `VITE_BOARD_MODE`, but the
  application does not read it. The current static artifact contains no service
  clients or credentials; later server features require enforced isolation and
  environment-context checks, rather than relying on this variable alone.
- Open issues [#12](https://github.com/cboone/board/issues/12) through
  [#17](https://github.com/cboone/board/issues/17) describe a broader foundation
  than this PR delivered. Reconcile them with the agreed roadmap before marking
  their remaining work complete.
- The fixture helper's `ready` count excludes issues needing clarification. The
  original skill defines that header count as open issues minus hard-blocked
  issues and derives start eligibility separately. Settle any product extension
  explicitly and replace the simplified helper when implementing the report.
