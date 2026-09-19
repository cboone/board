# Board

Board turns a GitHub repository's open issues into a focused backlog report. It
shows what can proceed, what is blocked, where work overlaps, and which issues
need clarification.

Board has a static sample experience and a separate production composition for
GitHub sign-in, eligible repository selection, and explicit source checks. Live
owner sign-in, eligible public and private source checks, sign-out, and preview
isolation have passed. Paid analysis and saved reports follow in the next phase.
Open `/demo` to explore a complete report, an empty backlog, or issues with
unresolved questions. Every sample uses synthetic data.

## Try the sample reports

Board requires Node.js 24.13.0, recorded in `.tool-versions`.

```bash
git clone https://github.com/cboone/board.git
cd board
npm ci
npm run dev
```

Open the address Vite prints and select **View sample report**. Use **Sample
scenario** to switch reports. The theme button supports light and dark views and
remembers your preference.

Reports contain source metadata, six backlog counts, a summary, Start now,
Lanes, Contention, and Blocked. Source links demonstrate navigation to GitHub;
browsing the sample never contacts GitHub or Anthropic and needs no credentials.

## Initial hosted release

The planned hosted release is for the `cboone` account and its eligible public
and private repositories. Reports require sign-in and are saved across browsers
and devices. Opening a report checks GitHub for changes; paid analysis runs only
through **Generate report** or an explicit refresh. Uncertain issues remain
visible with affected start recommendations withheld.

Production source checks use read-only GitHub App authorization. Repository
selection makes no paid calls; **Check GitHub** gathers the approved inputs
under bounded limits and shows source provenance. Repository text and
credentials stay on the server. Owner sessions remain separate from current
source access.

The [living roadmap](docs/plans/todo/2026-09-18-board-product-roadmap.md)
records the confirmed requirements and delivery phases. See
[CONTRIBUTING.md](CONTRIBUTING.md) for development and verification, the
[production setup](docs/production-setup.md) for the owned site, and the
[report contract](docs/report-contract.md) for report data and original skill
provenance.
