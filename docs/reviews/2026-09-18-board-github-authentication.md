# Board GitHub authentication branch review

Reviewed on: 2026-09-18

Branch: `feature/github-authentication`

Base: `main` at `f8b78767babe021754873bd60540fbac8500b186`

Reviewed through: `f1f8ddb70a42a2ad265c35aca0de5d1c6ea0edc4`, with the accompanying
living-document corrections checked separately.

## Result

Ready for deployed acceptance and the phase PR. Local verification passes and
independent authentication, source, frontend, and build reviews are clean.
Deployed acceptance and current-head PR checks remain separate phase gates.
Paid analysis and report persistence belong to the following phase.

## Reviewed behavior

- Native production API checks deploy context and canonical request origin
  before secret configuration or store access. Owner authorization uses numeric
  GitHub identity `99961` independently of current source availability.
- OAuth uses PKCE, browser binding, single-use conditional claims, encrypted
  token pairs, secure opaque cookies, and session-bound CSRF. Logout and final
  owner rechecks prevent delayed private responses from restoring revoked views.
- Shared-token rotation allows one provider exchange. Exact conditional writes
  preserve newer authorization fences. Retained publication evidence prevents
  an unacknowledged pair from becoming usable after a delayed storage commit.
  Storage transport and complete response bodies share the operation deadline.
- Repository eligibility requires the expected personal GitHub App installation
  and actual read grants. Source gathering collects complete primary inventory,
  nested pages and issue comments, pinned tree/files, and metadata-only closed
  references. Two matching observations cover the actual admitted source fields.
- Assignment alone does not establish progress. Verified closing PRs, unmerged
  remote branches, and explicit in-progress labels supply canonical evidence.
  Unsupported external references remain uncertain without an external fetch.
- Protected browser state contains approved metadata only and clears on logout,
  observed expiry, navigation, or failed session verification. Response
  generations independently prevent stale successful responses and old 401s
  from changing a newer session.
- Production and fixture composition are distinct. Root fixture installs remain
  independent of the locked server package. Every nonproduction composition
  removes generated Functions and excludes the production browser graph.

## Resolved review findings

Independent synthetic reproducers identified and verified corrections for:

1. Late token-pair publication and storage response deadlines, including the
   SDK's internal retries and complete body reads.
2. GitHub's `MERGED` PR reference state and current `fullDatabaseId` string IDs.
3. Unsupported GraphQL integer references, retained as uncertainty without an
   invalid provider query.
4. Control characters in branch progress and excessive API restrictions on
   otherwise valid literal branch characters.
5. Unicode collection ordering, using a total comparison while preserving exact
   source strings for fingerprints, file selection, and branch evidence.
6. Known credential paths, including Git credential storage and agent/CLI
   authorization files, while preserving eligible agent guidance.
7. One shared repository-list admission limit, successful direct-check
   authorization status, and OAuth identity API version/rate-limit categories.

No credential files or real repository inputs were used in these reproducers.

## Verification

- `npm run verify`: formatting, linting, 152 report unit checks, 45 fixture
  browser checks across three engines, build, and static artifact gate passed.
- `npm run test:server`: all 161 native backend checks passed.
- `npm run lint:server` and `npm run audit:server` passed; the dependency audit
  reports zero vulnerabilities.
- `npm run test:composition`: all five checks passed, including actual Vite
  graph isolation, authored native entry resolution, preview context rejection,
  failure cleanup, and all-regular-file credential marker checks.
- `npm run test:browser:production`: all 54 checks passed across Chromium,
  Firefox, and WebKit using mocked APIs. The narrow dark view was visually
  inspected from a synthetic screenshot. No real private metadata was captured.
- `git diff --check` passed. Signed checkpoints retain reviewable boundaries;
  the latest build checkpoint's local GPG signature was verified.

## Remaining acceptance

The existing owned site is `tracker-boards`, ID
`9ddf762e-9c92-44da-8636-e03913200664`. Its repository connection and first
deployment are pending. Production-only environment metadata and the owner's
App-installation confirmation are recorded in the
[setup document](../production-setup.md). They do not establish live OAuth,
runtime, public/private source acceptance, deployed headers, or zero-Function
preview behavior.

Record private acceptance as sanitized pass/fail without private repository
identifiers, counts, source tips, issue titles, or screenshots. Deliberate live
installation revocation is not performed; synthetic tests cover that boundary.
Anthropic credentials and paid calls are absent. Setup spending remains zero.
