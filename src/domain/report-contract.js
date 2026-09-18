import { deriveReport, localIssueNumber } from './lane-model.js';

const REPORT_LIMITS = Object.freeze({
  issues: 1000,
  arrayLength: 2000,
  referencesPerIssue: 100,
  depth: 16,
  nodes: 50000,
  textLength: 20000,
  totalTextLength: 2000000,
  errors: 100,
});
const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && /\S/u.test(value);
const isNumber = (value) => Number.isSafeInteger(value) && value > 0;
const isBranch = (value) =>
  isText(value) &&
  !/\s/u.test(value) &&
  value
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..');
const isProgress = (value) =>
  value === 'the in progress label' ||
  (typeof value === 'string' &&
    /^PR #[1-9]\d*$/u.test(value) &&
    isNumber(Number(value.slice(4)))) ||
  isBranch(value);
const has = (object, key) => Object.hasOwn(object, key);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function safeHttps(value) {
  if (
    !isText(value) ||
    !/^https:\/\//iu.test(value) ||
    /[\s"<>\\]/u.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (!url.port || Number(url.port) > 0) &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/iu.test(
        url.hostname,
      )
    );
  } catch {
    return false;
  }
}

function validRepoUrl(value, repo) {
  if (!safeHttps(value)) return false;
  const url = new URL(value);
  const path = value.slice(value.indexOf('/', 'https://'.length));
  return (
    !url.search &&
    !url.hash &&
    /^\/(?:[a-z0-9_.~-]+\/)*[a-z0-9_.~-]+\/?$/iu.test(path) &&
    !/(^|\/)\.{1,2}(\/|$)/u.test(path) &&
    url.pathname.replace(/\/$/u, '').endsWith(`/${repo}`)
  );
}

function validTimestamp(value) {
  if (!isText(value)) return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d+)?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(
      value,
    );
  if (!match) return false;
  const [, year, month, day] = match.map((part, index) =>
    index > 0 && index < 4 ? Number(part) : part,
  );
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function referenceKey(value, repo, byNumber, repoUrl) {
  const number = localIssueNumber(value, repo, byNumber, repoUrl);
  if (number != null) return `issue:${number}`;
  for (const kind of ['pr', 'branch', 'ref', 'url']) {
    if (value[kind] != null) return `${kind}:${value[kind]}`;
  }
  return null;
}

function hasCycle(graph) {
  const incoming = new Map([...graph.keys()].map((number) => [number, 0]));
  for (const edges of graph.values()) {
    for (const target of edges) incoming.set(target, incoming.get(target) + 1);
  }
  const queue = [...incoming]
    .filter(([, count]) => count === 0)
    .map(([number]) => number);
  for (let index = 0; index < queue.length; index += 1) {
    for (const target of graph.get(queue[index])) {
      incoming.set(target, incoming.get(target) - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
  }
  return queue.length !== graph.size;
}

/** Validate a report against independently gathered canonical source facts. */
function validateReport(report, inventory) {
  const errors = [];
  const add = (path, code, message) => {
    if (errors.length < REPORT_LIMITS.errors)
      errors.push({ path, code, message });
  };
  const check = (condition, path, code, message) => {
    if (!condition) add(path, code, message);
    return condition;
  };
  try {
    function inspect(value, path) {
      const stack = [{ value, path, depth: 0, ancestors: [] }];
      let nodes = 0;
      let characters = 0;
      while (stack.length) {
        const entry = stack.pop();
        nodes += 1;
        if (nodes > REPORT_LIMITS.nodes || entry.depth > REPORT_LIMITS.depth) {
          add(
            entry.path,
            'size_limit',
            'The payload exceeds the structural limits.',
          );
          return false;
        }
        if (typeof entry.value === 'string') {
          characters += entry.value.length;
          if (
            entry.value.length > REPORT_LIMITS.textLength ||
            characters > REPORT_LIMITS.totalTextLength
          ) {
            add(
              entry.path,
              'size_limit',
              'The payload exceeds the text limits.',
            );
            return false;
          }
          if (/[\u0000-\u001f\u007f-\u009f]/u.test(entry.value)) {
            add(
              entry.path,
              'unsafe_text',
              'Text must not contain control characters.',
            );
          }
        } else if (entry.value !== null && typeof entry.value === 'object') {
          const array = Array.isArray(entry.value);
          const prototype = Object.getPrototypeOf(entry.value);
          if (
            array
              ? prototype !== Array.prototype
              : ![Object.prototype, null].includes(prototype)
          ) {
            add(
              entry.path,
              'not_json',
              'The payload must contain plain JSON objects and arrays.',
            );
            return false;
          }
          if (entry.ancestors.includes(entry.value)) {
            add(
              entry.path,
              'not_json',
              'The payload must not contain circular objects.',
            );
            return false;
          }
          if (array && entry.value.length > REPORT_LIMITS.arrayLength) {
            add(
              entry.path,
              'size_limit',
              'The array exceeds the structural limit.',
            );
            return false;
          }
          const keys = Reflect.ownKeys(entry.value);
          if (keys.length > REPORT_LIMITS.nodes) {
            add(
              entry.path,
              'size_limit',
              'The object exceeds the structural limit.',
            );
            return false;
          }
          const properties = [];
          for (const key of keys) {
            if (typeof key !== 'string') {
              add(
                entry.path,
                'not_json',
                'Symbol properties are not JSON data.',
              );
              return false;
            }
            const descriptor = Object.getOwnPropertyDescriptor(
              entry.value,
              key,
            );
            if (
              array &&
              key === 'length' &&
              descriptor &&
              !descriptor.enumerable &&
              has(descriptor, 'value')
            )
              continue;
            if (
              !descriptor ||
              !descriptor.enumerable ||
              !has(descriptor, 'value')
            ) {
              add(
                `${entry.path}.${key}`,
                'not_json',
                'Properties must be enumerable data values.',
              );
              return false;
            }
            properties.push({ key, value: descriptor.value });
          }
          if (array) {
            const indexedKeys = new Set(properties.map(({ key }) => key));
            for (let index = 0; index < entry.value.length; index += 1) {
              if (!indexedKeys.has(String(index))) {
                add(
                  `${entry.path}.${index}`,
                  'not_json',
                  'Array elements must be present and enumerable.',
                );
                return false;
              }
            }
            if (properties.length !== entry.value.length) {
              add(
                entry.path,
                'not_json',
                'Arrays must contain only their indexed elements.',
              );
              return false;
            }
          }
          for (const { key, value } of properties) {
            characters += key.length;
            if (
              key.length > REPORT_LIMITS.textLength ||
              characters > REPORT_LIMITS.totalTextLength
            ) {
              add(
                entry.path,
                'size_limit',
                'Field names exceed the text limits.',
              );
              return false;
            }
            if (/[\u0000-\u001f\u007f-\u009f]/u.test(key))
              add(
                entry.path,
                'unsafe_text',
                'Field names must not contain control characters.',
              );
            stack.push({
              value,
              path: `${entry.path}.${key}`,
              depth: entry.depth + 1,
              ancestors: [...entry.ancestors, entry.value],
            });
          }
        } else if (
          (!['number', 'boolean'].includes(typeof entry.value) &&
            entry.value !== null) ||
          (typeof entry.value === 'number' && !Number.isFinite(entry.value))
        ) {
          add(
            entry.path,
            'not_json',
            'The payload must contain only JSON values.',
          );
        }
      }
      return true;
    }
    if (
      !inspect(report, 'report') ||
      !inspect(inventory, 'inventory') ||
      errors.length
    )
      return { valid: false, errors };

    function text(value, path, optional = false) {
      check(
        (optional && value == null) || isText(value),
        path,
        'type',
        'Expected nonempty text.',
      );
    }
    function identity(value, prefix) {
      if (!check(isObject(value), prefix, 'type', 'Expected an object.'))
        return;
      check(
        value.board === 'backlog-triage',
        `${prefix}.board`,
        'board',
        'Expected the backlog-triage board type.',
      );
      text(value.title, `${prefix}.title`);
      check(
        isText(value.repo) &&
          /^(?!\.{1,2}\/)[a-z0-9_.-]+\/(?!\.{1,2}$)[a-z0-9_.-]+$/iu.test(
            value.repo,
          ),
        `${prefix}.repo`,
        'repository',
        'Expected owner/repository.',
      );
      if (value.repoUrl != null)
        check(
          validRepoUrl(value.repoUrl, value.repo),
          `${prefix}.repoUrl`,
          'url',
          'Expected a safe HTTPS URL for this repository.',
        );
      if (
        !check(
          isObject(value.sync),
          `${prefix}.sync`,
          'type',
          'Expected sync metadata.',
        )
      )
        return;
      check(
        validTimestamp(value.sync.at),
        `${prefix}.sync.at`,
        'timestamp',
        'Expected a calendar-valid timestamp with a time zone.',
      );
      check(
        isBranch(value.sync.branch),
        `${prefix}.sync.branch`,
        'branch',
        'Expected a branch name without empty or dot path segments.',
      );
      check(
        isText(value.sync.commit) &&
          /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value.sync.commit),
        `${prefix}.sync.commit`,
        'commit',
        'Expected a full commit SHA.',
      );
      if (value.sync.timeZone != null) {
        let valid =
          isText(value.sync.timeZone) &&
          /^[a-z][a-z0-9_+-]*(?:\/[a-z0-9_+-]+)*$/iu.test(value.sync.timeZone);
        if (valid) {
          try {
            new Intl.DateTimeFormat('en', { timeZone: value.sync.timeZone });
          } catch {
            valid = false;
          }
        }
        check(
          valid,
          `${prefix}.sync.timeZone`,
          'timezone',
          'Expected a recognized IANA time zone.',
        );
      }
      if (value.sync.openPullRequests != null)
        check(
          Number.isSafeInteger(value.sync.openPullRequests) &&
            value.sync.openPullRequests >= 0,
          `${prefix}.sync.openPullRequests`,
          'count',
          'Expected a nonnegative count.',
        );
      if (value.sync.extra != null)
        check(
          Array.isArray(value.sync.extra) && value.sync.extra.every(isText),
          `${prefix}.sync.extra`,
          'type',
          'Expected a list of nonempty text.',
        );
    }
    identity(report, 'report');
    identity(inventory, 'inventory');
    if (!isObject(report) || !isObject(inventory))
      return { valid: false, errors };
    text(report.summary, 'report.summary');

    function issuesShape(issues, prefix, source) {
      if (
        !check(
          Array.isArray(issues) && issues.length <= REPORT_LIMITS.issues,
          `${prefix}.issues`,
          'type',
          `Expected at most ${REPORT_LIMITS.issues} issues.`,
        )
      )
        return;
      const seen = new Set();
      issues.forEach((issue, index) => {
        const path = `${prefix}.issues.${index}`;
        if (!check(isObject(issue), path, 'type', 'Expected an issue object.'))
          return;
        check(
          isNumber(issue.number),
          `${path}.number`,
          'number',
          'Expected a positive safe integer.',
        );
        check(
          !seen.has(issue.number),
          `${path}.number`,
          'duplicate',
          'An issue number appears more than once.',
        );
        seen.add(issue.number);
        text(issue.title, `${path}.title`);
        check(
          has(issue, 'milestone') &&
            (issue.milestone === null || isText(issue.milestone)),
          `${path}.milestone`,
          'milestone',
          'A milestone title or explicit null is required.',
        );
        if (source)
          check(
            has(issue, 'inProgress') &&
              (issue.inProgress === null || isText(issue.inProgress)),
            `${path}.inProgress`,
            'source_progress',
            'Canonical source progress must be present, or explicit null.',
          );
        if (issue.inProgress != null)
          check(
            isProgress(issue.inProgress),
            `${path}.inProgress`,
            'progress',
            'Expected PR, branch, or in-progress label evidence, never assignment alone.',
          );
        if (!source) {
          text(issue.short, `${path}.short`, true);
          for (const field of ['waitingOn', 'after']) {
            if (issue[field] != null)
              check(
                Array.isArray(issue[field]) &&
                  issue[field].length <= REPORT_LIMITS.referencesPerIssue,
                `${path}.${field}`,
                'type',
                'Expected a bounded reference list.',
              );
          }
          if (issue.sameBranchAs != null)
            check(
              isNumber(issue.sameBranchAs),
              `${path}.sameBranchAs`,
              'number',
              'Expected an issue number.',
            );
          if (issue.uncertainty != null) {
            if (
              check(
                isObject(issue.uncertainty),
                `${path}.uncertainty`,
                'type',
                'Expected an uncertainty object.',
              )
            )
              text(issue.uncertainty.reason, `${path}.uncertainty.reason`);
          }
        }
      });
    }
    issuesShape(report.issues, 'report', false);
    issuesShape(inventory.issues, 'inventory', true);
    if (
      !check(
        Array.isArray(report.lanes),
        'report.lanes',
        'type',
        'Expected a lane list.',
      )
    )
      return { valid: false, errors };
    const laneKeys = new Set();
    report.lanes.forEach((lane, index) => {
      const path = `report.lanes.${index}`;
      if (!check(isObject(lane), path, 'type', 'Expected a lane object.'))
        return;
      text(lane.key, `${path}.key`);
      text(lane.name, `${path}.name`);
      check(
        !laneKeys.has(lane.key),
        `${path}.key`,
        'duplicate',
        'A lane key appears more than once.',
      );
      laneKeys.add(lane.key);
      check(
        ['serial', 'head', 'any'].includes(lane.mode),
        `${path}.mode`,
        'mode',
        'Expected serial, head, or any.',
      );
      text(lane.owns, `${path}.owns`, true);
      text(lane.note, `${path}.note`, true);
      check(
        Array.isArray(lane.issues) &&
          lane.issues.length > 0 &&
          lane.issues.every(isNumber),
        `${path}.issues`,
        'type',
        'Expected a nonempty list of issue numbers.',
      );
    });
    check(
      Array.isArray(report.startNow),
      'report.startNow',
      'type',
      'Expected a pick list.',
    );
    if (Array.isArray(report.startNow))
      report.startNow.forEach((pick, index) => {
        const path = `report.startNow.${index}`;
        if (!check(isObject(pick), path, 'type', 'Expected a pick object.'))
          return;
        check(
          isNumber(pick.issue),
          `${path}.issue`,
          'number',
          'Expected an issue number.',
        );
        text(pick.why, `${path}.why`);
        text(pick.touches, `${path}.touches`, true);
      });
    if (report.milestones != null) {
      if (
        check(
          Array.isArray(report.milestones),
          'report.milestones',
          'type',
          'Expected a milestone list.',
        )
      )
        report.milestones.forEach((milestone, index) => {
          const path = `report.milestones.${index}`;
          if (
            !check(
              isObject(milestone),
              path,
              'type',
              'Expected a milestone object.',
            )
          )
            return;
          text(milestone.title, `${path}.title`);
          text(milestone.short, `${path}.short`, true);
        });
    }
    if (
      report.notes != null &&
      check(
        isObject(report.notes),
        'report.notes',
        'type',
        'Expected section notes.',
      )
    ) {
      for (const [key, value] of Object.entries(report.notes)) {
        check(
          ['startNow', 'blocked', 'contention'].includes(key),
          `report.notes.${key}`,
          'field',
          'Unknown section note.',
        );
        text(value, `report.notes.${key}`);
      }
    }
    if (
      report.contention != null &&
      check(
        isObject(report.contention),
        'report.contention',
        'type',
        'Expected contention data.',
      )
    ) {
      text(report.contention.rowLabel, 'report.contention.rowLabel', true);
      if (
        check(
          Array.isArray(report.contention.claims),
          'report.contention.claims',
          'type',
          'Expected a claims list.',
        )
      )
        report.contention.claims.forEach((claim, index) => {
          const path = `report.contention.claims.${index}`;
          if (!check(isObject(claim), path, 'type', 'Expected a claim object.'))
            return;
          text(claim.name, `${path}.name`);
          text(claim.query, `${path}.query`, true);
          check(
            Array.isArray(claim.issues) &&
              claim.issues.length >= 2 &&
              claim.issues.every(isNumber),
            `${path}.issues`,
            'type',
            'A claim must list at least two issue numbers.',
          );
        });
    }
    if (errors.length) return { valid: false, errors };

    for (const field of ['board', 'title', 'repo'])
      check(
        report[field] === inventory[field],
        `report.${field}`,
        'source_mismatch',
        'Report identity differs from the source inventory.',
      );
    const repoUrl = (value) =>
      (value.repoUrl ?? `https://github.com/${value.repo}`).replace(/\/$/u, '');
    check(
      repoUrl(report) === repoUrl(inventory),
      'report.repoUrl',
      'source_mismatch',
      'Repository URL differs from the source inventory.',
    );
    for (const field of [
      'at',
      'branch',
      'commit',
      'timeZone',
      'openPullRequests',
      'extra',
    ])
      check(
        same(report.sync[field] ?? null, inventory.sync[field] ?? null),
        `report.sync.${field}`,
        'source_mismatch',
        'Sync metadata differs from the source inventory.',
      );
    const sourceByNumber = new Map(
      inventory.issues.map((issue) => [issue.number, issue]),
    );
    const byNumber = new Map(
      report.issues.map((issue) => [issue.number, issue]),
    );
    for (const number of sourceByNumber.keys())
      check(
        byNumber.has(number),
        'report.issues',
        'missing_issue',
        `Open issue #${number} is missing.`,
      );
    report.issues.forEach((issue, index) => {
      const source = sourceByNumber.get(issue.number);
      const path = `report.issues.${index}`;
      if (
        !check(
          Boolean(source),
          `${path}.number`,
          'unknown_issue',
          'The issue is not in the source inventory.',
        )
      )
        return;
      for (const field of ['title', 'milestone', 'inProgress'])
        check(
          (issue[field] ?? null) === source[field],
          `${path}.${field}`,
          'source_mismatch',
          `Canonical issue ${field} differs from the source inventory.`,
        );
    });

    function reference(value, path, issueNumber) {
      if (typeof value === 'number') {
        check(
          isNumber(value) && byNumber.has(value),
          path,
          'unknown_reference',
          'Expected an open issue number on this report.',
        );
        check(
          value !== issueNumber,
          path,
          'self_reference',
          'An issue cannot depend on itself.',
        );
        return;
      }
      if (
        !check(
          isObject(value),
          path,
          'reference',
          'Expected an issue number or reference object.',
        )
      )
        return;
      const kinds = ['pr', 'branch', 'ref', 'url'].filter(
        (kind) => value[kind] != null,
      );
      if (
        !check(
          kinds.length === 1,
          path,
          'reference',
          'A reference must name exactly one target kind.',
        )
      )
        return;
      const kind = kinds[0];
      if (kind === 'pr')
        check(
          isNumber(value.pr) && !byNumber.has(value.pr),
          `${path}.pr`,
          'reference',
          'Expected a positive PR number, not a known issue number.',
        );
      if (kind === 'branch')
        check(
          isBranch(value.branch),
          `${path}.branch`,
          'branch',
          'Expected a branch without empty or dot path segments.',
        );
      if (kind === 'ref')
        check(
          isText(value.ref) &&
            /^(?!\.{1,2}\/)[a-z0-9_.-]+\/(?!\.{1,2}#)[a-z0-9_.-]+#[1-9]\d*$/iu.test(
              value.ref,
            ) &&
            isNumber(Number(value.ref.slice(value.ref.lastIndexOf('#') + 1))),
          `${path}.ref`,
          'reference',
          'Expected owner/repository#number with a positive safe integer.',
        );
      check(
        issueNumber == null ||
          localIssueNumber(value, report.repo, byNumber, report.repoUrl) !==
            issueNumber,
        path,
        'self_reference',
        'An issue cannot depend on itself through a repository reference.',
      );
      if (kind === 'url') {
        check(
          safeHttps(value.url),
          `${path}.url`,
          'url',
          'Expected a safe HTTPS URL without credentials.',
        );
        text(value.label, `${path}.label`);
      }
      text(value.title, `${path}.title`, true);
    }
    const placement = new Map();
    report.lanes.forEach((lane, index) => {
      lane.issues.forEach((number, issueIndex) => {
        const path = `report.lanes.${index}.issues.${issueIndex}`;
        check(
          byNumber.has(number),
          path,
          'unknown_issue',
          'The lane names an issue outside the report.',
        );
        check(
          !placement.has(number),
          path,
          'duplicate_placement',
          'The issue appears in more than one lane position.',
        );
        placement.set(number, lane.key);
      });
    });
    const rootOf = (number) => byNumber.get(number)?.sameBranchAs ?? number;
    report.issues.forEach((issue, index) => {
      const path = `report.issues.${index}`;
      check(
        placement.has(issue.number),
        path,
        'missing_lane',
        'Every issue must belong to exactly one lane.',
      );
      if (issue.sameBranchAs != null) {
        const root = byNumber.get(issue.sameBranchAs);
        check(
          Boolean(root) &&
            root.number !== issue.number &&
            root.sameBranchAs == null,
          `${path}.sameBranchAs`,
          'branch_unit',
          'A companion must name another root issue.',
        );
        check(
          placement.get(issue.number) === placement.get(issue.sameBranchAs),
          `${path}.sameBranchAs`,
          'branch_unit',
          'Companions must share their root lane.',
        );
      }
      for (const field of ['waitingOn', 'after'])
        (issue[field] ?? []).forEach((target, refIndex) =>
          reference(target, `${path}.${field}.${refIndex}`, issue.number),
        );
      const waiting = issue.waitingOn ?? [];
      if (waiting.length) text(issue.blockedBecause, `${path}.blockedBecause`);
      else
        check(
          issue.blockedBecause == null,
          `${path}.blockedBecause`,
          'blocker_reason',
          'A blocker reason requires a hard dependency.',
        );
      if (isObject(issue.uncertainty) && issue.uncertainty.reference != null)
        reference(
          issue.uncertainty.reference,
          `${path}.uncertainty.reference`,
          undefined,
        );
      for (const [refIndex, target] of (issue.after ?? []).entries()) {
        const number = localIssueNumber(
          target,
          report.repo,
          byNumber,
          report.repoUrl,
        );
        if (number != null)
          check(
            rootOf(number) !== rootOf(issue.number),
            `${path}.after.${refIndex}`,
            'branch_order',
            'Issues on the same branch cannot come after one another.',
          );
      }
    });
    if (errors.length) return { valid: false, errors };
    report.issues.forEach((issue, index) => {
      const key = (target) =>
        referenceKey(target, report.repo, byNumber, report.repoUrl);
      const waits = new Set((issue.waitingOn ?? []).map(key));
      for (const [refIndex, target] of (issue.after ?? []).entries())
        check(
          !waits.has(key(target)),
          `report.issues.${index}.after.${refIndex}`,
          'duplicate_relation',
          'Keep a hard dependency instead of also listing soft ordering.',
        );
    });

    // Kahn's traversal bounds work by nodes plus edges and includes mixed cycles.
    const graph = new Map(
      report.issues.map((issue) => [
        issue.number,
        new Set(
          [...(issue.waitingOn ?? []), ...(issue.after ?? [])]
            .map((target) =>
              localIssueNumber(target, report.repo, byNumber, report.repoUrl),
            )
            .filter((target) => target != null),
        ),
      ]),
    );
    check(
      !hasCycle(graph),
      'report.issues',
      'dependency_cycle',
      'Hard and soft issue dependencies must not form a cycle.',
    );
    const unitGraph = new Map(
      report.issues
        .filter((issue) => issue.sameBranchAs == null)
        .map((issue) => [issue.number, new Set()]),
    );
    for (const issue of report.issues) {
      const source = rootOf(issue.number);
      // Companion hard blockers affect companion admission, not root starts.
      const relations = [
        ...(issue.sameBranchAs == null ? (issue.waitingOn ?? []) : []),
        ...(issue.after ?? []),
      ];
      for (const relation of relations) {
        const number = localIssueNumber(
          relation,
          report.repo,
          byNumber,
          report.repoUrl,
        );
        if (number != null && rootOf(number) !== source)
          unitGraph.get(source).add(rootOf(number));
      }
    }
    check(
      !hasCycle(unitGraph),
      'report.issues',
      'dependency_cycle',
      'Branch units must not form a cycle through root blockers or soft ordering.',
    );
    const claimNames = new Set();
    for (const [index, claim] of (report.contention?.claims ?? []).entries()) {
      const path = `report.contention.claims.${index}`;
      check(
        !claimNames.has(claim.name),
        `${path}.name`,
        'duplicate',
        'A claim name appears more than once.',
      );
      claimNames.add(claim.name);
      check(
        new Set(claim.issues).size === claim.issues.length,
        `${path}.issues`,
        'duplicate',
        'A claim cannot repeat an issue.',
      );
      check(
        claim.issues.every((number) => byNumber.has(number)),
        `${path}.issues`,
        'unknown_issue',
        'Claimed issues must be on the report.',
      );
      check(
        new Set(claim.issues.map((number) => placement.get(number))).size === 1,
        `${path}.issues`,
        'contention_lane',
        'A shared component cannot span independent lanes.',
      );
    }
    if (errors.length) return { valid: false, errors };
    const derived = deriveReport(report);
    const eligible = new Set(
      derived.lanes.flatMap((lane) => lane.startableRoots),
    );
    const picked = new Set();
    report.startNow.forEach((pick, index) => {
      check(
        !picked.has(pick.issue),
        `report.startNow.${index}.issue`,
        'duplicate',
        'A start pick appears more than once.',
      );
      picked.add(pick.issue);
      check(
        eligible.has(pick.issue),
        `report.startNow.${index}.issue`,
        'ineligible_pick',
        'The issue is not an eligible new branch in its lane.',
      );
    });
    if (
      report.startNow.length <
      derived.lanes.reduce(
        (count, lane) => count + lane.startableRoots.length,
        0,
      )
    )
      text(report.notes?.startNow, 'report.notes.startNow');
  } catch {
    add(
      'report',
      'malformed_input',
      'The report or inventory could not be inspected safely.',
    );
  }
  return { valid: errors.length === 0, errors };
}

export { REPORT_LIMITS, validateReport };
