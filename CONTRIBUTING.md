# Contributing to Board

Thank you for contributing to Board. Participation is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting issues

- Report bugs and request features in the
  [issue tracker](https://github.com/cboone/board/issues).
- Ask questions in
  [GitHub Discussions](https://github.com/cboone/board/discussions).
- Report vulnerabilities according to the
  [security policy](.github/SECURITY.md).

## Development setup

Board requires Node.js 24.13.0 and npm.

```bash
git clone https://github.com/cboone/board.git
cd board
npm ci
npm run dev
```

Open `/demo` for synthetic sample reports. No credentials are required. Report
data and the independent fixture inventory are described in the
[report contract](docs/report-contract.md).

Run `npm run format` before committing. Install Playwright browsers with
`npx playwright install chromium firefox webkit`, then run `npm run verify` and
`npm audit --audit-level=high` before opening a pull request.

Verification covers formatting, linting, unit checks, built-asset browser checks
in Chromium/Firefox/WebKit, the fixture build, and the static artifact gate.
Browser tests use a loopback server that serves the built files with the
committed Netlify security headers. Its test-only source routes support
rejected-payload checks and are never deployed. This verifies local built
behavior; a deployed Netlify site still requires its own route and header
checks.

The backend has an independent locked package. Install and verify it explicitly:

```bash
npm run install:server
npm run lint:server
npm run test:server
npm run audit:server
npm run test:composition
npm run test:browser:production
```

Backend and composition checks use injected provider/storage mocks and synthetic
configuration. The production browser suite serves a separate production build
and mocks its APIs; it verifies protected views and response races without live
GitHub access. These checks do not require application credentials. Root fixture
checks run without a server dependency install.

`npm run build` always produces fixtures. `npm run build:production` stages the
server only for exact `CONTEXT=production`; every other context removes
generated Functions and produces fixtures. See
[production setup](docs/production-setup.md) for the owned site's settings and
separate live acceptance.

Deploy Previews and branch deploys must remain static fixture experiences with
zero Functions, storage access, credentials, or production data. Keep server
capabilities outside browser imports. Private acceptance evidence in this public
repository records sanitized pass/fail without private identifiers or source
facts.

## Pull requests

Create a descriptive branch using a type prefix such as `feature/` or `fix/`.
Use Conventional Commits and include tests and documentation with the change.

Use GPG-signed commits and merge commits. Retain dated plans and review
artifacts in this repository. Describe any verification that requires a deployed
environment and distinguish it from passing fixture checks.
