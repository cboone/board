# Report contract

Board's fixture experience uses a source-bound backlog report, a shared lane
model, and a DOM renderer. These modules do not authenticate users, gather GitHub
data, call a model, or persist reports. The synthetic inputs are in
[the fixture module](../src/fixtures/reports.js).

## Module interfaces

| Module                                               | Interface                                | Result                                                   |
| ---------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| [Report validator](../src/domain/report-contract.js) | `validateReport(report, inventory)`      | `{ valid, errors }`                                      |
| [Lane model](../src/domain/lane-model.js)            | `deriveReport(report)`                   | Lookups, branch units, lane state, relations, and counts |
| [Renderer](../src/report/render.js)                  | `renderReport(mount, report, inventory)` | An idempotent disposal function                          |
| [Source links](../src/report/links.js)               | `createSourceLinks(report)`              | Encoded source URL builders                              |

The validator accepts external input without throwing on malformed data. Each
error has `path`, `code`, and `message`, for example:

```json
{
  "valid": false,
  "errors": [
    {
      "path": "report.issues",
      "code": "missing_issue",
      "message": "Open issue #101 is missing."
    }
  ]
}
```

Call `deriveReport` only on validated data. The renderer runs validation itself
and displays a visible “Report unavailable” error instead of partial report
content when validation fails. Validation and rendering use the same lane model
for eligibility; presentation code must not calculate a separate set of starts.

## Report and inventory

The report requires `board`, `title`, `repo`, `sync`, `summary`, `issues`, `lanes`,
and `startNow`. The supported `board` value is `backlog-triage`. Optional top-level
fields are `repoUrl`, `milestones`, `contention`, and `notes`.

The independent inventory requires `board`, `title`, `repo`, `sync`, and `issues`;
it may also supply `repoUrl`. Its issue records contain canonical `number`,
`title`, `milestone`, and `inProgress`. Use explicit `null` for absent inventory
milestones and progress evidence. It does not need analysis fields such as lanes
or dependencies.

Author fixture inventories independently of the report under validation. A future
collector must assemble complete, paginated source inventories before analysis;
the model's returned issue list cannot serve as its own inventory. Validation
detects omissions and additions relative to the inventory, but cannot prove that
an incorrectly assembled inventory includes every source issue.

Report identity, normalized repository URL, sync metadata, issue titles,
milestone membership, and progress evidence must match the inventory. Omitting
`repoUrl` means `https://github.com/OWNER/REPOSITORY`; an equivalent explicit URL
with a trailing slash is accepted. Canonical issue titles remain verbatim even
when an optional `short` title is used in recommendations or blocked summaries.

### Sync fields

`sync.at` is a calendar-valid ISO timestamp with a numeric offset or `Z`.
`sync.branch` names the source branch without whitespace or dot path segments.
`sync.commit` is a full lowercase hexadecimal SHA, either 40 or 64 characters.
Optional fields are a recognized IANA `timeZone`, a nonnegative
`openPullRequests` count, and an `extra` list of nonempty facts. Supply `timeZone`
when viewers should see the same display zone. All supplied sync facts are bound
to the independent inventory.

### Issue fields and references

Each report issue requires a unique positive safe-integer `number`, a nonempty
`title`, and `milestone`, using `null` when absent. Optional analysis fields are
`short`, `waitingOn`, `blockedBecause`, `after`, `sameBranchAs`, `inProgress`, and
`uncertainty`.

`waitingOn` expresses a hard blocker. It requires a nonempty `blockedBecause`
reason whenever its list is nonempty; a reason without a hard blocker is invalid.
`after` expresses soft ordering. Both lists accept these reference forms:

| Form                                                         | Meaning                                  |
| ------------------------------------------------------------ | ---------------------------------------- |
| `101`                                                        | An open issue on this report             |
| `{ "pr": 390 }`                                              | A pull request in the source repository  |
| `{ "branch": "feature/api" }`                                | A branch compared with the synced branch |
| `{ "ref": "other/package#17" }`                              | A repository issue reference             |
| `{ "url": "https://example.com/design", "label": "Design" }` | A labeled external source                |

Reference objects name exactly one target kind and may include `title`. A `pr`
cannot mislabel a known issue number. A `ref` matching the current repository and
a known open issue is treated as the same local target as its number, including
case differences in repository names. An ordinary `/issues/N` URL under the
source repository's origin and path also resolves to that known local issue.
Other origins, repository paths, and unlisted numbers remain external. Local
equivalence applies to dependency cycles, self-references, hard/soft duplicates,
branch ordering, reverse relations, and head freeing. The displayed reference
can retain its authored form.

Reject issue dependency cycles across hard and soft relations, including mixed
cycles. Also reject cycles between branch units through root hard blockers or
any member's soft ordering. A target cannot appear in both `waitingOn` and
`after`, and soft ordering between members of the same branch is invalid.

These checks establish structural consistency. They do not prove that a claimed
dependency, footprint, external blocker, or component grouping is factually
correct. Source gathering and analysis remain responsible for those judgments.

### Lanes, recommendations, and contention

Every open issue belongs to exactly one lane position. Each lane has a unique
`key`, nonempty `name`, `mode` (`serial`, `head`, or `any`), and a nonempty `issues`
list. Optional `owns` and `note` describe its footprint and ordering.

Each `startNow` pick has an `issue`, a concrete `why`, and optional `touches`.
Picks are unique, eligible new branch roots. Recommendations may use fewer
eligible branches when `notes.startNow` provides a nonempty explanation. The
other supported notes are `blocked` and `contention`.

`milestones` supplies display records with `title` and optional `short`.
`contention` has optional `rowLabel` and a `claims` list. Each claim has a unique
`name`, optional issue-search `query`, and at least two distinct issue numbers.
Claimed issues must be present and share one lane; a shared component cannot
span independently runnable lanes.

## Branch units and lane state

An issue with `sameBranchAs` is a companion of another root issue. Companions
share their root's lane, cannot form chains, and do not create separate branches
or independent picks.

A companion's independent hard blocker holds back that companion without
automatically blocking a runnable root. Soft ordering on any member queues the
whole unit. Active work on a root or companion occupies the branch's slot.
Uncertainty on any member suppresses new starts for the unit.

- A `serial` lane skips roots that cannot run and permits its first eligible
  root when no active branch holds the slot.
- A `head` lane permits only its head until that work lands. Blocked, queued,
  or uncertain heads hold later roots. `freedAfter` counts subsequent roots
  released by the head and its admitted companions, excluding roots still held
  by independent blockers, companion soft ordering, or uncertainty.
- An `any` lane counts independently runnable branch units and retains existing
  active work even if its current dependency state differs.

Existing active overlap in a serial or head lane stays visible and contributes
to occupied capacity. It does not authorize another new pick. Assignment alone
is not progress evidence: the canonical inventory must identify a related
`PR #N`, a branch identifier, or `the in progress label`. A report cannot invent
or omit known source progress.

Hosted reports can observe only GitHub-visible source evidence. Unpushed local
branches and worktrees are outside the source inventory.

`deriveReport` returns `byNumber`, `laneOf`, `units`, `lanes`, `blockedIssues`,
`unblocks`, `eases`, and `stats`. `laneOf` values are raw report lanes. `units` is
keyed by root number and exposes companions, active issues, progress evidence,
root blocking, soft queuing, and uncertainty. Each derived lane exposes roots,
active/running/startable roots, `nowIssues`, `rankByIssue`, `stateByIssue`,
`capacity`, and `freedAfter`. Visible issue states are `now`, `queued`, `blocked`,
or `uncertain`; an active issue can still display a blocked or uncertain state.
The lane module also exports
`localIssueNumber(reference, repo, byNumber, repoUrl?)`, which resolves numeric
or known current-repository issue references and source issue URLs to a number,
and returns `null` for other targets.

### Header counts

| Model field      | Definition                                                       |
| ---------------- | ---------------------------------------------------------------- |
| `open`           | Complete report issue count                                      |
| `ready`          | Open issues minus issues with hard blockers                      |
| `blocked`        | Issues with a nonempty `waitingOn` list                          |
| `lanes`          | Report lane count                                                |
| `branchesAtOnce` | Sum of lane capacity, counting branch roots and active occupancy |
| `picks`          | Number of recommended new branches                               |

Ready is not a start count. Queued, active, and uncertain issues can remain ready
under the original header definition. Companions count as issues, but count only
once with their root when measuring branch capacity.

## Uncertainty and empty backlogs

An affected issue may carry `uncertainty: { reason, reference? }`. The reason is
nonempty; the optional reference uses the source forms above and can cite the
issue itself because it is evidence, not a dependency edge. Show unclear scope
or unverifiable blockers here rather than inventing a verified dependency state.
Keep the affected issue visible, withhold its unit's start, and render the rest
of the valid report. An uncertain head also holds its lane.

An empty source backlog is valid when issues, lanes, and picks are all empty.
The renderer shows zero counts and meaningful Start now, Lanes, Contention matrix,
and Blocked sections. Empty lanes cannot conceal a nonempty inventory.

## Report safety limits

The validator exports `REPORT_LIMITS`. Structural inspection applies separately
to the report and inventory, including unknown fields. Strings and field names
must not contain control characters; values must be plain JSON without circular
objects or nonfinite numbers.

| Limit                | Value     | Scope                                           |
| -------------------- | --------- | ----------------------------------------------- |
| `issues`             | 1,000     | Issues in either input                          |
| `arrayLength`        | 2,000     | Any inspected array                             |
| `referencesPerIssue` | 100       | Each issue's hard or soft reference list        |
| `depth`              | 16        | Nesting depth, with the input root at zero      |
| `nodes`              | 50,000    | Inspected values per input                      |
| `textLength`         | 20,000    | Length of an individual string or field name    |
| `totalTextLength`    | 2,000,000 | Combined string and field-name length per input |
| `errors`             | 100       | Returned errors per validation call             |

Text lengths use JavaScript string length. These are report safety and rendering
bounds. They do not authorize paid analysis, define provider token budgets, or
set future repository-file and model-input gathering limits.

## Rendering, links, and CSP

`renderReport` builds text nodes and elements without `innerHTML`, inline style
attributes, or dynamic script execution. The stylesheet is scoped to `.report`,
uses system fonts, and follows the shell's light/dark theme. Dispose the previous
render before replacing its mount or changing scenarios; successful renders use
one age interval updating once per minute, and invalid renders allocate none.
Disposal clears
the interval and is safe to call repeatedly.

Generated issue, PR, branch, commit, and milestone links use GitHub or the
inventory-verified optional repository base. Branch path segments and search
queries are encoded; milestone qualifiers escape quotes and backslashes before
query encoding. Prose issue references are linked without interpreting ordinary
language such as `C#1` or URL fragments as issue references.

Explicit external references require HTTPS, a DNS-style hostname, and a visible
label. Validation rejects URL credentials, whitespace, backslashes, double
quotes, and angle brackets. Link helpers defensively return no destination for
unsafe values, allowing plain-text fallback. Links navigate in the current
browser context and the site uses `Referrer-Policy: no-referrer`. Future links
opening another tab require `noopener noreferrer`. External references are not
fetch instructions.

[The static response headers](../public/_headers) restrict scripts, styles,
fonts, and connections to the site's own origin. The built-site browser suite
exercises those headers with Alpine CSP and external Vite assets. Fixture routes
remain static and contain no application Functions or service credentials.

## Source provenance and deliberate adaptations

The semantic and design baseline is `publish-report-board` version `1.0.0` at
immutable source revision `046f1389caf53d6ec8c81e8c88b927a40d154b79`. Read its
[original skill and report sources][original-source], especially the backlog
type, sync metadata, design conventions, validator, and HTML template.

The application preserves the original sections, source links, six counts,
same-branch behavior, lane modes, active overlap, and milestone contention.
Deliberate adaptations are independent inventory binding, bounded plain-JSON
validation, mixed and branch-unit cycle checks, local-reference equivalence,
successor companion constraints in head freeing, explicit uncertainty, empty
backlogs, and the assignment-only override. The DOM mount API, external assets,
system fonts, scoped theme styles, and disposable age interval support the Vite
application and its CSP.

Application job, freshness, provider, and retention metadata stay outside this
report payload. Durable current and previous successful reports belong to a
future server implementation; the fixture contract does not claim that storage
or authenticated access exists.

[original-source]: https://github.com/cboone/agent-harness-plugins/tree/046f1389caf53d6ec8c81e8c88b927a40d154b79/plugins/publish-report-board
