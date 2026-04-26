import { initToasts, toast } from './modules/toast.js';
import { initTheme, toggleTheme, applyAccent, ACCENT_NAMES, getAccent } from './modules/theme.js';
import { EVENTS, on, emit } from './modules/eventBus.js';
import { DashboardRecipe, ASSEMBLY_STORAGE_KEY } from './modules/recipe.js';
import { createDashboardScene } from './modules/scene.js';

function wireDashboardUI(dash) {
  document.querySelectorAll('[data-dash-action="reload-assembly"]').forEach((btn) =>
    btn.addEventListener('click', () => { dash?.reloadAssemblyFromStorage(); toast('сборка перезагружена'); }),
  );
  document.querySelectorAll('[data-dash-action="stop-clip"]').forEach((b) =>
    b.addEventListener('click', () => dash?.stopClipPlayback()),
  );
  document.querySelectorAll('[data-dash-action="reset-cam"]').forEach((b) =>
    b.addEventListener('click', () => { dash?.resetCamera(); toast('камера сброшена'); }),
  );
  document.querySelectorAll('[data-dash-action="fullscreen"]').forEach((b) =>
    b.addEventListener('click', () => {
      const el = document.querySelector('.scene-area');
      if (!document.fullscreenElement) el?.requestFullscreen?.();
      else document.exitFullscreen?.();
    }),
  );

  const dashJsonIn = document.getElementById('dashAssemblyJsonInput');
  dashJsonIn?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const text = await f.text();
      JSON.parse(text);
      localStorage.setItem(ASSEMBLY_STORAGE_KEY, text);
      dash?.reloadAssemblyFromStorage();
      emit(EVENTS.ASSEMBLY_UPDATED);
      toast('JSON сборки загружен', { type: 'success' });
    } catch (err) {
      console.warn('json превью', err);
      toast('Не удалось прочитать JSON', { type: 'error' });
    }
  });
}

function wireTheme() {
  const themeBtn = document.querySelector('[data-action="toggle-theme"]');
  themeBtn?.addEventListener('click', () => toggleTheme());

  const accentBox = document.querySelector('[data-accent-picker]');
  if (accentBox) {
    accentBox.innerHTML = ACCENT_NAMES.map((n) => `<button type="button" class="accent-swatch accent-${n}${getAccent() === n ? ' active' : ''}" data-accent="${n}" title="${n}"></button>`).join('');
    accentBox.addEventListener('click', (e) => {
      const b = e.target.closest('[data-accent]');
      if (!b) return;
      applyAccent(b.dataset.accent);
      accentBox.querySelectorAll('.accent-swatch').forEach((s) => s.classList.toggle('active', s === b));
    });
  }
}

function wireShortcuts(recipe) {
  window.addEventListener('keydown', (e) => {
    const tag = (e.target?.tagName || '').toLowerCase();
    const inEditable = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable;
    if (inEditable) return;

    const cmd = e.ctrlKey || e.metaKey;
    if (cmd && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); recipe.undo(); return; }
    if (cmd && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); recipe.redo(); return; }
    if (e.key === 'n' || e.key === 'N')  { e.preventDefault(); recipe.resetHandPose(); return; }
    if (e.key === 't' || e.key === 'T')  { e.preventDefault(); toggleTheme(); return; }
    if (e.key === '?') {
      toast('N — сброс пальцев, T — тема, Ctrl+Z / Ctrl+Y — отмена/повтор, F — на весь экран', { timeout: 4500 });
    }
    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      const el = document.querySelector('.scene-area');
      if (!document.fullscreenElement) el?.requestFullscreen?.();
      else document.exitFullscreen?.();
    }
  });
}

function main() {
  initTheme();
  initToasts();

  const dashCanvas = document.getElementById('dashboardCanvas');
  const fpsEl = document.getElementById('fpsCounter');
  const loadingEl = document.getElementById('sceneLoading') || document.querySelector('.scene-loading');

  const dash = dashCanvas
    ? createDashboardScene(dashCanvas, {
        fpsEl,
        onLoading: (b) => {
          loadingEl?.classList.toggle('active', !!b);
          if (loadingEl) loadingEl.setAttribute('aria-busy', b ? 'true' : 'false');
        },
      })
    : null;

  if (dash) {
    on(EVENTS.ASSEMBLY_UPDATED, () => dash.reloadAssemblyFromStorage());
    on(EVENTS.PREVIEW_SCENE, ({ sceneId } = {}) => sceneId && dash.previewScene(sceneId));
    on(EVENTS.PLAY_CLIP,     ({ clipId  } = {}) => clipId  && dash.playClip(clipId));
  }

  wireDashboardUI(dash);
  wireTheme();

  const recipe = new DashboardRecipe();
  recipe.init();

  wireShortcuts(recipe);

  toast('готово. ? — шорткаты', { type: 'success', timeout: 2800 });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
else main();
