import { initToasts, toast } from './modules/toast.js';
import { initTheme, toggleTheme } from './modules/theme.js';
import { initSnakeGame } from './modules/snakeGame.js';
import { EVENTS, on, emit } from './modules/eventBus.js';
import { DashboardRecipe, ASSEMBLY_STORAGE_KEY } from './modules/recipe.js';
import { createDashboardScene } from './modules/scene.js';
import { initArduinoSerialBridge } from './modules/arduinoSerial.js';

const DESKTOP_DESIGN_VIEWPORT = { width: 2560, height: 1440 };

function initViewportScale() {
  const root = document.documentElement;
  const body = document.body;
  let raf = 0;

  const applyScale = () => {
    raf = 0;
    const vw = window.innerWidth || DESKTOP_DESIGN_VIEWPORT.width;
    const vh = window.innerHeight || DESKTOP_DESIGN_VIEWPORT.height;
    const isDesktopLayout = vw > 1000 && vh > 700;
    const rawScale = Math.min(vw / DESKTOP_DESIGN_VIEWPORT.width, vh / DESKTOP_DESIGN_VIEWPORT.height, 1);
    const scale = isDesktopLayout ? Math.max(0.72, rawScale) : 1;
    const scaled = scale < 0.995;

    root.style.setProperty('--viewport-scale', scale.toFixed(4));
    root.style.setProperty('--viewport-width', `${Math.round(vw / scale)}px`);
    root.style.setProperty('--viewport-height', `${Math.round(vh / scale)}px`);
    body?.classList.toggle('is-viewport-scaled', scaled);
  };

  const scheduleScale = () => {
    if (raf) return;
    raf = requestAnimationFrame(applyScale);
  };

  applyScale();
  window.addEventListener('resize', scheduleScale, { passive: true });
  window.addEventListener('orientationchange', scheduleScale, { passive: true });
}

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

  const armAnimationList = document.getElementById('armAnimationList');
  armAnimationList?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-arm-animation]');
    if (!btn) return;
    const index = Number(btn.dataset.armAnimation);
    if (!Number.isInteger(index)) return;
    if (dash?.playArmAnimation(index)) toast(`анимация: ${btn.textContent.trim()}`);
  });
}

function renderArmAnimationList(groups = [], activeIndex = -1) {
  const list = document.getElementById('armAnimationList');
  if (!list) return;
  list.replaceChildren();
  if (!groups.length) {
    const empty = document.createElement('div');
    empty.className = 'animation-empty';
    empty.textContent = 'анимаций нет';
    list.append(empty);
    return;
  }
  groups.forEach((group, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `animation-item${index === activeIndex ? ' active' : ''}`;
    button.dataset.armAnimation = String(index);
    button.textContent = group?.name || `Анимация ${index + 1}`;
    list.append(button);
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
  initViewportScale();
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
        onAnimationsChanged: renderArmAnimationList,
      })
    : null;

  if (dash) {
    on(EVENTS.ASSEMBLY_UPDATED, () => dash.reloadAssemblyFromStorage());
    on(EVENTS.PREVIEW_SCENE, ({ sceneId } = {}) => sceneId && dash.previewScene(sceneId));
    on(EVENTS.PLAY_CLIP,     ({ clipId  } = {}) => clipId  && dash.playClip(clipId));
  }

  wireDashboardUI(dash);
  wireTheme();
  initArduinoSerialBridge({ toast });

  const recipe = new DashboardRecipe({
    onHandPoseChanged: (handPose) => dash?.applyHandPose?.(handPose),
  });
  recipe.init();
  dash?.applyHandPose?.(recipe.state?.handPose);

  wireShortcuts(recipe);

  toast('готово. ? — шорткаты', { type: 'success', timeout: 2800 });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
else main();
