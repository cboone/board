const sourceStates = new Set([
  'ready',
  'reauthorization-required',
  'installation-required',
  'unverified',
]);

const messages = Object.freeze({
  invalid_request: 'This request is unavailable. Select a repository again.',
  session_required: 'Your Board session has ended. Sign in again to continue.',
  forbidden:
    'This request is not authorized. Check your session and try again.',
  source_authorization_required:
    'Reconnect GitHub to check repositories. Your Board session remains signed in.',
  source_unavailable:
    'This repository is unavailable or ineligible for new analysis.',
  source_unstable:
    'GitHub changed during the check. Try again to collect a consistent result.',
  source_limit_exceeded:
    'This repository exceeds the current collection limits. The check did not complete.',
  source_incomplete:
    'Some required GitHub inputs could not be collected. Try the check again.',
  provider_rate_limited:
    'GitHub limited the requests. Try again after the limit resets.',
  source_timeout:
    'The GitHub check reached its runtime limit. The check did not complete.',
  provider_unavailable: 'GitHub is unavailable. Try again.',
  service_unavailable: 'Board is unavailable. Try again.',
  internal_error: 'Board could not complete the request. Try again.',
  network_error:
    'Board could not be reached. Check your connection and try again.',
  invalid_response: 'Board returned an incomplete response. Try again.',
});

const countLabels = Object.freeze({
  openIssues: 'Open issues',
  openPullRequests: 'Open pull requests',
  milestones: 'Milestones',
  labels: 'Labels',
  branches: 'Remote branches',
  unmergedBranches: 'Unmerged branches',
  issueComments: 'Issue comments',
  treeEntries: 'Repository tree entries',
  selectedFiles: 'Selected files',
});

const buttonClass =
  'rounded-md bg-blue-800 px-4 py-2 font-semibold text-white hover:bg-blue-900 disabled:cursor-wait disabled:opacity-60 dark:bg-blue-300 dark:text-slate-950 dark:hover:bg-blue-200';
const secondaryClass =
  'rounded-md border border-slate-400 px-4 py-2 font-medium hover:border-blue-700 dark:border-slate-500 dark:hover:border-blue-300';
const mutedClass = 'text-slate-700 dark:text-slate-300';
const boxClass =
  'rounded-lg border border-slate-300 bg-white p-5 dark:border-slate-700 dark:bg-slate-900';

class StaleRequest extends Error {}
class ApiError extends Error {
  constructor(code) {
    super(messages[code] ?? messages.internal_error);
    this.code = Object.hasOwn(messages, code) ? code : 'internal_error';
  }
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function action(text, handler, secondary = false) {
  const node = element(
    'button',
    text,
    secondary ? secondaryClass : buttonClass,
  );
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
}

function link(text, path, primary = false) {
  const node = element(
    'a',
    text,
    primary ? buttonClass : 'text-blue-800 underline dark:text-blue-300',
  );
  node.href = path;
  return node;
}

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value, maximum = 2000) =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;
const isId = (value) => Number.isSafeInteger(value) && value > 0;
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

function validSession(value) {
  return (
    isObject(value) &&
    value.auth === true &&
    isObject(value.user) &&
    value.user.id === 99961 &&
    value.user.login === 'cboone' &&
    isText(value.csrfToken, 256) &&
    value.csrfToken.length >= 32 &&
    sourceStates.has(value.sourceAuthorization)
  );
}

function validRepository(value) {
  if (
    !isObject(value) ||
    !isId(value.id) ||
    !isText(value.name, 100) ||
    !/^[A-Za-z0-9._-]+$/u.test(value.name) ||
    value.name === '.' ||
    value.name === '..' ||
    value.fullName !== `cboone/${value.name}` ||
    !isText(value.url) ||
    typeof value.private !== 'boolean'
  )
    return false;
  try {
    const url = new URL(value.url);
    return (
      url.origin === 'https://github.com' &&
      url.pathname === `/${value.fullName}` &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function repositoryList(value) {
  if (
    !isObject(value) ||
    !Array.isArray(value.repositories) ||
    value.repositories.length > 10000 ||
    !value.repositories.every(validRepository) ||
    new Set(value.repositories.map(({ id }) => id)).size !==
      value.repositories.length
  )
    throw new ApiError('invalid_response');
  return value.repositories.map(
    ({ id, name, fullName, private: privateRepo }) => ({
      id,
      name,
      fullName,
      private: privateRepo,
      url: `https://github.com/${fullName}`,
    }),
  );
}

function validSummary(value, selected) {
  return (
    isObject(value) &&
    value.status === 'complete' &&
    validRepository(value.repo) &&
    value.repo.id === selected.id &&
    value.repo.fullName === selected.fullName &&
    isObject(value.sync) &&
    isText(value.sync.at) &&
    Number.isFinite(Date.parse(value.sync.at)) &&
    isText(value.sync.branch) &&
    isText(value.sync.commit, 64) &&
    /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value.sync.commit) &&
    isCount(value.sync.openPullRequests) &&
    isObject(value.fingerprint) &&
    value.fingerprint.algorithm === 'sha256' &&
    isText(value.fingerprint.value, 64) &&
    /^[a-f0-9]{64}$/u.test(value.fingerprint.value) &&
    value.fingerprint.scope === 'core-and-collected-context' &&
    isObject(value.counts) &&
    Object.keys(countLabels).every((key) => isCount(value.counts[key])) &&
    isObject(value.provenance) &&
    isText(value.provenance.observedFrom) &&
    isText(value.provenance.observedTo) &&
    Number.isFinite(Date.parse(value.provenance.observedFrom)) &&
    Number.isFinite(Date.parse(value.provenance.observedTo)) &&
    value.provenance.consistency === 'two-pass-matched' &&
    Array.isArray(value.provenance.limitations) &&
    value.provenance.limitations.length <= 100 &&
    value.provenance.limitations.every((entry) => isText(entry)) &&
    Array.isArray(value.provenance.files) &&
    value.provenance.files.length <= 40 &&
    value.provenance.files.every(
      (file) =>
        isObject(file) &&
        isText(file.path) &&
        isText(file.blobId, 64) &&
        /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(file.blobId),
    )
  );
}

function selectedId() {
  const path = window.location.pathname.replace(/\/$/u, '') || '/';
  if (path === '/') return null;
  const match = /^\/repositories\/([1-9]\d*)$/u.exec(path);
  return match && isId(Number(match[1])) ? Number(match[1]) : false;
}

export function mountProduction(mount) {
  let generation = 0;
  let stopped = false;
  let sessionTimer;
  let checkingSession = false;
  const controllers = new Set();
  const state = {
    authenticated: false,
    user: null,
    csrfToken: '',
    sourceAuthorization: 'unverified',
    repositories: [],
    selected: null,
    summary: null,
    pending: null,
    error: null,
    notice: '',
    signingOut: false,
  };

  function current(stamp) {
    return !stopped && stamp === generation;
  }

  function clearProtected() {
    generation += 1;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    window.clearInterval(sessionTimer);
    sessionTimer = undefined;
    checkingSession = false;
    state.authenticated = false;
    state.user = null;
    state.csrfToken = '';
    state.sourceAuthorization = 'unverified';
    state.repositories = [];
    state.selected = null;
    state.summary = null;
    state.pending = null;
    state.error = null;
    state.notice = '';
    state.signingOut = false;
    document.title = 'Board';
    mount.replaceChildren();
  }

  async function request(method, path, { csrfToken = state.csrfToken } = {}) {
    const stamp = generation;
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = window.setTimeout(() => controller.abort(), 65000);
    try {
      const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(method === 'POST' ? { 'X-CSRF-Token': csrfToken } : {}),
        },
      });
      if (!current(stamp)) throw new StaleRequest();
      let data;
      try {
        data = await response.json();
      } catch {
        if (!current(stamp)) throw new StaleRequest();
        throw new ApiError('invalid_response');
      }
      if (!current(stamp)) throw new StaleRequest();
      if (!response.ok) {
        if (response.status === 401 && path !== '/api/auth/logout') {
          clearProtected();
          state.notice = messages.session_required;
          paint();
          throw new StaleRequest();
        }
        throw new ApiError(
          isObject(data) && isObject(data.error)
            ? data.error.code
            : 'invalid_response',
        );
      }
      return data;
    } catch (error) {
      if (!current(stamp) || error instanceof StaleRequest)
        throw new StaleRequest();
      throw error instanceof ApiError ? error : new ApiError('network_error');
    } finally {
      window.clearTimeout(timeout);
      controllers.delete(controller);
    }
  }

  function showError(error) {
    if (error instanceof StaleRequest) return;
    state.pending = null;
    state.error =
      error instanceof ApiError ? error : new ApiError('internal_error');
    if (state.error.code === 'source_authorization_required')
      state.sourceAuthorization = 'reauthorization-required';
    paint();
  }

  async function bootstrap() {
    clearProtected();
    const address = new URL(window.location.href);
    const callbackError = address.searchParams.get('auth_error');
    if (callbackError && Object.hasOwn(messages, callbackError))
      state.notice = 'GitHub sign-in could not be completed. Please try again.';
    if (callbackError !== null) {
      address.searchParams.delete('auth_error');
      window.history.replaceState(null, '', address);
    }
    state.pending = 'bootstrap';
    paint();
    const stamp = generation;
    try {
      const session = await request('GET', '/api/session');
      if (!current(stamp)) return;
      if (isObject(session) && session.auth === false) {
        state.pending = null;
        paint();
        return;
      }
      if (!validSession(session)) throw new ApiError('invalid_response');
      state.authenticated = true;
      state.user = { id: session.user.id, login: session.user.login };
      state.csrfToken = session.csrfToken;
      state.sourceAuthorization = session.sourceAuthorization;
      sessionTimer = window.setInterval(verifySession, 60000);
      await loadRepositories();
    } catch (error) {
      if (current(stamp)) showError(error);
    }
  }

  async function verifySession() {
    if (!state.authenticated || checkingSession || stopped) return;
    checkingSession = true;
    const stamp = generation;
    try {
      const session = await request('GET', '/api/session');
      if (!current(stamp)) return;
      if (isObject(session) && session.auth === false) {
        clearProtected();
        state.notice = messages.session_required;
        paint();
      } else if (!validSession(session)) {
        throw new ApiError('invalid_response');
      } else if (session.csrfToken !== state.csrfToken) {
        await bootstrap();
      } else if (state.sourceAuthorization !== session.sourceAuthorization) {
        state.sourceAuthorization = session.sourceAuthorization;
        paint();
      }
    } catch (error) {
      if (!current(stamp)) return;
      clearProtected();
      showError(error);
    } finally {
      if (current(stamp)) checkingSession = false;
    }
  }

  async function loadRepositories() {
    const stamp = generation;
    state.pending = 'repositories';
    state.error = null;
    paint();
    try {
      const data = await request('GET', '/api/repositories');
      if (!current(stamp)) return;
      state.repositories = repositoryList(data);
      const id = selectedId();
      state.selected =
        state.repositories.find((repo) => repo.id === id) ?? null;
      state.pending = null;
      if (id !== null && !state.selected && id !== false)
        state.error = new ApiError('source_unavailable');
      paint();
    } catch (error) {
      if (current(stamp)) showError(error);
    }
  }

  function chooseRepository(event) {
    const id = Number(event.target.value);
    state.selected = state.repositories.find((repo) => repo.id === id) ?? null;
    state.summary = null;
    state.error = null;
    const path = state.selected ? `/repositories/${state.selected.id}` : '/';
    window.history.pushState(null, '', path);
    paint();
  }

  async function checkSource() {
    if (!state.selected || state.pending) return;
    const stamp = generation;
    const selected = state.selected;
    state.pending = 'check';
    state.error = null;
    paint();
    try {
      const data = await request(
        'POST',
        `/api/repositories/${selected.id}/check`,
      );
      if (!current(stamp) || state.selected?.id !== selected.id) return;
      if (!validSummary(data, selected)) throw new ApiError('invalid_response');
      state.summary = data;
      state.pending = null;
      paint();
    } catch (error) {
      if (current(stamp)) showError(error);
    }
  }

  async function logout() {
    const csrfToken = state.csrfToken;
    clearProtected();
    window.history.replaceState(null, '', '/');
    state.signingOut = true;
    state.notice = 'Signing out…';
    paint();
    const stamp = generation;
    try {
      const result = await request('POST', '/api/auth/logout', { csrfToken });
      if (!current(stamp)) return;
      if (!isObject(result) || result.ok !== true)
        throw new ApiError('invalid_response');
      state.signingOut = false;
      state.notice = 'Signed out of Board.';
      paint();
    } catch (error) {
      if (!current(stamp)) return;
      state.signingOut = false;
      state.notice =
        'Your local view is cleared, but server sign-out could not be confirmed. Check your session before trying again.';
      showError(error);
    }
  }

  function paint() {
    if (stopped) return;
    mount.replaceChildren();
    const id = selectedId();
    if (id === false) {
      document.title = 'Page unavailable · Board';
      mount.append(
        element('h1', 'Page unavailable', 'text-3xl font-bold'),
        element(
          'p',
          'This address does not identify a Board page.',
          `mt-4 ${mutedClass}`,
        ),
        link('Return to Board', '/'),
      );
      return;
    }
    document.title = state.selected
      ? `${state.selected.fullName} · Board`
      : 'Board';

    if (state.authenticated) {
      const account = element(
        'div',
        undefined,
        'mb-8 flex flex-wrap items-center justify-between gap-4',
      );
      account.append(
        element('p', `Signed in as @${state.user.login}`, mutedClass),
        action('Sign out', logout, true),
      );
      mount.append(account);
    }

    if (state.notice) {
      const notice = element('p', state.notice, `mb-5 ${mutedClass}`);
      notice.setAttribute('role', 'status');
      mount.append(notice);
    }
    if (state.error) {
      const alert = element('p', state.error.message, `${boxClass} mb-5`);
      alert.setAttribute('role', 'alert');
      mount.append(alert);
    }

    if (!state.authenticated) {
      mount.append(
        element(
          'h1',
          'A clearer way to decide what to start next.',
          'max-w-3xl text-4xl font-bold tracking-tight sm:text-6xl',
        ),
      );
      mount.append(
        element(
          'p',
          'Sign in with GitHub to open your repository backlog. Public and private reports are available only to your account.',
          `mt-6 max-w-2xl text-lg leading-8 ${mutedClass}`,
        ),
      );
      if (state.pending === 'bootstrap') {
        const status = element(
          'p',
          'Checking your session…',
          `mt-6 ${mutedClass}`,
        );
        status.setAttribute('role', 'status');
        mount.append(status);
      } else if (!state.signingOut) {
        const controls = element(
          'div',
          undefined,
          'mt-8 flex flex-wrap items-center gap-5',
        );
        controls.append(link('Sign in with GitHub', '/api/auth/start', true));
        if (state.error || state.notice)
          controls.append(action('Check session', bootstrap, true));
        controls.append(link('View sample report', '/demo'));
        mount.append(controls);
      }
      return;
    }

    mount.append(element('h1', 'Your repositories', 'text-3xl font-bold'));
    mount.append(
      element(
        'p',
        'Choose an eligible repository from your GitHub App installation.',
        `mt-3 ${mutedClass}`,
      ),
    );
    if (state.sourceAuthorization === 'reauthorization-required')
      mount.append(link('Reconnect GitHub', '/api/auth/start', true));
    if (state.pending === 'repositories') {
      const status = element(
        'p',
        'Loading repositories…',
        `mt-6 ${mutedClass}`,
      );
      status.setAttribute('role', 'status');
      mount.append(status);
      return;
    }
    if (!state.repositories.length) {
      mount.append(
        element(
          'p',
          'No eligible repositories are available. Check the App installation and repository selection.',
          `mt-6 ${mutedClass}`,
        ),
      );
      const controls = element(
        'div',
        undefined,
        'mt-5 flex flex-wrap items-center gap-5',
      );
      controls.append(
        link(
          'Manage GitHub App access',
          'https://github.com/settings/installations',
        ),
        action('Reload repositories', loadRepositories, true),
      );
      mount.append(controls);
      return;
    }
    const label = element('label', 'Repository', 'mt-6 block font-semibold');
    label.htmlFor = 'repository-selection';
    const select = element(
      'select',
      undefined,
      'mt-2 w-full max-w-xl rounded-md border border-slate-400 bg-white px-3 py-3 text-slate-950 dark:border-slate-500 dark:bg-slate-950 dark:text-slate-50',
    );
    select.id = 'repository-selection';
    select.disabled = state.pending === 'check';
    const placeholder = element('option', 'Select a repository');
    placeholder.value = '';
    select.append(placeholder);
    for (const repo of state.repositories) {
      const option = element(
        'option',
        `${repo.fullName}${repo.private ? ' (private)' : ''}`,
      );
      option.value = String(repo.id);
      select.append(option);
    }
    select.value = state.selected ? String(state.selected.id) : '';
    select.addEventListener('change', chooseRepository);
    mount.append(label, select);
    if (!state.selected) return;

    const source = element('section', undefined, `${boxClass} mt-8`);
    source.setAttribute('aria-labelledby', 'selected-repository-title');
    const title = element(
      'h2',
      state.selected.fullName,
      'break-all text-2xl font-bold',
    );
    title.id = 'selected-repository-title';
    source.append(
      title,
      element(
        'p',
        state.selected.private ? 'Private repository' : 'Public repository',
        `mt-2 ${mutedClass}`,
      ),
    );
    const controls = element(
      'div',
      undefined,
      'mt-5 flex flex-wrap items-center gap-5',
    );
    const check = action(
      state.pending === 'check' ? 'Checking GitHub…' : 'Check GitHub',
      checkSource,
    );
    check.disabled =
      state.pending === 'check' ||
      state.sourceAuthorization === 'reauthorization-required';
    controls.append(
      check,
      link('Open repository on GitHub', state.selected.url),
    );
    source.append(
      controls,
      element(
        'p',
        'Checking GitHub gathers the approved inputs. It does not run paid AI analysis or create a report.',
        `mt-4 text-sm ${mutedClass}`,
      ),
    );
    if (state.pending === 'check') {
      const progress = element(
        'p',
        'Collecting and verifying GitHub inputs…',
        `mt-4 ${mutedClass}`,
      );
      progress.setAttribute('role', 'status');
      source.append(progress);
    }
    mount.append(source);
    if (state.summary) paintSummary(state.summary);
  }

  function paintSummary(summary) {
    const result = element('section', undefined, `${boxClass} mt-8`);
    result.setAttribute('aria-labelledby', 'source-check-title');
    const title = element('h2', 'GitHub check complete', 'text-2xl font-bold');
    title.id = 'source-check-title';
    result.append(title);
    const observed = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(summary.sync.at));
    result.append(
      element(
        'p',
        `Checked ${observed}. This is a source check; no analysis report has been generated.`,
        `mt-3 ${mutedClass}`,
      ),
    );
    const counts = element(
      'dl',
      undefined,
      'mt-6 grid grid-cols-2 gap-5 sm:grid-cols-3',
    );
    for (const [key, label] of Object.entries(countLabels)) {
      const entry = element('div');
      entry.append(
        element('dt', label, `text-sm ${mutedClass}`),
        element('dd', String(summary.counts[key]), 'mt-1 text-xl font-bold'),
      );
      counts.append(entry);
    }
    result.append(counts);
    const details = element(
      'details',
      undefined,
      'mt-6 border-t border-slate-300 pt-5 dark:border-slate-700',
    );
    details.append(
      element('summary', 'Input provenance', 'cursor-pointer font-semibold'),
    );
    details.append(
      element(
        'p',
        'Two matching observations cover the collected GitHub inputs. They do not establish an atomic GitHub snapshot or verify external references.',
        `mt-3 text-sm ${mutedClass}`,
      ),
    );
    details.append(
      element(
        'p',
        `Observed ${summary.provenance.observedFrom} to ${summary.provenance.observedTo}.`,
        `mt-3 break-words text-sm ${mutedClass}`,
      ),
    );
    details.append(
      element(
        'p',
        `Default branch: ${summary.sync.branch}`,
        `mt-3 break-all text-sm ${mutedClass}`,
      ),
    );
    details.append(
      element(
        'p',
        `Source fingerprint: ${summary.fingerprint.value}`,
        `mt-3 break-all font-mono text-xs ${mutedClass}`,
      ),
    );
    if (summary.provenance.files.length) {
      details.append(element('h3', 'Selected files', 'mt-4 font-semibold'));
      const files = element(
        'ul',
        undefined,
        'mt-2 list-disc space-y-1 pl-5 text-sm',
      );
      for (const file of summary.provenance.files)
        files.append(element('li', file.path, 'break-all'));
      details.append(files);
    }
    if (summary.provenance.limitations.length) {
      details.append(
        element(
          'h3',
          'Collection limits and uncertainty',
          'mt-4 font-semibold',
        ),
      );
      const limitations = element(
        'ul',
        undefined,
        'mt-2 list-disc space-y-2 pl-5 text-sm',
      );
      for (const limitation of summary.provenance.limitations)
        limitations.append(element('li', limitation));
      details.append(limitations);
    }
    result.append(details);
    mount.append(result);
  }

  const restore = () => bootstrap();
  const pageShow = (event) => {
    if (event.persisted) bootstrap();
  };
  const pageHide = () => clearProtected();
  window.addEventListener('popstate', restore);
  window.addEventListener('pageshow', pageShow);
  window.addEventListener('pagehide', pageHide);
  bootstrap();

  return () => {
    stopped = true;
    clearProtected();
    window.removeEventListener('popstate', restore);
    window.removeEventListener('pageshow', pageShow);
    window.removeEventListener('pagehide', pageHide);
  };
}
