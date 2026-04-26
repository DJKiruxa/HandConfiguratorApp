import { EVENTS, emit } from './eventBus.js';

const KEY = 'babylon_theme';

const ACCENT_KEY = 'babylon_accent';

function clearSavedAccent() {
  try {
    localStorage.removeItem(ACCENT_KEY);
  } catch {
    /* ignore */
  }
  const root = document.documentElement;
  root.style.removeProperty('--accent');
  root.style.removeProperty('--accent2');
  root.removeAttribute('data-accent');
}

export function getTheme() {
  return localStorage.getItem(KEY) || 'dark';
}

export function applyTheme(theme = getTheme()) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(KEY, theme);
  emit(EVENTS.THEME_CHANGED, { theme });
}

const THEME_TRANSITION_MS = 400;

export function toggleTheme() {
  const next = getTheme() === 'dark' ? 'light' : 'dark';
  const root = document.documentElement;
  root.classList.add('theme-transitioning');
  applyTheme(next);
  setTimeout(() => root.classList.remove('theme-transitioning'), THEME_TRANSITION_MS);
}

export function initTheme() {
  clearSavedAccent();
  applyTheme();
}
