# Board

Board turns a GitHub repository's open issues into a focused backlog triage report. It will show what can proceed, what is blocked, where work overlaps, and which issues need clarification.

Board is in its foundation release. The current site is a static fixture preview. It does not authenticate with GitHub, store account data, contact Anthropic, or analyze repositories yet.

## Run the preview

Board requires Node.js 24.13.0. The version is recorded in `.tool-versions`.

```bash
git clone https://github.com/cboone/board.git
cd board
npm ci
npm run dev
```

Open the address Vite prints. The preview includes no credentials or service access.

## Verify a change

```bash
npm run format:check
npm run lint
npm test
npm run test:browser
npm run build
npm audit --audit-level=high
```

The browser suite requires Playwright's browser engines:

```bash
npx playwright install chromium firefox webkit
```

## Planned product behavior

Users will authenticate with GitHub and choose from their personally owned, eligible repositories. Board will request read-only access, retain reports for authenticated users, and use Anthropic only when creating a report or responding to an explicit refresh request.

The [project roadmap](docs/plans/todo/2026-09-18-board-product-roadmap.md) describes the delivery sequence. See [CONTRIBUTING.md](CONTRIBUTING.md) for development and pull request guidance.
