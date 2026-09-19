# Board production setup

The production site is
[tracker-boards.netlify.app](https://tracker-boards.netlify.app), site ID
`9ddf762e-9c92-44da-8636-e03913200664`, in the owned `cboone` Netlify account.
The currently deployed authentication/source-check composition is from signed,
GitHub-verified Phase 2 merge `370c257c49c09492426b4d8df24d37240884e908`,
automatic deploy ID `6aaddca5bf99630008491b49`. The site API independently
reports that deployment ready in production context with one Function. The
project is connected through Netlify's GitHub provider to `cboone/board`,
production branch `main`, build `npm run build`, and publish directory `dist`.
On September 18, 2026, live owner sign-in, an eligible public repository source
check, an eligible private repository source check, sign-out, and the provider
summary's zero Edge Functions count all passed. No custom domain or self-hosting
guide is required for this release.

As of September 19, 2026, Phase 3 report generation is implemented on its
feature branch. Its production composition has two Functions, plus report
persistence and a paid-analysis path. It has not yet been merged or deployed. No
paid calibration or live Phase 3 acceptance is recorded in this guide.

## Owner-controlled GitHub App setup

The registered App is `cboone-tracker-boards`, ID `4995264`, Client ID
`Iv23liQyjqNGXrULGeSB`, owned by GitHub user `99961`. Its repository permissions
were independently verified as `metadata:read`, `issues:read`,
`pull_requests:read`, and `contents:read`, with `events:[]`.

Required App settings include owner-only installation, the production homepage,
and the single user callback
`https://tracker-boards.netlify.app/api/auth/callback`.

Repository permissions are Metadata, Issues, Pull requests, and Contents, all
read-only. Give no account/email, organization, or write permissions. Keep
webhooks inactive with no events, device authorization disabled, and
authorization during installation disabled. Enable expiring user access tokens.
The registration link preselects documented fields; verify the required switches
before live OAuth acceptance. The owner confirms installation on the personal
`cboone` account covering the intended selected repositories and generation of
the installation-required App private key. The downloaded PEM is handled outside
the repository and Netlify. This is owner-confirmed setup; live installation and
repository-access verification subsequently passed through the sanitized public
and private source checks recorded below. Board authorization remains a separate
sign-in operation after deployment. Board's server uses user tokens and does not
accept that key or a webhook secret as runtime configuration.

The App identifiers and Client Secret are installed in Netlify's production
context. Metadata confirms `GITHUB_APP_CLIENT_SECRET` is secret, has scopes
`builds`, `functions`, and `runtime`, and has one production value with no
development, branch-deploy, or deploy-preview records. Production-only context
normalization completed and preserved the existing production value. Future
Client Secret changes belong directly in
[the site's environment settings](https://app.netlify.com/projects/tracker-boards/configuration/env).
Do not send its value in chat. Set no all-context, preview, branch, or
development value. The existing Personal plan supplies production values to both
trusted production builds and Functions; build scripts never read or export
those values.

Source:
[GitHub's prefilled registration documentation](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-using-url-parameters).

## Production environment

The following initial settings are installed and independently verified in
production context only. Secret verification uses metadata without reading or
publishing values. Netlify's runtime override belongs in its UI/API environment
configuration rather than TOML; a configured override does not establish a
deployed runtime.

| Variable                     | Value or handling                     |
| ---------------------------- | ------------------------------------- |
| `BOARD_APP_ORIGIN`           | `https://tracker-boards.netlify.app`  |
| `BOARD_OWNER_ID`             | `99961`                               |
| `GITHUB_APP_ID`              | `4995264`                             |
| `GITHUB_APP_CLIENT_ID`       | `Iv23liQyjqNGXrULGeSB`                |
| `GITHUB_APP_CLIENT_SECRET`   | Installed as a production-only secret |
| `BOARD_TOKEN_KEY_ID`         | `2026-09-18`                          |
| `BOARD_TOKEN_ENCRYPTION_KEY` | Fresh 32-byte base64 secret           |
| `AWS_LAMBDA_JS_RUNTIME`      | `nodejs24.x`                          |

The token-encryption key was cryptographically generated during initial setup.
Optional `BOARD_PREVIOUS_TOKEN_KEY_ID` and `BOARD_PREVIOUS_TOKEN_ENCRYPTION_KEY`
support future key rotation; leave both absent for initial setup. Never give
secrets `VITE_` names, put values in shell arguments, print them, or save them
in project files. No Anthropic key is required for the
authentication/source-check phase currently deployed. Its production bundle
manifest contains one native `api` Function using `nodejs24.x`, runtime API
version 2, and `/api/*`. Live anonymous API and OAuth transaction storage checks
pass. Owner sign-in, actual installation/source grants for one eligible public
repository and one eligible private repository, and sign-out pass. Disabled
device flow and expiring user-token behavior remain covered by configuration and
automated checks. App installation and private-key handling are owner-confirmed.

## Phase 3 production composition

The active Phase 3 production build stages exactly two native Netlify Functions:

| Function     | Role                                 |
| ------------ | ------------------------------------ |
| `api`        | Synchronous authenticated API routes |
| `report-job` | Native background analysis           |

The background Function exports `config.background: true`; it does not use an
Edge Function or an `/api/*` rewrite. Its default endpoint is
`/.netlify/functions/report-job`. Both Functions require production context, the
canonical production request origin, and a currently published deployment before
reading secret configuration or opening the site-wide application stores. The
production server package targets Node.js 24.

Production data is isolated by purpose:

| Blob store      | Contents                                                  |
| --------------- | --------------------------------------------------------- |
| `board-auth`    | OAuth transactions, sessions, and encrypted owner tokens  |
| `board-reports` | Repository state and immutable successful report versions |
| `board-jobs`    | Durable analysis jobs and publication state               |
| `board-spend`   | Setup and future production spending ledgers              |

The production build installs the independent server package and stages the two
Functions plus their server and shared-domain modules. Every missing, unknown,
deploy-preview, and branch-deploy context produces the fixture build instead.
Those artifacts contain zero Functions, zero Edge Functions, no server package,
no service credentials, no token-encryption keys, and no production data.

## Anthropic and spending configuration

Phase 3 introduces one server-only secret, `ANTHROPIC_API_KEY`. Install it in
Netlify only after the reviewed pre-key gates pass, with production context and
the available server/function scopes. The current account can expose a
production-context value to its trusted production build, so build code must
never read or export it. Do not create `development`, `branch-deploy`,
`deploy-preview`, or all-context values. Never give it a `VITE_` name, expose it
to the frontend, place it in a command argument, print it, download it for
inspection, or record its value here. Only the guarded background Function reads
it when handling an authorized analysis job.

The implemented setup policy fixes model `claude-opus-5`, high effort, global
inference, and standard service. Its ledger admits at most two attempts for an
operation, reserves against a
$25 total setup cap, and requires an explicit
discussion decision before a new reservation would bring total exposure to at
least $20.
Calibration and acceptance calls, including any authorized corrective attempt,
share this setup budget.

`REVIEWED_SETUP_PRICING_ATTESTATIONS` is an append-only registry of exact,
code-reviewed setup pricing attestations. Only its last entry may admit new
work. Each immutable policy ID hashes that exact attestation together with the
deploy ID. Stored historical policies remain valid only while their exact
attestation entry remains in the registry; arbitrary stored rates, dates, and
feature facts are rejected. Current admission also verifies that the last
entry's rates and computed attempt ceiling match the fixed setup constants. A
new exact pricing attestation requires an appended reviewed registry entry that
retains referenced historical entries, or another explicit versioned migration.
Model, feature, and schema changes require an explicit migration and otherwise
fail closed.

On an ordinary deploy rollover, `ensureSetupSpendLedger` strongly reads the
shared `setup/v1` lifetime ledger and conditionally adds and selects the new
deploy-bound policy. It preserves earlier policies and their discussion
decisions, active reservations and unknown exposure, settled cost, accounting
sequence, and accounting digest. Nonpaid reads and accounting may reconcile
prior-deploy reservations. Browser summaries, owner decisions, and new
reservations require the exact current active policy. A lost activation
acknowledgement is resolved by strong read without repeating policy or monetary
accounting changes. The 16-policy limit fails closed.

Collection and counting use committed 90,000 ms and 60,000 ms durable windows.
Authentication, token refresh, and prior-report retrieval consume the collection
window. The worker strongly rereads the job and proves the same live collecting
token before any GitHub request. GitHub, model-metadata, and token counting
operations receive only the time remaining before their current
`stateDeadlineAt` and the provider cutoff. An expired worker cannot adopt a
replacement lease; reconciliation owns expiry finalization.

This setup policy does not authorize ordinary production paid usage. That mode
remains disabled until measured calibration evidence supports a separate user
decision for the monthly cap, per-report maximum including retries, and any
other production limits. The selected production policy must then be versioned,
implemented, reviewed, and deployed before ordinary paid report generation is
enabled. Additional Netlify credits do not change the Anthropic authorization.

## Report persistence and retention

`board-reports` stores one repository-state record plus immutable successful
version objects. Repository state has separate `current` and `previous`
pointers. A successful generation or refresh rotates those logical pointers;
failed, ambiguous, budget-blocked, and superseded attempts leave them unchanged.
The authenticated report route returns browser-safe metadata for both pointers
but includes report, inventory, comparison, source, and analysis content only
for the current envelope.

When the former-previous version key is non-null, the job records it as
`cleanupCandidateKey` before attempting the pointer rotation. The field is inert
retention metadata. Phase 3 does not scan or delete that object. After the
rotation displaces it, the immutable version remains physically stored outside
the logical current/previous history and cannot be listed or read through the
initial browser API. There is no report history or report deletion API in this
release. Raw GitHub/file inputs, prompts, provider output, and credentials
remain transient and are not written to these stores.

## Phase 3 pre-PR documentation checklist

Complete this checklist against the exact proposed PR head:

- [ ] README behavior matches the implemented Generate, Refresh, freshness, and
      source-unavailable flows without describing Phase 3 as live.
- [ ] The report contract matches the current envelope projection, the durable
      current/previous pointers, and the absence of history and deletion APIs.
- [ ] This guide matches the authored production composition with two Functions,
      four store names, runtime version, routes, and fixture-only build
      boundary.
- [ ] Every required environment variable is named without a secret value, and
      `ANTHROPIC_API_KEY` is documented only for production server use.
- [ ] Setup limits and future production-policy decisions are clearly separate;
      no paid calibration or ordinary production authorization is implied.
- [ ] Deploy rollover preserves lifetime setup accounting and prior-policy
      reconciliation while current admission uses the last exact reviewed
      pricing attestation and the current deploy-bound policy.
- [ ] Collection and counting use only the remaining committed durable lease
      window, and expiry finalization belongs to reconciliation.
- [ ] Verification records label mocked, local, deployed free, and deployed paid
      evidence separately and name exact commits/deployments only when observed.
- [ ] Scoped Prettier checks, the repository format check, and Markdown
      link/path checks pass for the proposed documentation.

## Deployment dependencies and evidence

The owner confirmed the actual shared balance in
[Netlify billing](https://app.netlify.com/teams/cboone/billing/general) on
September 18, 2026: 863.7 of 1,000 credits remaining, expiring September
23, 2026. This satisfies the initial deployment-balance check; it is dated
evidence rather than a promise of the balance available at a later deployment.
The account has 1,000 monthly credits with automatic top-up disabled, but the
undocumented API counters do not establish its current spendable balance. No
purchase, recharge, upgrade, migration, or automatic top-up change is implied.

For the deployed Phase 2 merge, live verification passes for `/`, `/demo`, and a
protected deep link with CSP and security headers; an anonymous no-store
session; no-store 401 responses for repository, check, and logout routes without
a session; live encrypted OAuth transaction storage and PKCE redirect; a
sanitized invalid callback with cookie clearing; and 403 rejection of the
immutable deployment origin. These are anonymous Phase 2 checks and do not
establish an authorized source snapshot.

The Phase 2 manual fixture draft `6aadcd18b83e9e153b9c7bbf` is independently
reported ready in `deploy-preview` context with an explicit provider inventory
of zero Functions. Its welcome and `/demo` routes serve fixtures with CSP, and
`/api/session` serves the fixture-only JSON `404`. The fresh isolated staging
directory contained no Edge Functions. On September 18, 2026, the owner
confirmed that the Netlify deploy summary reported `Edge Functions: 0` for the
acceptance preview.

The Phase 2 final PR #22 preview `6aaddaf81b0a15000836bc03` is independently
reported ready in `deploy-preview` context from reviewed signed head
`ef3934d41977807a2e6b3a763cc1c02ac5c5d83e`, with an explicit provider inventory
of zero Functions. Its fixture/CSP and static API JSON `404` checks pass. This
verifies repository-linked preview composition separately from the manual draft.

Phase 2 live acceptance on September 18, 2026, records the owner's results:
public repository pass; private repository pass; sign-out pass; Netlify deploy
summary `Edge Functions: 0`. Owner sign-in had already passed in the same
acceptance run. The committed production context selects
`npm run build:production`; every other context produces fixtures. Keep the
Netlify GitHub App limited to the required repository access. Avoid the CLI's
legacy deploy-key/webhook registration flow. These results do not establish a
Phase 3 deployment or paid Anthropic call.

Public evidence records private acceptance pass/fail without private
identifiers, counts, source tips, issue titles, or screenshots. Keep mocked
checks distinct from live checks. Subsequent documentation-only commits do not
change the deployed implementation; production evidence names its exact source
commit.
