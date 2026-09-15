import Alpine from '@alpinejs/csp';

import './style.css';

Alpine.data('boardShell', () => ({
  subtitle:
    'Board will turn your GitHub backlog into a focused report of what can proceed, what is blocked, and where work overlaps.',
  themeLabel: 'Use dark theme',
  toggleTheme() {
    const root = document.documentElement;
    const isDark = root.classList.toggle('dark');
    this.themeLabel = isDark ? 'Use light theme' : 'Use dark theme';
  },
}));

Alpine.start();
