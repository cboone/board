# Board

Board turns a GitHub repository's open issues into a focused backlog report. It shows what can proceed, what is blocked, where work overlaps, and which issues need clarification.

The current release is a static sample experience. Open `/demo` to explore a complete report, an empty backlog, or issues with unresolved questions. Every scenario uses synthetic data. GitHub sign-in, repository analysis, and saved reports are being implemented in the following phases.

## Try the sample reports

Board requires Node.js 24.13.0, recorded in `.tool-versions`.

```bash
git clone https://github.com/cboone/board.git
cd board
npm ci
npm run dev
```

Open the address Vite prints and select **View sample report**. Use **Sample scenario** to switch reports. The theme button supports light and dark views and remembers your preference.

Reports contain source metadata, six backlog counts, a summary, Start now, Lanes, Contention, and Blocked. Source links demonstrate navigation to GitHub; browsing the sample never contacts GitHub or Anthropic and needs no credentials.

## Initial hosted release

The planned hosted release is for the `cboone` account and its eligible public and private repositories. Reports require sign-in and are saved across browsers and devices. Opening a report checks GitHub for changes; paid analysis runs only through **Generate report** or an explicit refresh. Uncertain issues remain visible with affected start recommendations withheld.

The [living roadmap](docs/plans/todo/2026-09-18-board-product-roadmap.md) records the confirmed requirements and delivery phases. See [CONTRIBUTING.md](CONTRIBUTING.md) for development and verification, and the [report contract](docs/report-contract.md) for report data and original skill provenance.
