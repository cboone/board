# Analysis, report persistence, and refresh

Date: 2026-09-18

Status: implementation active in the `feature/report-generation` worktree. The
source contract, fixed provider client, report/job/spend stores, analysis
worker, authenticated API and browser flows, a production composition with two
Functions, and mocked coverage are implemented for review. Documentation, final
local verification, independent review resolution, PR delivery, deployment, key
setup, paid calibration, and the ordinary production spending-policy decision
remain. The reviewed planning baseline
`314f598db6044fafeed5e27c8427690a9f7c7382` had no material planning blocker. No
Anthropic credential has been read, no provider request has been made, and
recorded Anthropic setup spend remains $0.

## Outcome and authority

An authenticated authorized owner can open a stable page for an eligible
`cboone/*` repository, view its last successful backlog report across browsers
and devices, and explicitly generate or refresh that report. Opening a saved
report automatically performs a free GitHub source check. It never starts paid
analysis. A successful analysis publishes a complete, inventory-bound report; an
incomplete source, rejected model response, failed refresh, ambiguous provider
outcome, or concurrent stale job leaves the last successful report unchanged.

The [original project prompt](../project-prompt.md), the original
`publish-report-board` skill and backlog-triage reference at version `1.0.0`,
confirmed user answers, and project instructions control this phase. The
[product roadmap](2026-09-18-board-product-roadmap.md) is the current
interpretation. This plan must be corrected when it conflicts with those
sources.

The controlling product decisions are:

- Authorize only GitHub user ID `99961`, currently `cboone`, and eligible
  personally owned, nonfork, nonarchived `cboone/*` repositories.
- Support eligible public and private repositories. Every real report requires
  owner authentication, including a report for a public repository.
- Use the app-managed Anthropic key, fixed model `claude-opus-5`, and `high`
  effort. There is no provider or model selector.
- Spend at most
  $25 total on setup, calibration, retries, and acceptance. Stop
  for discussion before another dispatch would bring settled, reserved, and
  unknown setup exposure to $20
  or more.
- Do not infer a production monthly cap or maximum cost per report. Measure
  calibration and acceptance calls, present a concrete policy proposal, obtain
  the user's decision, and deploy that policy before ordinary paid production
  use.
- A repository with no saved report opens without a paid call and shows
  **Generate report**. A saved board opens with its report and automatically
  checks GitHub for changes, while paid reanalysis requires an explicit
  **Refresh report** action.
- Expose the current and previous successful report pointers per repository.
  Return only current-envelope content through the initial report API. Raw
  source inputs and provider request/output remain transient. Displaced
  immutable versions remain physically stored outside the logical
  current/previous history; `cleanupCandidateKey` is inert retention metadata.
  Sign-out preserves saved reports. History and report deletion APIs are
  deferred.
- Keep a saved report available when its source becomes archived, transferred,
  deleted, or inaccessible. Mark it historical/source-unavailable and disable
  new analysis until the source is eligible and accessible again.
- Assignment alone is not progress. Only a related pull request, an unmerged
  remote branch, or an explicit in-progress label establishes progress.
- Retain unclear issues and unverified external blockers as uncertainty,
  suppress affected start recommendations, and complete the rest of a valid
  report.

## Baseline and phase boundary

The Phase 3 worktree and branch start from verified Phase 2 merge commit
`370c257c49c09492426b4d8df24d37240884e908`. Automatic production deploy
`6aaddca5bf99630008491b49` is ready from that exact merge, the protected GitHub
flow remains live, and owner acceptance passed for public source, private
source, sign-out, and zero Edge Functions. Issue #16 is closed as completed.

Phase 2 supplies these reviewed boundaries:

- Production-only native Netlify Functions guarded by production context,
  canonical origin, and strict environment validation. Phase 2 omitted an
  explicit published-deploy runtime guard; the active Phase 3 Functions add it
  before secret configuration or site-wide application stores are opened.
- Owner-only GitHub OAuth sessions, CSRF protection, encrypted renewable tokens,
  and source authorization that remains separate from Board authentication.
- Eligible repository listing and a two-observation source collector with
  complete core pagination, bounded comments/tree/files, canonical source
  fingerprinting, and transient `sourceSnapshot` output.
- A strong-read, conditional-write Netlify Blobs adapter with bounded transport
  behavior and no hidden provider retry.
- Static fixture-only Deploy Previews and branch deploys with zero Functions,
  zero server packages in the deployed artifact, zero credentials, and no
  production-store access.
- A shared inventory-bound report validator, lane model, renderer, safe source
  links, and complete/empty/uncertain fixtures.

Phase 3 implements analysis, report/job/spend persistence, source freshness, and
Generate/Refresh behavior. Its active implementation remains undeployed and
uncalibrated. Phase 4 retains final hosted-user guidance, operational recovery
documentation, remaining issue reconciliation, and final whole-product
acceptance unless those artifacts are required to use or validate Phase 3
safely.

The active implementation keeps native `fetch` and adds no Anthropic SDK.
`@netlify/blobs` remains the only server runtime package.

## Architecture and trust boundaries

The active implementation uses a synchronous authenticated admission endpoint
and a native Netlify background Function. Admission creates an inert durable
job, claims the repository's one active-analysis slot, reserves its full
authorized exposure, and dispatches only a job ID plus a random capability. The
background function gathers GitHub data in memory, performs free token
admission, crosses a durable at-most-once paid boundary, validates the result,
writes an immutable successful report version, and conditionally rotates the
repository pointer.

The worker is `server/functions/report-job.mjs` with an explicit
`config.background: true` export, following Netlify's current
[Background Functions guidance](https://docs.netlify.com/build/functions/background-functions/).
Invoke its default `/.netlify/functions/report-job` endpoint directly; do not
route it through `/api/*` or use the legacy filename suffix.

The browser polls Board state. A Netlify background response is only dispatch
evidence because the platform returns an empty `202` before work completes.
Netlify may deliver the same background invocation again after failure or
termination. Every invocation must claim the durable job before work, and only
the invocation that proves ownership of the paid-attempt token may call
Anthropic.

Use Netlify Blobs strong reads and conditional writes as single-object
compare-and-swap. Blobs does not provide multi-object transactions. Order
cross-key changes so interruption can strand an inert job or conservative
reservation but cannot spend without a reservation, publish an unvalidated
report, replay an ambiguous paid request, or overwrite a newer report. Every
repair path is idempotent and must avoid another Anthropic request.

Keep four data classes separate:

1. Authentication records remain in the existing `board-auth` store.
2. Repository state and immutable successful report versions use a
   `board-reports` store.
3. Analysis jobs use a `board-jobs` store.
4. Setup and later production spending ledgers use a `board-spend` store.

Every store adapter validates an explicit key grammar, requests strong reads,
requires `onlyIfNew` or `onlyIfMatch` writes, bounds transport size and
duration, and exposes no unguarded production singleton during module
evaluation. Preview and branch artifacts contain no adapter or function bundle.

## Source collection prerequisite and analysis input

Add canonical issue `createdAt` and bounded canonical assignee IDs/logins to
both matched GitHub observations, the transient source snapshot, saved inventory
metadata, and the canonical fingerprint. Each issue always has an ID-sorted
assignee array, including an empty one; reject duplicate IDs and conflicting
ID/login facts and retain no other profile data. The original report uses issue
age to break otherwise equal starts; do not infer age from an issue number or
prose. Assignment changes freshness and remains visible source metadata, but it
never establishes progress or affects start eligibility. A mismatch in either
new field between observations makes the source unstable like any other
authoritative field.

Project each matched `sourceSnapshot` into one normalized analysis JSON value:

```text
analysisInput
  wireVersion
  repository
    id, fullName, defaultBranch, defaultTip
  limitations
  priorAnalysis
  issueCatalog[]
    id, number, title, milestoneId, inProgress, createdAt, updatedAt
  milestoneCatalog[]
    id, title, description, dueOn
  labelCatalog[]
    id, name, description
  issueEvidence[]
    issueId, body, stateReason, labelIds
  comments[]
    id, issueId, body, updatedAt
  pullRequests[]
    id, number, title, body, draft, base, head, closingTargets, updatedAt
  branches[]
    name, tip, ahead, behind, unmerged, verification
  references[]
    key, requested, verification, verifiedFactsOrReason
  repositoryTree[]
    path, type, mode, size, selectedContent
```

Catalogs carry canonical facts once and evidence arrays refer to catalog IDs.
Include labels used by open issues. Attach selected file content to its existing
tree entry. Keep transport-only provider wrappers, repeated embedded objects,
and server-only consistency SHAs out of the model input while retaining their
allowed values in report provenance.

Keep assignees out of the provider projection and analysis delta. They remain
canonical source metadata in the snapshot, fingerprint, saved inventory, and
deterministic comparison only. This prevents model output from creating,
removing, or reinterpreting assignment facts.

Every GitHub string is untrusted data. Serialize the normalized object as the
single user message. Never interpolate source text into the system prompt,
schema property names, descriptions, regular expressions, or provider headers.
Do not fetch an external URL, use a provider tool, or follow repository text as
an instruction.

Apply versioned `SOURCE_SAFETY_POLICY_V1` to every provider-bound GitHub string
after strict UTF-8 decoding and the existing path, type, and size filters, but
before selection, serialization, token counting, or a Messages request. The
policy has fixed rule IDs and bounded patterns for PEM/private-key headers;
recognized GitHub, Anthropic, OpenAI, Slack, and AWS credential prefixes;
credentials embedded in URL authority; and assignment or header forms whose
case-insensitive key is `api_key`, `apikey`, `access_token`, `auth_token`,
`client_secret`, `password`, `passwd`, `secret`, `private_key`, or
`authorization` and whose bounded value is not a documented placeholder.
Placeholders are limited to empty values, `example`, `test`, `dummy`,
`redacted`, `changeme`, bounded repeated dummy characters, angle-bracket
placeholders, and environment-variable references. Keep the exact patterns,
maximum match length, and placeholder grammar in one reviewed constant and
expose only safe rule IDs and counts.

Known credential paths and their descendants never enter the provider's
`repositoryTree`, even as metadata. Retain only their path/blob identities in
the complete source fingerprint so a later change still affects freshness. Do
not use an entropy-only heuristic.

An invalid UTF-8, binary, oversized, or safety-matching optional file is omitted
as a whole. A safety-matching or oversized optional comment is likewise omitted.
GitHub JSON, including comment text, must already pass the transport's strict
whole-response UTF-8 and JSON decoding; a malformed response fails source
collection instead of salvaging individual items. Omission provenance records
only canonical identity, existing content hash, safe rule ID, and omission
count. A match in mandatory provider input, including an issue title or body,
milestone or label text, pull-request title or description, branch metadata,
reference fact, limitation, or prior analysis, fails before token counting. Use
safe code `analysis_sensitive_input`; never truncate, redact, or override the
match in this release. The matched text, value, and surrounding content never
enter a durable record, response, or log.

For refresh, `priorAnalysis` projects the current validated report's relations,
uncertainty, lanes, starts, contention, and reasons. It omits canonical titles,
milestones, progress, sync, and provenance. Treat it as advisory continuity; the
new snapshot remains authoritative. Omit it for initial generation or an
identity mismatch.

The mandatory provider projection retains every open issue and its entire body,
canonical title, milestone, labels, progress, and dates; complete admitted
milestone, label, PR, remote-branch, verified-reference, and tree metadata; the
repository identity and sync facts; collection limitations; and allowed prior
analysis. Never remove, summarize, or truncate an open issue. If this mandatory
projection or its structural output floor exceeds a bound, fail before a paid
call.

Only issue comments and selected file contents are optional provider context.
Build one deterministic candidate prefix. Sort issues by number ascending; sort
each issue's comments by `updatedAt` descending and numeric ID ascending; then
take one comment from each nonempty issue in that issue order on every
round-robin pass. Classify files in this priority order: a repository-relative
path explicitly named by issue or comment text through the versioned path
extractor; repository guidance (`README*`, `AGENTS.md`, then `CLAUDE.md`);
package, build, and test configuration recognized by the existing `CONFIG_FILE`
policy; then every remaining Phase 2 selected path. Sort ties with
`compareSourceKeys(path)`. Preserve the class in transient collection metadata
or recompute it from the matched snapshot with the same versioned extractor.
Replace the collector's global path-sort admission with this class order before
its selected-file count and byte limits, so referenced and guidance files can
enter the bounded fetched set.

Interleave one comment first, then one file, repeating while both classes have
candidates; when one is exhausted, append the other in its existing order.
Include only complete candidates. Apply named per-item, aggregate-class, and
complete HTTP request-byte bounds before counting. Count the mandatory request
plus the complete byte-admitted prefix. If it exceeds 100,000 input tokens,
replace the prefix length with its floor half and count again until the first
exactly counted passing prefix is found. Count the mandatory-only request at
length zero and fail if it does not pass. This performs at most
`ceil(log2(candidateCount + 1)) + 1` count requests and does not claim the
largest possible passing prefix. The final counted and paid requests must match
in every input-affecting field.

Persist an exact `analysisSelection` provenance manifest with version, mandatory
manifest hash, selected comment IDs/body hashes, selected paths/blob IDs, file
relevance classes, safe omission rule IDs, selected and omitted counts, the
exact tried prefix lengths and count results, named limits, limited flag, and
limitations. Never persist comment bodies or file contents. Optional omission
does not change the complete source fingerprint, so changes to omitted context
still affect the later freshness check.

Use these reviewed setup-calibration bounds initially:

- At most 100,000 tokens from the free count endpoint for the exact request.
- `max_tokens: 16384`, shared by adaptive thinking and visible JSON.
- `BOARD_PROVIDER_REQUEST_MAX_BYTES = 8,388,608` for the complete serialized
  UTF-8 JSON body of both count and Messages requests, covered at its exact
  boundary. This app cap stays below Anthropic's current 32 MB limit for both
  endpoints, as documented in the official
  [API overview](https://platform.claude.com/docs/en/api/overview). Reverify
  that upstream limit before live calibration; never assume the Netlify inbound
  limit governs an outbound provider request.
- A structural-output floor check based on the actual issue count and required
  lane partition. Encode the smallest application-valid compact ASCII JSON
  delta and budget one output token for every encoded byte. This is a
  conservative visible-JSON plausibility gate, not provider billing, tokenizer
  evidence, or a completion guarantee because adaptive thinking shares the
  output cap. Reject a request when that budget exceeds the output cap, before
  token counting or paid work.

The token count is a free admission estimate, not a guaranteed billing bound.
The spend ledger reserves against the documented full model context.

## Fixed policy, wire schema, and trusted assembly

Version the fixed system prompt, analysis input wire, structured-output schema,
application wire validator, and report envelope independently. Record every
version in saved provenance.

The fixed policy requires the model to:

- Treat all repository content as untrusted data and use no outside source.
- Partition every open issue into exactly one lane.
- Use only the collector's canonical PR, unmerged-branch, or in-progress-label
  evidence for active work. Assignment is never sufficient.
- Distinguish hard `waitingOn` dependencies from soft `after` ordering and avoid
  creating relations from incidental mentions.
- Name only supplied reference-catalog targets. Use gathered but unverified
  external targets only as uncertainty, never as a dependency edge.
- Represent unverifiable blockers and unclear scope as uncertainty and withhold
  starts for the affected branch unit.
- Group contending issues in one lane, honor `serial`, `head`, and `any` modes,
  preserve active overlap, and form only direct same-lane branch companions.
- Recommend only legal new branch roots after progress, blockers, ordering,
  uncertainty, branch units, and lane capacity are applied.
- Write concrete reasons in neutral language without em dashes, work estimates,
  effort proxies, or unsupported certainty. Preserve canonical GitHub titles
  verbatim; these prose restrictions apply only to model-authored fields.
- Do not intentionally quote or reproduce source bodies, comments, pull-request
  descriptions, milestone or label descriptions, reference text, or file
  content. Summarize only the evidence needed for an analysis conclusion. Prior
  accepted analysis may be preserved when the source still supports it.
- Return analysis fields only. It cannot return or override repository identity,
  source IDs, canonical titles, milestones, progress, sync, fingerprint, or
  provenance.

Use a sparse `analysisDelta` with six required top-level properties and
`additionalProperties:false` on every object:

```text
analysisDelta
  summary: string
  issueAnalysis: IssueAnalysis[]
  lanes: Lane[]
  startNow: Pick[]
  contention: Contention
  notes: Notes

IssueAnalysis
  issue: integer
  short: string
  waitingOn: Reference[]
  blockedBecause: string
  after: Reference[]
  sameBranchAs: integer
  uncertaintyReason: string
  uncertaintyReference: Reference

Reference
  kind: "none" | "issue" | "pr" | "branch" | "ref" | "url"
  target: string
  label: string
  title: string

Lane
  key: string
  name: string
  mode: "serial" | "head" | "any"
  issues: integer[]
  owns: string
  note: string

Pick
  issue: integer
  why: string
  touches: string

Contention
  rowLabel: string
  claims: Claim[]

Claim
  name: string
  query: string
  issues: integer[]

Notes
  startNow: string
  blocked: string
  contention: string
```

All properties are required to stay within provider grammar limits. Empty
strings, empty arrays, `sameBranchAs:0`, `kind:"none"`, and an empty claim
`query` are wire sentinels; the strict application validator controls where they
are legal. Use only local, nonrecursive schema definitions. Keep `issueAnalysis`
sparse; every issue still appears once in `lanes[].issues`.

The application validator applies tighter field, count, prose, reference, and
sentinel limits than the provider schema. The trusted assembler then:

1. Accepts only a complete terminal response from exactly `claude-opus-5` with
   valid usage and one structured text result.
2. Rejects refusal, truncation, interruption, model mismatch, malformed JSON,
   duplicate or unknown issue IDs, invalid sentinels, and over-limit output.
3. Source-binds every decoded relation to the matched snapshot. Local issues,
   PRs, and branches must match canonical inventory entries. A cross-repository
   reference or URL must exactly match a gathered `references[]` key, requested
   value, and normalized target. An invented or altered target is invalid.
   Closed, merged, integrated, absent, or unverified targets cannot become hard
   or soft dependencies. A gathered but unverified external target may appear
   only as uncertainty with its trusted verification reason.
4. Starts from the trusted inventory's report identity, sync, and issue records.
   It merges only allowed analysis fields into canonical issues.
5. Translates wire references, removes explicit sentinels, and copies allowed
   lanes, starts, contention, and prose without semantic repair. A nonempty
   claim query is validated and copied as the exact rendered search; an empty
   query becomes the report contract's absent value. Comparison uses the
   renderer's effective search, `claim.query || "is:open " + claim.name`, so an
   absent query and an explicit default are reader-equivalent. Rejects model
   prose containing prohibited em dashes or estimate patterns and applies
   bounded string/count checks; human quality acceptance still evaluates
   concreteness and neutral wording that deterministic checks cannot prove.
6. Runs `validateReport(report, inventory)`, then `deriveReport(report)`, and
   verifies that the derived display/count state is safe for the renderer.
7. Binds the candidate to the exact source fingerprint and job generation that
   produced it. A later source check cannot relabel the analysis as newer.

Validation failure is an analysis failure. It never produces a partial report.

Before trusted assembly, apply `NO_VERBATIM_POLICY_V1` to every model-authored
persisted prose field. Build its transient corpus only from admitted issue
bodies, comments, pull-request descriptions, milestone and label descriptions,
reference text, and selected file content. Previously validated and persisted
prior-analysis prose is not raw source and stays outside this corpus so an
unchanged refresh can preserve it and compare as `unchanged`.

Normalization is ordered and fixed to the pinned Node 24.13.0 runtime's Unicode
16.0 behavior. First replace CRLF and lone CR with LF, apply `normalize('NFC')`,
then apply ECMAScript `toLowerCase()` without a locale. For line matching, split
on LF before replacing each run of remaining Unicode `White_Space` characters
with one ASCII space and trimming the line. For full-field and window matching,
replace every Unicode `White_Space` run, including LF, with one ASCII space and
trim. Count Unicode code points with string iteration, not UTF-16 code units.

Reject when any nonempty normalized model prose field exactly equals any
complete normalized raw-source field, when it contains a normalized source line
of at least 32 code points, or when it contains a contiguous normalized source
window of 64 code points. The deterministic validator permits shorter incidental
overlap that is neither a complete-field equality nor long enough for those
thresholds; the system policy still forbids intentional quoting. Implement
line/window matching with bounded hashes over already bounded inputs, then
confirm every hash match by exact normalized comparison. Canonical source fields
inserted by the server, including titles and display identities, are not model
prose and are outside this corpus check. Apply `SOURCE_SAFETY_POLICY_V1` to
model output as well, regardless of match length. A violation is a strict
output-validation failure; no raw match enters its safe error, job, report
version, or log.

## Provider transport and paid-attempt policy

Use server-side native HTTP with `redirect:'error'`. Read `ANTHROPIC_API_KEY`
only after all production runtime guards pass. Send `x-api-key`,
`anthropic-version: 2023-06-01`, and JSON content type to the exact Anthropic
API origin. Configure no SDK or HTTP automatic retry.

The primary Messages request is fixed to:

```javascript
{
  model: 'claude-opus-5',
  max_tokens: 16384,
  inference_geo: 'global',
  service_tier: 'standard_only',
  thinking: { type: 'adaptive', display: 'omitted' },
  output_config: {
    effort: 'high',
    format: { type: 'json_schema', schema: ANALYSIS_DELTA_SCHEMA },
  },
  system: FIXED_BACKLOG_ANALYSIS_POLICY,
  messages: [{ role: 'user', content: JSON.stringify(analysisInput) }],
  stream: true,
}
```

Omit tools, citations, prompt caching, premium speed, US-only inference,
sampling controls, message prefilling, model fallback, and any beta feature not
required by the reviewed request. Pin every paid request to global inference and
standard-only service so workspace defaults cannot select a priced geography or
priority tier. Send the same model, system, message, thinking, effort, and
output schema to the free token-count endpoint; the count request omits billing
controls that its endpoint does not accept.

Implement a bounded streaming-event parser. Bound response bytes, event count,
line length, JSON depth, and elapsed runtime. Retain validated input and cache
usage plus effective inference geography and service tier from `message_start`;
replace output usage with the latest cumulative `message_delta` values; and
require a final `message_stop`. Never add cumulative deltas. Missing,
decreasing, contradictory, or incomplete final usage or billing classification
makes the attempt financially unknown and retains its full reservation. Select
content by block type and never persist thinking blocks, signatures, SSE frames,
raw model JSON, the provider request, or provider error bodies. From invocation
start, stop provider work at 810,000 ms and reserve the final 90,000 ms of
Netlify's 15-minute limit for durable classification and bookkeeping. Bound
complete source collection to 90,000 ms, all count requests together to 60,000
ms, and each Messages attempt to 300,000 ms or the earlier provider cutoff.
Cross a paid boundary only when its full configured attempt window and the
finalization margin remain. If a correction cannot start within that rule,
release its never-dispatched reservation and fail with the primary's safe
validation code. Abort a live stream at its attempt deadline and durably
classify the outcome as ambiguous within the remaining margin when execution
remains available.

The 90,000 ms collection and 60,000 ms counting limits are maximum durable state
windows. Authentication, token refresh, prior-report retrieval, and every other
operation in a state consume its committed `stateDeadlineAt` window. Every
downstream signal and operation budget uses only the time remaining before the
earlier of that durable deadline and the provider cutoff.

Allow at most one corrective attempt during setup calibration. Reserve both
attempt ceilings atomically before the first dispatch. A corrective attempt is
permitted only in the same worker invocation after a definitive, billed,
terminal first response fails the strict wire or report-domain validator and the
exact corrective request passes token admission. It uses the same fixed model,
effort, output cap, source input, and a bounded machine-readable list of
validation errors. It may use the first delta transiently, but persists neither
delta. Do not retry refusals, `max_tokens`, model mismatch, rate limits,
provider/server errors, transport interruption, source instability, or any
ambiguous result. A worker restart never reconstructs or replays the corrective
attempt.

Catch known worker failures, persist the appropriate terminal or ambiguous job
state, and return successfully so Netlify does not retry a known failure. Do not
assume hard termination or the platform's 15-minute limit produces another
delivery. A duplicate invocation that observes a paid-boundary state performs
only the nonpaid reconciliation described below and never calls the provider.

Before the first paid calibration request, use the configured credential to read
live metadata for exact model `claude-opus-5`. Require positive current limits
that support the reviewed context and output reservation. Separately verify
current official pricing and every billed feature used by the request. Append
that exact bounded-validity pricing attestation to the reviewed code registry
and use only its last entry for new admission. Bind each immutable setup policy
ID to that exact attestation plus the deploy ID. A missing, mismatched, or
expired current attestation disables paid dispatch and returns a sanitized
configuration error. Immediately before each paid-boundary CAS, strongly read
the exact active policy and reservation and require its reviewed validity window
to extend through the immutable provider cutoff. Every paid state deadline and
Messages abort signal remains at or before that cutoff, so pricing cannot expire
in the proof/CAS gap or during the request.

The model metadata endpoint does not attest pricing. Keep the manually verified
official rates, billed-feature exclusions, source URL, verification time, and
valid-through time in a reviewed immutable policy constant; compare that exact
constant with the durable policy and runtime deploy. Use model metadata only for
model identity and supported positive limits.

## Durable keys and schemas

All records are plain versioned JSON. Reject unknown required schema versions
instead of guessing. Timestamps are server-generated ISO 8601 UTC values;
monetary values are nonnegative safe integers in microdollars.

Define an exact recursive allowlist projector and strict validator for every
durable record and API response. Build saved values only through those
projectors and reject unknown properties on read. `validateReport` remains a
domain validator; it is not the raw-data retention boundary because it permits
unknown fields. Enforce serialized byte caps before every write and on every
read. Repository-state and analysis-job records each have an 8 KiB cap; their
maximum-width valid projections are 4,407 and 6,676 bytes respectively. The
immutable authenticated report envelope has a 5 MiB cap. Every JSON API route
uses a response-specific recursive projector, then rejects a buffered response
at or above 6 MiB.

### Repository state

Use `board-reports` key `owners/99961/repositories/<repository-id>/state`. The
validated record contains:

```text
schemaVersion
ownerId
repository
  id, fullName, name, private, url
revision
current
  reportId, versionKey, generatedAt, sourceFingerprint
previous
  reportId, versionKey, generatedAt, sourceFingerprint
activeJob
  jobId, operation, expectedCurrentReportId, admittedAt
sourceCheck
  sequence, startedAt, completedAt, status
  summary or sanitized errorCode
lastAnalysisAttempt
  jobId, operation, status, completedAt, sanitized errorCode
```

`current`, `previous`, `activeJob`, `sourceCheck`, and `lastAnalysisAttempt` are
nullable. The repository identity is the last trusted identity and lets an
authenticated owner discover a saved report without current GitHub access. Never
use the saved identity alone to authorize new analysis.

Starting a source check increments `sourceCheck.sequence` through CAS. Only the
matching sequence may publish its result. A complete check stores the safe Phase
2 source summary. A definitive inaccessible/ineligible result records
`source-unavailable`; transient failure records a sanitized failed check while
preserving the last successful report. An older check cannot overwrite a newer
one.

### Owner report catalog

Use strongly read `board-reports` key `owners/99961/catalog` as the bounded
discovery root. Its validated schema contains `schemaVersion`, `ownerId`,
`revision`, `membershipRevision`, `updatedAt`, and an ID-sorted `repositories[]`
array. Each entry contains only repository ID, last trusted display identity,
repository-state key, catalog-entry creation time, and safe current-report
summary metadata. Permit at most 1,000 entries and 1,048,576 serialized UTF-8
bytes, including the complete record. Validate both exact ceilings before each
conditional write and after each read.

Before initial Generate admission can reserve or dispatch paid work, CAS-upsert
the repository entry and resolve a lost write acknowledgement with a strong
read. Concurrent upserts merge by numeric repository ID and preserve every
existing entry; increment `membershipRevision` only when membership changes.
This release never deletes catalog membership. Therefore every publishable
report already has a discoverable root. At either catalog ceiling, a Generate
for an uncataloged repository fails with `report_catalog_full` before job
creation, repository claim, or spend reservation. Existing members may still
generate or refresh, and no current or historical report is deleted.

`GET /api/reports` pages over at most 50 catalog entries, strongly reads at most
those 50 repository states, filters entries without a current report, and
projects current state rather than trusting stale summary metadata. It repairs
at most five stale safe catalog summaries per request. A versioned base64url
cursor contains the validated membership revision/digest and last numeric
repository ID; it contains no authority or secret. Reject malformed cursors and
return `report_catalog_changed` when membership changed so the browser can
restart from page one. Summary-only repairs do not change the membership digest.
Return `nextCursor` after the last examined entry, including when a page
contains no saved reports. The browser deduplicates by repository ID and follows
at most 20 pages per pass; after one membership-change restart it stops after
another 20 pages and shows a retryable list error.

Publication and direct report reads idempotently repair a stale entry after
pointer rotation within the same five-repair request budget. If projected repair
would exceed the catalog byte cap, leave its summary stale and still return
state-derived data. Normal discovery never relies on Blob prefix listing; a
bounded operator audit may compare prefixes only as recovery evidence. Test
concurrent first reports, a lost catalog CAS acknowledgement, publication
interruption, later source deletion, direct-route repair, exact 1,000-entry and
1,048,576-byte limits, 50-entry pages, empty filtered pages, malformed and stale
cursors, a stale later-page entry, both browser pass bounds, and uncataloged
versus existing-member behavior at each ceiling.

### Successful report version

Use immutable `board-reports` key
`owners/99961/repositories/<repository-id>/versions/<report-id>`, written with
`onlyIfNew`. It contains:

```text
schemaVersion
reportId, jobId, ownerId
repositoryId
generatedAt
report
inventory
comparison
  schemaVersion, status
  basis
    reportId, generatedAt, sourceFingerprint, sync
  result
    reportId, generatedAt, sourceFingerprint, sync
  entries[]
    kind, issueNumber, laneKey, claimName, fields, before, after
source
  fingerprint, sync, counts, provenance
analysis
  model, effort
  promptVersion, schemaVersion, wireVersion, assemblerVersion
  pricingPolicyId
  attempts[]
    number, terminalClass, inputTokens, cacheCreationInputTokens
    cacheReadInputTokens, outputTokens, rates, inferenceGeo, serviceTier
    costMicrousd
```

The saved `report` and independent `inventory` contain canonical titles,
milestones, assignees, progress evidence, and derived analysis required for
rendering. Allowed provenance includes source identity, revisions, observation
timestamps, selected paths and blob IDs, reference verification counts, bounds,
and limitations. The version never contains bodies, comments, pull-request
descriptions, selected file content, the repository tree, prompts, hidden
thinking, raw provider output, provider error bodies, credentials, or tokens.

Compute a bounded, strictly validated `comparison` deterministically against the
current report admitted as the refresh basis. Port every reader-visible category
from the pinned original comparator: board identity where applicable; opened and
closed issues; title, displayed milestone, assignment, progress, hard blocker,
blocker reason, soft ordering, uncertainty, and branch-unit changes; lane
membership, addition, removal, mode, issue order, lane order, name, ownership,
and note; start membership, order, reason, and footprint; contention claim
membership, issue order, claim order, claim name, effective rendered claim
search, row label, and displayed milestone labels; summary, notes, and displayed
short titles. The trusted report stores every claim's `query`, using the report
contract's absent value after the empty wire sentinel. Initial generation has an
explicit `initial` comparison state, distinct from a refresh with no
reader-visible changes. Render this saved comparison separately from source
freshness so a later free check cannot rewrite what changed at analysis time.

Define comparison `kind` as a closed enum and validate kind-specific optional
fields and `before`/`after` shapes. Bound entry count, nested arrays, text,
depth, and serialized bytes. Sort by the pinned comparator's category order and
stable source order while preserving reader-visible order inside lanes, picks,
and claims. The three statuses are `initial`, `unchanged`, and `changed`; no
entries is not enough to conflate the first two.

Use the deterministic `reportId` and `versionKey` stored in the inert job.
Canonically serialize the exact projected envelope and compute
`candidateDigest`. Write with `onlyIfNew` while holding bounded finalization
ownership. A conflict or lost acknowledgement is success only when a strong read
validates the entire stored envelope and proves the same digest, owner,
repository, and job. Then CAS the token-owned job to `version-written` with the
digest. A missing version after finalization expires produces a paid, known-
usage failure; it never permits another provider request.

Publication first derives the displaced former-previous key from the strong
pre-rotation repository read. When that key is non-null, CAS it into the
`version-written` job before attempting pointer rotation. The value cannot be
overwritten, and `report-published` preserves the staged value instead of
accepting one from its caller. Publication then CAS-updates repository state
only when `activeJob.jobId` and `current.reportId` still equal the job's
admitted values. Rotation sets `previous` to the old `current` and `current` to
the new version. Resolve a lost pointer-CAS acknowledgement by strong read:
exact `current.reportId == reportId` and expected rotation is success; unchanged
admitted state may be retried within a bound; any different state fences the job
as superseded. A stale worker cannot replace a newer report. A reconciler can
resume publication from a validated immutable version and its durable retention
metadata without another paid call.

The displaced former-previous key is inert retention metadata. This release does
not automatically delete immutable report versions. The authenticated API and
browser expose exactly current and previous, while displaced physical versions
remain stored until an explicit retention and deletion policy is approved. Do
not scan or delete unreferenced versions.

### Analysis job

Validate a browser idempotency key as a UUID and derive a stable URL-safe global
job ID from a domain-separated SHA-256 digest of owner ID and that key. Use
`board-jobs` key `jobs/<job-id>`, created with `onlyIfNew`; repository,
operation, and expected report remain stored attributes, so reuse of the UUID
for another request is detectably an `idempotency_conflict`. The record contains
only coordination and audit facts. Derive `reportId` and `versionKey`
deterministically from the job ID and store them when this inert record is
created, before any paid boundary:

```text
schemaVersion, stateMachineVersion
jobId, ownerId, repositoryId
operation
expectedCurrentReportId
authorizationEpoch, admissionDeployId
createdAt, updatedAt
state, stateVersion, stateDeadlineAt
dispatchCapabilityHash
freeLease
  tokenHash, expiresAt
finalizationLease
  tokenHash, expiresAt
pricePolicyId
sourceFingerprint
attempts[]
  number, reservationMicrousd, state, tokenHash
  startedAt, deadlineAt, completedAt, terminalClass, terminalStopReason
  inputTokens, cacheCreationInputTokens, cacheReadInputTokens
  outputTokens, costMicrousd
publication
  reportId, versionKey, candidateDigest, basisReportId
  pointerRevision, publishedAt, cleanupCandidateKey
accounting
  status, ledgerRevision, accountingSequence, accountingDigest, transitionId
terminal
  status, completedAt, sanitized errorCode
```

Never store a raw dispatch or lease token. The synchronous route generates a
cryptographically random dispatch capability, stores only its hash, and sends
the raw value once in the bounded background invocation. The job stores no
source body, comment, file content, tree, prompt, raw delta, hidden thinking, or
provider body.

The `accounting` object is always present. The inert job starts with status
`unreserved` and nullable ledger revision, sequence, digest, and transition ID.
The first committed reservation and every later monetary accounting transition
sets status `pending` and fills those facts. A terminal job keeps its current
accounting status between the terminal-state CAS and later ledger/job-accounting
CAS operations; its final accounting status is `complete` after all exposure is
known and the active entry can be removed, or `unknown` while conservative
exposure remains active. A transition ID is a 64-character lowercase hexadecimal
domain-separated SHA-256 digest of the canonical job/attempt transition.
Accounting digests use the same fixed representation; ledger revisions and
sequences are nonnegative safe integers. Project the maximum terminal widths
before the first paid boundary. Persist the job's resulting accounting facts
before removing its active ledger entry.

Admission copies the authenticated session's `authorizationEpoch`, not its
cookie or token. The worker uses a job-only auth helper to acquire the current
encrypted account token pair only when owner ID and authorization epoch still
match and the account remains active. It uses the existing serialized token
refresh protocol, rechecks the returned token generation and active account
state after collection and immediately before the paid boundary, and aborts
without a provider call after authorization revocation. Ordinary sign-out
revokes the browser session but does not cancel a job the owner already
explicitly admitted; reconnecting or revoking GitHub authorization still fences
the job through the account epoch and token-generation checks.

After a candidate report validates and immediately before the immutable version
write, repeat the authorization-epoch, active-account, and token-generation
check. A reconnect or GitHub authorization revocation after paid analysis
prevents the immutable write and publication, settles any definitive billed
usage, and terminates the job safely. Ordinary Board sign-out alone still does
not cancel the admitted job.

Only one nonterminal job may occupy a repository's `activeJob`. Repeating the
same idempotency key returns the existing job. A different key while a job is
active returns `analysis_in_progress` without another reservation or dispatch.
Admission verifies `operation:'generate'` only when no current report exists and
`operation:'refresh'` only when `expectedCurrentReportId` exactly matches the
current report. Stale tabs receive `report_state_changed` and reload. Reusing
one idempotency key with different repository, operation, or expected report
values is an `idempotency_conflict`, never a reinterpretation of the existing
job.

Free source collection uses bounded collecting and counting leases. After
acquiring the GitHub token and, for refresh, reading the prior report, the
worker strongly rereads the job and requires the same live collecting token
before any GitHub request. Collection gets only the time remaining in the
committed 90,000 ms `stateDeadlineAt` window and provider cutoff. Counting
likewise checks the committed 60,000 ms window before model metadata and token
count requests and gives them only its remaining time. An expired worker cannot
adopt a replacement lease; reconciliation owns expiry finalization.

Immediately before an Anthropic request, CAS the job to the numbered primary or
corrective in-flight state with an invocation-unique attempt-token hash and a
hard deadline. The CAS winner may continue. If the write response is lost, it
may continue only when a strong read proves its own token and unexpired
deadline; all other invocations exit. Every later worker CAS requires that same
token. A paid boundary never becomes lease-recoverable.

When a stream ends definitively, first CAS the token-owned attempt to persist
its terminal class and complete usage. Move `primary-in-flight` to
`primary-response-complete` or `corrective-in-flight` to
`corrective-response-complete`. The original invocation then separately
CAS-claims its finalization token and moves to `validating-primary` or
`validating-corrective` before validating or assembling in memory. If the first
output is invalid but eligible for correction, persist its bounded safe
validation classification, settle that attempt in the ledger while retaining the
full second reservation, resolve any uncertain ledger acknowledgement by strong
read, and only then fence attempt two as `corrective-in-flight`. An invocation
never dispatches the correction while attempt-one accounting is uncertain.

State progression is explicit and monotonic:

```text
created -> reserved -> dispatchable -> collecting -> counting
        -> primary-in-flight -> primary-response-complete
        -> validating-primary -> version-written -> published -> succeeded

validating-primary -> primary-invalid -> corrective-in-flight
        -> corrective-response-complete -> validating-corrective
        -> version-written
```

Terminal alternatives are `failed`, `ambiguous`, `superseded`, and
`budget-blocked`. A definitive invalid first response may transition once to a
separately fenced corrective attempt. Only the original invocation that owns the
primary finalization token can make that transition. Unknown paid outcomes
become `ambiguous`; they are never replayed.

The job records a deadline for every nonterminal state. `collecting` and
`counting` have bounded free leases; reconciliation, rather than an expired
worker, finalizes their expiry. After a complete response is durably recorded,
the original invocation must CAS-claim a bounded finalization token before
in-memory validation and version writing. That token authorizes no provider call
and is never renewed by another invocation. After its expiry, a matching
immutable version advances to `version-written`; without one, the job fails and
its durably known usage settles. An expired `primary-invalid` fails and releases
attempt two. An expired in-flight attempt becomes `ambiguous` and unknown; later
states resume only nonpaid publication and bookkeeping.

`attempts[]` has a fixed maximum of two and preserves a reconstructable audit of
each paid boundary. Aggregate report usage is derived from these records, never
stored as the only evidence. No attempt record contains output text or provider
error content.

Record the admitting deploy and state-machine version. Production deploys must
remain backward-compatible with every nonterminal job schema they can encounter
from the immediately preceding immutable deploy. If a future migration cannot
provide that compatibility, first stop new admission and resolve or safely
expire every pre-provider job; never abandon a paid-boundary state or replay it
under a new schema.

### Spending ledger

Use setup ledger key `setup/v1` in `board-spend`. Its policy is fixed by code
and checked against the stored copy:

```text
schemaVersion: 1
currency: "USD"
revision
activePolicyId
policies
  <policy-id>
    model, effort, inferenceGeo, serviceTier, maximumAttempts
    inputRateMicrousd, outputRateMicrousd
    attemptInputCeiling, attemptOutputCeiling, attemptCostCeilingMicrousd
    capMicrousd: 25000000
    discussionMicrousd: 20000000
    featurePolicyHash
    pricingSource, pricingVerifiedAt, pricingValidThrough, deployId
settledMicrousd
accountingSequence, accountingDigest
active
  <job-id>
    policyId, createdAt, accountingState
    lastLedgerRevision, lastAccountingSequence, lastAccountingDigest
    lastTransitionId
    attempts[]
      number, ceilingMicrousd, state
      actualCostMicrousd, unknownExposureMicrousd, recordedAt
discussions
  <policy-id>
    status, currentRevision, triggeredAt, triggerExposureMicrousd
    decisions[]
      triggerRevision, decidedAt, observedExposureMicrousd
      decisionId, decision, authorizedThroughMicrousd, authorizedOperations
pricingReviewRequired
updatedAt
```

`revision` is a nonnegative safe integer incremented by every successful ledger
CAS; the Blob ETag remains transport-only for `onlyIfMatch`. Monetary accounting
transitions also increment `accountingSequence` and advance `accountingDigest`.
Policy/discussion mutations and accounting-complete active entry removal
increment `revision` but remain outside the monetary digest chain.

Set `SETUP_LEDGER_MAX_BYTES` to 262,144, `SETUP_LEDGER_MAX_ACTIVE_JOBS` to four,
and `SETUP_LEDGER_MAX_POLICIES` to 16. The existing 32-decision limit applies
per policy. At reservation, install every fixed attempt property and preflight
the entire ledger with each active numeric field projected to its maximum safe
terminal width. Policy and discussion mutations use the same projection. A
paid-boundary CAS requires that preallocated active entry, so later settlement,
release, or unknown classification never adds a field, array item, or unreserved
byte. Reject admission or policy mutation before a provider call when either
exact entry or serialized-byte ceiling would be exceeded.

The strict current schema reaches a 193,412-byte maximum-width projection with
four active jobs, 16 policies, 32 decisions per policy, maximum-byte deploy
identifiers, and every mutable numeric/timestamp field at terminal width. Test
that exact legal maximum against the 262,144-byte outer ceiling. The remaining
headroom is deliberate corruption and schema-change defense; no valid current
record can be padded to the outer ceiling.

The initial per-attempt reservation is 5,409,600 microdollars:

```text
1,000,000 input tokens * 5 microdollars
+ 16,384 output tokens * 25 microdollars
= 5,409,600 microdollars
```

Two possible setup attempts reserve 10,819,200 microdollars atomically before
the first dispatch. Every reservation iteration strongly reads the ledger and
its ETag, then strongly revalidates that the exact job is still
`created`/`unreserved`, nonterminal, within its admission deadline, and owns the
matching repository claim before conditionally writing against that ETag. A CAS
conflict restarts the ledger read and every job/claim proof within a bounded
loop; it never retries only the ledger operation. Admission requires
`settled + reserved + unknown + proposed <= 25,000,000`. Before a proposed
dispatch would make the same exposure reach or exceed 20,000,000, set the
versioned discussion gate, reject paid dispatch with
`budget_discussion_required`, and present the measured ledger state to the user.
Paid admission remains blocked until an explicit owner decision is recorded by
an authenticated, CSRF-protected acknowledgement transition against the exact
trigger revision. The acknowledgement records the observed exposure, concrete
remaining setup scope, and a ceiling no greater than $25; it never raises or
resets the cap. A later proposal beyond its authorized ceiling triggers a new
discussion revision.

A revision-bound `required -> stopped` decision permanently rejects every later
paid setup admission under that immutable price policy. An acknowledged decision
admits only an operation listed in `authorizedOperations` and only when exposure
including the proposal is at or below `authorizedThroughMicrousd` and the
lifetime $25 cap. Validate the exact policy ID, trigger revision, current ledger
revision, operation enum, ceiling, and aggregate exposure in the same
conditional ledger write that reserves spend. An acknowledgement for one policy
never authorizes a later policy; each new policy has its own discussion state
while all policies share the lifetime cap. Keep `decisions[]` append-only,
ordered by trigger revision, unique by bounded decision ID, and limited to 32
entries per policy. A proposal outside an acknowledged operation or ceiling
advances that policy to a new `required` revision without dispatch. A stopped
policy cannot advance or be reopened.

Preserve every immutable price policy and its discussion decision. Changing
`activePolicyId` never reinterprets, releases, or deletes earlier spend or
unknown exposure, and it creates a separate discussion state under the same
lifetime $25 setup cap.

`REVIEWED_SETUP_PRICING_ATTESTATIONS` is the append-only authority for setup
pricing. Its last exact entry is the only attestation allowed for new admission,
and each deploy-bound policy ID hashes that entry together with its deploy ID.
Project and validate an older stored policy only while its exact attestation
remains in the reviewed registry; reject arbitrary stored rates, dates, and
feature facts. Current admission also asserts that the last entry's rates and
computed attempt ceiling equal the fixed setup constants.

On an ordinary deploy rollover under a retained reviewed attestation,
`ensureSetupSpendLedger` strongly reads the shared `setup/v1` lifetime ledger
and conditionally adds and selects the new deploy policy. Activation advances
only the logical revision and update time around that selection; it preserves
every older policy and policy-scoped discussion, every active reservation and
unknown exposure, `settledMicrousd`, `accountingSequence`, and
`accountingDigest`. Nonpaid reservation reads and accounting accept prior-deploy
entries so the current reconciler can finish them. Browser summaries, owner
decisions, and new reservations require the exact current active policy. If an
activation acknowledgement is lost, resolve it by strong read without
duplicating a policy or accounting change. The 16-policy limit fails closed.

A new exact pricing attestation requires an appended, explicitly reviewed
registry entry that retains every attestation still referenced by durable
policies, or another explicit versioned migration. Model, feature, or schema
changes likewise require an explicit migration; otherwise admission fails
closed. Never trust arbitrary pricing facts read from the stored ledger.

At current published base rates and with every extra billed feature disabled,
actual cost is `5 * input_tokens + 25 * output_tokens` microdollars. Bind those
rates, `inference_geo:'global'`, `service_tier:'standard_only'`, and disabled
billed features to the stored setup policy and bounded-valid pricing
attestation. Validate nonnegative provider usage, require the response's
effective inference geography to be `global`, effective service tier to be
`standard`, and zero cache usage because caching is disabled. Reject tool,
premium, geography, tier, or other unexpected billing fields. Missing or
inconsistent billing facts make the attempt unknown.

Settle each definitively completed attempt immediately, including rejected
output, before another attempt can cross its paid boundary. Add its actual cost
to `settledMicrousd`, mark only that attempt settled, and release only the
difference from its ceiling. Keep the next attempt's reservation intact until it
is used or the job is terminal. A refusal follows documented zero-billing
behavior only when the response proves that classification. Any interrupted or
uncertain paid result moves that attempt's full ceiling to `unknown`; partial
usage is only a lower bound. Release reservations for attempts that provably
never crossed the boundary. Reconciliation never assumes an unknown attempt was
free.

Each accounting CAS increments `accountingSequence` and replaces
`accountingDigest` with a domain-separated hash of the previous digest and the
canonical job/attempt transition. The same CAS copies that transition's fixed
ID, resulting ledger revision, accounting sequence, and digest into its active
entry. The job then stores those resulting facts plus its complete per-attempt
audit. Resolve a lost ledger acknowledgement against the per-entry transition
fields even when another job has since advanced the global revision and digest.
Preallocate their maximum serialized widths at reservation. After the job is
durably accounting-complete, CAS-remove its active ledger entry only when it
contains no unknown attempt. Preserve an entry with unknown exposure until
authoritative owner billing evidence resolves it. Entry removal is idempotent
housekeeping outside the monetary accounting sequence and digest; a strong read
that proves absence resolves its lost acknowledgement. Thus the ledger retains
only active or unresolved exposure, while job records retain terminal history.

Before every new reservation, inspect all at-most-four active entries and their
jobs. Run the state-specific nonpaid reconciler for every terminal entry with
pending bookkeeping and every expired nonterminal entry, including pre-provider
`created` jobs with matching active entries and `reserved`, `dispatchable`,
`collecting`, and `counting` jobs from other repositories. Pending bookkeeping
includes a terminal job whose accounting status is still `unreserved` but whose
matching active ledger entry proves an interrupted reservation. Remove entries
only when the job's complete accounting tuple and the entry's last transition
prove all attempts known or released. Any terminal job with a matching reserved
active entry is pending bookkeeping regardless of whether its job accounting is
`unreserved`, `pending`, or stale `complete`. Leave only live nonterminal work
and unresolved unknown exposure untouched. Do not admit new paid work while a
terminal-pending or expired entry remains unreconciled. Setup exposure permits
at most two simultaneously fully reserved jobs and at most four full-ceiling
unknown attempts, so the four-entry bound is compatible with the cap. A future
production policy must define its own compatible active-entry and byte bounds
before it can be enabled.

On every strong read, validate `settledMicrousd`, accounting sequence/digest,
the fixed active-entry shapes, and recompute total exposure as the aggregate
settled value plus active reserved ceilings plus active unknown exposures.
Settled attempts are already represented by the aggregate and released attempts
contribute zero. An unknown attempt contributes at least its full reviewed
ceiling and any larger known lower bound. Integer overflow, duplicate or
inconsistent accounting transitions, an actual cost above its ceiling, a
capacity invariant failure, or a policy mismatch sets `pricingReviewRequired`
and blocks later paid work without reducing recorded exposure. The rolling
digest is a CAS continuity and lost-ack coordination head, not a claim that the
compacted ledger contains full history. A paged operator audit can cross-check
aggregate settled cost against retained bounded per-job attempt records without
running in normal admission; it need not reconstruct every historical
intermediate digest.

Production ledgers are disabled during setup. After calibration, a separate
versioned production policy will define a positive monthly USD cap, a maximum
USD exposure per report including every permitted attempt, the permitted retry
count, and effective month. Store each monthly ledger at
`production/<policy-id>/<YYYY-MM>`. The server must fail closed when policy
values are absent, malformed, or inconsistent with the request reservation.
Setup spend remains in its lifetime ledger and is never reset or relabeled as
production spend.

## Admission, dispatch, and recovery sequence

The synchronous admission route performs these steps in order:

1. Enforce production/published/canonical-origin guards, authorized owner
   session, CSRF, request shape, idempotency key, operation, and exact expected
   current report.
2. Run the bounded lightweight `pinRepository` access check: list the current
   user's installations, list the repositories granted to matching App
   installations, require the numeric owner and repository membership, fetch the
   repository directly, compare its identity and eligibility to the list, and
   fetch its named default branch tip. This proves current App installation,
   grant, owner, nonfork, nonarchived, repository identity, access, default
   branch, and tip without fetching issues, comments, pulls, trees, or files.
   Retain only the safe repository facts needed by this invocation.
3. CAS-upsert and strongly confirm the owner-catalog entry before initial
   Generate can proceed.
4. Create an inert job with `onlyIfNew`, including deterministic report/version
   identity. For an existing job, validate the complete idempotency tuple and
   run state-specific reconciliation before returning its safe view.
5. CAS the repository state to claim `activeJob`. A competing active job wins;
   terminally fence the losing inert job before returning and avoid any
   reservation for it.
6. CAS the applicable ledger to reserve every possible attempt, then CAS the job
   to `reserved` with the exact policy and resulting ledger revision, accounting
   sequence, accounting digest, and transition ID. If reservation is rejected,
   terminally fence the job as `budget-blocked` before clearing its repository
   claim.
7. Generate a raw cryptographic dispatch capability in memory. In one
   `onlyIfMatch` write, move the exact reserved job to `dispatchable` and
   install the capability hash and generation. If the write loses, discard the
   raw value. Invoke the production background endpoint with only job ID and the
   capability after the write succeeds or a strong read proves that exact hash.
   The body remains below Netlify's 256 KB background limit.
8. Record dispatch acknowledgement and return `202` with the safe job view.

Every uncertain job, ledger, catalog, repository, or version write is resolved
by an exact strong read before the next cross-key step. Netlify Blobs offers no
multi-object transaction; never describe or implement these ordered writes as
one CAS.

Because raw source may not be persisted, the worker performs its own complete
fresh two-pass GitHub collection after claiming the free lease. It independently
enforces owner, repository, installation, archive, fork, and access rules before
token counting. A source that becomes ineligible between the lightweight
admission check and worker collection fails without a paid call.

If dispatch acknowledgement is lost, a bounded redispatch in the same admission
may deliver the same capability again. Duplicate workers still share one job and
one paid CAS boundary. It must never create a second job or reservation.

Repeating an identical admission resumes a job that is still safely before its
paid boundary. For `created`/`unreserved`, strongly read the ledger. When an
exact matching active entry proves an interrupted reservation, validate its
owner, job, policy, complete attempts, ceilings, and repository claim, then CAS
the job to `reserved`/accounting `pending` with the entry's full resulting
tuple. Continue without another reservation. Resolve an adoption CAS loss by
strong re-read; a competing terminal fence wins and enters cleanup. A safely
resumable job may rotate the dispatch-capability hash and redispatch only after
a strong read proves that no worker has claimed it.

When a `created`, `reserved`, `dispatchable`, `collecting`, or `counting` job
cannot be resumed, recovery first CAS-fences that exact job and lease as
terminal. It then CAS-releases any still-reserved exact ledger attempts,
CAS-marks the job's accounting complete with the resulting ledger revision,
accounting sequence, accounting digest, and transition ID, and finally
CAS-clears only its matching repository claim. For a `created` job, strongly
read the ledger because an interruption after the reservation CAS but before the
job CAS can leave a matching active entry. If one exists, release it, copy the
full resulting accounting tuple into the job, mark accounting complete, and
remove the entry; nullable accounting facts remain only when the strong read
proves no matching entry. In that no-entry branch, perform a nonmonetary
reservation-fence ledger CAS that increments only logical `revision` against the
exact read ETag before marking the job accounting complete. On conflict, restart
the ledger read: a delayed reservation that won must be released through the
active-entry branch, while a successful fence makes every outstanding
reservation CAS based on the earlier ETag fail. If cleanup stops after the
terminal fence, that terminal job plus any matching active entry is pending
bookkeeping regardless of its current accounting status, and the bounded global
sweep resumes it. If the terminal job CAS loses to a paid transition, recovery
releases nothing and reconciles the newly read state. A new explicit
Generate/Refresh action is required after terminal cleanup. A report GET or job
poll never creates a new reservation or dispatches a new paid attempt.

The worker performs:

1. Runtime, canonical origin, published deploy, invocation method/body, and
   dispatch-capability checks, followed by state-specific reconciliation.
2. Free-lease claim and complete matched GitHub gathering in memory.
3. Input normalization, deterministic optional selection, byte/output-floor
   bounds, exact free count requests, and final count bound.
4. Strong-read job and ledger proofs, paid-attempt CAS ownership, then exactly
   one native Messages request for that numbered attempt.
5. Complete stream/usage verification and a token-owned CAS that durably records
   sanitized usage before strict wire validation, source binding, trusted report
   assembly, report validation, and deterministic comparison.
6. For an eligible correction, terminally record the primary validation result,
   settle attempt one while retaining attempt two, prove that ledger mutation,
   and separately fence attempt two before its one provider request.
7. Recheck authorization, write and read-back the deterministic immutable
   version, durably record any non-null displaced former-previous key, rotate
   the guarded report pointer while retaining `activeJob`, mark the job
   published, settle/release the ledger attempts, mark the job succeeded, clear
   only its repository claim, repair catalog metadata, and retain displaced
   physical versions.

Failure and ambiguity paths normally use the same cross-store order: CAS the job
to a terminal state first so no provider transition remains; update the ledger
second to settle, release, or retain unknown exposure; then mark job accounting
`complete` when every attempt is known or `unknown` while conservative exposure
remains in the active ledger; and clear this job's repository claim last. The
one ordering exception is fully validated fixed-rate usage whose calculated
lower bound exceeds its reserved attempt ceiling. The worker first CAS-marks
that attempt unknown in the ledger with the exact known cost and exposure equal
to the greater of the ceiling and known cost. Its revalidation binds the write
to the exact attempt token in either the matching in-flight job or the same
terminal job with an in-flight/unknown attempt. An `unknown -> unknown` CAS may
only raise known cost and exposure, derives its timestamp monotonically from the
worker input, existing attempt, and ledger, and makes a ceiling-only reconciler
treat stronger evidence as already satisfied. This permits an expiry reconciler
to win the terminal CAS without reducing evidence and resolves a lost ledger
acknowledgement by exact strong read. The worker does not perform its terminal
CAS unless that stronger ledger state is durably proven.

A terminal job with a prior reservation leaves accounting `pending` until the
separate ledger CAS and job-accounting CAS finish. An unreserved `created` or
reservation-rejected terminal job moves directly from `unreserved` to `complete`
with nullable accounting facts only after a strong ledger read proves there is
no matching active entry and the conditional reservation-fence ledger CAS
succeeds. A fence conflict restarts the read and uses the active-entry branch
when a reservation won. If an interrupted reservation entry exists, recovery
releases it and persists the full resulting accounting tuple before marking
`complete`. A reservation rejection may still require a nonmonetary policy or
discussion ledger CAS that advances only the logical ledger revision. Successful
publication orders the immutable version, job digest, and any non-null
displaced-version key before the pointer. It retains the claim through ledger
settlement and clears it only after the job is succeeded. No path releases a
reservation while its job can still cross a paid boundary, and no path admits a
replacement job before the prior accounting is durable.

Implement one bounded nonpaid reconciler invoked at the start of every worker,
authenticated job poll and report read, identical admission, and any admission
that encounters `activeJob`. It strongly reads the job first and only the state,
ledger, catalog, and deterministic version needed. It never gathers GitHub,
counts tokens, reserves spend, rotates a dispatch capability, or calls
Anthropic.

- A live pre-provider lease remains untouched; after expiry, free work may be
  reclaimed or the job is fenced before its reservation and claim are released.
- An unexpired primary/corrective in-flight state remains untouched. After its
  hard deadline, CAS the exact state/token to `ambiguous`, move that attempt's
  full ceiling to unknown, release only never-dispatched attempts, mark
  accounting `unknown` while retaining its active ledger entry, and clear the
  matching repository claim.
- An unexpired response-complete state remains untouched until its state
  deadline, and an unexpired validating state remains untouched until its
  finalization-token deadline. After the applicable expiry, first check the
  deterministic version. A matching exact version advances to `version-written`;
  without one, fence as failed, settle durable complete usage, and release
  never-dispatched attempts. Incomplete usage becomes unknown, sets job
  accounting `unknown`, and retains its active ledger entry.
- An unexpired `primary-invalid` with live finalization ownership remains
  untouched; only that owner may settle attempt one and fence the corrective
  attempt. After finalization expiry, reconciliation first CAS-fences the exact
  job as terminal failed. It then settles durably known primary usage, releases
  the never-dispatched correction, marks accounting complete, and clears the
  matching claim.
- `version-written` resumes guarded pointer publication; `published` resumes
  ledger settlement, job success, claim clearing, and catalog repair. Terminal
  states with pending accounting resume bookkeeping only.

The original invocation must prove its token in every post-provider CAS. If a
deadline reconciler fences the state first, the original invocation stops. This
path does not depend on another Netlify delivery: the next authenticated read or
admission resolves a hard-terminated worker without paid replay.

## Authenticated API contracts

Retain the Phase 2 session, repository, source-check, and authentication routes.
All responses use `Cache-Control: no-store`; all errors use the existing safe
JSON envelope with fixed messages.

Add these owner-authenticated routes:

| Method | Route                               | Purpose                      |
| ------ | ----------------------------------- | ---------------------------- |
| GET    | `/api/reports`                      | List saved report identities |
| GET    | `/api/repositories/:id/report`      | Load current board state     |
| POST   | `/api/repositories/:id/report-jobs` | Admit Generate or Refresh    |
| GET    | `/api/report-jobs/:jobId`           | Poll one authorized job      |
| POST   | `/api/setup-budget-decision`        | Record an explicit decision  |

The separate `POST /.netlify/functions/report-job` background endpoint is not
session-authenticated and never receives cookies, a GitHub token, or a CSRF
token from the browser. After production, published-deploy, method, origin, and
bounded-body guards, it accepts only the job ID and raw dispatch capability from
the server-side admission call. It validates the capability hash before any
source, storage-dependent continuation, or provider work and returns no report
data.

`GET /api/reports?cursor=<cursor>` requires only the Board session. It must not
acquire a GitHub token or reject access because source authorization expired. It
applies the catalog's 50-entry scan, 50-state-read, and five-repair bounds, then
returns `items` and `nextCursor`. Items contain saved repository IDs and last
trusted display identities, current report IDs and generation times, safe source
status, and safe active-job summaries. An examined page may have no items and
still return a cursor. The UI performs the bounded, restartable page merge
described above and combines it with the current eligible repository list so
inaccessible saved reports remain discoverable.

After storage reads and immediately before returning any catalog or report
response, recheck the authoritative Board session generation and owner. A
logout, expiry, revocation, or replacement session that wins the race returns
`401` and no private response body.

`GET /api/repositories/:id/report` also requires only Board authentication. It
returns the validated current report plus inventory, saved comparison,
provenance, current/previous metadata, last source-check state, last analysis
attempt, safe active-job view, and spend-mode availability. The response keeps
the repository's last trusted live identity separate from the immutable
identity analyzed by the current report, so a rename cannot invalidate or hide
that report. It never returns the previous full report, raw source, raw job
record, dispatch/lease tokens, ledger internals, or provider bodies. An existing
repository state with no saved report returns a valid empty state. If no state
exists yet, the route returns `report_not_found`; the browser may construct the
same empty view only when that numeric ID appeared in the current eligible
repository list. Its automatic source check then creates the trusted state.
Neither path starts analysis.

After that response renders, the browser automatically calls the existing
CSRF-protected source-check route. Extend that route to sequence and store its
safe result. The browser compares a complete check fingerprint to the report's
analysis fingerprint and shows `unchanged` or `changes detected`. Incomplete,
unstable, rate-limited, timed-out, or failed checks cannot claim unchanged.
Definitive ineligibility or inaccessible source produces historical/source-
unavailable status and disables Generate/Refresh without hiding the report. No
check route imports or calls the Anthropic client.

`POST /api/repositories/:id/report-jobs` accepts exactly:

```json
{
  "idempotencyKey": "browser-generated UUID",
  "operation": "generate or refresh",
  "expectedCurrentReportId": "null or current report ID"
}
```

It requires authorized owner, CSRF, current eligibility/access, exact report
state, available spend policy, and one active-job slot. Its success response is
`202` with `{job:{id,operation,state,createdAt}}`. Selecting or opening a
repository never calls this route.

`GET /api/report-jobs/:jobId` returns only a job owned by the current authorized
account and repository. Expose coarse states `queued`, `gathering`, `analyzing`,
`validating`, `publishing`, `succeeded`, `failed`, or `ambiguous`, plus fixed
safe error codes and the resulting report ID. Do not expose provider error text,
private counts, internal CAS state, cost reservations, or capability hashes.

`POST /api/setup-budget-decision` has no ordinary automatic caller. It requires
the owner session and CSRF token plus exact policy ID, discussion revision,
`acknowledge` or `stop`, a bounded decision ID, approved setup-operation enum
list, and, for acknowledgement, a ceiling at or below $25. It is used only after
the required user discussion and performs no dispatch or reservation.

Add stable errors and status mapping for `report_state_changed`,
`analysis_in_progress`, `analysis_unavailable`, `analysis_input_too_large`,
`analysis_output_invalid`, `analysis_ambiguous`, `budget_exhausted`, and
`budget_discussion_required`, plus `analysis_sensitive_input`,
`report_catalog_full`, and retryable `report_catalog_changed`. A provider rate
limit remains distinct from a GitHub rate limit in internal code even if the
browser messages are similarly brief. Session `401` remains the only response
that clears Board authentication. GitHub `403` does not hide saved reports.

## Browser behavior and report presentation

Keep `/demo` synthetic and keep all real data behind the production API. Extend
the existing production shell without introducing a frontend framework.

The repository landing view has two authenticated groups:

- Currently eligible GitHub repositories.
- Saved boards that are currently unavailable or no longer eligible.

Deduplicate by stable numeric repository ID. Display private/public status only
to the authenticated owner. A direct `/repositories/:id` navigation loads its
saved board through the authenticated API and never embeds report data in HTML,
URLs, browser storage, or static artifacts.

For a repository without a report:

- Render repository identity and source-check status.
- Show **Generate report** only when source eligibility/access and spending mode
  permit it.
- Selecting the repository and completing the automatic source check remain
  free. Only the explicit button POST may start Anthropic analysis.

For a repository with a report:

- Render the current validated report immediately, before the automatic source
  check completes.
- Validate saved report, inventory, and provenance against the immutable
  analyzed identity while using the last trusted live identity for navigation
  and new eligibility checks. A successful check may update the live identity
  after a repository rename without rewriting the saved report.
- Show report generation time, analyzed commit/fingerprint, model/effort, input
  provenance, bounds/limitations, and saved comparison with the previous
  successful report.
- Show automatic source freshness in a separate status region: checking,
  unchanged, changes detected, check failed, or source unavailable.
- Show **Refresh report** as the only paid update action. A changed fingerprint
  never starts it automatically. An unchanged fingerprint does not imply the
  explicit action is free.
- Preserve the rendered report during job progress and every refresh failure.
  Show job failure, ambiguity, or budget blocking in a separate live-status
  region.
- Mark an inaccessible/ineligible board historical/source-unavailable and
  disable Refresh while retaining all report sections and provenance.

Generate/Refresh creates one `crypto.randomUUID()` per click and reuses it after
an uncertain HTTP response. Disable duplicate controls while the active job is
known. Reloading obtains the active job from server state and resumes polling;
it does not create another job. Poll with bounded backoff, stop on terminal
state, dispose timers/abort controllers on navigation or sign-out, and perform
one report reload after success.

Keep the original report sections and lane semantics: header counts, Summary,
Start now, Lanes, Contention, Blocked, and authoritative footer. Render the
saved change comparison and freshness/provenance controls around that report,
without treating them as model-authored source facts. Continue text-node-only
rendering and validated HTTPS links. Cover keyboard access, live-region
announcements, focus after actions, narrow screens, themes, and age-timer
disposal.

## Environment and deployment gate

Complete all implementation, fixture/mocked tests, independent reviews, and a
reviewable production artifact before requesting owner-only credential setup.
The only new provider secret is `ANTHROPIC_API_KEY`. The owner stores it in the
Netlify UI as a secret with exactly one production contextual value and the
available server/function scopes. The value is never sent in chat, printed,
downloaded, read back, placed in a `VITE_*` variable, committed, or made
available to a preview/branch context.

Production spend mode defaults to setup and remains fail-closed without the
reviewed setup ledger. No ordinary production policy environment values are
invented. After the user chooses production limits, validate explicit policy ID,
monthly microdollar cap, per-report microdollar cap including retries, retry
count, and effective month through server-only configuration. Redeploy after
every environment change because Netlify captures function values per deploy.

Before any paid call, verify in the deployed artifact:

- The production API and background function exist and use Node 24.
- The currently published canonical deployment is the only accepted runtime.
- Automatic PR preview and a manual fixture draft each report zero Functions and
  zero Edge Functions, return fixture JSON `404` for `/api/*`, and cannot access
  site-wide Blobs.
- Static assets contain no known synthetic sentinel, environment key name where
  inappropriate, credential value, private source data, provider request, or
  server package.
- Live anonymous report/job endpoints reject access, owner session behavior
  remains correct, and the background endpoint rejects missing/invalid
  capabilities without work.
- Model metadata and free token counting work with the exact fixed request; the
  durable ledger still records zero settled spend before the first Messages
  request.

## Validation plan

### Domain and source tests

- Add `createdAt` and canonical assignee collection, observation matching,
  fingerprint, saved inventory, ordering, assignment-only start eligibility, and
  boundary tests. Prove assignment never creates progress.
- Test normalized input catalogs, ID joins, no duplicate source text, prior
  analysis projection, prompt-injection-shaped source strings, complete issue
  and issue-body retention, deterministic whole-comment/file selection,
  overlapping file relevance classes, one-stream exhaustion, shuffled source
  order, exact count-request sequences including nonmonotonic mock results,
  selection manifests, zero/exact/over byte and token bounds, mandatory-only
  failure, and structural output-floor rejection.
- Test `SOURCE_SAFETY_POLICY_V1` against ordinary-path secret-bearing files,
  credential paths in tree metadata, every rule and placeholder boundary,
  invalid UTF-8, mandatory-input failure before count, optional whole-item
  omission, and safe provenance. Test `NO_VERBATIM_POLICY_V1` at 31/32-line and
  63/64-span boundaries, exact whole-field equality at short lengths, ordered
  CR/LF, NFC, lowercase, horizontal/full whitespace, Unicode-version, and
  code-point boundaries. Cover permitted shorter incidental overlap,
  canonical-title and accepted-prior-analysis exemptions, an unchanged refresh,
  prompt-injection requests to copy text, claim queries, output secrets,
  corrective-output rejection, and absence of matched text from jobs, versions,
  errors, and logs.
- Test every wire sentinel and invalid combination, sparse issue analysis,
  duplicate/unknown IDs, output limits, source binding, canonical-field
  protection, uncertainty, branch units, assignment-only behavior, and final
  `validateReport`/`deriveReport` integration.
- Test exact catalog binding for local, cross-repository, and HTTPS references,
  including invented/altered/absent, closed, merged, integrated, and unverified
  targets. Only exact gathered unverified targets may support uncertainty.
- Port fixtures for every original comparison category, including summary,
  notes, displayed short titles and milestones, blocker and start reasons,
  footprints, lane details/order, contention labels/order, and effective claim
  searches. Cover absent, explicit-default, and changed override queries.
  Independently test `initial`, `unchanged`, and `changed` plus all comparison
  bounds.

### Provider tests

- Compare the free-count and Messages request envelopes field for field and
  assert the exact model, effort, thinking, schema, version header, paid-only
  global-inference and standard-only-service controls, and omitted paid
  features.
- Exercise fragmented streaming frames, input/cache usage in `message_start`,
  cumulative output in multiple `message_delta` events, usage-free
  `message_stop`, multiple content block types, terminal ordering, refusal,
  `max_tokens`, model mismatch, decreasing/missing/contradictory usage,
  malformed events/JSON, response bounds, aborts, timeouts, rate limits, server
  errors, redirects, and zero automatic retries.
- Prove one primary request and at most one narrowly eligible corrective
  request. Plant duplicate delivery and lost-CAS-response conditions and count
  provider mock invocations.
- Consume almost all of the committed collecting window during authentication
  and prior-report retrieval, then prove source collection receives only the
  remaining time. Replace the collecting token after it expires and prove the
  old worker makes no GitHub or provider request. Expire counting immediately
  after its durable claim and prove the worker stops before model metadata or
  token counting while reconciliation owns terminal expiry handling.
- Reject an expired or mismatched pricing attestation, policy ID, model, rates,
  billed-feature hash, inference geography, service tier, or deploy ID before a
  Messages call. Prove workspace defaults cannot replace the pinned paid
  controls. For a dispatched response with an unpriceable model, cache use, tool
  use, premium/service tier, geography, or unknown billed field, prove the job
  publishes no version, records unknown exposure at
  `max(full attempt ceiling, known lower bound)`, sets `pricingReviewRequired`,
  cannot run correction, and blocks later paid admission.
- Assert no raw request, output, thinking, error body, or source text enters
  logs, persisted jobs, ledgers, or report envelopes.

### Storage, concurrency, and budget tests

- Exercise exact allowlist schemas and byte bounds, strict key validation,
  strong reads, `onlyIfNew`, `onlyIfMatch`, bounded CAS conflicts, and
  fail-closed storage errors. Include the job accounting sequence, digest,
  transition ID, and ledger revision plus the ledger and active-entry revisions
  at absent, initial, maximum-width, and invalid boundaries. Prove nonmonetary
  ledger mutations change only the logical ledger revision.
- Fill the setup ledger to each four-active-job, 16-policy, and 32-decision
  boundary using worst-width projections. Prove the exact 193,412-byte maximum
  legal projection remains below the 262,144-byte outer ceiling. Repeat definitive
  zero-billed refusals and very small settlements beyond those counts and prove
  accounting-complete entries are removed, aggregate settled cost and the hash
  chain remain stable, and post-dispatch settlement always fits its preallocated
  record.
- Activate deploy B over a deploy A ledger containing prior-policy discussions,
  reservations in every state, settled cost, unknown exposure, and a nonzero
  accounting sequence. Prove activation preserves those facts, new summaries,
  decisions, and reservations require B, and nonpaid reconciliation still
  finishes A entries. Lose the activation acknowledgement and prove a strong
  read resolves it without duplicate policy or accounting changes. Prove the
  16-policy boundary fails closed. Retain exact historical reviewed-attestation
  registry entries and reject a removed entry, arbitrary stored pricing facts,
  and an unreviewed current attestation.
- Commit job A's accounting transition while losing its response, advance the
  global accounting head with job B, then prove A recovers from its own active
  entry's ledger revision, transition ID, accounting sequence, and digest
  without replaying settlement. Fill the active map with interrupted
  pre-provider jobs from other repositories, expire them, then prove a new
  admission reconciles each job/accounting/claim order within the four-entry
  bound before reserving. Separately, commit repository A's terminal job CAS and
  interrupt before its ledger settlement; prove a new repository B admission
  uses the global pre-reservation sweep to settle A exactly once, mark A
  accounting-complete, remove A's active entry, clear A's claim last, and only
  then reserve for B.
- Race identical and different idempotency keys, concurrent repositories, global
  cross-repository UUID reuse, active-job claims, source checks, catalog
  merges/repair, report publication, and ledger reservations.
- Exercise exact 1,000-entry and 1,048,576-byte catalog bounds, 50/51-entry
  pagination, empty filtered pages with a next cursor, malformed and changed
  cursors, one bounded restart, a stale entry on a later page, a repair that
  would exceed the byte cap, and uncataloged versus existing-member behavior at
  each ceiling.
- Prove aggregate setup exposure cannot exceed
  $25 and a proposed dispatch at
  or above $20 enters the discussion gate
  without a provider call. Verify exact revision-bound acknowledgement and stop
  decisions without changing the cap. Cover stale revisions, duplicate decision
  IDs, permanent stopped-policy rejection, wrong operations, the authorized
  ceiling boundary, the 32-decision bound, a new policy's separate gate, and
  lifetime exposure preservation.
- Cover successful settlement, output-rejected settlement, unused retry release,
  classifier refusal handling, unknown reservation retention, exact `unreserved`
  to `complete`, `pending` to `complete`, and `pending` to `unknown`
  job-accounting transitions, active-entry removal versus retention, and
  reconciliation after each interruption point.
- Interrupt after job creation, repository claim, reservation, dispatch, source
  collection, each paid-boundary write, each complete response, primary
  settlement, corrective fencing, validation, immutable version write,
  displaced-key recording, pointer rotation, and publication. Inject
  committed-but-lost and uncommitted write responses. Verify only free states
  repeat, attempts settle once, a committed rotation retains its displaced key,
  successful publication resumes without another model call, and ambiguous paid
  states never replay.
- Interrupt after the reservation ledger CAS and before the job moves from
  `created` to `reserved`. Prove identical admission validates and adopts the
  matching entry's full tuple into `reserved`/`pending` without a second
  reservation, including its race with terminal recovery. When resumption is
  unavailable, prove recovery fences the job, finds and releases the matching
  active entry exactly once, persists the full resulting accounting tuple, marks
  accounting complete, removes the entry, and clears the claim last. Stop once
  more after the terminal fence, then prove a different-repository admission's
  global sweep resumes that pending bookkeeping and restores capacity. Also
  prove the no-entry branch moves directly from `unreserved` to `complete` with
  nullable facts only after its reservation-fence ledger CAS. Delay the original
  reservation CAS until after the no-entry read: prove either the reservation
  wins and is released exactly once or the fence wins and the delayed
  reservation cannot commit. Make the losing reservation writer reread and try
  to retry: prove the full job/deadline/claim revalidation observes the terminal
  fence and prevents a new reservation. Delay writers around each ledger read,
  job/claim proof, and reservation/fence CAS boundary. If a terminal job is
  stale `complete` with a still-reserved matching entry, prove the sweep
  reconciles it rather than deleting or trusting the entry.
- Interrupt after lightweight eligibility, capability generation, capability
  installation, and committed-but-unacknowledged installation. Race the
  repository-claim loser and each ordered pre-provider terminal/accounting/claim
  cleanup step. Poll after `primary-invalid` but before primary settlement and
  prove the live owner can still fence exactly one corrective paid attempt.
- Prove current/previous rotation is exact, failed jobs leave both pointers
  unchanged, stale jobs cannot overwrite newer success, deterministic version
  read-back resolves lost acknowledgements, and displaced immutable versions
  remain stored but absent from the logical report history.
- Simulate a worker hard termination with no platform retry. Trigger only an
  authenticated poll and prove expired paid work is fenced, ledger exposure is
  conservative, the repository claim clears last, and provider call count does
  not increase.

### API and browser tests

- Require owner authentication for all real reports and jobs, including public
  repositories and direct URLs. Reject another account, repository, job, CSRF
  token, or stale expected report ID.
- Retrieve a saved report without a current GitHub token or eligible source;
  discover it through the durable catalog and preserve it across
  sign-out/sign-in and simulated browsers/devices. Cover a missing/stale catalog
  summary, direct-route repair, source deletion, concurrent first reports, and a
  logout/session-replacement race after storage reads but before response.
- Verify no saved report, report open, report list, automatic source check, job
  poll, failure retry UI, or page reload calls the provider mock.
- Verify only explicit Generate/Refresh creates a job, repeats use one
  idempotency key, progress resumes after reload, and stale asynchronous results
  cannot replace current UI state.
- Cover complete unchanged/changed freshness, failed checks, reauthorization,
  archive/transfer/deletion/App-access loss, restored access, and historical
  labels/actions.
- Exercise successful generation and refresh, previous comparison, invalid
  output, provider error, ambiguous state, cap and discussion gates, concurrent
  click/navigation, narrow screens, supported browsers, themes, keyboard flow,
  live regions, and automated accessibility.

### Build, CI, and deployment tests

- Keep root fixture tests independent of `server/node_modules`; keep native
  backend tests under the server package and provider/store/network mocks
  default-deny.
- Extend production composition tests to include both API and background
  functions, then build fixture context and prove both are removed. Assert
  `report-job.mjs` exports `config.background:true`; assert
  missing/unknown/preview/branch contexts never install or stage server code.
- Verify buffered API responses remain below 6 MiB and dispatch bodies under
  256 KB. Bound provider streams and stored JSON independently.
- Run repository formatting, frontend/backend lint, all unit and integration
  tests, browser suites in Chromium/Firefox/WebKit, fixture and production
  builds, artifact checks, dependency audit, and secret scanners.
- Inspect actual production and preview function inventories, deploy contexts,
  headers, routes, immutable-origin rejection, and published commit identity.
- Prove both API and worker reject an unpublished or superseded deploy. Before
  live calibration, record current official Opus 5 limits, standard prices, and
  billed-feature rules and require the exact deployed price-policy ID, rates,
  feature hash, deploy ID, and validity interval.

Use mocked provider responses for routine and CI tests. No CI, preview, local
fixture, or dependency test may require `ANTHROPIC_API_KEY` or spend funds.

## Paid calibration, acceptance, and production-policy decision

Paid work begins only after the implementation, spend state machine, provider
transport, preview isolation, and mocked tests have independent clean reviews
and are deployed to the protected production composition. Every live call is
admitted by the setup ledger and recorded without private source content.

Run live acceptance in this order:

1. Verify exact model metadata and token counting without a paid Messages call.
2. Generate one representative eligible public-repository report through the
   explicit owner action. Verify full issue coverage, report semantics,
   uncertainty, provenance, usage settlement, current-envelope retrieval with
   current/previous pointer state, retrieval after sign-out/sign-in, and
   retrieval in another browser/device.
3. Generate one representative eligible private-repository report through the
   explicit owner action. Verify the same behavior without recording repository
   identity, issue text, or screenshots in public artifacts.
4. Explicitly refresh a suitable saved report. Verify previous rotation,
   deterministic change comparison, source freshness separation, and unchanged
   retention on any failure. Do not manufacture a paid failure if mocked and
   state-machine tests already establish that invariant.
5. Confirm automatic opening/checking and a detected source change make zero
   Messages calls. Confirm historical/source-unavailable viewing through a safe
   reversible source fixture or mocked deployment check rather than changing a
   real repository's ownership/archive state.

For each paid attempt, record in the private-safe deployment evidence: job ID,
operation, public/private classification, model, effort, input count estimate,
terminal input/output token usage, calculated settled cost, retry count, result
validity, report issue count, output-bound headroom, elapsed code runtime, and
remaining settled/reserved/unknown setup exposure. Do not record repository
names, titles, bodies, comments, paths that disclose private content, raw
provider output, or credentials.

Assess report quality against the original skill: complete inventory, canonical
titles/milestones/progress, legal lanes and branch units, hard/soft
dependencies, uncertainty, contention, start picks, concrete reasons,
previous-report comparison, and source provenance. A structurally valid but
materially poor report does not establish acceptance.

After those measured calls, prepare a production-policy decision for the user
with:

- Settled cost and token usage for each accepted call and any rejected attempt.
- Observed retry need and the consequences of allowing zero or one corrective
  retry.
- The reviewed worst-case reservation per attempt under the final input/output
  bounds.
- Concrete monthly-cap and per-report-cap options, each showing how many
  simultaneous reservations it admits and whether a corrective retry fits.
- A recommended policy tied to the measured owner-only usage, with no claim that
  observed cost is a guaranteed maximum.

Do not enable ordinary paid production use until the user explicitly selects the
monthly cap and per-report maximum, including retries. If the
$20 discussion
gate or $25 setup cap blocks remaining paid acceptance, stop paid
dispatch, report settled/reserved/unknown exposure, and continue every fixture,
documentation, review, and nonpaid task that remains possible.

Record the selected limits in the roadmap and phase plan, implement the
versioned production ledger/configuration, repeat nonpaid verification, deploy,
and perform one explicitly authorized ordinary production report only if needed
to establish the selected policy. Never reinterpret additional Netlify credits
as additional Anthropic authorization.

## Documentation and operational evidence

Update the living roadmap, report contract/developer documentation, production
setup guide, and README portions needed to use Generate/Refresh and understand
freshness, provenance, report retention, source-unavailable status, and spending
gates. Keep the README focused on the hosted owner flow; do not add a
self-hosting guide.

Document current schemas, state transitions, environment names without values,
provider/version pins, analysis bounds, cost arithmetic, reconciliation rules,
and recovery commands that do not expose secrets or raw inputs. Record actual
verification and deployment identifiers. Distinguish mocked, local, deployed
free, and deployed paid evidence.

Complete this documentation checklist against the exact proposed PR head:

- [ ] README behavior matches the implemented Generate, Refresh, freshness, and
      source-unavailable flows without describing Phase 3 as deployed.
- [ ] The report contract distinguishes the validated report payload, immutable
      successful envelope, durable current/previous pointers, and current
      envelope API projection.
- [ ] Retention text records `cleanupCandidateKey` as inert metadata, confirms
      displaced immutable versions remain physically stored, and claims no
      history or deletion API.
- [ ] The production setup guide and project agent guidance name exactly the
      `api` and `report-job` production Functions and all four Blob stores.
- [ ] Every required environment variable is named without its value;
      `ANTHROPIC_API_KEY` is production-only and absent from fixture, preview,
      and branch deployments.
- [ ] Setup spending controls are distinct from the future user-approved
      ordinary production monthly and per-report policy.
- [ ] The phase plan and production guide document deploy-bound setup-policy
      activation, the exact reviewed-attestation registry, prior-deploy nonpaid
      reconciliation, and the committed collection/counting lease windows.
- [ ] Verification evidence is labeled mocked, local, deployed free, or deployed
      paid; no unobserved deployment or calibration is presented as complete.
- [ ] Scoped formatting, Markdown checks, repository verification, and artifact
      checks pass before the PR is opened.

Update related GitHub issues only with sanitized evidence. Close an issue only
when its acceptance criteria are actually complete; do not let the Phase 3 PR
claim final whole-product acceptance that belongs to Phase 4.

## Commit, review, PR, and merge workflow

Work in a distinct `feature/report-generation` worktree created from the
verified Phase 2 merge. Commit this reviewed detailed plan first. Use small,
GPG-signed Conventional Commits at these logical boundaries:

1. Source prerequisite, normalized wire, schema, assembler, comparison, and
   domain tests.
2. Report/job/spend stores, CAS state machines, rotation, retained candidate
   metadata, and concurrency tests.
3. Native provider/count/stream client and production background worker.
4. Authenticated report/job APIs and source-check persistence.
5. Generate/Refresh/freshness/historical frontend flows and browser coverage.
6. Production/fixture composition, CI, setup/developer/user documentation, and
   mocked acceptance evidence.
7. Live deployment, calibration, chosen production policy, and sanitized
   acceptance evidence, split further when the user decision changes code.

Run scoped checks after each boundary and the complete repository verification
before final review. Obtain independent final reviews of at least:

- Provider request, billing arithmetic, reservations, and at-most-once paid
  dispatch.
- Storage schemas, CAS races, current/previous rotation, historical access, and
  raw-input retention boundaries.
- Inventory binding, report semantics, uncertainty, comparison, and UI behavior.
- Production/preview composition, authentication, secret handling, and live
  evidence.

Resolve every actionable finding with signed commits and rerun affected checks.
Open the PR with final behavior and validation evidence, inspect every current-
head CI result, all unresolved review threads, all review bodies, mergeability,
and current-head Copilot assessment. Each push invalidates earlier current-head
review evidence.

Use a merge commit only after the PR is clean. Verify the merge signature and
automatic production deployment from that merge, rerun protected live routes and
nonpaid freshness checks, and confirm the selected paid-policy state. Remove the
worktree and local/remote feature branches through the established workmux
workflow, then continue to Phase 4.

## Exact out-of-scope items

- Any GitHub user other than owner ID `99961`; organization repositories,
  third-party owners, forks, archived repositories for new analysis, or GitHub
  Enterprise.
- Public report sharing, unauthenticated report access, collaboration, roles,
  invitations, or multi-user billing.
- Multi-repository reports, board types other than backlog triage, or observing
  local worktrees and unpushed branches.
- Automatic, scheduled, webhook-triggered, or source-change-triggered paid
  analysis. A source change only changes the free freshness status.
- Provider/model selection, model fallback, lower effort chosen without review,
  tools, web browsing, citations, prompt caching, premium inference modes, or
  storing provider thinking.
- Fetching arbitrary external URLs or treating unverified cross-repository
  references as confirmed blockers.
- API or browser access to more than current and previous successful reports, a
  historical-report browser, export, report deletion controls, or raw source
  snapshot retention. Displaced immutable versions remain physically stored
  pending an approved retention and deletion policy.
- Netlify Database, Async Workloads, preview functions, preview production-data
  copies, a GitHub App private-key runtime, or new GitHub write permissions.
- Changing Anthropic account purchases, credits, organization/workspace limits,
  automatic recharge, Netlify plan/top-up settings, custom domains, or DNS.
- An Anthropic Admin API dependency or automatic resolution of unknown billed
  attempts without authoritative evidence.
- A self-hosting guide. Final operational polish and whole-product release
  acceptance continue in Phase 4.

## Exit criteria

Phase 3 is complete when all of the following are true:

- The fixed Opus 5/high-effort path generates a complete, valid original-style
  report from an eligible public and private repository through explicit owner
  actions within the authorized setup ledger.
- Reports persist server-side across sign-out, browsers, and devices; current
  and previous rotate only on successful publication.
- Existing reports open before an automatic free GitHub check, never reanalyze
  automatically, and clearly separate report provenance, source freshness, and
  failed analysis state.
- Saved reports remain authenticated and viewable with historical/source-
  unavailable status after eligibility/access loss; new analysis is disabled.
- At-most-once paid-boundary, idempotency, concurrency, cap, ambiguity, invalid
  output, runtime, and stale-publication invariants pass meaningful tests.
- Durable records, logs, responses, static artifacts, and previews contain no
  forbidden raw source/provider/credential material.
- Fixture previews and branch deploys have zero Functions and production data;
  the canonical published production deploy contains only the reviewed API and
  worker composition.
- Calibration evidence supports a concrete user decision, the user has selected
  production monthly and per-report limits including retries, and the deployed
  server enforces that versioned policy before ordinary paid use.
- Documentation, independent reviews, current-head CI/review, merge commit,
  automatic production deployment, and worktree/branch cleanup are complete.
