import { validateReport } from '../domain/report-contract.js';
import { deriveReport } from '../domain/lane-model.js';
import { createSourceLinks, proseReferences, safeUrl } from './links.js';

const WORDS = [
  'no',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];
const NO_MILESTONE = Symbol('no milestone');
const word = (n) => WORDS[n] ?? String(n);
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Render only a report verified against its independent source inventory. */
export function renderReport(mount, report, inventory) {
  const document = mount.ownerDocument;
  const window = document.defaultView;
  let interval = null;
  const dispose = () => {
    if (interval !== null) window.clearInterval(interval);
    interval = null;
  };
  const h = (tag, attributes, children) => {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes ?? {})) {
      if (value === null || value === undefined || value === false) continue;
      if (name === 'class') element.className = value;
      else element.setAttribute(name, value === true ? '' : String(value));
    }
    for (const child of [children ?? []].flat(Infinity)) {
      if (
        child === null ||
        child === undefined ||
        child === false ||
        child === ''
      )
        continue;
      element.append(child);
    }
    return element;
  };
  const hidden = (text) => h('span', { class: 'visually-hidden' }, text);
  mount.classList.add('report');
  const validation = validateReport(report, inventory);
  if (!validation.valid) {
    mount.classList.remove('no-milestones');
    mount.replaceChildren(
      h('section', { class: 'report-message', role: 'alert' }, [
        h('h2', null, 'Report unavailable'),
        h(
          'p',
          null,
          'The report does not match its source inventory. No report data has been displayed.',
        ),
        h(
          'ul',
          null,
          validation.errors.map((error) =>
            h('li', null, `${error.path}: ${error.message}`),
          ),
        ),
      ]),
    );
    return dispose;
  }

  const model = deriveReport(report);
  const { byNumber, laneOf, units, lanes, unblocks, eases, stats } = model;
  const links = createSourceLinks(report);
  const issues = report.issues;
  const picks = report.startNow;
  const notes = report.notes ?? {};
  const anyMilestone = issues.some((issue) => issue.milestone);
  const link = (href, text, className = 'ref') =>
    h(
      safeUrl(href) ? 'a' : 'span',
      { class: className, href: safeUrl(href) },
      text,
    );
  const ref = (number) => link(links.issue(number), `#${number}`, 'ref num');
  const prose = (text) =>
    proseReferences(text, links).map((part) =>
      typeof part === 'string' ? part : link(part.href, part.text),
    );
  const shortTitle = (number) =>
    byNumber.get(number)?.short || byNumber.get(number)?.title || '';
  const laneLabel = (lane) => `${lane.key} ${lane.name}`;
  const unitOf = (number) =>
    units.get(byNumber.get(number)?.sameBranchAs ?? number);
  const chip = (milestone) =>
    link(
      links.milestone(milestone),
      milestone || 'No milestone',
      milestone ? 'chip' : 'chip chip--none',
    );

  function reference(value) {
    if (typeof value === 'number')
      return {
        link: ref(value),
        title: shortTitle(value),
        from: laneOf.has(value) ? laneLabel(laneOf.get(value)) : '',
      };
    if (value.pr != null)
      return {
        link: link(links.pull(value.pr), `PR #${value.pr}`, 'ref num'),
        title: value.title,
        from: 'a pull request',
      };
    if (value.branch != null)
      return {
        link: link(links.compare(value.branch), value.branch),
        title: value.title,
        from: 'a branch merge',
      };
    if (value.ref != null)
      return {
        link: link(links.crossIssue(value.ref), value.ref),
        title: value.title,
        from: value.ref.split('#')[0],
      };
    return {
      link: link(value.url, value.label),
      title: value.title,
      from: 'outside the repository',
    };
  }

  function tokens(parts) {
    const result = [];
    for (const [label, entries, soft] of parts) {
      if (!entries.length) continue;
      if (result.length) result.push(' · ');
      result.push(`${label} `);
      entries.forEach((entry, index) => {
        if (index) result.push(', ');
        const node = reference(entry).link;
        if (soft) node.classList.add('ref--soft');
        result.push(node);
      });
    }
    return result;
  }

  function progressTag(where) {
    const href = links.progress(where);
    return h(
      href ? 'a' : 'span',
      { class: 'tag', href, title: `In progress on ${where}` },
      ['In progress', hidden(` on ${where}`)],
    );
  }

  function uncertainty(issue) {
    if (!issue.uncertainty) return null;
    return h('span', { class: 'item-uncertainty' }, [
      h('strong', { class: 'uncertainty-label' }, 'Uncertain: '),
      prose(issue.uncertainty.reason),
      issue.uncertainty.reference
        ? [' ', reference(issue.uncertainty.reference).link]
        : null,
    ]);
  }

  function section(id, title, note, body, compact = false) {
    return h(
      'section',
      {
        class: `section${compact ? ' section--compact' : ''}`,
        'aria-labelledby': `${id}-heading`,
      },
      [
        h('div', { class: 'section-head' }, [
          h('h2', { class: 'section-title', id: `${id}-heading` }, title),
          note ? h('p', { class: 'section-note' }, prose(note)) : null,
        ]),
        body,
      ],
    );
  }

  const syncedAt = new Date(report.sync.at);
  const formatSync = (locale, options) =>
    new Intl.DateTimeFormat(locale, {
      ...options,
      timeZone: report.sync.timeZone ?? undefined,
    }).format(syncedAt);
  const dateText = formatSync('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const timeText = formatSync('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  });
  const age = h('p', { class: 'when-age' });
  function refreshAge() {
    const minutes = Math.max(
      0,
      Math.floor((Date.now() - syncedAt.getTime()) / 60000),
    );
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    age.textContent =
      days >= 1
        ? `Synced ${count(days, 'day', 'days')} ago`
        : hours >= 1
          ? `Synced ${count(hours, 'hour', 'hours')} ago`
          : minutes >= 1
            ? `Synced ${count(minutes, 'minute', 'minutes')} ago`
            : 'Synced just now';
    age.classList.toggle('is-aging', days >= 1 && days < 3);
    age.classList.toggle('is-stale', days >= 3);
  }
  refreshAge();
  const header = h('header', { class: 'head' }, [
    h('div', { class: 'head-top' }, [
      h('div', { class: 'head-title' }, [
        h('p', { class: 'eyebrow' }, 'Backlog review'),
        h(
          'h1',
          { class: 'title' },
          link(links.repository, report.repo, 'repo-link'),
        ),
        report.title !== report.repo
          ? h('p', { class: 'report-title' }, report.title)
          : null,
      ]),
      h('div', { class: 'when' }, [
        h('time', { class: 'when-date', datetime: report.sync.at }, dateText),
        h('p', { class: 'when-time' }, timeText),
        age,
      ]),
    ]),
    h(
      'dl',
      { class: 'stats', 'aria-label': 'Report counts' },
      [
        [stats.open, 'Open'],
        [stats.ready, 'Ready'],
        [stats.blocked, 'Blocked'],
        [stats.lanes, 'Lanes'],
        [stats.branchesAtOnce, 'Branches at once'],
        [stats.picks, 'Picks'],
      ].map(([value, label]) =>
        h('div', { class: 'stat' }, [
          h('dt', { class: 'stat-label' }, label),
          h('dd', { class: 'stat-value' }, String(value)),
        ]),
      ),
    ),
  ]);

  function startRow(pick, index) {
    const lane = laneOf.get(pick.issue);
    const companions = units.get(pick.issue).companions;
    return h('li', { class: 'start-row' }, [
      h(
        'span',
        { class: 'start-rank', 'aria-hidden': 'true' },
        String(index + 1),
      ),
      h('div', null, [
        h('p', { class: 'start-title' }, [
          ref(pick.issue),
          ' ',
          h('span', { class: 'issue-title' }, shortTitle(pick.issue)),
        ]),
        companions.length
          ? h(
              'p',
              { class: 'start-with' },
              tokens([['share a branch with', companions]]),
            )
          : null,
      ]),
      h('p', { class: 'start-why' }, prose(pick.why)),
      h('div', { class: 'start-lane' }, [
        h('span', { class: 'badge' }, lane.key),
        h('div', null, [
          h('p', { class: 'start-lane-name' }, lane.name),
          pick.touches
            ? h('p', { class: 'start-touches' }, pick.touches)
            : null,
          anyMilestone
            ? [
                h('p', { class: 'mini-label' }, 'Milestone'),
                chip(byNumber.get(pick.issue).milestone),
              ]
            : null,
        ]),
      ]),
    ]);
  }
  const idle = lanes.some((lane) => lane.startableRoots.length);
  const hasUncertainty = issues.some((issue) => issue.uncertainty);
  const emptyStartNote = !issues.length
    ? 'There are no open issues to start.'
    : idle
      ? 'No branches picked today.'
      : hasUncertainty
        ? 'No new branches can start while the affected work remains uncertain, blocked, queued, or in progress.'
        : 'Nothing can start today: every issue is blocked, queued behind another, or already in progress.';
  const startSection = section(
    'start-now',
    'Start now',
    notes.startNow ||
      (picks.length
        ? `${capitalize(word(picks.length))} ${picks.length === 1 ? 'branch' : 'branches'} to open today.`
        : emptyStartNote),
    picks.length
      ? h('ol', { class: 'start', role: 'list' }, picks.map(startRow))
      : null,
    true,
  );

  function barRow(laneModel) {
    const { lane, stateByIssue } = laneModel;
    const states = lane.issues.map((n) => stateByIssue.get(n));
    const tally = (state) => states.filter((value) => value === state).length;
    return h('div', { class: 'bar-row' }, [
      h('p', { class: 'bar-name' }, [
        h('span', { class: 'badge badge--small' }, lane.key),
        h('span', null, lane.name),
      ]),
      h(
        'div',
        {
          class: 'bar',
          role: 'img',
          'aria-label': `${laneLabel(lane)}: ${tally('now')} can run now, ${tally('queued')} queued, ${tally('blocked')} blocked, ${tally('uncertain')} uncertain`,
        },
        states.map((state) => h('span', { class: `seg seg--${state}` })),
      ),
      h(
        'p',
        { class: 'bar-legend' },
        `${tally('now')} of ${count(states.length, 'issue', 'issues')}`,
      ),
    ]);
  }

  function laneItem(number, laneModel) {
    const issue = byNumber.get(number);
    const rank = laneModel.rankByIssue.get(number);
    const stateWord = {
      now: 'can run now',
      queued: 'queued',
      blocked: 'blocked',
      uncertain: 'uncertain',
    }[laneModel.stateByIssue.get(number)];
    const deps = tokens([
      [
        'same branch as',
        issue.sameBranchAs == null ? [] : [issue.sameBranchAs],
      ],
      ['waits on', issue.waitingOn ?? []],
      ['better after', issue.after ?? [], true],
      ['unblocks', unblocks.get(number) ?? []],
      ['eases', eases.get(number) ?? [], true],
    ]);
    const affectedUnit = unitOf(number);
    const heldUncertain = !issue.uncertainty && affectedUnit.uncertain;
    return h('li', { class: 'item', 'data-issue': number }, [
      h(
        'span',
        { class: 'item-rank', 'aria-hidden': rank === '·' ? 'true' : null },
        [hidden('Step '), rank],
      ),
      h('span', { class: 'item-num' }, [
        hidden('Issue '),
        ref(number),
        hidden(`, ${stateWord}.`),
      ]),
      h('span', { class: 'item-title' }, [
        h('span', { class: 'issue-title' }, issue.title),
        issue.inProgress ? progressTag(issue.inProgress) : null,
        uncertainty(issue),
        heldUncertain
          ? h(
              'span',
              { class: 'item-uncertainty' },
              'This branch shares uncertain work; its start is withheld.',
            )
          : null,
      ]),
      anyMilestone
        ? h('span', { class: 'item-ms' }, [
            hidden('Milestone: '),
            chip(issue.milestone),
          ])
        : null,
      h(
        'span',
        { class: 'item-deps' },
        deps.length ? [hidden('Dependencies: '), deps] : null,
      ),
    ]);
  }

  function laneBlock(laneModel) {
    const { lane, capacity, freedAfter } = laneModel;
    const unit =
      lane.mode === 'any'
        ? capacity === 1
          ? 'branch at once'
          : 'branches at once'
        : capacity === 1
          ? 'branch at a time'
          : 'branches at a time';
    const then =
      lane.mode === 'head' && freedAfter > 0
        ? freedAfter === 1
          ? 'then one more'
          : `then ${word(freedAfter)} at once`
        : '';
    const blocked = lane.issues.filter(
      (n) => laneModel.stateByIssue.get(n) === 'blocked',
    ).length;
    const overlap = lane.mode !== 'any' && laneModel.activeRoots.length > 1;
    return h('li', { class: 'lane' }, [
      h('div', { class: 'lane-meta' }, [
        h('h3', { class: 'lane-title' }, [
          h('span', { class: 'badge' }, lane.key),
          h('span', null, lane.name),
        ]),
        h('div', { class: 'cap' }, [
          h('p', { class: 'cap-line' }, [
            h('span', { class: 'cap-figure' }, String(capacity)),
            h('span', { class: 'cap-unit' }, unit),
          ]),
          then ? h('p', { class: 'cap-then' }, then) : null,
        ]),
        h('div', { class: 'lane-facts' }, [
          h(
            'p',
            { class: 'lane-count' },
            `${count(lane.issues.length, 'issue', 'issues')} · ${blocked} blocked`,
          ),
          lane.owns ? h('p', { class: 'lane-owns' }, lane.owns) : null,
          overlap
            ? h(
                'p',
                { class: 'lane-overlap' },
                `${laneModel.activeRoots.length} branches already in progress; existing overlap holds this lane.`,
              )
            : null,
        ]),
      ]),
      h('div', { class: 'lane-content' }, [
        lane.note ? h('p', { class: 'lane-note' }, prose(lane.note)) : null,
        h(
          'div',
          { class: 'cols', 'aria-hidden': 'true' },
          [
            '#',
            'Issue',
            'Title',
            anyMilestone ? 'Milestone' : null,
            'Dependency',
          ]
            .filter(Boolean)
            .map((label) => h('span', null, label)),
        ),
        h(
          'ol',
          { class: 'items', role: 'list' },
          lane.issues.map((n) => laneItem(n, laneModel)),
        ),
      ]),
    ]);
  }
  const keyItem = (state, label) =>
    h('span', { class: 'key-item' }, [
      h('span', { class: `seg seg--${state}` }),
      label,
    ]);
  const lanesSection = section(
    'lanes',
    'Lanes',
    issues.length
      ? "Each lane's order is the order to work in. One segment per issue shows what can run now, what is queued, blocked, or uncertain. Branch capacity counts shared branches once and includes work already in progress."
      : 'There are no open issues or work lanes.',
    lanes.length
      ? [
          h('div', { class: 'bars' }, lanes.map(barRow)),
          h('div', { class: 'key', 'aria-hidden': 'true' }, [
            keyItem('now', 'can run now'),
            keyItem('queued', 'queued'),
            keyItem('blocked', 'blocked'),
            hasUncertainty ? keyItem('uncertain', 'uncertain') : null,
          ]),
          h('ol', { class: 'lanes', role: 'list' }, lanes.map(laneBlock)),
        ]
      : null,
  );

  const claims = report.contention?.claims ?? [];
  const rowLabel = report.contention?.rowLabel || 'Component';
  const milestoneKey = (number) =>
    byNumber.get(number)?.milestone || NO_MILESTONE;
  const listed = (report.milestones ?? []).map((milestone) => milestone.title);
  const shortName = new Map(
    (report.milestones ?? []).map((milestone) => [
      milestone.title,
      milestone.short || milestone.title,
    ]),
  );
  const seen = [];
  for (const claim of claims)
    for (const n of claim.issues)
      if (!seen.includes(milestoneKey(n))) seen.push(milestoneKey(n));
  const position = (key) =>
    key === NO_MILESTONE
      ? Number.MAX_SAFE_INTEGER
      : listed.includes(key)
        ? listed.indexOf(key)
        : listed.length + seen.indexOf(key);
  const columns = [...seen].sort((a, b) => position(a) - position(b));
  const anyClaimMilestone = columns.some((key) => key !== NO_MILESTONE);
  function contentionNote() {
    if (notes.contention) return notes.contention;
    if (!claims.length) return 'No shared component contention is recorded.';
    const across = claims.filter(
      (claim) => new Set(claim.issues.map(milestoneKey)).size > 1,
    ).length;
    const within = claims.length - across;
    const lead = `${capitalize(word(claims.length))} ${rowLabel} ${claims.length === 1 ? 'row is' : 'rows are'} claimed by more than one issue`;
    let split = anyClaimMilestone ? ', each within one milestone.' : '.';
    if (across && within)
      split = `: ${word(across)} across milestones, ${word(within)} within one.`;
    else if (across)
      split =
        claims.length === 1
          ? ', across milestones.'
          : ', all across milestones.';
    return `${lead}${split} Filled cells identify shared work that may need a rebase. Names link to every open issue that mentions them.`;
  }
  const matrixSection = section(
    'contention',
    'Contention matrix',
    contentionNote(),
    claims.length
      ? h(
          'div',
          {
            class: 'matrix-scroll',
            tabindex: '0',
            role: 'region',
            'aria-label': 'Contention matrix, scrollable table',
          },
          h('table', { class: 'matrix' }, [
            h(
              'caption',
              { class: 'visually-hidden' },
              'Shared components claimed by open issues, grouped by milestone',
            ),
            h('colgroup', null, [
              h('col', { class: 'matrix-first' }),
              columns.map(() => h('col', { class: 'matrix-column' })),
            ]),
            h(
              'thead',
              null,
              h('tr', null, [
                h(
                  'th',
                  { scope: 'col' },
                  anyClaimMilestone ? `${rowLabel} / milestone` : rowLabel,
                ),
                columns.map((key) =>
                  key === NO_MILESTONE
                    ? h(
                        'th',
                        { scope: 'col' },
                        anyClaimMilestone ? 'No milestone' : 'Claimed by',
                      )
                    : h(
                        'th',
                        { scope: 'col', title: key },
                        link(links.milestone(key), shortName.get(key) ?? key),
                      ),
                ),
              ]),
            ),
            h(
              'tbody',
              null,
              claims.map((claim) =>
                h('tr', null, [
                  h(
                    'th',
                    { scope: 'row' },
                    link(
                      links.search(claim.query || `is:open ${claim.name}`),
                      claim.name,
                    ),
                  ),
                  columns.map((key) => {
                    const hits = claim.issues.filter(
                      (n) => milestoneKey(n) === key,
                    );
                    return h(
                      'td',
                      { class: hits.length ? 'hit' : null },
                      hits.length
                        ? h('div', { class: 'hit-refs' }, hits.map(ref))
                        : null,
                    );
                  }),
                ]),
              ),
            ),
          ]),
        )
      : null,
  );

  const blockedIssues = [...model.blockedIssues].sort(
    (a, b) => a.waitingOn.length - b.waitingOn.length || a.number - b.number,
  );
  function blockedRow(issue) {
    const refs = issue.waitingOn.map(reference);
    const freeing = [...new Set(refs.map((r) => r.from).filter(Boolean))];
    const label = (text) => h('span', { class: 'cell-label' }, text);
    return h('li', { class: 'blocked-row' }, [
      h('p', { class: 'blocked-issue' }, [
        ref(issue.number),
        ' ',
        shortTitle(issue.number),
      ]),
      h('div', { class: 'waiting' }, [
        label('Waiting on'),
        refs.map((r) =>
          h('p', { class: 'waiting-item' }, [
            r.link,
            r.title
              ? [' ', h('span', { class: 'waiting-title' }, r.title)]
              : null,
          ]),
        ),
      ]),
      h('p', { class: 'blocked-why' }, [
        label('Why it cannot start'),
        prose(issue.blockedBecause),
      ]),
      h('p', { class: 'blocked-lane' }, [
        label('Freed from'),
        freeing.join(' + '),
      ]),
    ]);
  }
  const blockedSection = section(
    'blocked',
    'Blocked',
    notes.blocked ||
      (blockedIssues.length
        ? `${capitalize(word(blockedIssues.length))} ${blockedIssues.length === 1 ? 'issue waits' : 'issues wait'} on other open work.`
        : 'Nothing is blocked.'),
    blockedIssues.length
      ? [
          h(
            'div',
            { class: 'blocked-cols', 'aria-hidden': 'true' },
            ['Issue', 'Waiting on', 'Why it cannot start', 'Freed from'].map(
              (label) => h('span', null, label),
            ),
          ),
          h(
            'ol',
            { class: 'blocked-list', role: 'list' },
            blockedIssues.map(blockedRow),
          ),
        ]
      : null,
    true,
  );

  const milestoneCount = new Set(
    issues.map((issue) => issue.milestone).filter(Boolean),
  ).size;
  const withoutMilestone = issues.filter((issue) => !issue.milestone).length;
  const footer = h('footer', { class: 'sync' }, [
    'Synced ',
    h('strong', null, `${dateText}, ${timeText}`),
    ' against ',
    link(links.branch(report.sync.branch), report.sync.branch),
    ' at ',
    link(links.commit(report.sync.commit), report.sync.commit.slice(0, 8)),
    '. ',
    milestoneCount
      ? [
          `${count(issues.length, 'open issue', 'open issues')} across `,
          link(
            `${links.repository}/milestones`,
            count(milestoneCount, 'milestone', 'milestones'),
          ),
          withoutMilestone ? `, ${withoutMilestone} without one` : '',
        ]
      : `${count(issues.length, 'open issue', 'open issues')}, none in a milestone`,
    typeof report.sync.openPullRequests === 'number'
      ? `, ${count(report.sync.openPullRequests, 'open PR', 'open PRs')}`
      : '',
    (report.sync.extra ?? []).map((fact) => `, ${fact}`),
    '. Refresh the report after issue, milestone, pull request, branch, or repository file changes. GitHub and the repository are the source of truth; this page is a snapshot.',
  ]);
  mount.classList.toggle('no-milestones', !anyMilestone);
  mount.replaceChildren(
    header,
    h('div', { class: 'body' }, [
      h('p', { class: 'summary' }, prose(report.summary)),
      startSection,
      lanesSection,
      matrixSection,
      blockedSection,
      footer,
    ]),
  );
  interval = window.setInterval(refreshAge, 60000);
  return dispose;
}
