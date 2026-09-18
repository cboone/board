# Board report fixtures branch review

Reviewed on: 2026-09-18

Branch: `feature/render-report-fixtures`

Base: `main` at `b33458215bc16bc549ecb3b4948dce00fb096097`

Reviewed through: `fc8071def7b93c81cee091fd70b03561738b0b17`

Reviewed range: 29 changed files. This subsequently added review artifact is
outside that snapshot's file count.

## Result

Ready for the phase PR. No material findings remain in the reviewed implementation.
The [phase plan](../plans/todo/2026-09-18-board-report-fixtures.md) is implemented
as a synthetic static experience; this does not establish production completion.

The report/lane core, renderer/links/styles, application shell, and static
build/server/CI composition received independent reviews outside their authors'
areas. The final documentation delta was independently checked against actual
test results and source behavior. The exact provenance navigation links were
then checked against the canonical plugin layout.

## Delivered behavior

- Validation binds report identity, issue coverage, canonical titles, milestones,
  and progress evidence to an independent inventory. Malformed or oversized
  payloads fail visibly before rendering report data.
- A shared deterministic model implements serial/head/any lanes, same-branch
  units, existing active overlap, legal starts, uncertainty, and original counts.
- `/demo` renders complete, empty, and uncertain synthetic reports with original
  sections, responsive layouts, safe source links, light/dark themes, and
  disposable source-age intervals.
- Static route fallback and strict CSP/security headers are committed. Browser
  checks exercise built assets through those headers, and CI checks the static
  publish artifact independently of the development server.
- README explains the current samples and limits. Subsidiary contract docs pin
  the original skill, reference, template, and validator sources and explain the
  deliberate application adaptations.

## Resolved findings

Three material dependency defects were reproduced, corrected, and independently
verified with positive and negative controls:

1. Head freeing now considers successor companions' soft ordering while
   preserving independent hard blockers' separate behavior.
2. Validation detects cycles between branch units as well as hard/soft issue
   cycles, without promoting companion hard blockers into root restrictions.
3. Known current-source issue references and ordinary issue URLs participate in
   self-reference, duplicate relation, branch-order, and cycle checks. Foreign,
   unknown, and unrelated URL targets remain external.

Additional checks reject an issue number mislabeled as a PR. The original
head-freeing source defect is recorded in
[plugin issue #457](https://github.com/cboone/agent-harness-plugins/issues/457).
Mechanical renderer corrections support both full SHA lengths, maintain progress
tag contrast, and avoid implying access to unpushed local worktrees.

The first PR review identified two additional valid cases. Head freeing now
requires the head to be the sole running branch unit, so completing it cannot
promise new starts while another active branch occupies the lane. Regression
checks preserve overlap capacity and verify the successor stays queued after
head completion. An independent review found no remaining issue in that change.
Prose references now share a preceding-character boundary, leaving longer paths
and embedded references as text while standalone references still link.
Optional null time zones use the browser's local-zone fallback rather than
passing null to the date formatter. An actual browser regression reproduces
the prior exception and checks complete rendering and interval disposal.

Sparse arrays and custom array prototypes previously bypassed parts of the
plain JSON inspection and later array traversal. Validation now rejects them,
including non-enumerable array elements. The independent reproducer confirms
both bypasses are rejected; dense frozen arrays and the ordinary invalid-pick
control retain their expected behavior. Ten regression checks cover these
structural boundaries. The review parser defect that omitted these body findings
is tracked in [plugin issue #458](https://github.com/cboone/agent-harness-plugins/issues/458).

Source identifier validation now rejects branch names with empty path components
and typed issue/PR numbers beyond the safe-integer range. The independent
reproducer confirms both reference gaps and the matching PR progress case.
Nested branch names and maximum-safe-integer references retain valid links;
generic HTTPS reference URLs retain their existing behavior.

The plain JSON boundary also rejects extra enumerable array properties while
preserving the existing exact-index sparse errors. The artifact scan inspects
every regular published file, including `.mjs` and source maps. Synthetic
forbidden-content mutations verify the rejected artifacts; ordinary built
assets remain valid.

Complete own-property inspection rejects hidden, symbol, and accessor properties
without executing getters. Independent reproductions confirm that hidden required
titles, callable properties, and array method overrides cannot bypass validation;
own-key bounds, frozen arrays, and null-prototype objects retain their controls.
Safe HTTPS schemes accept mixed case consistently with source-link generation.

## Verification

- `npm run verify` passed after the PR corrections: formatting, lint, 152 unit
  checks, 45 browser checks
  across Chromium/Firefox/WebKit, production build, and static artifact gate.
- `npm audit --audit-level=high` reported no vulnerabilities.
- The independent reproducers confirm the three dependency corrections and
  companion/foreign-reference negative controls.
- All implementation commits use GPG signing. The planning merge commit's
  GitHub signature is verified.
- The PR corrections also passed their scoped checks: 105 contract/lane checks
  and 26 source-link checks, plus formatting, lint, and whitespace validation.
  Full current-head CI and a fresh PR review remain merge gates.

## Remaining acceptance boundaries

The phase has no application Functions, service credentials, GitHub gathering,
Anthropic calls, production data, or report persistence. Separate setup created
the empty `tracker-boards` Netlify site in `cboone`, ID
`9ddf762e-9c92-44da-8636-e03913200664`, at
`https://tracker-boards.netlify.app`. It has no repository link or deployment;
production behavior remains unverified. The loopback server's test-only source routes
are outside the publish directory. Local built browser checks do not establish
deployed Netlify routing or response headers.

Validation establishes structural consistency and source-inventory agreement;
it cannot establish actual issue footprints or prove a collector's completeness.
Future source gathering and analysis must enforce those responsibilities. The
setup provider budget remains unspent. Report deletion remains deferred.

Current-head PR CI/review, merge commit, and branch/worktree cleanup remain the
authorized next workflow steps before Phase 2 implementation.
