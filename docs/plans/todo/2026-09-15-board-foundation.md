# Board foundation

## Goal

Establish the deployable, testable foundation for Board without connecting to GitHub, Anthropic, or production data.

## Decisions

- Use Vite, Alpine CSP, Tailwind CSS, JavaScript modules, and npm.
- Build a static fixture-preview application shell with no server packages, credentials, database connection, or background functions.
- Reserve production and integration application configuration for later phases; do not provision or register external services in this phase.
- Use GitHub Actions with SHA-pinned actions, linting, unit tests, browser tests, dependency checks, and secret scanning.

## Work

1. Add the project package manifest, Vite application shell, Tailwind styling, Alpine component setup, fixture data, and responsive accessible empty states.
1. Add unit and browser test harnesses, formatting and lint configuration, editor settings, Node version pin, and project commands.
1. Add Netlify configuration for static fixture previews and production build output, while preventing application functions and credentials from entering previews.
1. Add repository documentation, agent guidance, community files, Dependabot, CI, and secret-scanning workflows.

## Acceptance criteria

- `npm run build`, lint, unit tests, browser tests, and accessibility checks pass locally and in CI.
- The preview artifact is static and contains no application credentials, functions, or database dependency.
- The application shell supports light and dark color schemes, keyboard navigation, and narrow screens.
- The README explains the current fixture preview and distinguishes it from the later authenticated product.
