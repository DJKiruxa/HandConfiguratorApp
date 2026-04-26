import { EVENTS, emit } from './eventBus.js';

const KEY = 'babylon_theme';
const ACCENT_KEY = 'babylon_accent';

const ACCENTS = {
  blue:   { c1: '#4f8cff', c2: '#7c5cfc' },
  violet: { c1: '#9b7cfb', c2: '#ff6bd6' },
  emerald:{ c1: '#3dd68c', c2: '#4f8cff' },
  amber:  { c1: '#f5a623', c2: '#ff6b6b' },
  cyan:   { c1: '#22d3ee', c2: '#4f8cff' },
};

export function getTheme() {
  return localStorage.getItem(KEY) || 'dark';
}

export function getAccent() {
  return localStorage.getItem(ACCENT_KEY) || 'blue';
}

export function applyTheme(theme = getTheme()) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(KEY, theme);
  emit(EVENTS.THEME_CHANGED, { theme });
}

export function applyAccent(name = getAccent()) {
  const a = ACCENTS[name] || ACCENTS.blue;
  document.documentElement.style.setProperty('--accent', a.c1);
  document.documentElement.style.setProperty('--accent2', a.c2);
  document.documentElement.dataset.accent = name;
  localStorage.setItem(ACCENT_KEY, name);
}

export function toggleTheme() {
  applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

export function initTheme() {
  applyTheme();
  applyAccent();
}

export const ACCENT_NAMES = Object.keys(ACCENTS);
