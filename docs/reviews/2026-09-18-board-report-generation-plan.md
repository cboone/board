# Board report generation plan review

Date: 2026-09-18

Status: needs revision. Three independent reviews of exact planning commit
`976e1249f9b54776f44c0956e26bc2990e144125` found ten required corrections
before implementation. The implementation baseline is Phase 2 merge
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

Disposition: pending plan correction.

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

Disposition: pending plan correction.

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

Disposition: pending plan correction.

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

Disposition: pending plan correction.

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

Disposition: pending plan correction.

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

Disposition: pending plan correction.

### R7 Response-completion state

Finding: one transition moves a completed response to nonexistent state
`validating`, conflicting with the explicit response-complete and
finalization-token states.

Evidence: Phase 3 plan lines 668-687 at the reviewed commit.

Required resolution: move a primary response to
`primary-response-complete` and a corrective response to
`corrective-response-complete`, then separately claim finalization into the
corresponding validation state.

Disposition: pending plan correction.

### R8 Pre-provider expiry ordering

Finding: the plan describes one CAS as releasing a job, spend reservation, and
repository claim even though they are separate Blob records.

Evidence: Phase 3 plan lines 849-852, 866-870, and 895-902 at the reviewed
commit.

Required resolution: state the exact ordered recovery: terminally fence the
exact job state, release any matching reservation, mark job accounting
complete, and finally clear only its repository claim. If the first CAS loses
to a paid transition, reconcile the newly observed state instead.

Disposition: pending plan correction.

### R9 Discussion-decision enforcement

Finding: `stop` and `authorizedOperations` are stored without admission
semantics.

Evidence: Phase 3 plan lines 763-780 and 996-1000 at the reviewed commit.

Required resolution: make `required` to `stopped` permanently reject setup
admission under that price policy. An acknowledged admission must match its
authorized operations and ceiling as well as the lifetime cap. Enforce every
decision against exact revisions and policy identities.

Disposition: pending plan correction.

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

Disposition: pending plan correction.

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
