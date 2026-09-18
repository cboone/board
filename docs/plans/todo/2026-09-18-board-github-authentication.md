# GitHub authentication and authoritative gathering

Date: 2026-09-18

Status: ready for implementation against merged baseline
`f8b78767babe021754873bd60540fbac8500b186`. Preliminary corrections and independent
baseline reviews are complete. Implementation and live acceptance remain pending.

## Outcome and authority

An authorized GitHub user can sign in to Board, select an eligible owned public
or private repository, and run a free source verification that returns the
collection status and canonical source metadata. The server obtains a complete
core inventory, gathers the approved context within explicit limits, and
verifies references without making any Anthropic call. A source verification is
not an analysis report.

The [original project prompt](../project-prompt.md), original
`publish-report-board` skill and its backlog-triage references, and confirmed
interview answers control product behavior. The
[living product roadmap](2026-09-18-board-product-roadmap.md) supplies the
current phase boundary. Technical defaults below are proposed implementation
choices for review, not additional product requirements or settled provider
behavior.

- The only authorized user is GitHub numeric ID `99961`, currently `cboone`.
- Board supports personally owned `cboone/*` public and private repositories.
  Exclude forks, archives, organization repositories, and other owners.
- Every real-data operation requires an authenticated authorized account.
- GitHub remains authoritative. Hosted collection observes pushed remote work;
  it cannot observe local worktrees or unpushed branches.
- Assignment alone does not establish work in progress. A related open PR,
  relevant unmerged remote branch, or explicit in-progress label can do so.
- Unverifiable external references remain visible uncertainty. Do not invent
  verified blockers or silently drop issues.
- Raw repository text and source snapshots remain transient. Persist only
  authentication coordination and the limited provenance needed for this phase.
- Deploy previews and branch deploys remain static fixture applications with
  zero Functions, server packages in deployed artifacts, credentials, or access
  to production Blobs.

## Scope and dependencies

Implement authentication, account sessions, repository selection, authoritative
source gathering, source verification, and production server isolation. Preserve
the fixture application and Phase 1 report semantics.

Anthropic integration, paid Generate/Refresh behavior, report publication,
current/previous report rotation, freshness UI for saved analyses, and spending
ledger implementation belong to Phase 3. This phase establishes reusable
collection and authenticated-read boundaries without claiming those features are
implemented. Report deletion controls remain deferred.

Dependencies before implementation or live acceptance:

1. Phase 1 merged in [PR #21](https://github.com/cboone/board/pull/21), with
   baseline `f8b78767babe021754873bd60540fbac8500b186`. The final head has passing
   CI and a clean current-head Copilot review; its merge signature is verified.
   Verify this integrated plan against that baseline and obtain independent
   review before implementation.
2. The authorized new Netlify site was created in the owned `cboone` Personal
   account, displayed as Catamount Hardware: `tracker-boards`, site ID
   `9ddf762e-9c92-44da-8636-e03913200664`, canonical URL
   `https://tracker-boards.netlify.app`. It is empty, without a repository link
   or deployment. Creation does not establish production acceptance.
3. The registered App is `cboone-tracker-boards`, ID `4995264`, Client ID
   `Iv23liQyjqNGXrULGeSB`, owned by GitHub user `99961`. Independent
   verification confirms `metadata:read`, `issues:read`, `pull_requests:read`,
   `contents:read`, and `events:[]`. The owner confirms installation on the
   personal `cboone` account covering the intended selected repositories and
   generation of the installation-required App private key, with its downloaded
   PEM handled outside the repository and Netlify. These are owner-confirmed
   setup facts; live installation and repository-access verification have not
   run. Authorization and installation remain separate operations, and live
   OAuth has not run.
4. Production-context-only configuration is installed and independently
   verified: canonical `BOARD_APP_ORIGIN`, owner `BOARD_OWNER_ID=99961`, both
   App identifiers, `BOARD_TOKEN_KEY_ID=2026-09-18`, a fresh cryptographically
   generated 32-byte base64 `BOARD_TOKEN_ENCRYPTION_KEY` marked secret, and
   `AWS_LAMBDA_JS_RUNTIME=nodejs24.x`. Client-secret metadata confirms
   `GITHUB_APP_CLIENT_SECRET` is secret, has `builds`, `functions`, and
   `runtime` scopes, and has exactly one production record. Nonproduction
   development, branch-deploy, deploy-preview, and dev-server records were
   removed while preserving the existing production value. No secret values were
   read or published in acceptance evidence. The verified Personal plan does not
   support selective environment scopes, so these values also reach trusted
   production builds. Do not give them `VITE_` names, read them in build
   scripts, or embed them in browser/static artifacts. Leave deploy-preview and
   branch-deploy values absent. Use the established secrets workflow during
   setup; do not print secrets, inspect unrelated credential files, or commit
   credentials.
5. The owned Netlify account is verified as `credit-personal`, with 1,000
   monthly credits shared across its projects, automatic top-up disabled, and
   Background Functions included. No plan upgrade or migration is required for
   the selected capabilities. A read-only observation returned included credits
   `1000`, used credits `0`, a period of August 24 to September 24, active
   account status, auto-top-up `false`, and exceeded markers `0`. Those counters
   have undocumented semantics and are not an authoritative remaining-credit
   balance. The owner confirmed the dashboard balance on September 18, 2026:
   863.7 of 1,000 credits remaining, expiring September 23, 2026. This completes
   the initial deployment balance check; it does not guarantee the balance at a
   later deployment. Actual invoice details remain unknown. Avoid exhausting the
   shared allowance and pausing other projects. No recharge, credit purchase,
   auto-top-up change, upgrade, or migration is inferred. If the shared
   allowance cannot safely support deployment, report the concrete blocker for a
   decision without inventing a blanket registration/deployment approval gate
   for work already authorized.

Live installation/source-grant verification, callback acceptance, disabled
device flow, expiring user-token behavior, live OAuth/sign-in, deployment, and
runtime acceptance remain pending. Owner-confirmed setup does not establish any
of those outcomes or change the merged-baseline review prerequisite. Complete
locally testable implementation and reviewable setup instructions while a
dependency is pending; report the exact remaining dependency without
representing mocked acceptance as live acceptance.

## Minimal implementation structure

Use Node `24.13.0`, ECMAScript modules, native `fetch`, `URL`,
`AbortController`, and `node:crypto`. Avoid an authentication framework, GitHub
SDK, SQL/database package, and installation-token/App-JWT subsystem for this
phase.

Public npm registry metadata verified on 2026-09-18 reports these exact server
dependency candidates:

| Package              | Exact version | Node requirement |
| -------------------- | ------------- | ---------------- |
| `@netlify/blobs`     | `11.1.0`      | `>=22.12.0`      |
| `@netlify/functions` | `6.0.0`       | `>=22.12.0`      |

Use `@netlify/blobs@11.1.0` as the only selected server runtime dependency. Keep
`@netlify/functions@6.0.0` as an optional documented candidate if an actual
helper export is needed later; do not install it solely for unused types in
plain JavaScript. Netlify explicitly documents that this package is not required
for JavaScript Functions. A `.mjs` default handler receives the native Request
and platform-provided context, returns native Response, and can export a plain
`config` object without any SDK import. Source: [JavaScript Functions
setup][netlify-function-start].

Recheck metadata for packages actually used when implementing, then use exact
versions and a committed lockfile. Node 24 satisfies both candidates'
requirements. Sources: [Blobs registry metadata][blobs-registry] and [Functions
registry metadata][functions-registry].

Proposed file boundaries:

- `server/package.json` and `server/package-lock.json`: independent server
  dependency install, outside the root fixture dependency graph.
- `server/functions/`: minimal `.mjs` authentication/API router default handlers
  using native Request/Response and the platform-provided context, with plain
  exported route configuration.
- `server/lib/`: runtime guard, environment validation, encrypted storage,
  OAuth/session handling, GitHub client, gathering, source verification, and
  canonical fingerprinting.
- `server/tests/`: native-fetch/provider mocks and injected storage/clock/random
  interfaces that exercise actual route/helper behavior.
- `scripts/`: explicit fixture/production composition and artifact verification.
- `src/`: production sign-in, repository picker, and source-check status views,
  retaining existing fixture routes and renderer.

Keep server helpers independently testable. Import the actual deployed Blobs
adapter only inside the guarded production server dependency graph. Use native
JavaScript objects with explicit runtime validation at provider/storage edges;
never treat response shape as trusted because it came from GitHub or storage.

### Shared route and response interface

Authentication, collection, and frontend implementation use this server-only
interface contract. Every JSON response, including errors and session bootstrap,
uses `Cache-Control: no-store`. Redirects use the configured canonical origin;
no provider credentials or private inventory enter a URL.

| Method | Route                         | Outcome             |
| ------ | ----------------------------- | ------------------- |
| GET    | `/api/session`                | Session bootstrap   |
| GET    | `/api/repositories`           | Repository metadata |
| POST   | `/api/repositories/:id/check` | Source summary      |
| GET    | `/api/auth/start`             | Redirect to GitHub  |
| GET    | `/api/auth/callback`          | Redirect to `/`     |
| POST   | `/api/auth/logout`            | Logout result       |

Session bootstrap returns HTTP 200 with `{auth:false}` when no valid session
exists, or `{auth:true,user:{id,login},csrfToken,sourceAuthorization}` for owner
`99961`. `sourceAuthorization` is `ready`, `reauthorization-required`,
`installation-required`, or `unverified`. It describes currently known ability
to gather, not authorization to read historical reports or proof that a selected
repository is eligible. Session bootstrap does not need a live source fetch.
Logout returns HTTP 200 with `{ok:true}` after revoking the current session and
clearing its cookie; it requires the authenticated CSRF check.

Repository selection returns `{repositories:[{id,fullName,name,private,url}]}`.
Only validated eligible entries are serialized. The path `:id` is a positive
safe integer from that selection, not an arbitrary repository URL. The source
check response is `{status:'complete',repo,sync,fingerprint,provenance,counts}`;
`repo` uses the same metadata shape, and `sync` uses canonical report-compatible
`at`, `timeZone`, `branch`, `commit`, and `openPullRequests` fields.

`fingerprint` contains `algorithm:'sha256'`, `value` as 64 lowercase hexadecimal
characters, and `scope:'core-and-collected-context'`. `provenance` contains
`observedFrom`, `observedTo`, `consistency:'two-pass-matched'`, `inputs` entries
with `name` and `status` (`complete`, `bounded`, or `unverified`), `files`
entries with `path` and `blobId`, `references` with `verified` and `unverified`
counts, and a `limitations` string list. Observation timestamps use ISO 8601 UTC
strings. `counts` contains `openIssues`, `openPullRequests`, `milestones`,
`labels`, `branches`, `unmergedBranches`, `issueComments`, `treeEntries`, and
`selectedFiles`, all nonnegative safe integers. Policy-excluded or unselected
files become explicit bounded limitations; failure to fetch an admitted selected
file is an incomplete-collection error. Neither establishes that all approved
inputs are unchanged. A complete core summary with unverified external
references does not claim globally unchanged source. No raw bodies/comments/file
contents or token fields are serialized.

Use one safe JSON error envelope `{error:{code,message,retryable}}`. Map invalid
requests to 400, invalid Board sessions to 401, owner/CSRF/source access
failures to 403, unavailable selected sources to 404, unstable observations to
409, admission/incomplete collection to 422, rate limits to 429, and bounded
transport timeouts to 504. Stable codes are `invalid_request`,
`session_required`, `forbidden`, `source_authorization_required`,
`source_unavailable`, `source_unstable`, `source_limit_exceeded`,
`source_incomplete`, `provider_rate_limited`, and `source_timeout`,
respectively. Retryable upstream failure uses HTTP 502 with
`provider_unavailable`; unavailable storage uses 503 with `service_unavailable`;
unexpected exceptions use 500 with `internal_error`. Messages are
predefined/sanitized and omit private identities, counts, request URLs, and
provider response bodies. Provider source-token reauthorization uses 403 with
`source_authorization_required`, preserving a valid Board session; only a
Board-session 401 clears frontend authentication. An OAuth callback failure
clears its transaction cookie and redirects to `/` with an allowlisted generic
error code, never the provider's raw error text.

Inject `sourceOperations.listRepositories({ownerId,accessToken,signal,budget})`
and
`sourceOperations.checkRepository({ownerId,accessToken,repositoryId,signal,budget})`
into the guarded API handlers. Authentication owns session/CSRF/token rotation;
source operations own provider eligibility, gathering, validation, and summary
construction. The check operation returns `{summary,sourceSnapshot}` internally;
the API explicitly serializes only validated `summary`. `sourceSnapshot` stays
in server memory for validation and later reuse by Phase 3, never in logs,
storage, or the browser. Mocks implement the same injected interface without
provider/store calls. No paid-analysis or retention route is introduced.

### Separate lint, test, and dependency commands

Extend the root ESLint source coverage from `**/*.js` to both `**/*.js` and
`**/*.mjs`. Apply Node globals to server files, preserve existing frontend
rules, and ignore generated server copies and server dependency directories.
Root lint must parse authored backend handlers/helpers/tests even though root
Vitest excludes them. ESLint parses source without executing store/provider
imports, so fixture linting does not require installing the independent server
package.

Add `server/**` to the root Vitest exclusion list while retaining the project's
existing default/browser exclusions. Root `npm test` must not discover
`server/tests`, import the server SDKs, or require a server install. Keep
backend tests under `server/tests` and use the native Node test runner through
the server package's `test` script, proposed `node --test`. Inject provider
fetch, storage, clock, and randomness; unexpected network/store access fails a
test rather than contacting a real provider. No test imports a production store
adapter that opens Blobs at module evaluation.

Provide explicit root aliases for separate server operations:

- `npm run install:server`: run `npm ci --prefix server`.
- `npm run lint:server`: run root ESLint on authored server `.mjs` sources.
- `npm run test:server`: run `npm --prefix server test`.
- `npm run audit:server`: run the production dependency audit below.

```bash
npm exec -- eslint 'server/**/*.mjs'
npm --prefix server audit --omit=dev --audit-level=high
```

Keep install separate from test so tests cannot unexpectedly install packages.
Create a dedicated backend CI job that installs locked root tooling and the
independent locked server package, runs backend lint, native Node tests and
dependency audit, and exercises production/fixture composition with synthetic
sentinel keys and mocked services. The fixture CI job installs root dependencies
only and runs root Vitest/browser checks without `server/node_modules`.
Production composition checks use a valid synthetic encryption key and
unmistakably synthetic client-secret values, never real credentials. Run fixture
composition after production composition to prove stale Functions are removed,
and assert no server install is invoked for missing, unknown, preview, or branch
build context. These commands/jobs are future implementation deliverables, not
commands already added or run.

## GitHub App configuration

The registered `cboone-tracker-boards` App has independently verified owner ID
`99961`, App ID `4995264`, Client ID `Iv23liQyjqNGXrULGeSB`, the following exact
read-only repository permissions, and `events:[]`. The owner confirms personal
account installation covering the intended selected repositories; live
installation/source-access verification remains pending:

| Permission      | Access | Purpose                                          |
| --------------- | ------ | ------------------------------------------------ |
| `metadata`      | Read   | Identity, eligibility, installation repositories |
| `issues`        | Read   | Issues, comments, labels, milestones             |
| `pull_requests` | Read   | PR descriptions and issue-closing associations   |
| `contents`      | Read   | Branches, commit comparisons, tree, text blobs   |

Request no repository writes, account/email permissions, organization
permissions, or webhook events. Disable device authorization. Use expiring user
tokens. GitHub permission checks use the intersection of the App's grants and
the user's access; private source access also depends on suitable installation
access. GitHub Apps can read public resources implicitly, so an API success is
not proof of Board eligibility. Sources: [App permission
selection][github-permissions] and [App user authentication][github-user-auth].

Prepare one exact OAuth callback at the canonical production origin, proposed
`/api/auth/callback`. Set `request_oauth_on_install:false`, then have Board
explicitly initiate authorization with its own state and PKCE transaction. An
optional installation setup URL can return to the signed-in picker, but
`installation_id` received through that URL is an untrusted hint.

Prepare a configuration artifact with `public:false`, the permission map above,
`default_events:[]`, inactive webhooks, the homepage, callback, and optional
setup URL. Prefer GitHub's documented prefilled registration URL or manual
registration for this one-owner setup. A manifest remains a reproducible
configuration reference; Board does not need a public manifest-registration
flow.

If a manifest flow is used for setup, distinguish `redirect_url`, its temporary
registration callback, from `callback_urls`, the user OAuth callback array. All
three manifest handshake steps must complete within one hour. Conversion
produces private-key/webhook credentials even though this application does not
need them. The owner confirms generation of the installation-required private
key and handling of its downloaded PEM outside the repository and Netlify; Board
does not use that key at runtime. Sources: [manifest
registration][github-manifest], [prefilled registration][github-prefilled], and
[installation setup URL][github-setup].

## OAuth and account sessions

### Login transaction

1. Reject nonproduction runtime contexts and noncanonical origins before reading
   production environment secrets or opening Blobs.
2. Generate cryptographically random state, PKCE verifier, and browser-binding
   nonce. Compute the base64url SHA-256 PKCE challenge and use `S256`; GitHub
   does not support the `plain` challenge method.
3. Store a single-use OAuth transaction under a hashed state key with encrypted
   verifier, browser-binding hash, creation time, and ten-minute expiration. Set
   an opaque `__Host-board_oauth` cookie with Secure, HttpOnly, SameSite=Lax,
   Path=/, no Domain, and matching lifetime. Never place the verifier, provider
   secret, or tokens in browser storage.
4. Redirect to GitHub authorization with the configured client ID, exact
   callback, state, and challenge. `login=cboone` is a convenience hint, never
   authorization.
5. On callback, require matching state/browser binding, validate expiration, and
   atomically claim the transaction by ETag before exchanging the code. Remove
   its stored verifier as part of claim; keep the verifier only in the
   claimant's memory. A duplicate callback cannot exchange again.
6. Exchange the code server-side with client secret, verifier, and exact
   callback. Validate the entire successful token response. Call `GET /user`
   with the resulting user token and require numeric ID `99961`.
7. Reject another user before creating account credentials/session or returning
   private source data. Store the complete encrypted token pair atomically, then
   issue a newly generated session. Clear the OAuth cookie on terminal
   completion or failure. Do not log codes, callback query strings, or tokens.

Abort an interrupted/ambiguous code exchange and offer a new authorization
transaction. Do not retry a possibly consumed authorization code. Current
provider support is documented in [App user OAuth][github-oauth].

### Owned sessions

Use a random 32-byte opaque `__Host-board_session` cookie with Secure, HttpOnly,
SameSite=Lax, Path=/, and no Domain. Store only its hash as the record key,
numeric owner ID, CSRF verifier, issued/last-seen timestamps, and expiration.
Propose a seven-day absolute lifetime and eight-hour idle lifetime. Check both
on every protected request, using an injected clock in tests.

Verify the GitHub identity before issuing a new session. Subsequent saved-report
authorization uses the locally validated owner/session record and does not
depend on a live GitHub source check or token refresh. A known
user-authorization revocation invalidates the account's Board sessions; an
installation's removal only changes source access. An ambiguous refresh requires
new authorization for source operations but does not turn a previously
authenticated, unexpired Board session into another identity. Provider network
failures do not manufacture a new authenticated identity or invalidate a
historical read merely because a source check failed. Expired or revoked
sessions require sign-in again.

Use origin checks and a session-bound CSRF token for logout and source-check
POSTs. Deliver the token through an authenticated response with
`Cache-Control: no-store`; hold it in browser memory and send a request header.
Never implement mutation through a GET. Protected responses and failures use
`no-store`, never return provider tokens, and do not allow credentialed
cross-origin requests.

Logout first marks the current server session revoked, then clears the cookie.
It does not uninstall/revoke the GitHub App, delete saved reports, or mutate
GitHub. Keep expiration/revocation checks authoritative even if cleanup has not
removed old coordination records. Remove expired OAuth/session coordination
records through bounded maintenance; do not add report deletion controls.

Keep an account authorization epoch in the shared authentication record and bind
sessions to it, allowing a known account authorization revocation to invalidate
all sessions through one CAS update. This field is separate from
token-generation/source-access state. Use CAS for idle timestamp updates so a
concurrent request cannot restore a revoked session. Recheck owner/session
validity before returning private data from a long source operation; a logout or
expiry during gathering cannot be ignored by its final response.

### Protected browser state

Keep repository inventory, selected repository, source-check results, and CSRF
token in memory only. On logout initiation, session expiry, known authorization
revocation, or a protected-request 401, immediately clear that state and remove
its protected DOM content. Reset the selection/status view before any further
asynchronous result can render; the theme preference may remain.

Maintain a monotonic browser authentication generation. Every protected request
captures its generation; before applying any response, require that generation
still matches the currently authenticated session view. Increment the generation
and abort pending protected requests when authentication is cleared or replaced.
Late responses from the old session cannot restore inventory, selection, source
results, or CSRF state, including after another successful sign-in. The
generation check also precedes handling an old response's 401; it cannot clear a
newer authenticated view. A failed server logout still clears protected browser
state and reports that server sign-out was not confirmed; do not claim
successful revocation without a server response.

On initial load and browser history/back-forward-cache restoration, clear any
protected content before awaiting an authoritative session bootstrap response.
Validate the server session before restoring a protected view or starting a
repository request. Do not trust history state, retained DOM, or a previous
browser `authenticated` flag as authorization. A pending or failed bootstrap
does not display cached private inventory or check results. Browser tests should
exercise logout/expiry during an outstanding source request and a history return
after logout, not merely inspect state helper assignments.

### Saved reports and source eligibility

Keep `requireAuthorizedOwner` separate from `requireEligibleSource`. The future
saved-report read path authorizes by session owner and stored report owner/repo
ID; it does not require a currently eligible repository or active installation.
Test this contract with stored-report stubs, without implementing report
retention/rotation in this phase. A valid owner can read a historical report
when its source becomes archived, transferred, deleted, or inaccessible. The
same condition prevents new source gathering/analysis. An unsigned request or
another user cannot retrieve the stored report.

## Encrypted credentials and token rotation

Create one account credential record for ID `99961`, shared by that account's
sessions. Store access and refresh tokens as one encrypted pair, including
access/refresh expirations, provider type, generation, and the granted scope or
permission metadata. Derive expiration from validated provider `expires_in`
values rather than assuming every response matches the documented defaults.
GitHub currently documents access-token lifetime of eight hours and refresh
lifetime of six months; a successful refresh invalidates the old pair. Source:
[refreshing user tokens][github-refresh].

Encrypt with AES-256-GCM using a 32-byte server environment key, a fresh 12-byte
nonce, explicit 16-byte authentication tag, and authenticated additional data
binding encryption purpose, exact storage record key, schema version, owner ID,
and key ID. Use distinct purposes for OAuth PKCE transactions and GitHub user
token pairs, so ciphertext cannot be moved between record types or keys for the
same owner. Version the envelope so key rotation can accept a configured
previous key while writes use the current key. Reject malformed envelopes and
authentication failures. Do not print decrypted tokens or include them in
exception bodies. Use native cipher/decipher APIs with the explicit tag-length
option and AAD before processing content. Source: [Node crypto
APIs][node-crypto].

Use a site-wide Blobs store with strong reads. Read values and the exact ETag
with `getWithMetadata(key,{type:'json'})`; create with `onlyIfNew:true` and
update with `onlyIfMatch:etag`. Check `modified` explicitly; CAS failure is a
competing writer, not a successful operation. Preserve ETags exactly, including
quotes. These are documented atomic conditional writes; they are not
transactions across multiple records or provider calls. Source: [Netlify
Blobs][netlify-blobs].

Proposed account state machine:

1. `active`: token pair, generation, expiry, and last successful identity check.
   Refresh on demand when the access token has less than five minutes remaining.
2. `refreshing`: acquired through CAS, with generation, unique attempt ID, start
   time, and bounded operation deadline. Claim removes the pair from the shared
   record; only the claimant retains the old pair in memory for the single
   exchange. Other requests reread/poll within their request deadline instead of
   refreshing independently or authorizing with a stale cached pair.
3. `active` with generation incremented: after one confirmed successful refresh,
   validate the response and CAS-publish the complete new encrypted pair against
   the claim's ETag. Never publish only one token or overwrite a newer login.
4. `reauthorization-required`: refresh failed, the result is ambiguous, or the
   claimant stopped before durably publishing. An expired claim can move only to
   this state; another worker must never replay the old refresh token.

A transport timeout or process interruption can occur after GitHub rotates its
token but before Board saves it. Storage CAS cannot repair that transaction.
Require fresh authorization rather than retrying an uncertain refresh. A late
claimant cannot overwrite a new OAuth login or another generation. CAS retry
loops have explicit deadlines/attempt caps and never retry the provider refresh
itself. A confirmed current-generation 401 can require reauthorization;
distinguish it from a 401 produced by a superseded access-token generation.

## Repository picker and provider client

Use the GitHub App user token for `GET /user/installations`, followed by
`GET /user/installations/{installation_id}/repositories`. Paginate both with
`per_page=100`. The first endpoint needs no additional permission; the second
requires Metadata read. Inspect actual installation permissions rather than
assuming configuration changes have been accepted. Sources: [installation
endpoints][github-installations] and [permission changes][github-permissions].

Only offer repositories under the expected App's eligible nonsuspended personal
installation with owner ID `99961`, User account type, `fork:false`, and
`archived:false`. Validate private-repository access against actual grants. Do
not mistake UI filtering for server authorization. Every direct source request
revalidates repository identity, current ownership/type, and eligibility.

Use numeric repository IDs as stable selection identifiers. Resolve the current
name through the eligible inventory rather than accepting arbitrary owner/path
URLs from the browser. Revalidate any rename/transfer redirects, retaining the
selected repository ID and owner constraints. Do not follow provider URLs or
pagination links outside the configured GitHub API origin and expected resource
family. No GitHub write endpoint is needed.

Set Accept and `X-GitHub-Api-Version:2026-03-10`, verified as currently
supported in [GitHub API versions][github-api-versions]. Classify 401, 403
permissions, primary/secondary rate limits, 404 access uncertainty, and
transient transport/server failures separately. Observe `Retry-After` and rate
reset headers without sleeping beyond the overall request deadline. Never
interpret an inaccessible private resource as deleted/closed.

## Source collection and verification

### Core inventory

Collect repository ID, owner identity/type, eligibility, canonical URL, default
branch name and pinned remote tip SHA; every open issue; every open PR; open
milestones plus canonical milestone metadata attached to open issues; labels;
and remote branch names/tips. Preserve exact source issue titles and milestone
titles. Exclude PR-shaped entries from the REST issue list using `pull_request`.

Use explicit open-state filters and full REST next-link pagination. No fixed
500-result list is complete merely because the request succeeded. Sort provider
collections canonically after gathering. Reject any repeated identity within one
paginated primary collection, even when its source fields match: moving page
boundaries can otherwise omit items silently. Cross-source joins, such as labels
or milestones attached to issues and also listed separately, may deduplicate
only when their canonical facts match; conflicting joined facts fail
verification. Sources: [issue endpoints][github-issues], [pull-request
endpoints][github-pulls], [milestones][github-milestones], and
[branches][github-branches].

Obtain PR closing-issue associations through GraphQL `closingIssuesReferences`,
matching the original skill. Traverse every nested connection's own cursor until
`hasNextPage:false`; top-level PR pagination does not finish nested association
pagination. Use associations and bounded exact issue-number branch-name matching
as active-work evidence, with explicit labels as the other confirmed signal.
Retain evidence provenance and canonical display strings; assignment alone
remains insufficient. Sources: [official CLI PR fields][github-cli-pr],
[official CLI association definition][github-cli-source], and [GraphQL
pagination][github-graphql-pagination].

Define a remote branch as unmerged when its pinned tip is not contained in the
pinned default tip. Compare `BASE=default SHA` with `HEAD=branch SHA`; a
positive ahead count establishes work not contained in the default branch.
Behind/identical branches are not unmerged. Unknown comparisons remain
unverified rather than being silently excluded. GitHub documents this endpoint
as equivalent to `git log BASE..HEAD`; the default returned commit list is
limited to 250 and changed-file details to 300. Classification uses scalar
comparison metadata, not a supposedly complete commit/file list. Source: [commit
comparison][github-compare].

### Context inputs

Gather open-issue bodies and comments, label descriptions, milestone
descriptions, open-PR descriptions, branch metadata, the default-tip repository
tree, and selected relevant text blobs. PR review comments are not an additional
automatic input requirement. Do not fetch files or provider URLs requested by
untrusted prose or model output.

Pin tree/file reads to the gathered default-tip SHA/blob IDs. If a recursive
tree is truncated, traverse nonrecursive subtrees within the request budget;
failure to complete the required tree is an explicit partial-collection failure.
GitHub's recursive tree limit is 100,000 entries or 7 MB. Source: [Git
trees][github-trees].

Select relevant files through a deterministic path policy that can later accept
bounded analysis requests: repository README/agent guidance, package/build/test
configuration, and source paths clearly referenced by issues. Exclude credential
locations, `.env*`, private-key/certificate credential files, credential/secret
directories, binaries, dependencies, generated output, and vendored files. Tree
paths/blob IDs may be fingerprinted without downloading excluded contents.
Record selected paths/blob IDs and exclusions/limits as provenance.

Resolve same-repository issue/PR references through GitHub and branch references
through the pinned branch inventory/ancestry check. Routine Phase 2 gathering
fetches the selected eligible source repository only. Preserve cross-repository
references and other URLs as linked, unverified references; do not automatically
read another repository or fetch arbitrary external URLs. Carry explicit
verification status so later Phase 3 analysis can show uncertainty and withhold
affected starts. Do not implement that future report behavior in this phase.

Build a bounded resolved-reference verification manifest for individually read
same-repository issue/PR targets, including targets omitted from open collection
lists because they are closed. Each entry records requested identity and
verification outcome, plus only the resolved facts used: repository/item
identity, issue-versus-PR type, status/state, issue `state_reason`, and PR
merged status/merge SHA where relevant. Do not download closed-item
bodies/comments as additional model context. Deduplicate target reads and count
every request under the operation's existing limits.

Use explicit unreadable/unverified entries with stable uncertainty categories;
an inaccessible target does not mean closed or merged. Hash this manifest and
repeat the individual target verification in the second consistency pass,
including readable-to-unreadable and unreadable-to-readable transitions. A
changed closed target can affect blocker resolution without changing any open
issue/PR manifest or default tip. Unverified scope cannot establish globally
unchanged approved inputs. Branch verification remains tied to pinned branch
identities and ancestry facts.

### Proposed admission defaults

Keep collection admission separate from later Anthropic token/spending limits.
The following defaults bound API work and memory and are reviewable technical
choices. They do not promise that every admitted-count repository completes
within one synchronous invocation.

| Boundary                      | Proposed limit                           |
| ----------------------------- | ---------------------------------------- |
| GitHub page size              | 100                                      |
| Open issues                   | 1,000                                    |
| Open PRs                      | 1,000                                    |
| Remote branches               | 500                                      |
| Milestones / labels           | 2,000 / 5,000                            |
| Gathered issue comments       | 20,000 aggregate                         |
| Complete tree entries         | 100,000                                  |
| Decoded provider response     | 8 MiB per response                       |
| Transient decoded source data | 64 MiB aggregate                         |
| Selected relevant text files  | 40                                       |
| Selected file contents        | 64 KiB per file; 2 MiB aggregate         |
| GitHub requests per gather    | 300, including verification/stability    |
| Simultaneous GitHub requests  | 4                                        |
| Individual request timeout    | 15 seconds                               |
| Synchronous source operation  | 45 seconds, including token coordination |
| Read-only transport retries   | One within the same operation budget     |

Enforce byte limits while reading response streams, not after an unbounded
`response.json()` allocation. Every retry consumes the same request/deadline
budget. Honor rate-limit backoff only if it fits that budget. Mutating provider
token exchanges have no automatic retry.

The 1,000-open-issue admission limit matches the existing report contract's
`REPORT_LIMITS`; collection cannot admit an inventory that later report
validation necessarily rejects. Keep that shared limit authoritative when
integrating the plan against the actual Phase 2 baseline.

If core inventory exceeds a bound or a required page cannot be gathered, refuse
the source operation with a specific incomplete/admission result. Never remove
open issues to fit. Optional file/comment context may later be selected within
disclosed Phase 3 analysis limits, but a truncated check cannot establish that
all approved inputs are unchanged. Phase 2 should gather/hash the admitted
comment collection completely; it does not silently treat a context subset as
complete freshness coverage.

Netlify sync execution is limited to 60 seconds. A 45-second application
deadline leaves room to return a controlled result; it is not a provider latency
promise. If live verification proves this inadequate, report the exact bounded
failure and plan worker execution separately. Do not add raw-source handoff
persistence or an unmeasured background subsystem to this phase. Source:
[Function limits][netlify-function-config].

### Fingerprints and changing sources

Produce canonical hashes over source fields and record the covered scope.
Include repository identity/eligibility/default branch and tip; issue
bodies/labels/ milestones/state; comment identities/body/updated time; PR
descriptions/base and head tips/closing associations; branch names/tips/unmerged
classification; milestone and label metadata; complete tree identity and
selected file blob IDs. Include the resolved-reference manifest's requested
identities, verification outcomes/uncertainty categories, and actual resolved
facts used, including closed targets' state reasons and relevant PR merge facts.
Sort unordered collections by stable IDs and numbers. Hashing is deterministic
across pagination order; changing source text changes the digest.

GitHub endpoint reads do not form an atomic cross-endpoint snapshot. Implement a
testable two-pass consistency guard within one bounded source operation:

1. Pin repository identity/eligibility/default tip. Gather complete primary
   collections and comments, build canonical collection manifests, and gather
   pinned tree/selected blobs. Each manifest contains stable IDs plus the actual
   source-field digests, update timestamps, membership, and relevant counts;
   timestamps alone do not prove unchanged text.
2. Recheck repository identity/eligibility/default tip and completely reread the
   primary issue, PR/closing-association, milestone, label, and branch
   manifests. Reread each admitted open issue's comment manifest, including
   comment IDs, update timestamps, body hashes, and count. A comment-count match
   or unchanged issue update timestamp cannot skip this comparison. New/closed
   issues, additions/deletions/edits of comments, changed PR associations, and
   changed branch tips must be visible to this pass. Independently repeat the
   resolved-reference verification manifest, including closed same-repository
   issue/PR targets and unverified outcomes; comparing only open primary lists
   cannot cover these facts.
3. Compare both manifests and the pinned repository identity/tip. Immutable
   tree, blob, and branch-comparison results can be reused only for identical
   pinned object IDs. If any relevant manifest differs, allow at most one entire
   gather retry within the original request/deadline/byte budget. Otherwise fail
   with unstable-source status.

Record observation start/finish and covered scope. Two matching observations
reduce collection inconsistency; they cannot prove no intervening change or
promise an atomic GitHub snapshot. A partial, unstable, inaccessible, or
rate-limited result is never `unchanged` or a complete successful verification.
An unchanged default SHA alone cannot establish source freshness because
issue/comment changes are independent of Git commits.

Use the complete in-memory core facts to build an independent source inventory
and validate collection consistency. Return only authenticated selection
metadata, counts, source identity, fingerprints, provenance/limits, and
meaningful failure or uncertainty summaries to the Phase 2 UI. Do not store raw
bodies/comments/ blobs in Blobs or send them to diagnostics. Authentication
records cannot double as a source cache. Raw context ends with the request.

## Production and preview isolation

Configure one generated Functions directory,
`server/.generated/server/functions`, outside `dist`. Default fixture builds
first remove generated server artifacts and run the existing static build. They
do not install the separate server dependency package, import its modules, open
Blobs, or contact GitHub/Anthropic. A production-only build command checks the
documented build context before `npm ci --prefix server`, then copies required
functions/ helpers into the generated server artifact. Unknown, missing,
deploy-preview, or branch-deploy context always takes the fixture path and
leaves Functions empty, even if the production command was invoked. Keep its
local dependency resolution valid under `server/` and keep all server bundles
outside static assets. Root `npm ci` must not install this independent package
through a workspace/lockfile link. Local backend tests explicitly install it
separately and use mocks; fixture builds and their ordinary unit graph never
import the store adapter.

Preserve source-relative imports by staging a miniature repository tree: entry
files under `server/.generated/server/functions/`, helpers under
`server/.generated/server/lib/`, and shared domain modules under
`server/.generated/src/domain/`. Imports such as `../lib/auth.mjs` and
`../../src/domain/report-contract.js` must still resolve after staging. This
shares the authoritative report limits without copying their values. Server
package lookup then reaches `server/node_modules` from that generated hierarchy.
Add an actual generated-entry import/resolution check with synthetic environment
and nonproduction mock context, verifying relative helper imports and the
selected Blobs package resolve without opening a store or calling providers.
Validate the Netlify production bundle manifest as well; a staging-path
explanation alone is not deployment evidence.

Use context-specific Netlify build commands to select this composition. Verify
production composition and preview composition independently, including a
preview build after a production build so stale generated artifacts cannot
survive. Check the generated directory, static import graph, Netlify function
manifest, and deployed preview endpoints. An environment flag alone does not
enforce this boundary. Sources: [deploy contexts][netlify-contexts] and
[Functions configuration][netlify-function-config].

The guarded build composition also explicitly sets the public browser mode:
`production` only for verified production context; `fixture` for every other
context regardless of an externally supplied frontend flag. Browser code treats
missing/unknown mode as fixture. Production `/` bootstraps `/api/session` before
showing protected picker/check views; fixture builds never call these endpoints.
Retain `/demo` as synthetic data. The browser-mode value is not a secret and
does not replace server/artifact guards.

Compose the deployed `_redirects` file for the selected mode. Fixture builds put
`/api/* /fixture-only.json 404` before the SPA fallback, serving only the static
synthetic `fixture_only` response for API paths. Production builds omit that API
fallback so it cannot intercept automatically configured Function paths; retain
the SPA rule for browser routes. Verify the actual deployed production callback,
session, repository, and source-check routes and the deployed preview API 404
behavior. Do not infer routing precedence or successful Functions deployment
merely from local build configuration.

Every production Function rejects `context.deploy.context !== 'production'`
before accessing environment secrets or importing/opening the Blobs adapter.
Also enforce the configured canonical request origin for cookie-backed routes.
Do not assume `process.env.CONTEXT` exists at runtime. Do not require
App/provider credentials in the root Vite build. Sources: [Functions deploy
context][netlify-api] and [function environment
variables][netlify-function-env].

Installed initial runtime configuration is the canonical app origin, authorized
owner numeric ID `99961`, App ID `4995264`, Client ID `Iv23liQyjqNGXrULGeSB`,
the production-only Client Secret, token key ID `2026-09-18`, and a fresh
32-byte base64 token-encryption key marked secret. Configuration verification
does not claim a successful deployment or runtime use. Versioned previous-key
settings remain absent for initial setup. Validate them at guarded runtime
startup. The verified Personal plan has `env_var_scopes:false`; selective scopes
are a Pro/Enterprise capability. Configure secrets through UI/CLI/API with
production-context-only values and no all-context, preview, or branch values.
They necessarily reach trusted production builds as well as production
Functions. Build scripts must not read or print them, and they must never use
`VITE_` names or enter browser/static bundles. Check artifact leakage with
synthetic sentinel values, not real secrets. Zero preview Functions and the
absence of preview/branch secret values remain the isolation boundary. Source:
[environment-variable contexts and scopes][netlify-env-overview].

Netlify supports Node 24; an explicit `AWS_LAMBDA_JS_RUNTIME=nodejs24.x`
override is configured through UI/CLI/API and needs redeployment, not TOML. No
Anthropic key, SQL credentials, App private key, or Netlify personal token is
needed for these deployed capabilities. Sources: [Node runtime
configuration][netlify-function-config] and [Blobs integration][netlify-blobs].

## Validation and observable exits

### Mocked unit and route checks

- OAuth state mismatch, missing/wrong browser binding, expired transaction,
  duplicate callback claim, interrupted exchange, provider refusal, malformed
  token response, and wrong numeric user ID produce controlled errors without
  tokens or private data.
- Secure cookie attributes, session fixation resistance, absolute/idle expiry,
  CSRF/origin checks, logout revocation, and no-store protected responses are
  verified through actual route behavior.
- Two sessions sharing a token pair produce one refresh; CAS losers reread.
  Provider success plus storage interruption requires reauthorization. An
  expired refresh claim cannot replay the old token. A late response cannot
  overwrite a newer login. Encrypted envelopes reject tampering, wrong
  owner/purpose/record-key AAD, cross-record ciphertext substitution, and
  missing keys; versioned current/previous keys behave as designed.
- Installation and repository lists span more than 100 results. Picker and
  direct requests reject other owners, organizations, forks, archives, suspended
  installs, wrong App IDs, and missing private-repository grants.
  Public-resource provider accessibility never bypasses Board eligibility.
- Open-issue gathering spans more than 100 results and filters PR-shaped
  entries. Comments, milestones, branches, PRs, and nested closing references
  paginate completely; both matching and conflicting repeated identities within
  a primary collection fail visibly, as do unsafe next links. Canonically
  matching cross-source joins succeed; conflicting joined facts fail
  verification.
- Branch comparisons cover ahead, behind, identical, diverged, and unverified
  results. Tree truncation either completes through bounded traversal or returns
  incomplete status. Credential/binary paths never have content fetched.
- Canonical hashes ignore page order and change for issue/comment edits or
  deletion with unchanged default SHA, PR description/association edits,
  milestone/label changes, and branch changes. Moving source tips/eligibility
  and incomplete checks never establish unchanged source.
- Resolved-reference tests change a still-closed issue's `state_reason`,
  relevant PR merged/merge-SHA facts, and readable/unreadable outcomes while
  holding open manifests/default SHA fixed. Each changes the reference
  fingerprint and fails the two-pass stability comparison. An unchanged
  closed-target manifest is a stable control. Reopening a target, which the
  open-issue manifest already catches, is a negative control demonstrating why
  that case alone cannot prove the new closed-target guard works.
- Admission/response-byte/deadline/request limits, primary/secondary rate
  limits, 401/403/404, timeouts, and transient failures retain exact failure
  categories. Logs and storage writes contain no raw source or provider
  credentials.
- Authorized historical-read stubs remain accessible after installation/source
  removal, while gathering is refused; anonymous/wrong-user access is denied.
- Nonproduction runtime and canonical-origin failures occur before store adapter
  imports/reads or provider requests.

### Browser and artifact checks

Exercise mocked sign-in status, repository selection, free source verification,
logout, session expiry, access removal, and retryable collection failures. Keep
fixture tests independent of live services. Assert that selecting a repository
does not call Anthropic and that every Phase 2 flow makes zero paid AI requests.
Assert protected inventory/selection/results disappear on logout and expiry,
late old-session responses cannot restore them, and history/back-forward-cache
restoration validates authorization before displaying retained content. Use
delayed actual mocked route responses and browser navigation to exercise these
observable races.

Retain Phase 1 report, keyboard, narrow-screen, theme, and accessibility
coverage. Verify preview static artifacts have zero Functions and no
server/provider/store imports, keys, or real source data. Verify preview API
paths do not expose live capabilities. With synthetic secrets configured only in
the production test context, verify trusted production builds do not
read/log/embed them, production static artifacts contain no sentinel values, and
preview/branch environments receive none. Run repository formatting, lint, unit,
browser, build, and artifact checks once the relevant implementation is stable;
repeat only for meaningful subsequent changes or unresolved failures.

### Live acceptance

1. Record actual site/App identity, registration permissions, installation
   owner, and callback configuration without secrets. Production can serve the
   app; previews retain fixtures and no server data access.
2. The authorized owner signs in and the server verifies ID `99961`. An account
   with another ID cannot obtain a session or data.
3. Verify one actual eligible public repository and one actual eligible private
   repository selected by the owner. Private repository names, IDs, titles,
   source SHAs, completeness counts, and covered-scope details remain protected
   server-side or local transient acceptance evidence only. Committed public
   documents, PRs, comments, CI/application logs, and screenshots record only
   sanitized pass/fail for private acceptance, without those identifiers or
   facts. Inspect detailed evidence through the authorized interface; do not
   create a public screenshot or diagnostic dump of private inventory. Retain no
   raw acceptance source after the check.
4. Confirm unauthorized direct requests and unsupported repo types fail on the
   server. Verify logout and source/App access changes with the least disruptive
   owner-approved test arrangement already available; mocked cases stay visibly
   mocked if an actual revocation test would change the owner's installation.
5. Confirm complete collection or a precise admitted-limit failure, private data
   stays server-side, and zero Anthropic calls occurred. A successful collection
   does not claim that analysis/report persistence exists.

Exit when the implemented production authentication and gathering path passes
mocked behavior/artifact checks and authorized live public/private acceptance;
the exact deployed version, remaining provider/runtime limitations, sanitized
private-repository pass/fail, and any owner-dependent live checks are recorded.
Detailed private acceptance evidence remains protected/transient and is never
published with the plan/PR. Complete independent branch review, signed logical
commits, PR creation/monitoring, merge commit, and worktree cleanup through the
original authorized project workflow before starting Phase 3.

## Primary references

[blobs-registry]: https://registry.npmjs.org/@netlify%2fblobs/latest
[functions-registry]: https://registry.npmjs.org/@netlify%2ffunctions/latest
[github-permissions]: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
[github-user-auth]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user
[github-oauth]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
[github-refresh]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
[github-manifest]: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
[github-prefilled]: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-using-url-parameters
[github-setup]: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url
[github-installations]: https://docs.github.com/en/rest/apps/installations
[github-api-versions]: https://docs.github.com/en/rest/about-the-rest-api/api-versions
[github-issues]: https://docs.github.com/en/rest/issues/issues
[github-pulls]: https://docs.github.com/en/rest/pulls/pulls
[github-milestones]: https://docs.github.com/en/rest/issues/milestones
[github-branches]: https://docs.github.com/en/rest/branches/branches
[github-cli-pr]: https://cli.github.com/manual/gh_pr_list
[github-cli-source]: https://raw.githubusercontent.com/cli/cli/trunk/api/queries_pr.go
[github-graphql-pagination]: https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api
[github-compare]: https://docs.github.com/en/rest/commits/commits#compare-two-commits
[github-trees]: https://docs.github.com/en/rest/git/trees
[netlify-blobs]: https://docs.netlify.com/build/data-and-storage/netlify-blobs/
[netlify-function-config]: https://docs.netlify.com/build/functions/configuration/
[netlify-function-start]: https://docs.netlify.com/build/functions/get-started/
[netlify-function-env]: https://docs.netlify.com/build/functions/environment-variables/
[netlify-env-overview]: https://docs.netlify.com/build/environment-variables/overview/
[netlify-contexts]: https://docs.netlify.com/build/configure-builds/file-based-configuration/#deploy-contexts
[netlify-api]: https://docs.netlify.com/build/functions/api/#deploy
[node-crypto]: https://nodejs.org/docs/latest-v24.x/api/crypto.html
