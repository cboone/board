function localIssueNumber(reference, repo, byNumber, repoUrl) {
  if (typeof reference === 'number') {
    return byNumber.has(reference) ? reference : null;
  }
  if (typeof repo !== 'string') return null;
  let number;
  if (typeof reference?.ref === 'string') {
    const separator = reference.ref.lastIndexOf('#');
    if (reference.ref.slice(0, separator).toLowerCase() !== repo.toLowerCase())
      return null;
    number = Number(reference.ref.slice(separator + 1));
  } else if (typeof reference?.url === 'string') {
    try {
      const source = new URL(repoUrl ?? `https://github.com/${repo}`);
      const target = new URL(reference.url);
      const prefix = `${source.pathname.replace(/\/$/u, '')}/issues/`;
      const matchesPath =
        source.hostname === 'github.com'
          ? target.pathname.toLowerCase().startsWith(prefix.toLowerCase())
          : target.pathname.startsWith(prefix);
      if (target.origin !== source.origin || !matchesPath) return null;
      const suffix = target.pathname.slice(prefix.length);
      if (!/^[1-9]\d*\/?$/u.test(suffix)) return null;
      number = Number(suffix.replace(/\/$/u, ''));
    } catch {
      return null;
    }
  } else return null;
  // Unlisted numbers can denote PRs or unavailable issues; they stay external.
  return byNumber.has(number) ? number : null;
}

/** Derive report presentation and eligibility from a validated report. */
function deriveReport(report) {
  const byNumber = new Map(report.issues.map((issue) => [issue.number, issue]));
  const laneOf = new Map();
  const companions = new Map();
  const unblocks = new Map();
  const eases = new Map();
  const append = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };
  const waits = (number) => byNumber.get(number).waitingOn ?? [];
  const afters = (number) => byNumber.get(number).after ?? [];
  const blocked = (number) => waits(number).length > 0;
  const localTarget = (reference) =>
    localIssueNumber(reference, report.repo, byNumber, report.repoUrl);

  for (const issue of report.issues) {
    if (issue.sameBranchAs != null) {
      append(companions, issue.sameBranchAs, issue.number);
    }
    for (const target of issue.waitingOn ?? []) {
      const number = localTarget(target);
      if (number != null) append(unblocks, number, issue.number);
    }
    for (const target of issue.after ?? []) {
      const number = localTarget(target);
      if (number != null) append(eases, number, issue.number);
    }
  }
  for (const lane of report.lanes) {
    for (const number of lane.issues) laneOf.set(number, lane);
  }

  const units = new Map();
  for (const issue of report.issues) {
    if (issue.sameBranchAs != null) continue;
    const riders = companions.get(issue.number) ?? [];
    const members = [issue.number, ...riders];
    const activeIssues = members.filter(
      (number) => byNumber.get(number).inProgress,
    );
    units.set(issue.number, {
      root: issue.number,
      companions: riders,
      activeIssues,
      inProgress: activeIssues.length
        ? byNumber.get(activeIssues[0]).inProgress
        : null,
      rootBlocked: blocked(issue.number),
      queued: members.some((number) =>
        afters(number).some((target) => localTarget(target) !== issue.number),
      ),
      uncertain: members.some(
        (number) => byNumber.get(number).uncertainty != null,
      ),
    });
  }

  const lanes = report.lanes.map((lane) => {
    const roots = lane.issues.filter(
      (number) => byNumber.get(number).sameBranchAs == null,
    );
    const activeRoots = roots.filter(
      (number) => units.get(number).activeIssues.length,
    );
    const canStart = (number) => {
      const unit = units.get(number);
      return (
        !unit.rootBlocked &&
        !unit.queued &&
        !unit.uncertain &&
        !unit.activeIssues.length
      );
    };
    const canRun = (number) => {
      const unit = units.get(number);
      return (
        !unit.rootBlocked &&
        !unit.uncertain &&
        (!unit.queued || unit.activeIssues.length > 0)
      );
    };
    const first = lane.issues[0];
    const head =
      lane.mode === 'head' ? (byNumber.get(first).sameBranchAs ?? first) : null;
    let runningRoots;
    let startableRoots;
    if (lane.mode === 'any') {
      runningRoots = roots.filter(
        (number) => canRun(number) || activeRoots.includes(number),
      );
      startableRoots = roots.filter(canStart);
    } else if (activeRoots.length) {
      runningRoots = [...activeRoots];
      startableRoots = [];
    } else {
      const next = lane.mode === 'head' ? head : roots.find(canRun);
      runningRoots = next != null && canRun(next) ? [next] : [];
      startableRoots = runningRoots.filter(canStart);
    }

    const companionCanRun = (number, root) => {
      const issue = byNumber.get(number);
      return (
        !blocked(number) &&
        !units.get(root).uncertain &&
        (afters(number).every((target) => localTarget(target) === root) ||
          Boolean(issue.inProgress))
      );
    };
    const nowIssues = new Set(
      runningRoots.flatMap((root) => [
        root,
        ...units
          .get(root)
          .companions.filter((number) => companionCanRun(number, root)),
      ]),
    );
    const headUnit =
      head == null ? new Set() : new Set([head, ...units.get(head).companions]);
    const freeingUnit =
      head == null
        ? new Set()
        : new Set([
            head,
            ...units
              .get(head)
              .companions.filter((number) => companionCanRun(number, head)),
          ]);
    const freedAfter =
      head != null &&
      runningRoots.length === 1 &&
      runningRoots[0] === head &&
      !units.get(head).uncertain
        ? roots.filter(
            (number) =>
              !headUnit.has(number) &&
              !units.get(number).uncertain &&
              waits(number).every((target) =>
                freeingUnit.has(localTarget(target)),
              ) &&
              [number, ...units.get(number).companions].every((member) =>
                afters(member).every((target) =>
                  freeingUnit.has(localTarget(target)),
                ),
              ),
          ).length
        : 0;

    const rankByIssue = new Map();
    if (lane.mode === 'serial') {
      let rank = 0;
      for (const number of lane.issues) {
        if (byNumber.get(number).sameBranchAs == null)
          rankByIssue.set(number, String(++rank));
      }
      for (const number of lane.issues) {
        if (!rankByIssue.has(number))
          rankByIssue.set(
            number,
            rankByIssue.get(byNumber.get(number).sameBranchAs),
          );
      }
    } else {
      for (const number of lane.issues)
        rankByIssue.set(number, headUnit.has(number) ? '1' : '·');
    }
    const stateByIssue = new Map(
      lane.issues.map((number) => {
        const root = byNumber.get(number).sameBranchAs ?? number;
        const state = blocked(number)
          ? 'blocked'
          : units.get(root).uncertain
            ? 'uncertain'
            : nowIssues.has(number)
              ? 'now'
              : 'queued';
        return [number, state];
      }),
    );
    return {
      lane,
      roots,
      activeRoots,
      runningRoots,
      startableRoots,
      nowIssues,
      rankByIssue,
      stateByIssue,
      capacity: runningRoots.length,
      freedAfter,
    };
  });

  const blockedIssues = report.issues
    .filter((issue) => blocked(issue.number))
    .sort(
      (left, right) =>
        waits(left.number).length - waits(right.number).length ||
        left.number - right.number,
    );
  return {
    byNumber,
    laneOf,
    units,
    lanes,
    blockedIssues,
    unblocks,
    eases,
    stats: {
      open: report.issues.length,
      ready: report.issues.length - blockedIssues.length,
      blocked: blockedIssues.length,
      lanes: lanes.length,
      branchesAtOnce: lanes.reduce((total, lane) => total + lane.capacity, 0),
      picks: report.startNow.length,
    },
  };
}

export { deriveReport, localIssueNumber };
