# Board report generation plan review

Date: 2026-09-18

Status: corrections applied; exact-commit re-review pending. Three independent
reviews of exact planning commit
`976e1249f9b54776f44c0956e26bc2990e144125` found ten required corrections. The
implementation baseline is Phase 2 merge
`370c257c49c09492426b4d8df24d37240884e908`.

## Scope and evidence

Reviewed artifact:
[Phase 3 report generation plan](../plans/todo/2026-09-18-board-report-generation.md).
The reviews compared the complete plan with the original project prompt, the
living product roadmap, the installed `publish-report-board` 1.0.0 skill, the
merged Phase 2 source collector, storage adapter, report contract and renderer,
and the current official Anthropic and Netlify documentation named by the plan.

The reviews confirmed the repository was clean at the exact planning commit and
that its parent was the exact Phase 2 merge. `git diff --check` passed for that
range. No build, test, provider call, storage mutation, credential read, or live
runtime check was part of this documentation review.

## Required corrections

### R1 Source safety and raw-text retention

Finding: the plan excludes known credential paths but does not define a bounded
content screen for secret-bearing text in an ordinary file path. It also
forbids persisted source bodies while allowing model prose to be copied without
a deterministic anti-copy rule.

Evidence: product roadmap lines 193-201; collector lines 493-622; Phase 3 plan
lines 199-220, 343-349, and 527-534 at the reviewed commit.

Required resolution: define a versioned, bounded source-safety policy before
token counting. It must specify exact rule classes, placeholder handling,
mandatory-input failure, optional whole-item omission, safe provenance, and
fail-closed behavior. Add a fixed no-verbatim instruction and deterministic
validation of every persisted model-authored prose field against the transient
source corpus, plus output secret screening. Test that prohibited input never
enters count or Messages requests and that source excerpts never enter durable
records, logs, or errors.

Disposition: resolved in the corrected plan; exact-commit re-review pending.

### R2 Admission and capability installation

Finding: the numbered admission sequence requires complete collection while a
later paragraph permits a lightweight access check. It also moves a job to
`dispatchable` before generating and storing the capability hash.

Evidence: Phase 3 plan lines 825-859 at the reviewed commit.

Required resolution: use one bounded admission contract with exact GitHub calls
and evidence. Keep the complete fresh two-pass collection in the worker.
Generate the raw capability before one conditional write installs both the
`dispatchable` state and capability hash. Add interruption tests at both
boundaries.

Disposition: resolved in the corrected plan; exact-commit re-review pending.

### R3 Corrective-attempt polling race

Finding: the general state rules reserve live `primary-invalid` finalization for
the owning invocation, but the reconciler immediately fails every
`primary-invalid` job. An ordinary authenticated poll can cancel a valid
corrective path.

Evidence: Phase 3 plan lines 668-703 and 904-922 at the reviewed commit.

Required resolution: leave an unexpired token-owned `primary-invalid` state
untouched. Permit only its owner to settle attempt one and fence correction.
After finalization expiry, the reconciler may settle known usage, release the
never-dispatched attempt, and fail. Add a poll race regression.

Disposition: resolved in the corrected plan; exact-commit re-review pending.

### R4 Deterministic optional context

Finding: the optional selection names an undefined file relevance class and
does not define which candidate class starts alternation. It also claims that a
binary search finds the largest passing prefix without a monotonic token-count
contract.

Evidence: Phase 3 plan lines 207-215 and collector lines 505-570 at the reviewed
commit.

Required resolution: enumerate file classes and priorities, stable ties,
comment order, the initial alternation side, and exhaustion behavior. Replace
the maximality claim with a bounded-halving procedure that uses the first
exactly counted passing prefix. Test shuffled inputs, the exact manifest, and
the exact count-request sequence.

Disposition: resolved in the corrected plan; exact-commit re-review pending.

### R5 Comparison contract parity

Finding: the wire `Claim` omits the rendered `query` field, and the comparison
inventory omits changes to that search even though the existing contract,
renderer, and original comparator use it. The prose also calls the initial
comparison state both `initial-generation` and `initial`.

Evidence: Phase 3 plan lines 309-315 and 536-554, report contract lines 609-615,
renderer lines 603-610, and the pinned original comparator lines 510-517 at the
reviewed commit.

Required resolution: add required `Claim.query` handling with an empty-string
sentinel, trusted assembly, validation, effective rendered-search comparison,
and a regression fixture. Use `initial` consistently.

Disposition: resolved in the corrected plan; exact-commit re-review pending.

### R6 Bounded report catalog

Finding: one indefinitely retained catalog array is called bounded without an
entry ceiling, serialized-byte ceiling, page size, cursor contract, or repair
budget. `GET /api/reports` otherwise reads every referenced state in one call.

Evidence: Phase 3 plan lines 474-493, 949-956, and 1201-1202 and source limits
lines 4-18 at the reviewed commit.

Required resolution: define exact catalog ceilings and paged discovery. Bound
state reads and metadata repairs per request, return a stable validated cursor,
and have the browser merge bounded pages. Define admission behavior at the
ceiling without deleting reports. Test every exact boundary and a stale entry
on a later page.

Disposition: resolved in the corrected plan; exact-commit re-review pending.

### R7 Response-completion state

Finding: one transition moves a completed response to nonexistent state
`validating`, conflicting with the explicit response-complete and
finalization-token states.

Evidence: Phase 3 plan lines 668-687 at the reviewed commit.

Required resolution: move a primary response to
`primary-response-complete` and a corrective response to
`corrective-response-complete`, then separately claim finalization into the
corresponding validation state.

Disposition: resolved in the corrected plan; exact-commit re-review pending.

### R8 Pre-provider expiry ordering

Finding: the plan describes one CAS as releasing a job, spend reservation, and
repository claim even though they are separate Blob records.

Evidence: Phase 3 plan lines 849-852, 866-870, and 895-902 at the reviewed
commit.

Required resolution: state the exact ordered recovery: terminally fence the
exact job state, release any matching reservation, mark job accounting
complete, and finally clear only its repository claim. If the first CAS loses
to a paid transition, reconcile the newly observed state instead.

Disposition: resolved in the corrected plan; exact-commit re-review pending.

### R9 Discussion-decision enforcement

Finding: `stop` and `authorizedOperations` are stored without admission
semantics.

Evidence: Phase 3 plan lines 763-780 and 996-1000 at the reviewed commit.

Required resolution: make `required` to `stopped` permanently reject setup
admission under that price policy. An acknowledged admission must match its
authorized operations and ceiling as well as the lifetime cap. Enforce every
decision against exact revisions and policy identities.

Disposition: resolved in the corrected plan; exact-commit re-review pending.

### R10 Price-policy failure tests

Finding: the validation plan does not prove fail-closed behavior for an expired
or mismatched pricing attestation, policy, rates, billed-feature hash, deploy,
or unexpected billed response field.

Evidence: Phase 3 plan lines 416-423, 782-812, and 1124-1169 at the reviewed
commit.

Required resolution: add each mismatch case. A dispatched but unpriceable
attempt must become unknown at the greater of its full ceiling or known lower
bound, set `pricingReviewRequired`, prevent publication, and block later paid
work.

Disposition: resolved in the corrected plan; exact-commit re-review pending.

### R11 Fixed provider geography and service tier

Finding: corrected commit `3effe3ff19b12123011610f0d7c9871414b00699`
reserved only base rates while leaving `inference_geo` to the workspace
default. Current US-only inference costs 1.1 times the standard rates, so a paid
request could exceed its reservation. The service tier was also implicit.

Required resolution: pin every paid request and immutable price policy to
global inference and standard-only service. Require matching effective response
facts and treat missing or different billing classification as unknown exposure
that blocks publication and later paid work.

Disposition: resolved in the second corrected plan; exact-commit re-review
pending.

### R12 Bounded spend-ledger lifecycle

Finding: the corrected ledger retained every settled attempt in one record and
recomputed the aggregate from that unbounded history. Repeated zero-billed or
small jobs could fill the record, leaving a later paid response unable to
settle.

Required resolution: bound the ledger's bytes, policies, decisions, and active
jobs; reserve worst-case terminal serialization space before payment; retain
aggregate settled cost and a hash chain; keep terminal audit in each job; and
remove known accounting-complete active entries while retaining unknown
exposure. Add exact-cap and repeated zero-billed tests.

Disposition: resolved in the second corrected plan; exact-commit re-review
pending.

### R13 Expired corrective recovery order

Finding: one reconciler bullet on the corrected commit settled and released
spend before fencing expired `primary-invalid`, contradicting the global
job-first failure order.

Required resolution: CAS the exact expired job to terminal failed first, then
settle known primary usage, release the never-dispatched correction, complete
accounting, and clear the claim.

Disposition: resolved in the second corrected plan; exact-commit re-review
pending.

### R14 Prior-analysis reuse

Finding: the corrected no-verbatim corpus included the previously accepted
analysis while comparison treated its prose as reader-visible. Preserving valid
prose would fail the anti-copy check, while rephrasing it could create a false
`changed` result.

Required resolution: keep validated prior-analysis prose outside the raw-source
corpus and permit its reuse when the new source supports it. Retain the safety
screen and strict validation for the new output.

Disposition: resolved in the second corrected plan; exact-commit re-review
pending.

### R15 Exact no-verbatim normalization

Finding: global whitespace collapse erased the line boundaries needed by the
line rule, “case folding” did not select one runtime operation, and a complete
short raw item could be copied into one model field.

Required resolution: define ordered CR/LF, NFC, lowercase, line/full whitespace,
and Unicode code-point operations against the pinned runtime. Reject exact
whole-field equality at every nonempty length and state the shorter incidental
overlap that deterministic validation permits.

Disposition: resolved in the second corrected plan; exact-commit re-review
pending.

### R16 Background endpoint authentication

Finding: the capability-bound Netlify worker was listed as owner-session
authenticated even though admission invokes it server-to-server with only a job
ID and raw capability.

Required resolution: list it separately from browser API routes. Require
production, published-deploy, method, origin, body, and capability guards, and
never forward browser session, CSRF, or GitHub token material.

Disposition: resolved in the second corrected plan; exact-commit re-review
pending.

### R17 Concurrent ledger lost-ack proof

Finding: exact commit `80a41328a5e5b81fab0d0bbbf20f33f5827832e9`
stored only one global accounting digest. If job A lost its settlement response
and job B advanced that digest first, A could no longer prove its committed
transition from the bounded ledger entry.

Required resolution: preallocate and atomically update a fixed transition ID,
sequence, and digest in each active entry as well as the global chain. Recover a
lost acknowledgement from those per-entry facts even after another job advances
the global head. Treat accounting-complete entry removal as idempotent
housekeeping outside the monetary digest, and do not claim the compacted ledger
can reproduce every historical intermediate digest.

Disposition: resolved in the third corrected plan; exact-commit re-review
pending.

### R18 Cross-repository active-ledger recovery

Finding: the bounded capacity sweep handled terminal active entries but not an
expired pre-provider job belonging to another repository. Such entries could
retain reservations and fill the four-entry ledger indefinitely.

Required resolution: before every reservation, inspect all at-most-four active
jobs and run state-specific nonpaid reconciliation for expired entries. Leave
live and unknown entries untouched, and reject new paid work while an expired
entry remains unresolved.

Disposition: resolved in the third corrected plan; exact-commit re-review
pending.

## Confirmed design decisions

The reviews confirmed these parts of the exact plan:

- Every open issue and complete issue body remain mandatory. Only comments and
  selected file content may be omitted before the paid boundary.
- Assignment remains canonical source and comparison metadata but never creates
  progress or suppresses a start recommendation.
- Local and external references are bound to gathered facts. Unverified targets
  may support uncertainty only.
- Paid attempts use nonrenewable ownership and are never replayed after an
  ambiguous boundary.
- Immutable report versions, guarded current/previous rotation, strong read-back
  after uncertain writes, and nonpaid publication recovery preserve the last
  successful report.
- Historical report access remains independent of current GitHub eligibility,
  and source freshness remains separate from analysis state.
- The setup lifetime cap, discussion threshold, two-attempt reservation, and
  conservative unknown-exposure arithmetic are coherent. Ordinary production
  limits remain an explicit post-calibration owner decision.

## Open questions and limits

No additional product decision is required to resolve these findings. The
monthly production cap, per-report cap, and corrective-retry policy remain
deliberately deferred until measured calibration evidence exists. Ordinary paid
production analysis stays disabled until the owner records that decision.

This review establishes planning corrections only. It does not validate an
implementation, deployed Netlify artifact, GitHub behavior, Anthropic
credential, report quality, paid usage, or billing statement.

Prettier and markdownlint checks pass for this review artifact. The reviews
made no provider request or paid call.
