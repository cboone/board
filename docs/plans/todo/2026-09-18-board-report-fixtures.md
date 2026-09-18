# Board report contract and fixtures

## Status and authority

Phase 1 implementation is prepared and verified on 2026-09-18 after the product
requirements interview and independent plan review. The dedicated feature
branch awaits its PR review and merge. This phase implements
the report contract and a synthetic fixture experience; live authentication,
GitHub gathering, paid analysis, and report persistence belong to later phases.

Follow the [product roadmap](2026-09-18-board-product-roadmap.md), definitive
[project prompt](../project-prompt.md), original `publish-report-board` skill,
and confirmed user answers. Deletion controls, self-hosting documentation, and
custom-domain setup are deferred.

## Foundation baseline

The foundation at `800342dba1980c460812b15205cb41249a6ac584` provides Vite,
Alpine CSP, Tailwind CSS, Vitest, Playwright, formatting, and CI. The application
renders a welcome screen and theme button. `src/domain/board.js` is an unused
count helper whose ready-count semantics conflict with the original skill.
Tests cover that helper and the welcome screen.

The installed skill's validator and template match canonical plugin revision
`046f1389caf53d6ec8c81e8c88b927a40d154b79`. Its reference documents, validator,
and renderer provide the semantic baseline. The source has global styles,
inline assets, a remote font dependency, and an age interval without disposal;
adapt those deliberately when porting into the application.

## Deliverables

1. A pure JavaScript report validator bound to an independent source inventory.
1. A shared deterministic lane model for counts, branch units, eligibility,
   active overlap, and capacities.
1. A responsive report renderer preserving the skill's sections and design.
1. A clearly labeled synthetic demo with complete, empty, and uncertain cases.
1. Meaningful unit/browser checks and fixture-only built-artifact checks.
1. User-focused fixture instructions and subsidiary contract/provenance docs.

## Data and validation

Keep the required original report fields: `board`, `title`, `repo`, `sync`,
`summary`, `issues`, `lanes`, and `startNow`. Preserve optional top-level
`repoUrl`, `milestones`, `contention`, and `notes`. Every issue requires
`milestone`, using `null` when absent.
Keep application job, freshness-check, provider, and retention metadata outside
that report payload. Later server and browser code share the validator.

Validation takes a report plus an independently assembled inventory. For this
phase, fixture inventory and report are separately authored inputs. Production
will supply the inventory from GitHub, never from the model's returned issue
list. Validate report identity, complete issue coverage, canonical issue titles
and milestone membership, and visible work-in-progress evidence against source
facts. Assignment alone cannot create progress evidence.

Validate types, required fields, positive issue numbers, unique issue/lane/claim
identities, calendar-valid timestamps, full commit SHA, time zones, lane modes,
complete lane membership, reference shapes, dependency cycles, branch units,
and legal start picks. Detect cycles across hard and soft issue relations,
including mixed cycles and cycles between branch units. Normalize a reference
to the current repository's issue as a local dependency. Reject an `after`
target also listed in `waitingOn`, and reject soft ordering within a branch
unit. Validate contention references and reject a shared
claimed component split across independent lanes. Semantic analysis remains
responsible for identifying actual footprints; shape validation cannot prove
that a model understood the repository correctly.

Return field-specific validation errors without throwing on malformed external
input. Rendering accepts only validated data and fails visibly without rendering
an incomplete report. Set reasonable structural size bounds in code so an
untrusted payload cannot cause unbounded traversal or DOM construction.

Represent uncertainty explicitly on affected issues with a reason and optional
source reference. Keep unclear scope and unverifiable blockers visible without
inventing a verified dependency state. Suppress starts for affected branch
units and lane eligibility, including a head whose uncertainty holds its lane.
Preserve the original `ready = open - hard blocked` header definition; uncertainty,
queued work, active work, runnable capacity, and recommendations are distinct.

Deliberately extend the original validator's nonempty requirement for an empty
GitHub backlog: permit empty issues, lanes, and picks together, show zero counts
and meaningful empty sections. Do not permit empty lanes to hide nonempty issues.
This is an application empty state, not a new board type.

## Lane model

Build one shared model used by validation and rendering. Expose issue lookup,
lane membership, same-branch roots/companions, blocker/soft-order relations,
active evidence, eligible roots, per-lane capacity, head freeing counts, and
header statistics. Avoid reimplementing start eligibility inside the renderer.

- Serial lanes skip roots that cannot start and recommend their first eligible
  root when no active branch holds the slot.
- Head lanes allow only the head until it lands. A blocked, queued, or uncertain
  head prevents later roots from starting. Count what that head actually frees,
  excluding branches still held by independent constraints.
- Any-order lanes count independent runnable branch units, preserving active
  work even when its current blocker or ordering status differs.
- Active roots or companions hold serial/head slots. Multiple active roots
  remain visible as existing overlap rather than becoming valid new picks.
- Same-branch companions remain in the root's lane and do not count as separate
  branches or independent start picks. A companion's soft ordering queues the
  unit, and active companion work holds its slot. A companion's independent hard
  blocker prevents that companion from running without automatically blocking
  an otherwise runnable root. Approved uncertainty may conservatively suppress
  the affected unit.
- Starts may use fewer branches than capacity, with a concrete explanatory note.

## Renderer and application shell

Keep Vite, Alpine CSP, Tailwind, and the existing dependency set. Use plain DOM
helpers for report content and Alpine for shell state. No framework migration or
DOM-test package is needed for this phase.

Suggested boundaries:

- `src/domain/report-contract.js`: report and inventory validation.
- `src/domain/lane-model.js`: shared derived semantics.
- `src/report/render.js`: validated report to a supplied DOM mount.
- `src/report/links.js`: encoded source links and safe prose-reference parsing.
- `src/report/style.css`: scoped report tokens and component styles.
- `src/fixtures/`: authored synthetic reports and independent inventories.
- `src/main.js`: shell state, route selection, and shared theme behavior.

The `/` welcome screen links to `/demo`. The demo is always synthetic and clearly
labeled. It may offer authored scenarios without resembling a repository picker
connected to GitHub. Unknown routes receive a clear unavailable-page state.
Reserve the future `/:owner/:repo` route pattern in documentation; do not expose
real report routes or a fabricated live sign-in flow in this phase. Netlify
static route fallback must preserve direct demo navigation and refresh.

Render header metadata and six original counts, summary, Start now, Lanes,
Contention, Blocked, and the source-authoritative footer. Include uncertainty
alongside the affected issue and explain withheld starts. Preserve canonical
titles, no-milestone cues, all reference forms, active overlap, and branch units.
Keep content in one column at most 1080 pixels wide. Tables scroll within their
container; the page itself fits a narrow viewport.

Use theme tokens shared with the shell. Amber identifies current/actionable or
contended work; blue identifies interaction. Use solid, outlined, hatched, and
dashed state cues in addition to color. Preserve visible keyboard focus and
semantic headings/table relationships. Use local/system fonts rather than
introducing the template's remote font request.

Render untrusted strings with text nodes. Do not use `innerHTML`, dynamic script
execution, or unvalidated URL interpolation. Encode branch names, paths, and
search queries. Generated issue, PR, branch, commit, and milestone links use
`https://github.com` or the inventory-verified optional `repoUrl` base. Explicit
external references may target an HTTPS URL with a valid DNS-style hostname;
they require a visible label and
are navigation links only. Reject non-HTTPS URLs, credentials in URLs, whitespace,
backslashes, double quotes, and angle brackets during validation. Link helpers return
no destination for unsafe values, which defensive rendering shows as plain
text. Source links use the current browser context and the site's `no-referrer`
policy; any future links opening another tab require `noopener noreferrer`.
Never fetch external references.

Externalize script/styles/data. Adapt the template's inline style assignments
to classes or another verified CSP-compatible form. Define and verify the built
site's CSP and security headers against Alpine CSP, report styling, and Vite
assets; development-server behavior alone is insufficient evidence. Return a
renderer disposal function to clear the report age interval on replacement.

## Fixtures

Author synthetic repository identity and inputs; do not fetch real GitHub data.
Include a complete scenario demonstrating serial/head/any lanes, hard and soft
relations, cross-repository/PR/branch/URL references, shared components,
same-branch companions, active overlap, milestones, no-milestone issues, and
fewer recommendations than capacity.

Include empty/no-milestone, uncertain-scope/unverifiable-blocker, and safe-rendering
examples. Invalid payloads belong in test fixtures or a test harness, rather
than a normal product control. Scenario labels explain that they are sample
data and cannot trigger service calls.

## Implementation sequence

1. Commit the settled requirements and plan with GPG signing.
1. Create the phase's distinct feature branch/worktree and record its plan review.
1. Implement contract, uncertainty extension, lane model, and independent fixtures.
1. Port the renderer, safe source links, shared theme tokens, demo route, and
   disposal behavior.
1. Add relevant unit/browser coverage and built-static deployment checks.
1. Update README and subsidiary developer docs; reconcile phase-related open
   issues against delivered behavior without closing unrelated work.
1. Run project verification and review the final change independently.
1. Open and monitor the PR through clean current-head CI/review evidence, merge
   with a merge commit, clean up the branch/worktree, and continue to Phase 2.

## Verification and exit criteria

Unit checks establish inventory omissions/additions/title changes, malformed
payloads, invalid dates/SHA/zones, dependency cycles, reference/link validation,
cross-lane companion rules, contention grouping, and illegal picks. Lane checks
cover every mode, skipped serial roots, blocked/queued/uncertain heads, active
companions, overlapping active branches, unit constraints, and freeing counts.
Include an otherwise runnable root with an independently hard-blocked companion.
Include zero-issue and no-milestone cases. Expected outputs derive from the
contract examples, rather than merely repeating implementation calculations.

Browser checks cover actual sections/counts/source links, text-safe rendering,
sample scenario selection, direct demo navigation, unknown routes, theme use,
keyboard interaction, accessibility, and narrow-screen overflow. Exercise the
existing Chromium, Firefox, and WebKit projects. Verify no GitHub/Anthropic
requests and no user-data persistence from fixture routes.

Verify the built artifact and route/security-header configuration independently
of the dev server. Confirm no application functions, credentials, database
packages, or production inputs are deployed. Run `npm run verify` and relevant
configured security checks. Record actual results, not intended checks.

Phase 1 is complete when the original report behavior plus the agreed uncertainty
handling is usable with synthetic data, validator/lane checks are meaningful,
browser checks pass, and static-only preview isolation remains intact. It does
not claim live authentication, paid analysis, report storage, or production
completion.

## Recorded implementation verification

The implementation replaces the unused count helper with inventory-bound
validation and a shared lane model, renders all original sections at `/demo`,
and supplies independently authored complete, empty, and uncertain sample inputs.
Source links, theme preferences, responsive layouts, and renderer disposal are
implemented. Built browser checks use the committed Netlify security headers.

`npm run verify` passed after the PR corrections with 131 unit checks and 45
browser checks across
Chromium, Firefox, and WebKit, plus build and static artifact verification.
`npm audit --audit-level=high` reported no vulnerabilities. Independent final
reviews found three dependency-model defects, all corrected and independently
verified with positive and negative cases. The source head-freeing defect is
recorded in [plugin issue #457](https://github.com/cboone/agent-harness-plugins/issues/457).

The first PR review also corrected head-freeing claims when another branch is
active and prose links embedded in longer paths. The 95 contract/lane checks
and 26 source-link checks pass, including reproduced negative cases and positive
controls. Current-head PR checks and a fresh review remain required before merge.
Optional null time zones also render through the local-zone fallback; browser
coverage reproduces the prior formatter exception and verifies report sections
and interval disposal.

Structural validation rejects sparse arrays, non-enumerable array elements,
and custom array prototypes before traversing report data. Independent
reproductions confirm the rejected bypasses while dense frozen arrays retain
their valid behavior. The review parser's missed body findings are recorded in
[plugin issue #458](https://github.com/cboone/agent-harness-plugins/issues/458).

No actual Netlify deployment, credentials, GitHub gathering, provider call, or
report persistence is claimed by this phase. Deployed route/header verification
and the remaining live product are later acceptance requirements.

## Dependencies and deferred decisions

No credentials or paid provider calls are needed for this phase. GitHub App
registration, runtime/store selection, file/input bounds, production usage limits,
and site provisioning are later dependencies. Prepare concrete reviewed settings
before asking for any owner-only authentication or service action.
