# Board product roadmap

## Status and authority

Product requirements established as of 2026-09-18. Phases 1 and 2 are merged and
verified. Phase 2 owner acceptance passed for public and private source checks,
sign-out, and zero Edge Functions. Its exact reviewed head, verified merge, and
automatic production deployment are recorded below. Phase 3 is active in its
distinct worktree. The fixed provider path, four durable stores, analysis state
machine, current/previous rotation, authenticated report APIs, browser flows,
and a production composition with two Functions are implemented with synthetic
and mocked coverage. Final verification, review resolution, PR delivery,
deployment, key setup, paid calibration, and production report acceptance
remain. No paid Phase 3 call or live Phase 3 deployment is claimed. This is the
living roadmap for the complete product, not authorization to assume unanswered
spending or service-configuration choices. Production usage limits will be
proposed using setup calibration evidence before ordinary paid production usage
is enabled.

The definitive requirements are the original
[project prompt](../project-prompt.md), the original `publish-report-board`
skill, the user's answers, and applicable user and project instructions. This
roadmap, earlier plans, issue descriptions, and README predictions are
interpretations of those requirements. Update interpretations when they conflict
with the definitive sources.

The prompt's `/add-issue-report` reference is interpreted using the
`publish-report-board` skill the user explicitly identified. The original prompt
remains unchanged. Its current path is `docs/plans/project-prompt.md`;
`docs/project-prompt.md` is absent.

An earlier roadmap was consulted from a local backup branch during review. It is
not part of the published project documentation. Its claimed interview decisions
are context, not definitive requirements; this roadmap independently records the
confirmed user answers.

## Product outcome

The first production release supports only the user's GitHub account, `cboone`.
After signing in with GitHub, the user selects an eligible public or private
`cboone/*` repository and receives a backlog triage report modeled on the
original skill. Forks and archived repositories are excluded from new analysis.
Previously saved reports remain viewable when the source later becomes
ineligible or inaccessible, with clear historical/source-unavailable status.
Reports require sign-in and are accessible only to the authorized account,
including reports for public repositories.

The report answers what to start, what can proceed in parallel, and what is
blocked and by what. It remains a view of GitHub data: Board does not become the
issue tracker.

Completion requires the major agreed functionality working in production on
Netlify, passing tests at relevant levels, working CI/CD, and user-focused
documentation. A static preview, successful local build, or merged PR alone does
not establish production completion.

## Current evidence

Foundation baseline: `800342dba1980c460812b15205cb41249a6ac584`. Phase 1 landed
in [PR #21](https://github.com/cboone/board/pull/21), merge
`f8b78767babe021754873bd60540fbac8500b186`. Final head
`47ac8082c3d4bb8d65ad77a03e7e19487399a1cb` passed CI and received Copilot review
`5253326943`, with approval recommended and no findings. The merge signature is
verified; its branch and worktree are removed. `cboone/board` is active, not
archived, and not a fork.

- The [foundation phase](2026-09-15-board-foundation.md) landed in
  [PR #18](https://github.com/cboone/board/pull/18).
- Vite, Alpine CSP, Tailwind CSS, JavaScript modules, npm, pinned dependencies,
  and project verification commands are established.
- The Phase 1 static application has a welcome screen, theme control, and
  complete/empty/uncertain synthetic reports at `/demo`. It has no authenticated
  user flow, repository picker, application API, GitHub client, model client, or
  report store.
- Unit checks cover the report contract, source links, and lane model. Built
  browser checks cover report sections, routing, safe rendering, keyboard and
  narrow-screen behavior, themes, accessibility, and age-timer disposal.
- The Phase 1 plan and branch review record actual local verification. CI and
  secret scanning passed the final submitted head. These results do not
  establish live-service or production acceptance.
- Netlify configuration builds `dist`. The merged Phase 2 composition is live in
  production from exact merge `370c257c49c09492426b4d8df24d37240884e908`, while
  nonproduction deploys remain fixture-only with no Functions.
- The active Phase 3 worktree composes synchronous `api` and background
  `report-job` Functions only for production and uses `board-auth`,
  `board-reports`, `board-jobs`, and `board-spend` as isolated Blob stores. This
  is implementation evidence, not a merged or deployed Phase 3 result.
- Foundation issues #12 through #17 are reconciled with agreed scope. Scaffold
  issue #13 and fixture quality issue #14 are completed. Issue #16 is closed
  after its hosted-site, owner-source, sign-out, and preview-isolation
  acceptance conditions passed; #12, #15, and #17 retain later report and
  product acceptance.
- The owned `tracker-boards` site and read-only `cboone-tracker-boards` App are
  created. The owner confirmed installation for intended repositories.
  Production-only authentication configuration is installed; secret metadata
  confirms exactly one production context. On September 18 the owner confirmed
  863.7 of 1,000 shared credits remaining, expiring September 23. See
  [production setup](../../production-setup.md). Repository linkage, reviewed
  production deployment, owner OAuth, eligible public and private source checks,
  sign-out, and the preview Edge Functions summary are now verified.

## Established constraints

- Development investigation and changes are limited to the user's eligible
  `cboone/*` repositories, excluding forks and archives. The user also
  explicitly limits the first production release to their own GitHub account and
  those eligible repositories. Organization-owned repositories and other users
  are outside the first-release scope.
- Support both public and private eligible repositories. Enforce the account and
  repository restrictions server-side for repository listing, gathering,
  analysis, and refresh. Filtering the picker is insufficient. Direct requests
  must not bypass eligibility or expose another account's data. Previously saved
  reports remain accessible to the authorized account if the source is later
  archived, transferred, deleted, or inaccessible to the GitHub App. Clearly
  mark them historical/source-unavailable, disclose the source status, and
  disable new analysis while the source is ineligible or inaccessible. Retain
  them until a future explicit deletion request. A deletion control is deferred
  from this release. All saved-report access requires the authorized account; it
  does not require a currently eligible or accessible source.
- Require authentication and the authorized account for all real report data,
  regardless of the source repository's visibility. Public report sharing is
  outside the first-release scope. Fixture demonstrations must contain no real
  report data or private repository metadata.
- Use JavaScript, Tailwind CSS, and a minimal backend. Preserve the established
  Alpine CSP and Vite foundation unless concrete requirements justify a change.
  The prompt permits React if Alpine cannot keep the application simple.
- Deploy the working application to Netlify and retain the MIT license.
- Create a new Netlify production site. The preferred `tracker-boards` name was
  available and is reserved in `cboone`: site ID
  `9ddf762e-9c92-44da-8636-e03913200664`, address
  `https://tracker-boards.netlify.app`. Its reviewed authentication/source-check
  composition is deployed and connected to `cboone/board`; owner sign-in,
  eligible public and private source checks, and sign-out pass. A custom domain
  is later work; do not change DNS or register a custom domain in this release.
  This confirmed choice superseded issue #16's original `backlog-tracker-app`
  hostname and satisfied its preferred-name/fallback requirement. The
  authenticated CLI lists the owned `cboone` account, named **Catamount
  Hardware**, with account type **Personal**. Use that explicit account
  destination; its billing configuration and resource charges still require
  verification before depending on them.
- Document using this hosted instance for the authorized user. A self-hosting
  guide is explicitly outside the first-release scope.
- Keep provider keys and GitHub tokens out of browser code. Secrets use
  environment variables and approved server-side handling.
- AI analysis uses Anthropic with an app-managed key and the fixed Opus 5 model,
  `claude-opus-5`. Start report analysis at `high` effort and calibrate within
  the approved setup budget. Enforce usage limits server-side. Phase 3
  implements setup input, output, request, and runtime bounds that still require
  deployed verification. The ordinary production spending policy remains
  unspecified.
- The user authorizes a total
  $25 USD Anthropic budget for initial setup work,
  including paid calibration, retries, and acceptance tests. Raise a budget
  discussion at $20
  of recorded plus reserved spend. A production monthly cap and maximum
  production cost per report are not yet specified; the setup cap is not a
  permanent production allowance.
- Keep the Anthropic key in production server environment configuration. Do not
  solicit user-supplied provider keys or introduce provider selection in the
  first-release user flow. Private-repository input scope is a separate explicit
  decision, not blanket authorization to send all repository content.
- Treat issue text, repository text, and model output as untrusted. Validate
  analysis before rendering or accepting it as a successful report.
- Deploy Previews and branch deploys remain fixture-only static sites with zero
  Functions, zero Edge Functions, no server packages, no credentials, and no
  production data. Production server capability must be isolated from those
  artifacts and environments and verified as such.
- Preserve the distinction between the last successful report, the last GitHub
  check, and a failed refresh. A failed operation must not appear as a
  successful new analysis.
- Store successful reports server-side so the authorized user can reopen them
  across browsers and devices. Browser storage is not the authoritative report
  store. Keep access authenticated and restricted to the approved GitHub
  account. Retain the current and previous successful reports per repository
  until explicit deletion. A new successful report rotates the previous pair;
  failed attempts do not rotate or replace it. The initial report API returns
  current-envelope content with browser-safe current/previous pointer metadata;
  it does not return the previous envelope. `cleanupCandidateKey` is inert
  retention metadata. The initial release does not automatically delete
  displaced immutable versions; they remain physically stored but inaccessible
  through the report API until an explicit retention and deletion policy is
  approved. Netlify Blobs is the implemented storage service; backup and
  external recovery policy remain later operational decisions.
- Use raw GitHub and file inputs transiently for analysis; do not persist them
  as source snapshots, prompts, or diagnostic logs after analysis. Retain input
  provenance with reports, such as source identities, revisions, timestamps,
  selected paths, hashes, and disclosed limits. Saved reports contain the source
  titles and derived analysis needed to render them, rather than raw issue
  bodies, comments, or file contents.
- Signing out ends the session without deleting saved reports. The first release
  has no report history listing/retrieval API and no report deletion API or
  control. Preserve the agreed retention baseline until a future explicit
  retention and deletion policy. Extended report history is outside this
  baseline.
- When an existing board opens, automatically check GitHub for relevant source
  changes. Paid reanalysis of an existing board requires the user's explicit
  refresh request. Load the last successful report independently of the
  freshness check, and show its analysis provenance separately from the latest
  check result. Check failures preserve that report and disclose that current
  source freshness could not be established.
- Check for changes in the approved report inputs, including issues and their
  comments, labels, milestones, PRs, relevant remote branches, and source
  revisions. Do not claim the report is current merely because the default
  branch SHA is unchanged. Bound and disclose the check's scope; incomplete or
  failed checks cannot establish unchanged source. This is an implementation
  consequence of the agreed freshness behavior, not an additional paid feature.
- For a repository with no saved report, selecting it opens the repository page
  without a paid analysis call. Show a **Generate report** button; that explicit
  action initiates the first Anthropic analysis. Existing reports use an
  explicit refresh action for paid reanalysis.
- The authorized Anthropic inputs include issue bodies and comments, labels,
  milestones, PR descriptions, branches, the repository tree, and relevant files
  selected under bounded limits, for both public and private eligible
  repositories. Record which files and inputs informed the report. Select
  relevant text files conservatively, enforce total input bounds, and exclude
  credential locations and secret-bearing files from model input. Do not fetch
  arbitrary external URLs for model input in the first release. Retain linked
  references and disclose unverifiable external blockers as uncertainty. Raw
  input retention follows the transient-input baseline above.
- Assignment alone does not establish work in progress. Require evidence from a
  related PR, branch, or in-progress label. Preserve assignment as source
  metadata, but do not let it occupy a lane or suppress a start recommendation
  by itself. This is an explicit user override of the original skill's rule.
- If work scope is unclear or an external blocker cannot be verified, retain the
  issue, show the uncertainty, withhold affected start recommendations, and
  complete the rest of the report. Do not present an unverified reference as a
  confirmed completed or active blocker. This conservative handling does not
  permit an incomplete primary issue inventory or invalid analysis structure.

## Original report contract

The reviewed source is the installed `publish-report-board` version `1.0.0`,
with the original source under
[`cboone/agent-harness-plugins`](https://github.com/cboone/agent-harness-plugins/tree/046f1389caf53d6ec8c81e8c88b927a40d154b79/plugins/publish-report-board).
Its
[skill and references](https://github.com/cboone/agent-harness-plugins/tree/046f1389caf53d6ec8c81e8c88b927a40d154b79/plugins/publish-report-board/skills/publish-report-board),
[template](https://github.com/cboone/agent-harness-plugins/blob/046f1389caf53d6ec8c81e8c88b927a40d154b79/plugins/publish-report-board/templates/backlog-triage.html),
and
[validator](https://github.com/cboone/agent-harness-plugins/blob/046f1389caf53d6ec8c81e8c88b927a40d154b79/plugins/publish-report-board/scripts/report-board)
establish the baseline. The installed template and validator byte-match the
canonical files at revision `046f1389caf53d6ec8c81e8c88b927a40d154b79`. Record
that source in the port's developer documentation so later upstream changes do
not silently redefine application behavior.

### Inventory and analysis

- Gather the complete open-issue, open-PR, open-milestone, and relevant unmerged
  remote-branch inventories. Paginate rather than treating a truncated result as
  complete. Every open issue must appear in exactly one lane.
- Preserve GitHub issue titles and milestone names verbatim. Retain issues
  without milestones and issues already in progress.
- Record evidence for work in progress. The skill considers branches, worktrees,
  labels, current-user assignment, and PR closing references. The user
  explicitly overrides the assignment signal: Board requires a related PR,
  branch, or in-progress label. A hosted app cannot observe unpushed local work;
  disclose that limitation and derive evidence from GitHub-visible sources.
- Distinguish hard `waitingOn` blockers from soft `after` ordering. Support
  same-repository issues, PRs, branches, cross-repository references, and
  external links. Confirm completed blockers before removing them.
- Derive footprints and contention from the work described. Shared meaningful
  components determine contention and lane grouping; independent lanes must not
  claim the same component.
- Support `serial`, `head`, and `any` lane modes and `sameBranchAs` units. Work
  already in progress occupies the serial or head lane's slot. Existing overlap
  remains visible.
- Start recommendations follow lane eligibility and exclude blocked, active,
  soft-queued, and companion issues. Supply concrete reasons and footprints;
  explain when recommendations are fewer than available parallel slots.
- Derive counts, capacities, and eligibility in code. The original header's
  `ready` count is open issues minus hard-blocked issues; it is distinct from
  issues that can start now. The user-approved uncertainty handling withholds
  affected start recommendations without silently treating uncertainty as a
  verified hard dependency or changing the original count definition.

### Integrity and rendering

- Validate analysis against the independently gathered GitHub inventory, rather
  than trusting a model's returned issue list. Detect omissions, additions,
  duplicates, changed source titles, invalid lane membership, references,
  dependency cycles, branch units, and incompatible start picks.
- A GitHub collection failure or partial response must not produce a report
  presented as complete. Inaccessible external blockers and unclear scope remain
  visible uncertainties and suppress affected recommendations while the rest of
  a valid report completes. If the complete core inventory cannot fit supported
  analysis bounds, explain the limit and refuse generation rather than silently
  dropping issues. Trim optional file and comment context within explicit bounds
  and disclose that reduced context in report provenance.
- Preserve a stable repository identity and report address. Record the gathering
  timestamp, default branch, and full SHA of its remote tip, plus the scope and
  limitations of the gathered inputs.
- On a successful refresh, compare with the previous successful report and show
  the changes since that report. Initial generation has no previous report to
  compare. Guard against replacing a different repository's report or a newer
  concurrently published report. Basic comparison belongs to the original
  contract; omitting it requires an explicit product decision. A browser for
  historical reports is a separate possible extension.
- Preserve the original report structure: header and counts, summary, Start now,
  Lanes, Contention, Blocked, and source-authoritative footer. Use source links
  for issues, milestones, branches, commits, and contention components.
- Follow the skill's single-column responsive layout, semantic color and theme
  tokens, and text and shape cues for runnable, queued, blocked, and active
  work. Wide tables scroll inside their container.
- Render untrusted content as text through safe DOM operations. Validate link
  schemes and destinations before producing actionable links.
- Use concrete reasons, neutral language, no em dashes, and no work estimates.

Artifact pinning, local cache filenames, and shell publication steps belong to
the skill's delivery mechanism. They do not automatically determine the hosted
app's storage, sharing, authentication, or refresh design. Report caching does
not itself make Board the source of truth for issue state.

## Decision record

Record the user's answers here with their consequences. Do not silently inherit
the older roadmap's claimed decisions or the README's predictions.

<!-- markdownlint-disable MD013 -->

| ID  | Decision                                                                                                                                                                              | Why it matters                                                                                                                 | Status                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Q01 | Only the user's GitHub account (`cboone`), with eligible `cboone/*` repositories; exclude forks, archives, organizations, and other users                                             | Enforce account and repository eligibility server-side across all real-data operations                                         | Confirmed by user                                                |
| Q02 | Public and private eligible repositories; reports require sign-in and are accessible only to the authorized account                                                                   | Support private-repository authorization; prevent unauthenticated access and public sharing                                    | Confirmed by user                                                |
| Q03 | Anthropic, app-managed key, fixed Opus 5 (`claude-opus-5`), and enforced usage limits                                                                                                 | Start at high effort with bounded calibration; server-side key and spending controls                                           | Requirements confirmed; key, deployment, and calibration pending |
| Q04 | Assignment alone is insufficient; require a related PR, branch, or in-progress label                                                                                                  | Override the skill's assignment signal; disclose that hosted analysis cannot see unpushed local work                           | Confirmed by user                                                |
| Q05 | Automatic GitHub checks on existing boards; first analysis requires Generate report; paid reanalysis requires explicit refresh; preserve last good report on failure                  | Compare approved report-input changes without a paid call; incomplete checks cannot establish unchanged source                 | Confirmed by user                                                |
| Q06 | Durable server-side current and previous successful reports until a future explicit deletion request; transient raw inputs; retained provenance; logout preserves reports             | Rotate only on success; authenticate reads; deletion controls deferred by the later first-release scope answer                 | Confirmed by user                                                |
| Q07 | Issue bodies/comments, labels, milestones, PR descriptions, branches, repository tree, and relevant files selected under bounded limits                                               | Support richer context for public and private repos; use implemented technical bounds; do not fetch arbitrary external URLs    | Confirmed; bounds implemented                                    |
| Q08 | Retain unclear issues and unverified external blockers, show uncertainty, withhold affected starts, and complete the rest of the report                                               | Conservative recommendations without dropping issues; invalid structure and incomplete core collection still fail              | Confirmed by user                                                |
| Q09 | Opus 5 at appropriate effort; $25 total setup budget including paid tests and retries; discuss near the cap; production budget flexible and unspecified                               | Track and reserve all setup costs; notify at $20; settle runtime/input bounds and production policy                            | Confirmed setup; production pending                              |
| Q10 | New Netlify site, preferred tracker-boards.netlify.app or similar available name; custom domain later; no self-hosting guide for this release                                         | Owned tracker-boards site has reviewed production deployment, GitHub connection, and owner/source acceptance                   | Confirmed by user; site accepted                                 |
| Q11 | Original report plus sign-in, repo selection, generation/refresh, freshness, progress/errors, and provenance; report deletion deferred                                                | User confirms this covers initial needs; no additional report types or optional application features are required              | Confirmed by user                                                |
| Q12 | Saved reports stay viewable to the authorized account when the source is archived, transferred, deleted, or inaccessible; mark historical/source-unavailable and disable new analysis | Keep both retained reports until explicit deletion; saved-report retrieval is independent of current source eligibility/access | Confirmed by user                                                |

<!-- markdownlint-enable MD013 -->

The model is settled as `claude-opus-5`. The active implementation uses the
Netlify Node runtime, four isolated Blob stores, and explicit source, request,
response, and token bounds derived from the confirmed requirements and platform
documentation. The logical report lifecycle is settled. Settle the production
spending policy before enabling ordinary production paid usage; implementation
and setup acceptance can proceed under the separate $25 setup authorization.

## Setup spending controls

The $25 total begins with the user's setup-budget authorization in this
interview. No paid Board Anthropic calls have been made under that authorization
as of this planning update. This is a record of this project's authorized calls,
not a claim about the user's overall Anthropic account balance or prior usage.

- Keep a durable spending ledger across sessions and devices for all setup
  calls. Record model, effort, usage, billed-cost calculation, and outstanding
  reservations without storing credentials or private source content in the
  ledger.
- Before every call, reserve its conservative maximum input/output cost,
  including thinking output and the permitted retry sequence. Account for cache
  charges if caching is introduced. Actual spend plus all outstanding
  reservations must remain within $25; concurrent calls cannot independently
  consume the same remaining allowance.
- Reconcile reported usage after a completed call. Retain conservative
  reservations for an interrupted call whose billed usage is unknown rather than
  assuming it was free. Bound SDK and application retries explicitly.
- Notify the user when recorded plus reserved spend reaches
  $20 and discuss the
  remaining scope. No further paid call may exceed the $25
  total without new authorization. Continue fixture, implementation, and
  documentation work while a spending question is pending.
- Use fixtures and mocked provider responses for routine test suites. Reserve
  paid calls for representative calibration and live acceptance checks. Effort
  controls reasoning behavior, not the hard budget; enforce token and spending
  bounds independently.

## Architecture research

This research records the constraints used to select the current architecture.
The active Phase 3 implementation choices are called out below; deployment and
paid acceptance still require their separate gates. Research alone does not
authorize resource provisioning or provider spending. Setup paid calls follow
the separate authorization and spending controls above.

- The selected fixed Opus 5 model has standard base input/output prices of
  $5/$25 per million tokens and supports structured JSON output. Start at `high`
  effort, the documented default, and evaluate whether a lower setting preserves
  report quality before changing it. Application validation and hard token/spend
  bounds remain necessary. Sources:
  [Opus 5](https://platform.claude.com/docs/en/models/opus-5/overview),
  [effort](https://platform.claude.com/docs/en/build-with-claude/effort),
  [model versioning](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions),
  [pricing](https://platform.claude.com/docs/en/about-claude/pricing), and
  [structured output](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).
- A GitHub App can supply the approved inputs through read-only Metadata,
  Issues, Pull requests, and Contents permissions, with installation restricted
  to the user's account and selected repositories. Private-repository access
  requires both user authorization and a suitable installation. An OAuth App's
  private-repository `repo` scope grants broader write authority. Prefer the
  GitHub App approach; exact registration and callbacks depend on site identity
  and owner-controlled setup. Sources:
  [app differences](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps),
  [repository permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps),
  and
  [app registration](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).
- [Netlify Blobs](https://docs.netlify.com/build/data-and-storage/netlify-blobs/)
  supports durable JSON objects, strong reads, and conditional replacement by
  ETag. Site-wide stores are accessible across deploy contexts by default, so
  removing provider secrets from previews does not itself isolate private
  reports. Prove that fixture previews cannot reach the production store.
- [Netlify Database](https://docs.netlify.com/build/data-and-storage/netlify-database/)
  offers managed Postgres, transactions, and backups, but its default preview
  branching copies production data. Runtime route restrictions alone do not
  prevent that copy. Any use requires a verified provisioning boundary
  compatible with the prohibition on production data in previews. Current
  account plan, resource configuration, and actual storage charges remain
  unverified.
- Netlify synchronous and streaming functions have a 60-second execution limit;
  streaming does not extend it. Background Functions allow 15 minutes, return an
  immediate empty `202`, and cannot stream results. Phase 3 therefore uses
  authenticated synchronous job admission and polling with a native background
  Function. Background invocation errors can trigger automatic retries;
  duplicate delivery must not repeat paid analysis. The implemented dispatch
  passes only a job reference and capability and gathers raw source inside the
  worker instead of persisting raw input for handoff. Sources:
  [function configuration](https://docs.netlify.com/build/functions/configuration/)
  and
  [Background Functions](https://docs.netlify.com/build/functions/background-functions/).
- Enforce fixture-only deploys through the deployed artifacts. Phase 3 uses a
  generated functions directory populated with exactly `api` and `report-job`
  only for the production build; all other contexts leave it absent. This new
  composition still needs verification against actual deployments. Keep server
  bundles outside the static publish directory and check for zero preview
  function bundles. Runtime checks use the documented `context.deploy.context`;
  a frontend flag does not isolate the backend. Sources:
  [deploy-context configuration](https://docs.netlify.com/build/configure-builds/file-based-configuration/#deploy-contexts),
  [functions directory](https://docs.netlify.com/build/functions/configuration/#directory),
  and
  [runtime deploy context](https://docs.netlify.com/build/functions/api/#deploy).
- Netlify supports Node 24 for Functions. Runtime secrets must be configured
  through the UI, CLI, or API with values only in the production deploy context;
  values declared in `netlify.toml` are not available to Functions at runtime.
  Limit them to Functions scope when the account supports that setting. The
  verified `cboone` account is `credit-personal`, includes Background Functions,
  and has automatic credit top-ups disabled. Personal does not include selective
  environment scopes, so production values also reach the trusted production
  build. Keep them out of `VITE_*` variables, avoid reading them in build code,
  and verify browser artifacts and absent preview/branch values. No paid plan
  upgrade or legacy-plan migration is needed for this architecture. Redeploy
  after runtime environment changes. Sources:
  [environment contexts and scopes](https://docs.netlify.com/build/environment-variables/overview/),
  [runtime configuration](https://docs.netlify.com/build/functions/configuration/#nodejs-version-for-runtime)
  and
  [function environment variables](https://docs.netlify.com/build/functions/environment-variables/).

## Delivery phases

Numbering starts after the completed static foundation. Each phase gets a dated,
detailed plan and an independent second review before implementation. Update
this roadmap in place as decisions settle.

### Phase 1: Report contract and fixture experience

Delivered in PR #21: independently inventory-bound validation, shared lane
semantics, complete/empty/uncertain synthetic reports at `/demo`, safe source
links, and static build/CSP verification. Final local verification passed 152
unit checks and 45 browser checks in all three engines. See the
[detailed phase plan](2026-09-18-board-report-fixtures.md) and
[developer contract](../../report-contract.md). Final-head CI and review passed;
the merge and local cleanup are complete. This phase does not establish live
production acceptance.

Port the agreed report semantics, validator, and responsive renderer. Add a
usable fixture/demo report and application routes. Replace the simplified count
helper and show source metadata, empty states, and the agreed unresolved-work
behavior. Keep this phase independent of live credentials and provider access.

Exit when fixtures demonstrate all lane modes, dependencies, branch units,
overlapping active work, no-milestone issues, empty backlogs, and invalid-data
rejection. Browser checks cover report interactions, keyboard access, narrow
screens, light/dark themes, and automated accessibility.

### Phase 2: GitHub authentication and authoritative gathering

The [detailed phase plan](2026-09-18-board-github-authentication.md) passed
independent review against the merged Phase 1 baseline before implementation.

Local verification passes: 152 report unit checks, 166 native backend checks,
five composition checks, and 45 fixture plus 54 mocked production browser checks
across Chromium, Firefox, and WebKit. Formatting, linting, static artifact
verification, and the server dependency audit pass. These local checks use
synthetic data; the separate live acceptance below establishes owner sign-in and
GitHub source access. Anthropic setup spending remains zero.

Final signed feature head `ef3934d41977807a2e6b3a763cc1c02ac5c5d83e` passed the
complete CI matrix and independent review. PR #22 merged as signed,
GitHub-verified merge `370c257c49c09492426b4d8df24d37240884e908`. Automatic
production deploy `6aaddca5bf99630008491b49` is ready from that exact merge on
`main`. The native function manifest specifies Node24, runtime API version 2,
and `/api/*`; complete live security headers, anonymous and protected routes,
encrypted OAuth transaction storage/PKCE, sanitized invalid callback cleanup,
and immutable-origin rejection pass. On September 18, 2026, owner sign-in, one
eligible public repository source check, one eligible private repository source
check, and sign-out passed.

Manual fixture draft `6aadcd18b83e9e153b9c7bbf` is ready in `deploy-preview`
context. The provider reports zero Functions, and live fixture routes/CSP plus
the fixture-only API JSON `404` pass. Fresh staging contained no Edge Functions.
The owner confirmed that the provider deploy summary showed `Edge Functions: 0`.
Final PR #22 preview `6aaddaf81b0a15000836bc03` is also ready in
`deploy-preview` context from the exact reviewed head with explicit provider
inventory of zero Functions. Live fixture/CSP and static API JSON `404` checks
pass.

Implement the agreed GitHub authorization method, server-side token/session
handling, repository selection, complete gathering, and source verification.
Introduce production server configuration only with enforced preview isolation.
Validate the actual granted permissions and supported repository types. Verify
public and private eligible `cboone/*` repositories and enforce the
single-account boundary independently of browser UI state.

Exit when a real user can sign in, select a supported repository, and obtain a
complete validated source snapshot. Verify logout, expired/revoked access,
unauthorized repository requests, pagination, rate limits, collection failures,
and fixture-only preview artifacts and API behavior. Reject requests from other
GitHub accounts and requests for forks, archived repositories, or repositories
owned by another account or organization. A source snapshot alone is not a
completed analysis report. Saved historical report retrieval is a separate
authorized-account operation and must not be rejected solely because the source
has since become ineligible or inaccessible.

The live owner, eligible public repository, eligible private repository,
sign-out, and preview Edge Functions acceptance gates pass. Current-head PR CI,
review, merge, automatic production verification, issue closure, and branch and
worktree cleanup are complete.

### Phase 3: Analysis, report persistence, and refresh

The [detailed phase plan](2026-09-18-board-report-generation.md) fixes the Opus
5/high-effort wire contract, deterministic optional context selection,
source-bound assembly, durable report catalog and current/previous rotation,
at-most-once paid state machine, setup spending ledger, authenticated recovery,
and Generate/Refresh browser flow. The active worktree implements those paths
from the verified Phase 2 merge with native `fetch`, synchronous admission, and
a native `report-job` background Function. It composes exactly `api` and
`report-job` in production and uses the isolated `board-auth`, `board-reports`,
`board-jobs`, and `board-spend` Blob stores. Synthetic and mocked tests exercise
the implementation; complete local verification, PR review, a live deployment,
and paid acceptance remain. Anthropic setup spend remains $0 until its
deployment and paid-call gates pass.

The server enforces the fixed model configuration, bounded input collection,
validated analysis, comparison with the previous successful report, access and
setup-cost controls, and guarded concurrent publication. The production runtime
still requires representative deployed verification before calibration. The only
new secret is `ANTHROPIC_API_KEY`; it is production-only, server-side, and must
remain absent from preview and branch contexts. No value is recorded in project
documentation.

Store successful reports durably server-side. On opening a saved report,
automatically check GitHub for changes and display the check outcome separately
from the saved analysis. Anthropic reanalysis of an existing report requires an
explicit refresh request. When no saved report exists, show a **Generate
report** button and initiate paid analysis only through that action. Selecting a
repository never initiates a paid call. Collect the approved issue, comment, PR,
branch, tree, and relevant-file context within agreed bounds; expose input
provenance and limitations. Repository state exposes logical current and
previous successful pointers while the report route returns content only from
the current immutable envelope. Keep raw inputs transient and preserve
provenance. Before attempting pointer rotation, the job records every non-null
former-previous key as inert `cleanupCandidateKey` metadata. After rotation,
that version remains physically stored outside the logical current/previous
history until an explicit retention and deletion policy is approved. The initial
release has no history listing/retrieval API and no report deletion API. Logout
retains saved reports.

Exit when a real supported repository produces the full report, repeated use
follows the agreed freshness policy, and failures preserve the last successful
report. Validate incomplete/invalid model output, retry limits, provider errors,
runtime limits, concurrent refreshes, account isolation, and input-size bounds.
Require authenticated access to stored reports for both public and private
repositories; direct report URLs must enforce the same account boundary. Verify
that a report generated in one browser or device can be retrieved in another
after signing in. Opening a saved report must make no paid model call, including
when the automatic GitHub check detects changes or fails. Verify file selection,
input-size checks, and handling of untrusted source text. Selecting a repository
with no saved report must make no paid call either; the **Generate report**
action must initiate bounded, authorized analysis. Verify successful report
rotation, unchanged retention on failure, report access after sign-out/sign-in,
and absence of persisted raw source inputs and prompts. Verify that source
archival, transfer, deletion, and lost GitHub App access keep saved reports
discoverable and viewable only to the authorized account, with
historical/source-unavailable status and disabled new analysis. An unavailable
source must not trigger a paid model call. Verify that assignment alone does not
create active-work evidence. Unclear scope and unverifiable external blockers
must remain visible and withhold affected recommendations while allowing the
rest of a valid report to complete. Include provider metadata and input
provenance needed to explain the analysis.

### Phase 4: Production delivery and operational acceptance

Complete the user guide for the hosted instance. Reconcile remaining issues,
verify deployed security and environment boundaries, add operational failure
visibility and recovery guidance, and deliver the working Netlify app. Verify
the production spending policy selected, implemented, and deployed in Phase 3;
make no new account-resource or spending choice without another concrete user
decision.

Exit when the README alone guides the intended user from GitHub sign-in to a
real report in production. Verify the deployed version, live authentication,
report creation/retrieval/refresh, failure behavior, and CI/CD. Confirm that
private data and secrets are absent from static artifacts, previews, and logs.
File relevant deferred work in eligible owned repositories and retain plans and
reviews in this repository.

## Phase workflow and autonomy

The original prompt authorizes the complete phase workflow: inspect code, docs,
issues, and current requirements; create a detailed plan; take a second review
pass; implement in a distinct worktree; make small GPG-signed Conventional
Commits; validate and document; take a final review pass; open the PR; monitor
until clean; merge with a merge commit; delete clean branches/worktrees;
continue to the next phase. Do not ask again for ordinary steps already
authorized by that workflow.

Use installed skills as applicable and project commands for formatting, linting,
unit tests, browser tests, and build. Retain all plans and review documents in
this `cboone` repository and keep the living roadmap in `docs/plans/todo/`.
Preserve multi-agent guidance and the `CLAUDE.md` compatibility symlink.

PR monitoring must inspect CI, mergeability, unresolved review threads, and
review bodies against the current head. Each new push requires fresh review
evidence. A historical review or pending production check does not establish
completion. Confirm the production version after deployment.

Continue independent work while user authentication or answers are pending. Stop
dependent work for important unanswered choices, unsupported spending or account
changes, or problems with no safe authorized resolution. Explain the specific
dependency or approval rule; do not add repeated approval gates.

## Validation strategy

- Unit tests establish graph, lane, eligibility, capacity, inventory binding,
  validation, and freshness behavior, including meaningful invalid cases.
- Integration tests establish API authorization, pagination, session and token
  lifecycle, provider validation, report storage, concurrency, and failure paths
  appropriate to the settled architecture.
- Browser tests establish the sign-in/picker/report/refresh flows using
  controlled service fixtures, supported browsers, responsive layouts, keyboard
  navigation, and automated accessibility checks.
- Deployment checks establish actual preview isolation, headers, callback
  routes, production authentication, a real GitHub/provider report, persisted
  behavior, and deployed version identity. Protect real credentials and private
  inputs.
- Use `npm run format:check`, `npm run lint`, `npm test`,
  `npm run test:browser`, `npm run build`, and the configured CI/security
  checks. Add architecture-specific project commands when their need is
  established. Record checks actually run and distinguish passed, failed,
  blocked, and unverified results.

## Potential later scope

The first release implements the agreed single-repository GitHub backlog report
and the application controls needed to use it. Multi-repository boards, GitHub
Enterprise, extended historical browsing, and additional board types are
possible later work rather than requirements inferred from earlier
interpretations. Organization-owned repositories, other users, publicly shared
reports, and multi-user billing are outside the confirmed first-release scope.
Automatic paid reanalysis is outside the confirmed refresh policy. Background
execution is the implemented runtime mechanism for an explicitly requested
operation; it is not a separate automatic-analysis feature. Self-hosting
documentation and custom-domain setup are deferred beyond this release by the
user's explicit answers. Report deletion controls are also explicitly deferred.
