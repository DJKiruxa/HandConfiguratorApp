import { initToasts, toast } from './modules/toast.js';
import { initTheme, toggleTheme } from './modules/theme.js';
import { initSnakeGame } from './modules/snakeGame.js';
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
}

function isEditableKeyTarget(t) {
  if (!t || t === document.body) return false;
  const tag = (t.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
}

/**
 * Слушатель в фазе capture: canvas Babylon получает keydown раньше, чем всплытие
 * дойдёт до window — иначе N / T / F и отмена не срабатывают при фокусе на сцене.
 */
function wireShortcuts(recipe) {
  const onKey = (e) => {
    if (isEditableKeyTarget(e.target)) return;

    const cmd = e.ctrlKey || e.metaKey;

    if (cmd && e.code === 'KeyZ' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      recipe.undo();
      return;
    }
    if (cmd && (e.code === 'KeyY' || (e.shiftKey && e.code === 'KeyZ'))) {
      e.preventDefault();
      e.stopPropagation();
      recipe.redo();
      return;
    }

    if (!cmd && e.code === 'KeyN') {
      e.preventDefault();
      e.stopPropagation();
      recipe.resetHandPose();
      return;
    }
    if (!cmd && e.code === 'KeyT') {
      e.preventDefault();
      e.stopPropagation();
      toggleTheme();
      return;
    }
    if (!cmd && (e.key === '?' || (e.code === 'Slash' && e.shiftKey))) {
      e.preventDefault();
      e.stopPropagation();
      toast('N — сброс пальцев, T — тема, Ctrl+Z / Ctrl+Y — отмена/повтор, F — на весь экран', { timeout: 4500 });
      return;
    }
    if (!cmd && e.code === 'KeyF') {
      e.preventDefault();
      e.stopPropagation();
      const el = document.querySelector('.scene-area');
      if (!document.fullscreenElement) el?.requestFullscreen?.();
      else document.exitFullscreen?.();
    }
  };

  window.addEventListener('keydown', onKey, true);
}

function main() {
  initTheme();
  initToasts();
  initSnakeGame();

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
