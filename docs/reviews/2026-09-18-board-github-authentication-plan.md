# GitHub authentication plan review

Date: 2026-09-18

Status: ready for implementation. Preliminary corrections and independent
reviews of the integrated plan against merged baseline
`f8b78767babe021754873bd60540fbac8500b186` are complete. Implementation and live
acceptance remain pending.

## Scope and disposition

Preliminary independent plan review identified four required corrections. This
record states the findings and their plan resolutions. It does not claim that
implementation or runtime tests have passed.

Reviewed artifact:
[GitHub authentication plan](../plans/todo/2026-09-18-board-github-authentication.md).
The original prompt, original skill, and confirmed user answers control scope;
the living roadmap records their interpretation. No repository, code,
configuration, credential, or service implementation is performed by this
preliminary planning review. Independently verified production setup state is
recorded below; it does not establish implementation or live acceptance.

## R1 Private acceptance evidence

Finding: recording private repository IDs, counts, and source tips in committed
acceptance evidence would expose private metadata through the public repository
or PR even without raw issue bodies.

Resolution: the live acceptance section now keeps private names, IDs, titles,
SHAs, counts, and scope details in protected server-side or local transient
evidence only. Public documents, PRs/comments, logs, and screenshots record
sanitized private acceptance pass/fail. Detailed private screenshots/dumps are
excluded, and raw acceptance sources are not retained after the check.

Observable implementation check: live private acceptance succeeds through the
authorized interface while the committed evidence contains only the sanitized
result and no private identifiers or facts.

Disposition: resolved in plan; implementation/live evidence validation pending.

## R2 Resolved reference completeness

Finding: comparing open issues/PRs and source tips misses individually resolved
closed reference targets. Their state-reason/merge facts or accessibility can
change while the existing primary manifests remain fixed.

Resolution: the plan now requires a bounded resolved-reference manifest covering
same-repository targets actually read, including closed issues/PRs. It records
identity/type, state/status, issue state reason, relevant PR merged/merge-SHA
facts, and explicit verification/uncertainty outcomes. It excludes extra closed
body/comment context. Fingerprinting and the second pass independently compare
that manifest, including changes between readable and unreadable states.

Observable implementation checks: change a still-closed issue state reason,
relevant PR merge facts, or reference accessibility while keeping open manifests
and default SHA fixed; the reference fingerprint changes and the stability guard
fails. Unchanged closed facts form a stable control. Reopening, already caught
by the open manifest, is a negative control rather than the sole new guard test.

Disposition: resolved in plan; meaningful mocked regressions pending.

## R3 Backend test and dependency isolation

Finding: a standalone server package alone does not prevent root Vitest from
discovering backend tests, and an implicit test install path would undermine the
fixture dependency boundary. Backend validation and production composition need
explicit commands and CI ownership.

Resolution: add `server/**` to root Vitest exclusions without removing existing
exclusions. The independent server package uses native `node --test` with
injected provider/storage/clock/random mocks. Separate explicit install, test,
and audit aliases and a backend CI job install the locked server dependencies
and check server tests/audit plus production/fixture composition. Root ESLint
explicitly covers `**/*.mjs`, and a backend lint alias/job parses authored
server sources without executing imports. Root Vitest exclusion does not exclude
server code from lint coverage. The ordinary fixture job installs root
dependencies only. Composition uses synthetic sentinel keys and no real
credentials; missing/unknown/preview/branch context cannot invoke server
installation or leave Functions behind.

Observable implementation checks: root fixture tests pass without
`server/node_modules`; backend tests run through the separate native runner;
unexpected provider/store access fails closed; the backend job runs test/audit
and composition; preview-after-production artifacts contain zero Functions and
no secret sentinel values. No paid provider call is part of the suite.

Disposition: resolved in plan; commands/configuration/CI implementation pending.

## R4 Protected browser lifecycle

Finding: server logout/expiry checks alone leave private inventory and source
results in browser state. Outstanding responses or history restoration can
repopulate or redisplay protected content after authentication ends.

Resolution: clear inventory, selection, source-check results, CSRF state, and
protected DOM immediately on logout/expiry/revocation/401. Increment an
in-memory authentication generation, abort outstanding protected requests, and
ignore responses from older generations. Validate the authoritative server
session before initial/history/back-forward-cache restoration displays protected
content. A failed logout clears the browser view while reporting unconfirmed
server sign-out rather than claiming successful revocation.

Observable implementation checks: delayed old-session inventory/source responses
cannot restore content after logout, expiry, or a new login; browser
back/history restoration after logout shows no private content before
authorization succeeds. Tests exercise actual mocked route delays/navigation
rather than only helper assignments.

Disposition: resolved in plan; browser implementation/regressions pending.

## Verification and remaining review

The plan retains owner ID `99961`, the GitHub App read-only PKCE/user-token
approach, encrypted whole-pair CAS refresh without ambiguous replay, independent
historical-read authorization, the 1,000-issue contract limit, isolated server
dependencies, Node 24, verified Personal-plan constraints, and zero paid AI
scope. No new product questions, deletion UI, or future Phase 3 feature claims
were introduced. Authorized service setup is tracked separately from phase
implementation and review readiness.

The minimal server uses native Request/Response, platform-provided context, and
plain `.mjs` handlers/configuration. Official Netlify documentation confirms no
Functions SDK is required for JavaScript. Blobs `11.1.0` is the sole selected
runtime dependency; Functions `6.0.0` remains an optional helper candidate. The
plan requires generated-entry helper/package resolution and bundle checks.

The integration contract fixes authentication, repository-list, and source-check
routes, structured safe responses/errors, and injected source operations without
raw source serialization or Phase 3 routes. Preview composition serves a static
synthetic API 404 before its SPA fallback; production omits that API fallback.
Actual deployed routing remains an acceptance check. Primary pagination rejects
any repeated identity, including matching duplicates; canonically matching
cross-source joins remain valid.

Verified setup identifies the owned `tracker-boards` site as
`9ddf762e-9c92-44da-8636-e03913200664`, in account `cboone`, and the registered
`cboone-tracker-boards` App as ID `4995264`, Client ID `Iv23liQyjqNGXrULGeSB`,
owner `99961`. The exact verified repository grants are `metadata:read`,
`issues:read`, `pull_requests:read`, and `contents:read`, with `events:[]`.
Initial production environment configuration includes those identifiers,
canonical origin, owner ID, token key ID `2026-09-18`, a freshly generated
32-byte base64 token-encryption secret, and runtime override `nodejs24.x`.
Client-secret metadata verifies secret status, scopes `builds`, `functions`, and
`runtime`, and exactly one production record. Nonproduction dev, dev-server,
branch-deploy, and deploy-preview records were removed while preserving the
production value; no secret value is exposed by this evidence.

The account is verified as `credit-personal`, with 1,000 monthly shared credits,
Background Functions included, and auto-top-up disabled. Earlier undocumented
API counters do not establish a spendable balance. On September 18, 2026, the
owner confirmed 863.7 of 1,000 credits remaining in billing, expiring September
23, 2026. The initial deployment-balance check is complete; later balance is not
guaranteed. No credit purchase, recharge, or plan migration is inferred.

The owner confirms App installation on the personal `cboone` account covering
the intended selected repositories and generation of the installation-required
private key, with the downloaded PEM handled outside the repository and Netlify.
These are owner-confirmed setup facts. Live installation/source-access checks,
callback and disabled-device-flow verification, expiring user-token behavior,
OAuth, deployment, owner sign-in, and live public/private acceptance have not
run. Board does not use the App private key at runtime. Baseline verification
and the integrated independent plan review are complete against the merged
Phase 1 baseline.

Prettier formatting checks and Markdown linting pass for the plan and review.
Runtime, provider, browser, and production acceptance are not run for document
corrections.

## Integrated baseline review

Three independent scoped reviews examined the actual merged tree and integrated
plan before implementation. Source collection, authentication and protected UI,
and build/package/configuration/CI scopes each received a ready disposition with
no required revisions or open questions. The repository HEAD and PR #21 merge
match `f8b78767babe021754873bd60540fbac8500b186`.

The shared report limit remains 1,000 open issues. Its stricter own-property and
dense-array validation is compatible with the plan's canonical plain-data
inventory. Staging retains the report contract's lane-model import and resolves
server dependencies through the real independent server package. Existing
frontend-only dependencies, `.js` lint coverage, Vitest exclusions, build commands,
and static routes are correctly identified as the baseline to extend.

The reviews did not run implementation tests, open storage, or call providers.
Root verification through GitHub confirms the merged commit's valid signature;
local signature inspection was unavailable to a reviewer. No runtime or live
acceptance is inferred from document readiness.
