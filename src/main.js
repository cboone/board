import Alpine from '@alpinejs/csp';

import { fixtures } from './fixtures/reports.js';
import { renderReport } from './report/render.js';
import './style.css';

const themePreferenceKey = 'board.theme';
const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');

function storedTheme() {
  try {
    const value = localStorage.getItem(themePreferenceKey);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

const initialTheme = storedTheme() ?? (colorScheme.matches ? 'dark' : 'light');
applyTheme(initialTheme);

Alpine.data('boardShell', () => ({
  themeLabel: initialTheme === 'dark' ? 'Use light theme' : 'Use dark theme',
  toggleTheme() {
    const theme =
      document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(theme);
    this.themeLabel = theme === 'dark' ? 'Use light theme' : 'Use dark theme';
    try {
      localStorage.setItem(themePreferenceKey, theme);
    } catch {
      // Theme selection remains usable when browser storage is unavailable.
    }
  },
}));

const route = window.location.pathname.replace(/\/$/, '') || '/';
const production =
  import.meta.env.VITE_BOARD_MODE === 'production' && route !== '/demo';
const home = document.getElementById('welcome');
const demo = document.getElementById('demo');
const unavailable = document.getElementById('unavailable');
home.hidden = production || route !== '/';
demo.hidden = route !== '/demo';
unavailable.hidden = production || route === '/' || route === '/demo';

let disposeReport = () => {};

if (import.meta.env.VITE_BOARD_MODE === 'production' && route === '/demo')
  document.getElementById('board-footer').textContent =
    'This sample report uses synthetic data.';

if (production) {
  const mount = document.getElementById('production');
  mount.hidden = false;
  mount.textContent = 'Loading Board…';
  document.getElementById('board-footer').textContent =
    'Repository reports for your GitHub backlog.';
  import('./app/production.js')
    .then(({ mountProduction }) => mountProduction(mount))
    .catch(() => {
      mount.textContent = 'Board could not load. Reload the page to try again.';
      mount.setAttribute('role', 'alert');
    });
}

if (route === '/demo') {
  const selector = document.getElementById('sample-scenario');
  const description = document.getElementById('sample-description');
  const mount = document.getElementById('report-content');

  for (const [key, fixture] of Object.entries(fixtures)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = fixture.label;
    selector.append(option);
  }

  function showScenario(key) {
    disposeReport();
    disposeReport = () => {};
    const fixture = Object.hasOwn(fixtures, key) ? fixtures[key] : null;
    if (!fixture) {
      mount.replaceChildren();
      const message = document.createElement('p');
      message.setAttribute('role', 'status');
      message.textContent =
        'Sample scenario unavailable. Select one of the samples above.';
      mount.append(message);
      description.textContent =
        'This sample address does not identify an available scenario.';
      selector.value = '';
      document.title = 'Sample scenario unavailable · Board';
      return;
    }
    selector.value = key;
    description.textContent = fixture.description;
    disposeReport = renderReport(mount, fixture.report, fixture.inventory);
    document.title = fixture.label + ' · Board sample';
  }

  const selected =
    new URLSearchParams(window.location.search).get('scenario') ?? 'complete';
  showScenario(selected);

  selector.addEventListener('change', () => {
    const address = new URL(window.location.href);
    address.searchParams.set('scenario', selector.value);
    window.history.pushState(null, '', address);
    showScenario(selector.value);
  });

  window.addEventListener('popstate', () => {
    const key =
      new URLSearchParams(window.location.search).get('scenario') ?? 'complete';
    showScenario(key);
  });
}

window.addEventListener('pagehide', (event) => {
  if (!event.persisted) disposeReport();
});
Alpine.start();
