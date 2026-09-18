# Board production setup

The production site is
[tracker-boards.netlify.app](https://tracker-boards.netlify.app), site ID
`9ddf762e-9c92-44da-8636-e03913200664`, in the owned `cboone` Netlify account.
The reviewed authentication/source-check composition is deployed from signed
commit `9295a3a169f0294f475e0fad2da7f6e45bf80101`, deploy ID
`6aadcfbcf08a71c73059a8be`. The site API independently reports that deployment
ready in production context with one Function. The project is connected through
Netlify's GitHub provider to `cboone/board`, production branch `main`, build
`npm run build`, and publish directory `dist`. Live owner sign-in and
public/private source acceptance remain pending.
No custom domain or self-hosting guide is required for this release.

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
repository-access verification have not run. Board authorization remains a
separate sign-in operation after deployment. Board's server uses user tokens and
does not accept that key or a webhook secret as runtime configuration.

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
authentication/source-check phase. The production bundle manifest contains one
native `api` function using `nodejs24.x`, runtime API version 2, and `/api/*`.
Live anonymous API and OAuth transaction storage checks pass. Owner sign-in,
disabled device flow, expiring user-token behavior, and actual
installation/source grants remain live verification checks. App installation
and private-key handling are owner-confirmed.

## Deployment dependencies and evidence

The owner confirmed the actual shared balance in
[Netlify billing](https://app.netlify.com/teams/cboone/billing/general) on
September 18, 2026: 863.7 of 1,000 credits remaining, expiring September
23, 2026. This satisfies the initial deployment-balance check; it is dated
evidence rather than a promise of the balance available at a later deployment.
The account has 1,000 monthly credits with automatic top-up disabled, but the
undocumented API counters do not establish its current spendable balance. No
purchase, recharge, upgrade, migration, or automatic top-up change is implied.

Live verification passes for `/`, `/demo`, and a protected deep link with CSP
and security headers; an anonymous no-store session; no-store 401 responses for
repository, check, and logout routes without a session; live encrypted OAuth
transaction storage and PKCE redirect; a sanitized invalid callback with cookie
clearing; and 403 rejection of the immutable deployment origin. These are
anonymous checks and do not establish an authorized source snapshot.

Manual fixture draft `6aadcd18b83e9e153b9c7bbf` is independently reported
ready in `deploy-preview` context with an explicit provider inventory of zero
Functions. Its welcome and `/demo` routes serve fixtures with CSP, and
`/api/session` serves the fixture-only JSON `404`. The fresh isolated staging
directory contained no Edge Functions, but provider edge inventory still
requires confirmation from the per-deploy summary.

Automatic PR #22 preview `6aadce8caab4cf000879539c` is independently reported
ready in `deploy-preview` context from commit
`221f4d1fae02b096ebfa7416f01bf4c4bfcf1563`, with an explicit provider
inventory of zero Functions. Its fixture/CSP and static API JSON `404` checks
pass. This verifies repository-linked preview composition separately from the
manual draft.

Verify actual owner sign-in and an eligible public/private source check. Confirm
the provider summary's zero Edge Functions count. The committed production
context selects `npm run build:production`; every other context produces
fixtures. Keep the Netlify GitHub App limited to the required repository access.
Avoid the CLI's legacy deploy-key/webhook registration flow.

Public evidence records private acceptance pass/fail without private identifiers,
counts, source tips, issue titles, or screenshots. Keep mocked checks distinct
from live checks. Subsequent documentation-only commits do not change the
deployed implementation; production evidence names its exact source commit.
