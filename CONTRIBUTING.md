# Contributing to Board

Thank you for contributing to Board. Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting issues

- Report bugs and request features in the [issue tracker](https://github.com/cboone/board/issues).
- Ask questions in [GitHub Discussions](https://github.com/cboone/board/discussions).
- Report vulnerabilities according to the [security policy](.github/SECURITY.md).

## Development setup

Board requires Node.js 24.13.0 and npm.

```bash
git clone https://github.com/cboone/board.git
cd board
npm ci
npm run build
npm test
npm run lint
```

Run `npm run format` before committing. Install Playwright browsers with `npx playwright install chromium firefox webkit` before running `npm run test:browser`.

## Pull requests

Create a descriptive branch using a type prefix such as `feature/` or `fix/`. Use Conventional Commits and include tests and documentation with the change.

Before opening a pull request, run the applicable checks from the README and describe any verification that requires a deployed environment.
