import { EVENTS, on } from './eventBus.js';

let root = null;

function ensureRoot() {
  if (root) return root;
  root = document.createElement('div');
  root.className = 'toast-layer';
  root.setAttribute('aria-live', 'polite');
  document.body.appendChild(root);
  return root;
}

const ICONS = {
  info: 'i',
  success: '✓',
  warn: '!',
  error: '×',
};

export function toast(message, opts = {}) {
  const { type = 'info', timeout = 2600 } = opts;
  const r = ensureRoot();
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span class="toast-icon">${ICONS[type] || 'i'}</span><span class="toast-msg"></span>`;
  el.querySelector('.toast-msg').textContent = String(message);
  r.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  const close = () => {
    el.classList.remove('in');
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  };
  el.addEventListener('click', close);
  setTimeout(close, timeout);
}

export function initToasts() {
  on(EVENTS.TOAST, (detail) => {
    if (!detail) return;
    toast(detail.message, detail);
  });
}
