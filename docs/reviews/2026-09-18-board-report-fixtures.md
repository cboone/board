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

## Verification

- `npm run verify` passed: formatting, lint, 112 unit checks, 42 browser checks
  across Chromium/Firefox/WebKit, production build, and static artifact gate.
- `npm audit --audit-level=high` reported no vulnerabilities.
- The independent reproducers confirm the three dependency corrections and
  companion/foreign-reference negative controls.
- All implementation commits use GPG signing. The planning merge commit's
  GitHub signature is verified.
- Subsequent changes after the complete verification run are documentation and
  merge ancestry only; applicable formatting and whitespace checks passed.

## Remaining acceptance boundaries

The phase has no application Functions, service credentials, GitHub gathering,
Anthropic calls, production data, or report persistence. No actual Netlify site
has been provisioned or verified. The loopback server's test-only source routes
are outside the publish directory. Local built browser checks do not establish
deployed Netlify routing or response headers.

Validation establishes structural consistency and source-inventory agreement;
it cannot establish actual issue footprints or prove a collector's completeness.
Future source gathering and analysis must enforce those responsibilities. The
setup provider budget remains unspent. Report deletion remains deferred.

Current-head PR CI/review, merge commit, and branch/worktree cleanup remain the
authorized next workflow steps before Phase 2 implementation.
