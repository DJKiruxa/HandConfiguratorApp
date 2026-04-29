import { initToasts, toast } from './modules/toast.js';
import { initTheme, toggleTheme } from './modules/theme.js';
import { initSnakeGame } from './modules/snakeGame.js';
import { EVENTS, on, emit } from './modules/eventBus.js';
import { DashboardRecipe, ASSEMBLY_STORAGE_KEY } from './modules/recipe.js';
import { createDashboardScene } from './modules/scene.js';

let armAnimationGroupsState = [];
let armAnimationActiveIndex = -1;
let armAnimationActiveProgress = 0;
let armAnimationSequenceMode = false;
let armAnimationSequence = [];

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
    const moveBtn = e.target.closest('[data-arm-sequence-move]');
    if (moveBtn) {
      const index = Number(moveBtn.dataset.armSequenceMove);
      const direction = moveBtn.dataset.armSequenceDirection;
      moveArmAnimationInSequence(index, direction);
      return;
    }

    const btn = e.target.closest('[data-arm-animation]');
    if (!btn) return;
    const index = Number(btn.dataset.armAnimation);
    if (!Number.isInteger(index)) return;
    if (dash?.playArmAnimation(index)) toast(`анимация: ${btn.dataset.armAnimationName || btn.textContent.trim()}`);
  });
  armAnimationList?.addEventListener('input', (e) => {
    const input = e.target.closest('[data-arm-timeline]');
    if (!input) return;
    const index = Number(input.dataset.armTimeline);
    if (!Number.isInteger(index)) return;
    dash?.seekArmAnimation(index, Number(input.value) / 100);
  });
  armAnimationList?.addEventListener('change', (e) => {
    const input = e.target.closest('[data-arm-sequence-select]');
    if (!input) return;
    const index = Number(input.dataset.armSequenceSelect);
    if (!Number.isInteger(index)) return;
    setArmAnimationSequenceSelected(index, input.checked);
  });

  document.getElementById('animationSequenceToggle')?.addEventListener('click', () => {
    armAnimationSequenceMode = !armAnimationSequenceMode;
    renderArmAnimationList(armAnimationGroupsState, armAnimationActiveIndex, armAnimationActiveProgress);
  });
  document.getElementById('animationSequencePlay')?.addEventListener('click', () => {
    if (!armAnimationSequence.length) {
      toast('выберите анимации для очереди', { type: 'warn' });
      return;
    }
    if (dash?.playArmAnimationSequence(armAnimationSequence)) toast('очередь анимаций запущена');
  });
}

function formatAnimationDuration(group) {
  const seconds = Number(group?.durationSec);
  if (!Number.isFinite(seconds) || seconds <= 0) return '0.0s';
  return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
}

function formatAnimationTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '0.0s';
  return `${value.toFixed(1)}s`;
}

function updateArmAnimationProgress(activeIndex = -1, progress = 0, currentSec = 0) {
  const list = document.getElementById('armAnimationList');
  if (!list) return;
  armAnimationActiveIndex = activeIndex;
  armAnimationActiveProgress = progress;
  const safeProgress = Math.max(0, Math.min(1, Number(progress) || 0));
  const value = String(Math.round(safeProgress * 1000) / 10);
  list.querySelectorAll('.animation-item').forEach((item) => {
    const isActive = Number(item.dataset.armAnimationItem) === activeIndex;
    item.classList.toggle('active', isActive);
    const timeline = item.querySelector('[data-arm-timeline]');
    if (timeline && isActive) timeline.value = value;
    const current = item.querySelector('[data-arm-current-time]');
    if (current && isActive) current.textContent = formatAnimationTime(currentSec);
  });
}

function syncArmAnimationSequence(groups) {
  const valid = new Set(groups.map((_, index) => index));
  armAnimationSequence = armAnimationSequence.filter((index) => valid.has(index));
}

function updateArmAnimationSequenceButtons() {
  const toggle = document.getElementById('animationSequenceToggle');
  const play = document.getElementById('animationSequencePlay');
  toggle?.classList.toggle('active', armAnimationSequenceMode);
  if (toggle) toggle.textContent = armAnimationSequenceMode ? 'готово' : 'очередь';
  if (play) play.hidden = !armAnimationSequenceMode;
}

function setArmAnimationSequenceSelected(index, selected) {
  const exists = armAnimationSequence.includes(index);
  if (selected && !exists) armAnimationSequence.push(index);
  if (!selected && exists) armAnimationSequence = armAnimationSequence.filter((item) => item !== index);
  renderArmAnimationList(armAnimationGroupsState, armAnimationActiveIndex, armAnimationActiveProgress);
}

function moveArmAnimationInSequence(index, direction) {
  const position = armAnimationSequence.indexOf(index);
  if (position < 0) return;
  const nextPosition = direction === 'up' ? position - 1 : position + 1;
  if (nextPosition < 0 || nextPosition >= armAnimationSequence.length) return;
  [armAnimationSequence[position], armAnimationSequence[nextPosition]] =
    [armAnimationSequence[nextPosition], armAnimationSequence[position]];
  renderArmAnimationList(armAnimationGroupsState, armAnimationActiveIndex, armAnimationActiveProgress);
}

function renderArmAnimationList(groups = [], activeIndex = -1, activeProgress = 0) {
  const list = document.getElementById('armAnimationList');
  if (!list) return;
  armAnimationGroupsState = groups;
  armAnimationActiveIndex = activeIndex;
  armAnimationActiveProgress = activeProgress;
  syncArmAnimationSequence(groups);
  updateArmAnimationSequenceButtons();
  list.replaceChildren();
  if (!groups.length) {
    const empty = document.createElement('div');
    empty.className = 'animation-empty';
    empty.textContent = 'анимаций нет';
    list.append(empty);
    return;
  }
  groups.forEach((group, index) => {
    const item = document.createElement('div');
    item.className = `animation-item${index === activeIndex ? ' active' : ''}`;
    item.dataset.armAnimationItem = String(index);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'animation-play';
    button.dataset.armAnimation = String(index);
    button.dataset.armAnimationName = group?.name || `Анимация ${index + 1}`;

    const name = document.createElement('span');
    name.className = 'animation-name';
    name.textContent = button.dataset.armAnimationName;
    const duration = document.createElement('span');
    duration.className = 'animation-duration';
    duration.textContent = formatAnimationDuration(group);
    button.append(name, duration);

    const timeline = document.createElement('input');
    timeline.type = 'range';
    timeline.className = 'animation-timeline';
    timeline.min = '0';
    timeline.max = '100';
    timeline.step = '0.1';
    timeline.value = index === activeIndex ? String(Math.max(0, Math.min(1, activeProgress)) * 100) : '0';
    timeline.dataset.armTimeline = String(index);
    timeline.setAttribute('aria-label', `Таймлайн ${button.dataset.armAnimationName}`);

    const timelineRow = document.createElement('div');
    timelineRow.className = 'animation-timeline-row';
    const currentTime = document.createElement('span');
    currentTime.className = 'animation-current-time';
    currentTime.dataset.armCurrentTime = String(index);
    currentTime.textContent = formatAnimationTime(index === activeIndex ? activeProgress * (Number(group?.durationSec) || 0) : 0);
    const totalTime = document.createElement('span');
    totalTime.className = 'animation-total-time';
    totalTime.textContent = `/ ${formatAnimationDuration(group)}`;

    const time = document.createElement('span');
    time.className = 'animation-time';
    time.append(currentTime, totalTime);
    timelineRow.append(timeline, time);

    if (armAnimationSequenceMode) {
      const sequenceRow = document.createElement('div');
      sequenceRow.className = 'animation-sequence-row';
      const sequenceIndex = armAnimationSequence.indexOf(index);
      const checkboxLabel = document.createElement('label');
      checkboxLabel.className = 'animation-sequence-select';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = sequenceIndex >= 0;
      checkbox.dataset.armSequenceSelect = String(index);
      const order = document.createElement('span');
      order.textContent = sequenceIndex >= 0 ? `#${sequenceIndex + 1}` : 'выкл';
      checkboxLabel.append(checkbox, order);

      const controls = document.createElement('span');
      controls.className = 'animation-sequence-controls';
      ['up', 'down'].forEach((direction) => {
        const move = document.createElement('button');
        move.type = 'button';
        move.className = 'animation-sequence-move';
        move.dataset.armSequenceMove = String(index);
        move.dataset.armSequenceDirection = direction;
        move.textContent = direction === 'up' ? '↑' : '↓';
        move.disabled = sequenceIndex < 0 ||
          (direction === 'up' && sequenceIndex === 0) ||
          (direction === 'down' && sequenceIndex === armAnimationSequence.length - 1);
        controls.append(move);
      });
      sequenceRow.append(checkboxLabel, controls);
      item.append(sequenceRow);
    }

    item.append(button, timelineRow);
    list.append(item);
  });
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
        onAnimationsChanged: renderArmAnimationList,
        onAnimationProgress: updateArmAnimationProgress,
      })
    : null;

  if (dash) {
    on(EVENTS.ASSEMBLY_UPDATED, () => dash.reloadAssemblyFromStorage());
    on(EVENTS.PREVIEW_SCENE, ({ sceneId } = {}) => sceneId && dash.previewScene(sceneId));
    on(EVENTS.PLAY_CLIP,     ({ clipId  } = {}) => clipId  && dash.playClip(clipId));
  }

  wireDashboardUI(dash);

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
