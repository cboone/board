# Board

Board turns a GitHub repository's open issues into a focused backlog report. It
shows what can proceed, what is blocked, where work overlaps, and which issues
need clarification.

Board has a static sample experience and an owner-only production site. The
deployed Phase 2 site supports GitHub sign-in, eligible repository selection,
and source checks; live owner sign-in, public and private source checks,
sign-out, and preview isolation have passed. Phase 3 adds explicit report
generation, refresh, and saved reports, but remains pending deployment and paid
acceptance. Open `/demo` to explore a complete report, an empty backlog, or
issues with unresolved questions. Every sample uses synthetic data.

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

Open [tracker-boards.netlify.app](https://tracker-boards.netlify.app) and sign
in with the `cboone` GitHub account. The current Phase 2 deployment lets that
owner select eligible public or private `cboone/*` repositories and run source
checks. Phase 3 report controls will become available after their reviewed
deployment and production setup.

In the initial complete release, selecting a repository never starts paid
analysis. Before the first paid action for a deployment, **Verify analysis
setup** gathers one bounded eligible repository input, verifies the fixed model
metadata, and counts the exact request without calling Anthropic Messages or
changing monetary setup exposure. **Generate report** and **Refresh report**
remain disabled until that deployment, setup policy, and request contract are
verified. A repository without a saved report then shows **Generate report**. A
saved report opens immediately, checks GitHub for changes without a paid call,
and runs paid reanalysis only through **Refresh report**. Reports require
sign-in, persist across browsers and devices, preserve the last successful
result after a failure, and keep uncertain issues visible while withholding
affected start recommendations.

The authenticated dashboard shows aggregate setup spending against the $25 cap,
including settled cost, active reservations, and unresolved exposure. If a new
reservation would bring exposure to at least $20, Board pauses paid setup and
requires an explicit continue or stop decision. Recording that decision does
not start analysis.

Production source checks use read-only GitHub App authorization. Repository
selection makes no paid calls; **Check GitHub** gathers the approved inputs
under bounded limits and shows source provenance. During setup verification and
paid analysis, Board sends only the approved bounded source from its server to
Anthropic. Raw source inputs and credentials never enter browser storage or
static artifacts, and credentials are never sent to Anthropic. Owner sessions
remain separate from current source access.

Saved-report reads remain available after a source becomes inaccessible or
ineligible, with a clear historical/source-unavailable status and analysis
disabled. The initial release has no report history or deletion controls.
Ordinary paid production usage remains disabled until calibration supports the
user's separate monthly and per-report spending decision. No paid calibration or
live Phase 3 acceptance is claimed here.

The [living roadmap](docs/plans/todo/2026-09-18-board-product-roadmap.md)
records the confirmed requirements and delivery phases. See
[CONTRIBUTING.md](CONTRIBUTING.md) for development and verification, the
[production setup](docs/production-setup.md) for the owned site, and the
[report contract](docs/report-contract.md) for report data and original skill
provenance.
