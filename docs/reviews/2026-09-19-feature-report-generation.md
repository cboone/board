# Board report generation branch review

Reviewed on: 2026-09-19

Branch: `feature/report-generation`

Pull request: [#23](https://github.com/cboone/board/pull/23)

Plan:
[Analysis, report persistence, and refresh](../plans/todo/2026-09-18-board-report-generation.md)

Review scope: the complete branch implementation, including the no-spend
analysis preflight and setup-budget decision work. Local aggregate validation
covers the current tree. Exact-head CI, preview, and Copilot review are final
post-commit merge gates, so this document intentionally omits a self-referential
reviewed-through commit.

## Result

The implementation covers the planned application behavior for owner-only
report generation. It includes bounded source projection, fixed Opus 5 analysis,
strict result assembly, durable reports and jobs, conservative spend accounting,
at-most-once paid boundaries, authenticated APIs, explicit Generate and Refresh
flows, and production-only server composition.

The latest work adds two missing setup controls. An explicit no-spend preflight
checks model metadata and token count before analysis can be admitted. A global
setup-budget panel then shows settled, reserved, unknown, and total exposure and
records an explicit continue or stop decision when the $20 discussion gate is
reached. Neither control creates a job, reserves funds, or sends a Messages
request.

Independent review found authorization-ordering, concurrency, idempotency,
ledger-validation, and browser-state gaps in these controls. The current
branch addresses each finding described below. Exact-head pull request gates
are checked on the final commit before merge.

Phase 3 remains incomplete. The branch has not been merged or deployed, no
Anthropic key has been read or installed for this phase, and no paid provider
request has run. Setup spend therefore remains $0. Production deployment, free
deployed verification, paid public/private/refresh acceptance, the user's
ordinary production spending-policy decision, enforcement of that policy, and
branch cleanup remain pending.

## Changes by area

### Source safety, input, and report semantics

The canonical GitHub snapshot includes issue creation and assignee facts and is
projected into a bounded normalized provider wire format. Mandatory evidence
remains complete, optional comments and files use deterministic selection,
known credential paths and sensitive inputs are excluded or rejected, and raw
source remains transient. The fixed analysis wire, strict application
validator, trusted report assembler, no-verbatim policy, and deterministic
current-versus-previous comparison keep model output inside the report
contract.

Primary files: `server/lib/analysis-input.mjs`,
`server/lib/analysis-result.mjs`, `server/lib/source-safety.mjs`,
`server/lib/gather.mjs`, `src/domain/analysis-wire.js`, and
`src/domain/report-comparison.js`.

### No-spend analysis preflight

The owner- and CSRF-protected preflight route accepts the exact repository,
operation, and expected-current-report tuple. Every call pins current repository
access. When the deployment has no marker, preflight performs a fresh GitHub
source check, prepares the bounded input, retrieves fixed-model metadata, and
calls token counting through a provider surface that does not expose Messages.
That first verification persists one source-free readiness marker bound to the
deploy, setup policy, model contract, and request contract.

Admission requires the current marker and rejects a missing, malformed, stale,
or foreign marker. Reusing an existing marker skips full source and provider
setup while revalidating authorization, the exact report tuple, and active-job
state. The paid worker independently recollects and recounts its current source
before the paid boundary. New marker creation repeats the tuple and active-job
validation after publication, closing the interval in which another request
could claim the repository while metadata and token counting completed. Lost
marker acknowledgements and concurrent create-only writes converge on the same
canonical marker without another provider setup call.

Primary files: `server/lib/analysis-preflight-readiness.mjs`,
`server/lib/analysis-preflight.mjs`, `server/lib/analysis-request.mjs`,
`server/lib/analysis-admission.mjs`, and their tests.

### Provider transport and paid-work coordination

The native Anthropic transport fixes model `claude-opus-5`, high effort,
standard service, global inference, a 16,384-token output cap, structured
output, and zero automatic retries. The background worker proves current
authorization, policy validity, reservation ownership, lease ownership, and
remaining runtime before either paid transition. It permits at most one
strictly bounded corrective attempt and treats incomplete billing evidence as
conservative unknown exposure without replaying a paid request.

The background Function authorizes the current dispatchable state, capability,
and deployment before reading server secrets or opening any store beyond the
job store. The worker repeats the capability and deployment proof after
reconciliation, then uses the reconciled ETag for its conditional free-work
claim. A replay or concurrent capability rotation therefore stops before
source or provider work.

Netlify acknowledges a background Function request with an immediate `202` and
discards the handler's return value. The handler therefore completes with no
value for expected invalid or forbidden entry attempts, awaits authorized work,
and rejects unexpected failures with a fixed generic message so the platform
can retry without exposing internal details.

Primary files: `server/lib/anthropic.mjs`,
`server/lib/analysis-admission.mjs`, `server/lib/analysis-worker.mjs`,
`server/lib/analysis-reconciler.mjs`, and
`server/functions/report-job.mjs`.

### Durable reports, jobs, and setup spending

Separate storage purposes hold authentication, reports and immutable versions,
analysis jobs, and spending ledgers. Exact schemas, byte ceilings, strong
reads, conditional writes, revision-bound accounting, one active job per
repository, current/previous report rotation, an owner report catalog, and
bounded recovery paths preserve the last successful report through failures,
ambiguous provider outcomes, stale workers, source loss, and lost write
acknowledgements.

The setup ledger preserves every deploy-bound pricing policy and partitions
exposure into settled, reserved, and unknown amounts. It enforces the $25
lifetime cap and requires discussion before a new dispatch would bring total
exposure to $20 or more. Discussion decisions are append-only, ordered by
completed trigger revision, and use globally unique decision IDs across all
retained policies. A `required` discussion stays blocking if later accounting
reduces exposure. An acknowledgement's operation set and authorized ceiling
also remain binding below the threshold.

Exact retries of an already stored decision remain idempotent after deploy
rollover because lookup covers retained policies before current-policy
admission. Reusing the decision ID with different content fails, and a new
decision cannot be added to an inactive policy.

Primary files: `server/lib/cas-records.mjs`,
`server/lib/job-machine.mjs`, `server/lib/job-store.mjs`,
`server/lib/jobs.mjs`, `server/lib/report-records.mjs`,
`server/lib/report-store.mjs`, `server/lib/report-versions.mjs`,
`server/lib/spend.mjs`, and `server/lib/spend-store.mjs`.

### Authenticated API and budget projection

The production API provides saved-report listing, direct report retrieval,
Generate and Refresh admission, job polling, no-spend preflight, global analysis
availability, and setup-budget decisions. Exact response projectors expose only
the setup mode and status, policy and model, pricing validity, exposure
breakdown, limits, remaining amount, and current discussion summary. They do
not reveal jobs, attempts, deploy identifiers, ledger revisions, decision
history, or accounting details.

A decision request binds the policy, discussion revision, 32-byte hexadecimal
decision ID, decision, permitted operations, authorized ceiling, and the exact
settled/reserved/unknown observation shown to the owner. A conflicting current
projection is returned for fresh review. Retrying an uncertain response uses
the same ID and exact body. Final owner-session rechecks fence delayed private
responses, while source eligibility remains separate so an authenticated owner
can still read a historical report when GitHub access is unavailable.

Primary files: `server/lib/api.mjs`, `server/lib/api-responses.mjs`,
`server/lib/report-operations.mjs`, and `server/functions/api.mjs`.

### Browser report and setup experience

The production shell merges eligible repositories with the durable report
catalog, opens saved reports before a free source check, and offers paid work
only through explicit Generate or Refresh actions. It renders progress,
freshness, failures, provenance, comparisons, and historical/source-unavailable
states separately while preserving the current successful report.

The dashboard always presents the global setup-budget projection. At the
discussion gate, it shows the exact exposure breakdown, model, pricing date,
threshold, and limit. Continue records the bounded authorization, while Stop
requires inline confirmation. Neither action starts analysis. Conflicts replace
the display with the authoritative server projection, and uncertain failures
offer an exact-body retry.

Source checks, availability refreshes, preflight, admission, and setup decisions
are serialized where they can update shared analysis state. A terminal job that
arrives during a decision records a deferred availability refresh; the browser
fetches the authoritative projection after the decision completes. A
successful-job reload also records a deferred source check while shared state is
busy, so the refreshed report still receives its automatic GitHub check.
Request sequence checks, view generations, and sign-out cleanup prevent delayed
responses from restoring stale data. A newer projection clears obsolete stop
confirmation, and repository navigation and reload actions remain inactive
while a decision is pending.

Primary files: `src/app/production.js`,
`tests/browser/production/authentication.spec.js`,
`tests/browser/production/mock-api.js`, and
`tests/browser/production/reports.spec.js`.

### Composition, CI, and documentation

Production composition stages exactly the synchronous `api` Function and the
native background `report-job` Function. Every other context remains a static
fixture with zero Functions and no server package. CI covers the backend,
production composition, dependency audit, and production browser suite. The
README, report contract, production setup guide, project guidance, roadmap, and
phase plan document the implemented boundaries without claiming live Phase 3
evidence.

Primary files: `.github/workflows/ci.yml`, `.gitleaksignore`,
`scripts/build-board.mjs`, `AGENTS.md`, `README.md`,
`docs/production-setup.md`, `docs/report-contract.md`, and the roadmap and
phase-plan documents.

## Independent review resolutions

1. **Reused preflight marker:** Marker reuse now repeats authorization and
   reloads the exact Generate or Refresh tuple, including expected current
   report and active job. Tests cover stale Generate, stale Refresh, and an
   existing active job without repeating source or provider setup work.
2. **Marker-publication race:** Preflight now repeats authorization and exact
   tuple validation after the conditional marker write. A race test installs an
   active job during marker publication and confirms both the original and
   later marker-reuse paths reject admission.
3. **Source-check race:** Shared-state operations are serialized. Source
   checking waits for availability, preflight, admission, and decision work,
   while decisions wait for the source-check budget refresh. Browser coverage
   delays preflight and proves Check remains disabled and no extra source
   request starts.
4. **Deploy-rollover idempotency:** The store searches retained decisions before
   requiring the request policy to be active. An exact retry returns the stored
   result after rollover. Changed content under the same ID and a new decision
   against the old policy both fail.
5. **Discussion history:** Ledger projection requires one ordered decision for
   each completed trigger revision, exact current-status consistency, and
   decision-ID uniqueness across every retained policy. Focused tests reject
   missing, duplicate-revision, inconsistent-current, and cross-policy
   duplicate records.
6. **Below-threshold scope:** Reservation checks an existing `required` state
   unconditionally and enforces an acknowledgement's operations and ceiling at
   every exposure level. Tests settle or release exposure below $20 and confirm
   the gate remains closed until a matching decision exists.
7. **Deferred authoritative refresh:** Completion marks the aggregate refresh
   as deferred. After the decision or explicit reload finishes, the browser
   reads the current projection and applies normal sequence checks. Coverage
   includes failed and successful jobs racing with both completion paths.
8. **Stale browser state:** Availability requests use monotonic sequence tokens,
   protected state is cleared on sign-out, conflicts replace the projection,
   exact retry bodies are retained only for uncertain failures, and new
   projections clear obsolete stop confirmations.
9. **Final paid authorization:** Both paid paths validate the immutable
   preflight marker before the final active-account and token-generation
   recheck. That recheck is the last awaited proof before the primary or
   corrective paid-boundary CAS. Tests revoke authorization as each marker read
   completes and observe no corresponding Messages call.
10. **Post-success source check:** If a successful report reload occurs while a
    prior source check is active or a decision or availability read blocks
    shared state, the browser records a deferred source check. It runs after the
    active check or blocker clears, including after an active check fails, even
    when the view retains a non-idle freshness result from the report that was
    replaced.
11. **Resolved discussion state:** Any authoritative projection that no longer
    requires budget discussion clears only the matching stale admission error.
    Reload and decision paths preserve unrelated analysis failures and resume
    any aggregate refresh deferred by terminal accounting.
12. **Background-entry capability replay:** The native background entry now
    uses the job store's dispatch authorization before reading authentication
    or analysis secrets or opening the auth, report, and spend stores. The real
    store rejects a valid capability after the job leaves `dispatchable`, and a
    Function regression observes only the job store on that rejection.
13. **Capability rotation during reconciliation:** The worker rechecks the
    deployment and capability on the reconciled job before claiming free work.
    Its conditional claim still uses that exact snapshot, so a later rotation
    conflicts safely. A paused-worker regression rotates the capability during
    reconciliation and observes no source, model, counting, preflight, or
    Messages activity.
14. **Background acknowledgement semantics:** Netlify itself emits the immediate
    `202` and discards handler return values, so there was no production
    acknowledgement-timing defect. The handler now expresses its actual
    lifecycle as `Promise<void>`: expected invalid or forbidden attempts resolve
    without retry, authorized worker work remains awaited, and unexpected
    failures reject with the fixed generic message that signals a platform
    retry.
15. **Asynchronous source-check assertion:** The production browser test polls
    for the required automatic source-check request after the empty report state
    appears instead of assuming Firefox records that later request in the same
    rendering turn. The assertion still requires the exact repository-check
    method and path before generation proceeds.
16. **Preflight source-freshness wording:** Exact-head Copilot review found a
    documentation discrepancy in the reused-marker path. The review and pull
    request now distinguish the full source check used to create a marker from
    later calls that repin current access and revalidate report state without
    another full source or provider request. The worker still recollects and
    recounts the source used for paid analysis.
17. **Admission conflict cleanup:** A normal returned CAS conflict does not
    enter the admission catch, but a failed strong read while classifying a
    stale write can. Cleanup now rereads the live job and terminalizes only
    `created` or `reserved`; a concurrent `dispatchable` winner remains owned by
    its worker or deadline recovery. Deterministic tests cover failures after
    both the reservation and capability-install writes. Removing the live-state
    guard makes both tests end with an incorrect `failed` job.
18. **Credential boundary wording:** The README now states that Board sends its
    Anthropic API key only to Anthropic for provider authentication, while
    GitHub authorization tokens and owner-session credentials never go to
    Anthropic. The Anthropic API key and GitHub authorization tokens never enter
    browser-accessible storage or static artifacts.

## Plan compliance

The implementation is in good compliance with the plan's code, storage,
privacy, and user-experience workstreams. The branch implements:

1. Bounded source collection and deterministic provider input.
2. A fixed model policy, strict schema, trusted report assembly, and comparison.
3. No-spend preflight plus at-most-once provider dispatch and recovery.
4. Durable report, catalog, job, and conservative spending state.
5. Owner-authenticated APIs with exact request and response boundaries.
6. Explicit browser generation and refresh, setup-budget decisions, historical
   access, and failure preservation.
7. Two-Function production composition and fixture-only nonproduction builds.
8. User, developer, deployment, retention, and recovery documentation.

The following exit evidence remains partial or absent:

- No deployed public or private report has crossed the paid boundary.
- Paid cross-sign-out, cross-browser, and cross-device persistence has not been
  demonstrated against production storage.
- The production inventory for the final merge has not been deployed and
  inspected. Fixture-only preview verification remains an external merge gate.
- Paid calibration has not produced evidence for the user's monthly and
  per-report production limits, so the separate ordinary production policy is
  intentionally not implemented.

### Deviations

- The implementation uses more signed commits than the suggested logical
  boundaries. The additional commits isolate durable-state invariants, review
  fixes, setup preflight, and documentation changes without changing the
  planned architecture.
- Review-driven hardening added exact API response projectors, explicit record
  byte ceilings, broader catalog boundaries, final authorization fences,
  generic paid-transition guards, recursively exact comparison validation, and
  the preflight and budget race protections above. These changes support the
  plan's privacy, storage, and at-most-once requirements.
- Live deployment, key setup, paid acceptance, and production-policy work remain
  ordered after implementation review. They are pending delivery gates rather
  than omitted application behavior.

## Code quality assessment

The reviewed design is defensive and appropriately explicit for the privacy,
concurrency, and financial risks it handles. Source data, model output, durable
records, and browser responses have separate exact validators. Paid work uses
durable transitions, claims, leases, reservations, and reconciliation rather
than relying on background delivery behavior. Owner authentication and source
eligibility remain separate, preserving historical access without widening
analysis authority.

The tests concentrate on interruption points, conditional-write races, lost
acknowledgements, malformed provider events, schema smuggling, pagination,
session changes, budget transitions, decision idempotency, and browser state
races. The latest review findings resulted in focused regressions instead of
comment-only dispositions.

No refactor is required solely because the production and worker modules are
large. Their responsibilities remain separated across preflight, admission,
worker, reconciler, job, report, spend, transport, and response modules. The
current local review found no unresolved implementation defect.

## Verification

Current-tree validation includes:

- native preflight tests covering exact tuple revalidation, marker-publication
  races, malformed and stale marker fields, lost acknowledgements, and
  concurrent create-only writes;
- native spend and spend-store tests covering ordered globally unique decisions,
  below-threshold scope enforcement, and deploy-rollover idempotency;
- paid-boundary tests that revoke authorization as primary and corrective
  preflight reads complete;
- `npm test`: 182 of 182 Vitest checks;
- `npm run test:server`: 457 of 457 native backend checks;
- `npm run test:composition`: 5 of 5 composition checks;
- `npm run test:browser:production`: 189 of 189 checks across Chromium,
  Firefox, and WebKit;
- `npm run test:browser`: 45 of 45 checks across Chromium, Firefox, and WebKit;
- root and server dependency audits with zero vulnerabilities;
- fixture and production builds with their artifact verifiers;
- frontend and server lint, formatting, `actionlint`, Markdown lint, and
  `git diff --check`;
- exact full-history Gitleaks scanning with no leaks; and
- the exact v3.2.0 TruffleHog workflow command with zero verified findings and
  one known indeterminate historical URI fixture from commit `0e72d14`. The
  current fixture constructs that URI at runtime and passes a strict
  current-file scan.

Exact-head GitHub Actions, Netlify preview, Copilot review, unresolved threads,
and mergeability are external merge gates rather than current-tree evidence.
They must be clean on the final commit proposed for merge.

A stricter full-history TruffleHog run with `--fail` exits on that reviewed
historical fixture, so it is not recorded as a strict pass. No file-wide or
detector-wide exclusion was added. The shared action's missing released strict
mode and precise, redacted fixture allowlist are tracked in
[cboone/gh-actions#123](https://github.com/cboone/gh-actions/issues/123).

Every branch commit contains a `gpgsig` block. Local signature trust remains
unavailable in the sandbox; that limitation is separate from signature
presence.

## Remaining Phase 3 work

1. Obtain the user's explicit merge approval, merge with a signed merge commit,
   and verify the automatic production deploy from that exact merge, including
   two Functions, zero Edge Functions, production guards, protected routes, and
   fixture-only previews.
2. Complete the pre-key free checks. Then have the owner install the
   production-only `ANTHROPIC_API_KEY` through the Netlify UI without exposing
   or reading it back.
3. Run the ordered public, private, and refresh calibration and acceptance
   within the $25 setup cap and $20 discussion gate. Record only sanitized
   usage, cost, validity, and runtime evidence.
4. Present measured monthly-cap and per-report-cap options. After the user's
   decision, implement and deploy the versioned ordinary production policy.
5. Verify post-policy behavior and complete the worktree and branch cleanup
   required by the plan.
