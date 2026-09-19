# Board report generation branch review

Reviewed on: 2026-09-19

Branch: `feature/report-generation`

Base: `main` at merge base
`370c257c49c09492426b4d8df24d37240884e908`

Commits: 52

Files changed: 78 (48 added, 30 modified, 0 deleted, 0 renamed), with
36,295 insertions and 1,029 deletions

Reviewed through: `53f55af2e364752625e13006f254082fd093076b`

Plan:
[Analysis, report persistence, and refresh](../plans/todo/2026-09-18-board-report-generation.md)

## Result

The committed implementation is ready to proceed through PR review. It
implements the planned owner-only report-generation system, including bounded
source projection, fixed Opus 5 analysis, strict result assembly, durable
report/job/spend state, at-most-once paid boundaries, authenticated APIs,
Generate and Refresh browser flows, and production-only composition. An
independent final audit found no remaining evidence-backed Phase 3
implementation blocker in the reviewed working tree, and exact CI-style secret
scans found no verified leak.

Phase 3 as a whole is not complete. The branch has not been deployed, no
Anthropic key has been read or installed for this phase, no provider request has
been made, and setup spend remains $0. Current-head PR checks and review,
merge, the automatic production deployment, free deployed verification, paid
public/private/refresh acceptance, the user's production spending-policy
decision, enforcement of that policy, and branch cleanup remain.

## Changes by area

### Source safety, input, and report semantics

The branch extends the canonical GitHub snapshot with issue creation and
assignee facts, then projects it into a bounded, normalized provider wire
format. Mandatory evidence remains complete, optional comments and files use a
deterministic selection policy, known credential paths and sensitive inputs are
excluded or rejected, and raw source remains transient. The fixed analysis
wire, strict application validator, trusted report assembler, no-verbatim
policy, and deterministic current-versus-previous comparison keep model output
inside the original report contract.

Files: `server/lib/analysis-input.mjs`, `server/lib/analysis-result.mjs`,
`server/lib/source-safety.mjs`, `server/lib/gather.mjs`,
`src/domain/analysis-wire.js`, `src/domain/report-comparison.js`, and their
tests.

### Provider transport and paid-work coordination

The native Anthropic transport fixes model `claude-opus-5`, high effort,
standard service, global inference, a 16,384-token output cap, structured
output, and zero automatic retries. The background worker proves current
authorization, policy validity, reservation ownership, lease ownership, and
remaining runtime before either paid transition. It permits at most one
strictly bounded corrective attempt and treats incomplete billing evidence as
conservative unknown exposure without replaying a paid request.

Files: `server/lib/anthropic.mjs`, `server/lib/analysis-admission.mjs`,
`server/lib/analysis-worker.mjs`, `server/lib/analysis-reconciler.mjs`,
`server/functions/report-job.mjs`, and their tests.

### Durable reports, jobs, and spending

Four-purpose storage now separates authentication, report records and immutable
versions, analysis jobs, and spending ledgers. Exact schemas, byte ceilings,
strong reads, conditional writes, revision-bound accounting, one active job per
repository, current/previous report rotation, an owner report catalog, and
bounded recovery paths preserve the last successful report through failures,
ambiguous provider outcomes, stale workers, source loss, and lost write
acknowledgements. Displaced immutable versions remain stored while only current
and previous pointers are exposed logically.

Files: `server/lib/cas-records.mjs`, `server/lib/job-machine.mjs`,
`server/lib/job-store.mjs`, `server/lib/jobs.mjs`,
`server/lib/report-records.mjs`, `server/lib/report-store.mjs`,
`server/lib/report-versions.mjs`, `server/lib/spend.mjs`,
`server/lib/spend-store.mjs`, and their tests.

### Authenticated API and recovery behavior

The production API adds saved-report listing, direct report retrieval,
Generate/Refresh admission, job polling, and setup-budget decision routes.
Every response is projected through an exact allowlist and remains below the
buffered response limit. Owner-session rechecks fence delayed private
responses; source eligibility remains separate so an authenticated owner can
still read a historical report when GitHub access is unavailable. Polls and
admission perform bounded nonpaid recovery without replaying paid work.

Files: `server/lib/api.mjs`, `server/lib/api-responses.mjs`,
`server/lib/report-operations.mjs`, `server/functions/api.mjs`, and related
authentication, environment, error, storage, and API tests.

### Browser report experience

The production shell now merges eligible repositories with the durable saved
report catalog, opens saved reports before a free source check, and offers paid
work only through explicit Generate or Refresh actions. It renders progress,
freshness, failures, provenance, comparisons, and historical/source-unavailable
states separately while preserving the current successful report. Navigation,
session replacement, pagination, polling, duplicate actions, reload recovery,
narrow layouts, themes, keyboard behavior, and accessibility have mocked
browser coverage across all three supported engines.

Files: `src/app/production.js`,
`tests/browser/production/authentication.spec.js`,
`tests/browser/production/mock-api.js`, and
`tests/browser/production/reports.spec.js`.

### Composition, CI, and documentation

Production composition stages exactly the synchronous `api` Function and the
native background `report-job` Function. Every other context remains a static
fixture with zero Functions and no server package. CI now validates the backend,
production composition, dependency audit, and production browser suite. The
README, report contract, production setup guide, project guidance, roadmap, and
phase plan document the implemented boundaries without claiming live Phase 3
evidence.

Files: `.github/workflows/ci.yml`, `.gitleaksignore`,
`scripts/build-board.mjs`, `AGENTS.md`, `README.md`,
`docs/production-setup.md`, `docs/report-contract.md`, and the plan and
plan-review documents.

## File inventory

### New files

```text
.gitleaksignore
docs/plans/todo/2026-09-18-board-report-generation.md
docs/reviews/2026-09-18-board-report-generation-plan.md
server/functions/report-job.mjs
server/lib/analysis-admission.mjs
server/lib/analysis-input.mjs
server/lib/analysis-reconciler.mjs
server/lib/analysis-result.mjs
server/lib/analysis-worker.mjs
server/lib/anthropic.mjs
server/lib/api-responses.mjs
server/lib/background.mjs
server/lib/cas-records.mjs
server/lib/job-machine.mjs
server/lib/job-store.mjs
server/lib/jobs.mjs
server/lib/report-operations.mjs
server/lib/report-records.mjs
server/lib/report-store.mjs
server/lib/report-versions.mjs
server/lib/source-safety.mjs
server/lib/spend-store.mjs
server/lib/spend.mjs
server/tests/analysis-admission.test.mjs
server/tests/analysis-input.test.mjs
server/tests/analysis-result.test.mjs
server/tests/analysis-worker.test.mjs
server/tests/anthropic.test.mjs
server/tests/api-responses.test.mjs
server/tests/background.test.mjs
server/tests/cas-records.test.mjs
server/tests/job-machine.test.mjs
server/tests/job-store.test.mjs
server/tests/jobs.test.mjs
server/tests/report-job-function.test.mjs
server/tests/report-operations.test.mjs
server/tests/report-records.test.mjs
server/tests/report-store.test.mjs
server/tests/report-versions.test.mjs
server/tests/source-safety.test.mjs
server/tests/spend-store.test.mjs
server/tests/spend.test.mjs
src/domain/analysis-wire.js
src/domain/report-comparison.js
tests/browser/production/mock-api.js
tests/browser/production/reports.spec.js
tests/unit/analysis-wire.test.js
tests/unit/report-comparison.test.js
```

### Modified files

```text
.github/workflows/ci.yml
AGENTS.md
README.md
docs/plans/todo/2026-09-18-board-product-roadmap.md
docs/production-setup.md
docs/report-contract.md
scripts/build-board.mjs
server/functions/api.mjs
server/lib/api.mjs
server/lib/auth.mjs
server/lib/environment.mjs
server/lib/errors.mjs
server/lib/fingerprint.mjs
server/lib/gather.mjs
server/lib/source-limits.mjs
server/lib/storage.mjs
server/tests/api.test.mjs
server/tests/auth.test.mjs
server/tests/environment.test.mjs
server/tests/errors.test.mjs
server/tests/fingerprint.test.mjs
server/tests/gather.test.mjs
server/tests/source-fixtures.mjs
server/tests/source-limits.test.mjs
server/tests/storage.test.mjs
src/app/production.js
src/domain/report-contract.js
tests/browser/production/authentication.spec.js
tests/composition/build-board.test.mjs
tests/unit/report-contract.test.js
```

There are no deleted or renamed files.

## Notable changes

- **Security and privacy:** GitHub text and model output are untrusted at every
  boundary. Exact recursive schemas and response projectors reject extra data;
  secret-shaped mandatory input fails before counting; optional unsafe context
  is omitted whole; no-verbatim validation prevents persisted analysis from
  reproducing source evidence; credentials, prompts, provider bodies, and raw
  source are excluded from durable records and browser responses.
- **Authorization:** Numeric owner identity remains authoritative. Final session
  and paid-boundary authorization rechecks prevent delayed source, report, or
  provider work after sign-out or authorization replacement.
- **Financial safety:** The setup ledger caps aggregate exposure at $25 and
  enters the discussion gate before a new dispatch would bring exposure to $20
  or more. Reservations include both permitted attempts, pricing attestations
  are deploy-bound, and invalid or incomplete usage is retained conservatively.
- **Concurrency:** Durable capability, lease, transition, revision, digest, and
  ownership checks make duplicate delivery and lost acknowledgements
  recoverable without another paid request. Publication remains conditional on
  the same repository generation and finalization owner.
- **API surface:** The branch adds five owner-authenticated JSON routes and one
  capability-authenticated background endpoint. The browser receives only
  current-envelope content, safe previous metadata, safe job state, and safe
  spend availability.
- **Deployment:** The production artifact contains two Node 24 Functions and no
  Edge Function. Fixture, preview, and branch contexts remain static and omit
  the server package.
- **Dependencies:** No runtime dependency is added. The provider client uses
  native `fetch`; `@netlify/blobs` remains the server package's only runtime
  dependency.
- **Secret scanning:** The branch adds fingerprint-specific Gitleaks allowlist
  entries for reviewed fixed UUIDs, a public storage key, and synthetic
  credential shapes whose tests require them. A full-history scan of 95 commits
  then found no leaks.

## Plan compliance

### Compliance verdict

The implementation is in good compliance with the plan. All eight code and
documentation workstreams are implemented and independently reviewed. The
whole Phase 3 outcome remains partial because delivery and live operational
gates intentionally follow this branch review.

Against the plan's nine exit criteria, 4 are complete, 4 are partially complete,
and 1 has not started. The exit-gate fraction reflects required live and
delivery evidence, not a known gap in the committed implementation.

### Completed implementation workstreams

1. **Source prerequisite and bounded analysis input:** Issue creation and
   assignee facts, stable observation matching, fingerprints, normalized
   catalogs, deterministic optional context, safety policy, token admission,
   and structural output admission are implemented with boundary tests.
2. **Fixed policy, schema, trusted assembly, and comparison:** The model can
   supply only analysis fields; the server binds canonical facts, relations,
   uncertainty, lanes, starts, contention, no-verbatim policy, and comparisons
   before accepting a complete report.
3. **Provider transport and worker:** Fixed request construction, free counting,
   bounded SSE parsing, usage classification, zero transport retries, one
   conditional corrective attempt, durable at-most-once transitions, and
   nonpaid resumption are implemented.
4. **Report, catalog, job, and spend persistence:** Exact schemas and size caps,
   conditional storage, immutable versions, current/previous rotation, catalog
   pagination/repair, leases, claims, accounting, deploy rollover, and recovery
   are implemented.
5. **Authenticated APIs:** Saved-report discovery, report retrieval, job
   admission, polling, budget decisions, exact response projection, owner
   rechecks, and historical access are implemented.
6. **Browser experience:** Free opening/checking, explicit Generate/Refresh,
   polling and reload resumption, comparison, provenance, failures, budget
   gates, historical status, pagination, accessibility, and responsive behavior
   are implemented.
7. **Composition and CI:** The two-Function production composition and
   zero-Function fixture boundary are implemented with artifact and composition
   gates. Backend and production-browser jobs are added to CI.
8. **Documentation and mocked/local verification:** User, developer, report,
   deployment, recovery, and retention behavior is documented. Local tests and
   an independent audit cover the implementation. The documentation checklist
   content is present, although its boxes remain unchecked while final delivery
   evidence is pending.

### Exit criteria status

#### Done: 4 of 9

- Existing-report rendering, free automatic freshness checking, explicit paid
  refresh, provenance, and separate failure state are implemented and covered
  in domain and browser tests.
- Historical/source-unavailable reports remain authenticated and viewable while
  new analysis is disabled, with mocked source-loss and restoration coverage.
- At-most-once dispatch, idempotency, concurrency, cap, ambiguity, invalid
  output, runtime, and stale-publication invariants have meaningful focused and
  full-suite coverage.
- Exact retention boundaries, response projection, artifact isolation, and raw
  input exclusion are implemented and tested. The full-history Gitleaks scan
  found no leaks. TruffleHog found zero verified findings; its one unverified
  result is the known synthetic `example.invalid` URI used by the source-safety
  test.

#### Partially done: 4 of 9

- The fixed Opus 5/high-effort path is complete and mocked, but no deployed
  public or private report has crossed the paid boundary.
- Server-side persistence and current/previous rotation are implemented and
  tested, but paid cross-sign-out, cross-browser, and cross-device acceptance
  has not run against production storage.
- Local builds prove the reviewed two-Function production composition and
  zero-Function fixture composition. The actual Phase 3 production and preview
  inventories have not been deployed or inspected.
- Documentation, signed implementation commits, local checks, and independent
  review are complete through this head. The formal review commit, PR,
  current-head CI and review evidence, merge commit, automatic deployment,
  post-merge verification, and worktree/branch cleanup remain.

#### Not started: 1 of 9

- Paid calibration and acceptance have not run, so the user has not yet
  selected monthly and per-report production limits. The separate production
  policy has therefore not been implemented or deployed, as required by the
  plan.

### Deviations

- The implementation uses more signed commits than the seven suggested logical
  boundaries. This is reasonable: the additional commits isolate durable-state
  invariants, review fixes, and documentation corrections without changing the
  planned architecture.
- Review-driven hardening added exact API response projectors, explicit record
  byte ceilings, broader catalog boundary coverage, final authorization fences,
  generic paid-transition guards, and recursively exact comparison validation.
  These additions support the plan's privacy, storage, and at-most-once intent;
  they are not product-scope expansion.
- The plan's documentation checklist remains unchecked even though eight content
  items are implemented. Keeping the final verification item open is correct,
  but the unchecked completed content items make the plan status less precise
  than the implementation. Update them when recording final PR evidence.
- Live deployment, key setup, paid acceptance, and production-policy work were
  intentionally deferred until after implementation and independent review.
  This follows the plan's ordering and is not an omission.

### Fidelity concerns

No implementation fidelity concern remains from the independent audit. The
main residual risk is operational: mocked provider and storage coverage cannot
establish live Anthropic response quality, Netlify background execution, or
cross-device persistence. The plan correctly requires those checks before
Phase 3 completion and before ordinary paid production use.

## Code quality assessment

### Quality verdict

No code change is currently required before PR review. The implementation is
clear, defensive, and extensively tested relative to the concurrency, privacy,
and financial risks it handles. It is not ready to merge until the PR's
current-head CI, review bodies, unresolved threads, mergeability, and Copilot
assessment are clean.

### Strengths

- Trust boundaries are explicit and layered. Source, model output, durable
  records, and API responses each have independent exact validation.
- Paid work is modeled as durable transitions with bounded claims, leases,
  reservations, and reconciliation instead of relying on background-function
  delivery behavior.
- Failure paths preserve the last successful report, distinguish unknown spend
  from settled cost, and prevent stale workers from publishing.
- Storage and transport limits are constants with exact-boundary and
  maximum-width tests rather than undocumented assumptions.
- Owner authentication and source eligibility remain separate, preserving
  historical access without widening analysis authority.
- Tests target interruption points, races, lost acknowledgements, malformed
  provider events, schema smuggling, pagination boundaries, session changes,
  and browser state races. The independent audit also confirmed the generic
  paid-transition guard and no-reread conditional-write behavior in 66 focused
  checks.
- Documentation states current behavior and separates mocked/local evidence from
  live evidence. No secret value appears in the reviewed configuration or
  documentation.

### Required before merge

1. Commit this review artifact, open the PR, and require every current-head CI
   check and review source to be clean. Earlier checks cannot stand in for the
   final head.
2. Use a merge commit only after those gates pass. Production deployment and
   paid acceptance remain separate exit work and must not be presented as
   evidence for this reviewed head before they occur.

The newly added production and worker modules are large because they encode the
full state machines and their boundary checks. Their responsibilities are still
separated across admission, worker, reconciler, job, report, spend, transport,
and response modules. Splitting them further before live acceptance would add
movement without resolving an observed defect, so no refactor is required by
this review.

## Verification

The following committed-head local checks pass:

- `npm run format:check`
- `npm run lint`
- `npm test`: 182 of 182 Vitest checks
- `npm run lint:server`
- `npm run test:server`: 428 of 428 native backend checks
- `npm run test:composition`: 5 of 5 composition checks
- production build and production artifact verifier
- fixture build and fixture artifact verifier
- `npm run test:browser:production`: 138 of 138 checks across Chromium,
  Firefox, and WebKit
- fixture browser suite: 45 of 45 checks across Chromium, Firefox, and WebKit
- `actionlint`
- `markdownlint-cli2` on changed documentation
- root and server dependency audits: zero vulnerabilities
- `git diff --check`
- exact CI-style full-history Gitleaks scan: 95 commits, no leaks
- exact CI-style TruffleHog scan: exit 0, zero verified findings, and one
  unverified known synthetic `example.invalid` URI in
  `server/tests/source-safety.test.mjs`

The final independent audit reported: "Consolidated final audit: no remaining
evidence-backed Phase 3 implementation blockers in the current working tree."
Its focused transition and conditional-write checks passed 66 of 66.

The sandbox reported an operation-not-permitted cleanup message after
TruffleHog completed; the scan itself had already exited 0. Commits `a84e4d6`
and `53f55af` contain `gpgsig` blocks. Local `%G?` reports `N` because the
sandbox cannot access the GPG trust state, so this review records signature
presence without claiming a local trust verification.

## Remaining Phase 3 work

1. Commit this review artifact.
2. Push the branch, open the PR, and resolve exact-head CI, review, and
   mergeability findings.
3. Merge with a signed merge commit and verify the automatic production deploy
   from that exact merge, including two Functions, zero Edge Functions,
   production guards, protected routes, and fixture-only previews.
4. Complete the pre-key free checks. Then have the owner install the
   production-only `ANTHROPIC_API_KEY` through the Netlify UI without exposing
   or reading it back.
5. Run the ordered public, private, and refresh calibration and acceptance
   within the $25 setup cap and $20 discussion gate. Record only sanitized
   usage, cost, validity, and runtime evidence.
6. Present measured monthly-cap and per-report-cap options. After the user's
   decision, implement and deploy the versioned ordinary production policy.
7. Verify post-policy behavior and complete the worktree and branch cleanup
   required by the plan.
