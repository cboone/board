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
const home = document.getElementById('welcome');
const demo = document.getElementById('demo');
const unavailable = document.getElementById('unavailable');
home.hidden = route !== '/';
demo.hidden = route !== '/demo';
unavailable.hidden = route === '/' || route === '/demo';

let disposeReport = () => {};

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
