/* global BABYLON */

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function radToDeg(r) {
  return (r * 180) / Math.PI;
}

function degToRad(d) {
  return (d * Math.PI) / 180;
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function safeName(str) {
  return String(str || '')
    .trim()
    .replace(/[^\p{L}\p{N}\-_\. ]/gu, '_')
    .slice(0, 80) || 'object';
}

/** Разбивает путь вида `img/models/file.stl` на rootUrl и имя файла для SceneLoader */
function splitModelPath(fullPath) {
  const u = String(fullPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const idx = u.lastIndexOf('/');
  if (idx <= 0) return { rootUrl: '/', filename: u };
  return { rootUrl: u.slice(0, idx + 1), filename: u.slice(idx + 1) };
}

/**
 * Редактор заточен под печатные STL в миллиметрах:
 * вершины STL считаются в мм → 1 единица Babylon = 1 мм (без деления на 1000).
 * Старые manifest с scaleHint 0.001 (метры) приводим к мм.
 */
const EDITOR_DEFAULT_STL_SCALE = 1;

/** Общий ключ «сборка» в localStorage (редактор сохраняет, дашборд читает) */
const ASSEMBLY_STORAGE_KEY = 'babylon_editor_assembly';

/** Сценарий дашборда: последовательность + настройки + параметры (отдельно от геометрии) */
const DASHBOARD_RECIPE_KEY = 'babylon_dashboard_recipe';

function makeStepId() {
  return `st_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function makeAuthoringId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 9)}`;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function easeInOutCubic(t) {
  const u = clamp(t, 0, 1);
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}

function cameraSnapshot(cam) {
  if (!cam) {
    return { alpha: 0, beta: 0.85, radius: 140, target: { x: 0, y: 0, z: 0 } };
  }
  const tgt = cam.target ? cam.target : new BABYLON.Vector3(0, 0, 0);
  return {
    alpha: cam.alpha,
    beta: cam.beta,
    radius: cam.radius,
    target: { x: tgt.x, y: tgt.y, z: tgt.z },
  };
}

function applyCameraSnapshot(cam, snap) {
  if (!cam || !snap) return;
  if (Number.isFinite(snap.alpha)) cam.alpha = snap.alpha;
  if (Number.isFinite(snap.beta)) cam.beta = snap.beta;
  if (Number.isFinite(snap.radius)) cam.radius = snap.radius;
  cam.setTarget(objToVec3(snap.target, BABYLON.Vector3.Zero()));
}

function lerpTransformSnapshot(a, b, t) {
  if (!a) return b;
  if (!b) return a;
  const L = (xa, xb) => lerp(xa, xb, t);
  let rx = L(a.rotation.x, b.rotation.x);
  let ry = L(a.rotation.y, b.rotation.y);
  let rz = L(a.rotation.z, b.rotation.z);
  if (typeof BABYLON !== 'undefined' && BABYLON.Quaternion && BABYLON.Quaternion.Slerp) {
    try {
      const qa = BABYLON.Quaternion.FromEulerAngles(a.rotation.x, a.rotation.y, a.rotation.z);
      const qb = BABYLON.Quaternion.FromEulerAngles(b.rotation.x, b.rotation.y, b.rotation.z);
      const qr = BABYLON.Quaternion.Slerp(qa, qb, t);
      const e = qr.toEulerAngles();
      rx = e.x;
      ry = e.y;
      rz = e.z;
    } catch (_) {
      /* fallback — линейный euler */
    }
  }
  return {
    position: {
      x: L(a.position.x, b.position.x),
      y: L(a.position.y, b.position.y),
      z: L(a.position.z, b.position.z),
    },
    rotation: { x: rx, y: ry, z: rz },
    scaling: {
      x: L(a.scaling.x, b.scaling.x),
      y: L(a.scaling.y, b.scaling.y),
      z: L(a.scaling.z, b.scaling.z),
    },
  };
}

function normalizeAuthoring(raw) {
  if (!raw || typeof raw !== 'object') return { scenes: [], clips: [] };
  return {
    scenes: Array.isArray(raw.scenes) ? raw.scenes : [],
    clips: Array.isArray(raw.clips) ? raw.clips : [],
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDurationSec(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  if (sec < 60) return `${Math.round(sec)} с`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s ? `${m} мин ${s} с` : `${m} мин`;
}

const STEP_KIND_META = {
  prepare: { label: 'подготовка', color: '#4f8cff' },
  assemble: { label: 'сборка', color: '#3dd68c' },
  calibrate: { label: 'калибровка', color: '#f5a623' },
  verify: { label: 'проверка', color: '#9b7cfb' },
  custom: { label: 'этап', color: '#8b8fa8' },
};

function getRecipeStepDefaults() {
  return [
    {
      id: 'step_visual',
      title: 'Визуальный осмотр модели и креплений',
      kind: 'prepare',
      durationSec: 180,
      done: false,
      sceneId: null,
      clipId: null,
    },
    {
      id: 'step_align',
      title: 'Совмещение артикуляции с опорной схемой',
      kind: 'assemble',
      durationSec: 600,
      done: false,
      sceneId: null,
      clipId: null,
    },
    {
      id: 'step_calib',
      title: 'Ноль и диапазон приводов',
      kind: 'calibrate',
      durationSec: 300,
      done: false,
      sceneId: null,
      clipId: null,
    },
    {
      id: 'step_verify',
      title: 'Контрольный захват и повторяемость',
      kind: 'verify',
      durationSec: 240,
      done: false,
      sceneId: null,
      clipId: null,
    },
  ];
}

function getRecipeDefaultsPayload() {
  return {
    version: 1,
    sequence: {
      activeStepIndex: 0,
      steps: getRecipeStepDefaults(),
    },
    settings: {
      torqueLimit: {
        label: 'Ограничение усилия (защита)',
        description: 'Не превышать допустимый момент на приводе',
        value: true,
      },
      mirrorAxes: {
        label: 'Зеркало симметрии',
        description: 'Согласованное движение парных пальцев',
        value: false,
      },
      zeroCalibration: {
        label: 'Калибровка нуля перед работой',
        description: 'Обязательный прогон при старте сессии',
        value: true,
      },
      sessionLog: {
        label: 'Запись лога сессии',
        description: 'События шагов и изменения параметров',
        value: false,
      },
    },
    parameters: {
      gripForce: { label: 'Макс. усилие захвата', unit: '%', min: 0, max: 100, step: 1, value: 70 },
      flexSpeed: { label: 'Скорость сгибания', unit: '%', min: 0, max: 100, step: 1, value: 50 },
      sensorThresh: { label: 'Порог датчика касания', unit: '%', min: 0, max: 100, step: 1, value: 35 },
      smoothing: { label: 'Плавность / фильтр', unit: '%', min: 0, max: 100, step: 1, value: 60 },
    },
  };
}

class DashboardRecipe {
  constructor() {
    this.state = null;
  }

  load() {
    const def = getRecipeDefaultsPayload();
    try {
      const raw = localStorage.getItem(DASHBOARD_RECIPE_KEY);
      if (!raw) {
        this.state = JSON.parse(JSON.stringify(def));
        return;
      }
      const data = JSON.parse(raw);
      this.state = this.mergeWithDefaults(data, def);
    } catch (_) {
      this.state = JSON.parse(JSON.stringify(getRecipeDefaultsPayload()));
    }
  }

  mergeWithDefaults(data, def) {
    const out = JSON.parse(JSON.stringify(def));
    if (!data || typeof data !== 'object') return out;
    if (data.sequence && Array.isArray(data.sequence.steps) && data.sequence.steps.length) {
      out.sequence.steps = data.sequence.steps.map((s, i) => ({
        id: s.id || `step_${i}_${makeStepId()}`,
        title: String(s.title || `шаг ${i + 1}`),
        kind: STEP_KIND_META[s.kind] ? s.kind : 'custom',
        durationSec: Number.isFinite(s.durationSec) ? s.durationSec : 60,
        done: !!s.done,
        sceneId: s.sceneId != null && s.sceneId !== '' ? String(s.sceneId) : null,
        clipId: s.clipId != null && s.clipId !== '' ? String(s.clipId) : null,
      }));
      out.sequence.activeStepIndex = clamp(
        Number(data.sequence.activeStepIndex) || 0,
        0,
        out.sequence.steps.length - 1
      );
    }
    if (data.settings && typeof data.settings === 'object') {
      for (const k of Object.keys(out.settings)) {
        if (data.settings[k] && typeof data.settings[k].value === 'boolean') {
          out.settings[k].value = data.settings[k].value;
        }
      }
    }
    if (data.parameters && typeof data.parameters === 'object') {
      for (const k of Object.keys(out.parameters)) {
        if (
          out.parameters[k] &&
          data.parameters[k] &&
          Number.isFinite(Number(data.parameters[k].value))
        ) {
          out.parameters[k].value = clamp(
            Number(data.parameters[k].value),
            out.parameters[k].min,
            out.parameters[k].max
          );
        }
      }
    }
    return out;
  }

  save() {
    localStorage.setItem(DASHBOARD_RECIPE_KEY, JSON.stringify(this.state));
  }

  resetSettings() {
    const def = getRecipeDefaultsPayload();
    this.state.settings = JSON.parse(JSON.stringify(def.settings));
    this.renderSettings();
    this.save();
    this.updateOutput('настройки: сброс к умолчанию');
  }

  applySettings() {
    this.save();
    this.updateOutput('настройки применены');
  }

  resetParameters() {
    const def = getRecipeDefaultsPayload();
    this.state.parameters = JSON.parse(JSON.stringify(def.parameters));
    this.renderParams();
    this.save();
    this.updateOutput('параметры: сброс');
  }

  applyParameters() {
    this.save();
    this.updateOutput('параметры применены');
  }

  addStep() {
    const title = window.prompt('Название шага', 'Новый этап');
    if (title === null) return;
    const t = String(title).trim() || 'Новый этап';
    this.state.sequence.steps.push({
      id: makeStepId(),
      title: t,
      kind: 'custom',
      durationSec: 120,
      done: false,
      sceneId: null,
      clipId: null,
    });
    this.state.sequence.activeStepIndex = this.state.sequence.steps.length - 1;
    this.save();
    this.renderSequence();
    this.updateOutput('добавлен шаг');
  }

  removeStep(index) {
    if (this.state.sequence.steps.length <= 1) return;
    this.state.sequence.steps.splice(index, 1);
    this.state.sequence.activeStepIndex = clamp(
      this.state.sequence.activeStepIndex,
      0,
      this.state.sequence.steps.length - 1
    );
    this.save();
    this.renderSequence();
    this.updateOutput('шаг удалён');
  }

  moveStep(index, dir) {
    const steps = this.state.sequence.steps;
    const j = index + dir;
    if (j < 0 || j >= steps.length) return;
    const tmp = steps[index];
    steps[index] = steps[j];
    steps[j] = tmp;
    if (this.state.sequence.activeStepIndex === index) this.state.sequence.activeStepIndex = j;
    else if (this.state.sequence.activeStepIndex === j) this.state.sequence.activeStepIndex = index;
    this.save();
    this.renderSequence();
  }

  setActiveStep(index) {
    this.state.sequence.activeStepIndex = clamp(index, 0, this.state.sequence.steps.length - 1);
    this.save();
    this.renderSequence();
  }

  toggleStepDone(index) {
    const s = this.state.sequence.steps[index];
    if (!s) return;
    s.done = !s.done;
    this.save();
    this.renderSequence();
  }

  setStepSceneId(index, sceneId) {
    const s = this.state.sequence.steps[index];
    if (!s) return;
    s.sceneId = sceneId || null;
    this.save();
  }

  setStepClipId(index, clipId) {
    const s = this.state.sequence.steps[index];
    if (!s) return;
    s.clipId = clipId || null;
    this.save();
  }

  readAuthoringFromStorage() {
    try {
      const raw = localStorage.getItem(ASSEMBLY_STORAGE_KEY);
      if (!raw) return normalizeAuthoring(null);
      const data = JSON.parse(raw);
      return normalizeAuthoring(data.authoring);
    } catch (_) {
      return normalizeAuthoring(null);
    }
  }

  toggleSetting(key) {
    if (!this.state.settings[key]) return;
    this.state.settings[key].value = !this.state.settings[key].value;
    this.save();
    this.renderSettings();
  }

  setParamValue(key, val) {
    const p = this.state.parameters[key];
    if (!p) return;
    p.value = clamp(Number(val), p.min, p.max);
  }

  buildFullExportObject() {
    let assembly = null;
    try {
      const raw = localStorage.getItem(ASSEMBLY_STORAGE_KEY);
      if (raw) assembly = JSON.parse(raw);
    } catch (_) {}
    return {
      exportedAt: new Date().toISOString(),
      schema: 'babylon.pipeline+v1',
      assembly: assembly || null,
      pipeline: this.state,
    };
  }

  updateOutput(note) {
    const ta = document.getElementById('recipeOutput');
    const st = document.getElementById('recipeStatus');
    if (ta) {
      ta.value = JSON.stringify(this.buildFullExportObject(), null, 2);
    }
    if (st) {
      st.textContent = note || `обновлено ${new Date().toLocaleTimeString()}`;
    }
  }

  renderSequence() {
    const root = document.getElementById('recipeSeqList');
    if (!root || !this.state) return;
    root.innerHTML = '';
    const { steps, activeStepIndex } = this.state.sequence;
    const auth = this.readAuthoringFromStorage();
    const sceneOpts = auth.scenes
      .map((sc) => `<option value="${escapeHtml(sc.id)}">${escapeHtml(sc.name || sc.id)}</option>`)
      .join('');
    const clipOpts = auth.clips
      .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name || c.id)}</option>`)
      .join('');

    steps.forEach((step, index) => {
      const meta = STEP_KIND_META[step.kind] || STEP_KIND_META.custom;
      const row = document.createElement('div');
      row.className = `seq-item${index === activeStepIndex ? ' active' : ''}`;
      row.dataset.stepIndex = String(index);
      row.innerHTML = `
        <div class="seq-row-main">
          <div class="seq-handle"><span></span><span></span></div>
          <div class="seq-dot" style="background:${meta.color}"></div>
          <span class="seq-name" title="${escapeHtml(step.title)}">${escapeHtml(step.title)}</span>
          <span class="seq-time">${formatDurationSec(step.durationSec)}</span>
          <button type="button" class="seq-done${step.done ? ' checked' : ''}" title="Отметить выполнение" data-act="done">${step.done ? '✓' : ''}</button>
          <div class="seq-row-actions">
            <button type="button" data-act="up" title="Выше">↑</button>
            <button type="button" data-act="down" title="Ниже">↓</button>
            <button type="button" data-act="del" title="Удалить">×</button>
          </div>
        </div>
        <div class="seq-row-bind" data-no-step-select>
          <select class="seq-select" data-bind="scene" title="Сцена превью (из редактора)">
            <option value="">сцена —</option>
            ${sceneOpts}
          </select>
          <button type="button" class="seq-preview-btn" data-act="scene-prev" title="Показать сцену">◎</button>
          <select class="seq-select" data-bind="clip" title="Клип (анимация между сценами)">
            <option value="">клип —</option>
            ${clipOpts}
          </select>
          <button type="button" class="seq-preview-btn" data-act="clip-play" title="Проиграть клип">▶</button>
        </div>
      `;
      const selScene = row.querySelector('select[data-bind="scene"]');
      const selClip = row.querySelector('select[data-bind="clip"]');
      if (step.sceneId && selScene) selScene.value = step.sceneId;
      if (step.clipId && selClip) selClip.value = step.clipId;

      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        if (e.target.closest('[data-no-step-select]')) return;
        if (e.target.closest('select')) return;
        this.setActiveStep(index);
      });
      row.querySelector('[data-act="done"]').addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleStepDone(index);
      });
      row.querySelector('[data-act="up"]').addEventListener('click', (e) => {
        e.stopPropagation();
        this.moveStep(index, -1);
      });
      row.querySelector('[data-act="down"]').addEventListener('click', (e) => {
        e.stopPropagation();
        this.moveStep(index, 1);
      });
      row.querySelector('[data-act="del"]').addEventListener('click', (e) => {
        e.stopPropagation();
        if (steps.length <= 1) return;
        this.removeStep(index);
      });

      selScene?.addEventListener('change', () => {
        this.setStepSceneId(index, selScene.value);
        this.updateOutput('привязка сцены к шагу');
      });
      selClip?.addEventListener('change', () => {
        this.setStepClipId(index, selClip.value);
        this.updateOutput('привязка клипа к шагу');
      });
      row.querySelector('[data-act="scene-prev"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = selScene && selScene.value;
        if (!id) return;
        try {
          window.dispatchEvent(new CustomEvent('babylon-dash-preview-scene', { detail: { sceneId: id } }));
        } catch (_) {}
        this.updateOutput('превью сцены');
      });
      row.querySelector('[data-act="clip-play"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = selClip && selClip.value;
        if (!id) return;
        try {
          window.dispatchEvent(new CustomEvent('babylon-dash-play-clip', { detail: { clipId: id } }));
        } catch (_) {}
        this.updateOutput('клип');
      });

      root.appendChild(row);
    });
  }

  renderSettings() {
    const root = document.getElementById('recipeSettings');
    if (!root || !this.state) return;
    root.innerHTML = '';
    Object.keys(this.state.settings).forEach((key) => {
      const s = this.state.settings[key];
      const item = document.createElement('div');
      item.className = `setting-item${s.value ? ' active' : ''}`;
      item.innerHTML = `
        <span class="setting-label" title="${s.description || ''}">${s.label}</span>
        <div class="setting-toggle" aria-hidden="true"></div>
      `;
      item.addEventListener('click', () => {
        this.toggleSetting(key);
      });
      root.appendChild(item);
    });
  }

  renderParams() {
    const root = document.getElementById('recipeParams');
    if (!root || !this.state) return;
    root.innerHTML = '';
    Object.keys(this.state.parameters).forEach((key) => {
      const p = this.state.parameters[key];
      const gid = `rp_${key}`;
      const grp = document.createElement('div');
      grp.className = 'slider-group';
      grp.innerHTML = `
        <div class="slider-top">
          <span class="slider-label">${p.label}</span>
          <span class="slider-val" id="${gid}_v">${p.value}</span><span style="font-family:var(--mono);font-size:10px;color:var(--text3)">${p.unit || ''}</span>
        </div>
        <input type="range" id="${gid}" min="${p.min}" max="${p.max}" step="${p.step}" value="${p.value}">
      `;
      const inp = grp.querySelector('input');
      const valEl = grp.querySelector(`#${gid}_v`);
      inp.addEventListener('input', () => {
        this.setParamValue(key, inp.value);
        valEl.textContent = String(this.state.parameters[key].value);
      });
      inp.addEventListener('change', () => this.save());
      root.appendChild(grp);
    });
  }

  renderAll() {
    this.renderSequence();
    this.renderSettings();
    this.renderParams();
    this.updateOutput('готово');
  }

  bind() {
    document.querySelectorAll('[data-recipe-action="seq-add"]').forEach((el) => {
      el.addEventListener('click', () => this.addStep());
    });
    document.querySelector('[data-recipe-action="settings-reset"]')?.addEventListener('click', () => this.resetSettings());
    document.querySelector('[data-recipe-action="settings-apply"]')?.addEventListener('click', () => this.applySettings());
    document.querySelector('[data-recipe-action="params-reset"]')?.addEventListener('click', () => this.resetParameters());
    document.querySelector('[data-recipe-action="params-apply"]')?.addEventListener('click', () => this.applyParameters());
    document.querySelector('[data-recipe-action="refresh-output"]')?.addEventListener('click', () => this.updateOutput('ручное обновление'));
    document.querySelector('[data-recipe-action="export-json"]')?.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(this.buildFullExportObject(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pipeline_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      this.updateOutput('экспорт .json');
    });
    document.querySelector('[data-recipe-action="export-txt"]')?.addEventListener('click', () => {
      const text = JSON.stringify(this.buildFullExportObject(), null, 2);
      downloadText(`pipeline_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`, text);
      this.updateOutput('экспорт .txt');
    });
  }

  init() {
    this.load();
    this.renderAll();
    this.bind();
  }
}

function normalizeStlScaleHint(hint) {
  if (hint == null || Number.isNaN(hint)) return EDITOR_DEFAULT_STL_SCALE;
  const h = Number(hint);
  if (h <= 0) return EDITOR_DEFAULT_STL_SCALE;
  if (Math.abs(h - 0.001) < 1e-9) return 1;
  return h;
}

function vec3ToObj(v) {
  return { x: v.x, y: v.y, z: v.z };
}

function objToVec3(o, fallback) {
  if (!o) return fallback.clone();
  return new BABYLON.Vector3(Number(o.x) || 0, Number(o.y) || 0, Number(o.z) || 0);
}

function transformSnapshot(node) {
  return {
    position: vec3ToObj(node.position),
    rotation: vec3ToObj(node.rotation),
    scaling: vec3ToObj(node.scaling),
  };
}

function applyTransformSnapshot(node, snap) {
  node.position.set(snap.position.x, snap.position.y, snap.position.z);
  node.rotation.set(snap.rotation.x, snap.rotation.y, snap.rotation.z);
  node.scaling.set(snap.scaling.x, snap.scaling.y, snap.scaling.z);
}

/** Единичные направления осей в координатах SVG (совпадают с блоками `tool-gizmo-block`). */
const PANEL_GIZMO_AXIS_2D = (() => {
  const n = (x, y) => {
    const L = Math.hypot(x, y) || 1;
    return { x: x / L, y: y / L };
  };
  return { x: n(48, 30), y: n(0, -52), z: n(-48, 30) };
})();

function transformSnapshotsEqual(a, b) {
  if (!a || !b) return a === b;
  return (
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    a.position.z === b.position.z &&
    a.rotation.x === b.rotation.x &&
    a.rotation.y === b.rotation.y &&
    a.rotation.z === b.rotation.z &&
    a.scaling.x === b.scaling.x &&
    a.scaling.y === b.scaling.y &&
    a.scaling.z === b.scaling.z
  );
}

function scenePayloadUsesPartNames(parts) {
  return Array.isArray(parts) && parts.some((p) => p && p.partName);
}

/**
 * Сцена (авторинг): у частей может быть partName; превью дашборда — узлы dash_part_i, тогда берём по индексу.
 */
function getPartTransformForNodeInScene(scenePayload, node, index) {
  if (!scenePayload || !Array.isArray(scenePayload.parts)) return null;
  const pp = scenePayload.parts;
  if (scenePayloadUsesPartNames(pp)) {
    const isDash = node && String(node.name || '').startsWith('dash_part_');
    if (isDash) return pp[index] && pp[index].transform ? pp[index].transform : null;
    const hit = pp.find((p) => p && p.partName === node.name);
    return hit && hit.transform ? hit.transform : null;
  }
  return pp[index] && pp[index].transform ? pp[index].transform : null;
}

function partTintMaterial(scene, index) {
  const mat = new BABYLON.StandardMaterial(`partMat_${index}_${Date.now()}`, scene);
  const hue = ((index * 137.508) % 360) / 360;
  if (typeof BABYLON.Color3.FromHSV === 'function') {
    mat.diffuseColor = BABYLON.Color3.FromHSV(hue, 0.22, 0.94);
  } else {
    mat.diffuseColor = new BABYLON.Color3(0.55 + (index % 7) * 0.04, 0.62, 0.78);
  }
  mat.specularColor = new BABYLON.Color3(0.15, 0.16, 0.2);
  mat.specularPower = 64;
  return mat;
}

async function getManifestAssetList() {
  const res = await fetch('img/models/stl-manifest.json', { cache: 'no-store' });
  if (!res.ok) return [];
  const json = await res.json();
  if (!Array.isArray(json.assets)) return [];
  return json.assets
    .filter((a) => a && a.name && a.file)
    .map((a, idx) => ({
      id: a.id || `stl_${idx}`,
      name: String(a.name),
      file: a.file,
      url: `img/models/${a.file}`,
      scaleHint: normalizeStlScaleHint(typeof a.scaleHint === 'number' ? a.scaleHint : null),
    }));
}

function resolvePartAssetFromManifest(p, manifestAssets) {
  let asset = null;
  if (p.assetId) asset = manifestAssets.find((a) => a.id === p.assetId);
  if (!asset && p.label) {
    asset = manifestAssets.find(
      (a) => a.name === p.label || (p.label && (p.label.includes(a.name) || a.name.includes(p.label)))
    );
  }
  if (!asset && p.name) {
    const s = String(p.name);
    asset = manifestAssets.find((a) => a.file && s.includes(a.file));
    if (!asset) asset = manifestAssets.find((a) => s.includes(safeName(a.name)));
  }
  return asset;
}

function createDashboardScene(canvas) {
  const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.04, 0.045, 0.06, 1);
  scene.ambientColor = new BABYLON.Color3(0.18, 0.2, 0.24);

  const camera = new BABYLON.ArcRotateCamera(
    'dashCam',
    -Math.PI / 2.35,
    Math.PI / 3.1,
    180,
    new BABYLON.Vector3(0, 0, 0),
    scene
  );
  camera.attachControl(canvas, true);
  camera.wheelPrecision = 35;
  camera.panningSensibility = 60;
  camera.lowerRadiusLimit = 20;
  camera.upperRadiusLimit = 1200;

  new BABYLON.HemisphericLight('dashH', new BABYLON.Vector3(0.1, 1, 0.2), scene).intensity = 0.88;
  new BABYLON.DirectionalLight('dashD', new BABYLON.Vector3(-0.45, -0.85, -0.3), scene).intensity = 0.48;

  let assemblyRoot = null;
  let fallbackRoot = null;
  let lastAssemblyData = null;
  let clipRunId = 0;
  let dashClipRenderObs = null;

  function dashSceneById(data, sceneId) {
    const a = normalizeAuthoring(data && data.authoring);
    return a.scenes.find((s) => s.id === sceneId) || null;
  }

  function dashClipById(data, clipId) {
    const a = normalizeAuthoring(data && data.authoring);
    return a.clips.find((c) => c.id === clipId) || null;
  }

  function applyDashScenePayload(payload) {
    if (!payload || !payload.camera) return false;
    applyCameraSnapshot(camera, payload.camera);
    if (!assemblyRoot || !Array.isArray(payload.parts)) return true;
    const ch = assemblyRoot.children || [];
    for (let i = 0; i < ch.length && i < payload.parts.length; i++) {
      const tr = payload.parts[i].transform;
      if (tr && tr.position) applyTransformSnapshot(ch[i], tr);
    }
    return true;
  }

  function lerpDashScenes(a, b, t) {
    if (!a || !b || !a.camera || !b.camera) return;
    const ca = a.camera;
    const cb = b.camera;
    camera.alpha = lerp(ca.alpha, cb.alpha, t);
    camera.beta = lerp(ca.beta, cb.beta, t);
    camera.radius = lerp(ca.radius, cb.radius, t);
    const ta = objToVec3(ca.target, BABYLON.Vector3.Zero());
    const tb = objToVec3(cb.target, BABYLON.Vector3.Zero());
    camera.setTarget(BABYLON.Vector3.Lerp(ta, tb, t));
    if (!assemblyRoot) return;
    const ch = assemblyRoot.children || [];
    const pa = a.parts || [];
    const pb = b.parts || [];
    for (let i = 0; i < ch.length; i++) {
      const node = ch[i];
      const tra = getPartTransformForNodeInScene(a, node, i);
      const trb = getPartTransformForNodeInScene(b, node, i);
      if (!tra && !trb) continue;
      const lerped = lerpTransformSnapshot(tra, trb, t);
      if (lerped && lerped.position) applyTransformSnapshot(node, lerped);
    }
  }

  function previewScene(sceneId) {
    if (!lastAssemblyData) return false;
    const sc = dashSceneById(lastAssemblyData, sceneId);
    if (!sc) return false;
    clipRunId += 1;
    if (dashClipRenderObs) {
      scene.onBeforeRenderObservable.remove(dashClipRenderObs);
      dashClipRenderObs = null;
    }
    return applyDashScenePayload(sc);
  }

  function playClip(clipId) {
    if (!lastAssemblyData) return false;
    const clip = dashClipById(lastAssemblyData, clipId);
    if (!clip) return false;
    const a = dashSceneById(lastAssemblyData, clip.fromSceneId);
    const b = dashSceneById(lastAssemblyData, clip.toSceneId);
    if (!a || !b) return false;
    if (dashClipRenderObs) {
      scene.onBeforeRenderObservable.remove(dashClipRenderObs);
      dashClipRenderObs = null;
    }
    const run = ++clipRunId;
    const durMs = Math.max(150, (Number(clip.durationSec) || 2) * 1000);
    const t0 = performance.now();
    const clipObs = scene.onBeforeRenderObservable.add(() => {
      if (run !== clipRunId) {
        scene.onBeforeRenderObservable.remove(clipObs);
        if (dashClipRenderObs === clipObs) dashClipRenderObs = null;
        return;
      }
      const elapsed = performance.now() - t0;
      const u = Math.min(1, elapsed / durMs);
      const tt = easeInOutCubic(u);
      lerpDashScenes(a, b, tt);
      if (u >= 1) {
        lerpDashScenes(a, b, 1);
        scene.onBeforeRenderObservable.remove(clipObs);
        if (dashClipRenderObs === clipObs) dashClipRenderObs = null;
      }
    });
    dashClipRenderObs = clipObs;
    return true;
  }

  function stopClipPlayback() {
    clipRunId += 1;
    if (dashClipRenderObs) {
      scene.onBeforeRenderObservable.remove(dashClipRenderObs);
      dashClipRenderObs = null;
    }
  }

  function disposeFallback() {
    if (fallbackRoot) {
      fallbackRoot.dispose(false, true);
      fallbackRoot = null;
    }
  }

  function disposeAssembly() {
    if (assemblyRoot) {
      assemblyRoot.dispose(false, true);
      assemblyRoot = null;
    }
  }

  async function loadAssemblyIntoScene(data) {
    disposeAssembly();
    disposeFallback();
    lastAssemblyData = data || null;
    if (!data || !Array.isArray(data.parts) || !data.parts.length) return false;

    const manifest = await getManifestAssetList();
    assemblyRoot = new BABYLON.TransformNode('dash_assembly', scene);
    let placed = 0;

    for (let i = 0; i < data.parts.length; i++) {
      const p = data.parts[i];
      const tr = p.transform;
      if (!tr || !tr.position) continue;

      const asset = resolvePartAssetFromManifest(p, manifest);
      if (!asset) continue;

      const parsed = splitModelPath(asset.url);
      const child = new BABYLON.TransformNode(`dash_part_${placed}`, scene);
      child.parent = assemblyRoot;

      try {
        const res = await BABYLON.SceneLoader.ImportMeshAsync('', parsed.rootUrl, parsed.filename, scene);
        const meshes = (res.meshes || []).filter((m) => m);
        const mat = partTintMaterial(scene, placed);
        for (const m of meshes) {
          m.parent = child;
          if (m instanceof BABYLON.Mesh) m.material = mat;
        }
        applyTransformSnapshot(child, tr);
        placed += 1;
      } catch (e) {
        console.warn('dashboard STL:', e);
        child.dispose();
      }
    }

    if (!placed) {
      disposeAssembly();
      return false;
    }

    const info = assemblyRoot.getHierarchyBoundingVectors(true);
    const center = info.min.add(info.max).scale(0.5);
    const dx = info.max.x - info.min.x;
    const dy = info.max.y - info.min.y;
    const dz = info.max.z - info.min.z;
    const size = Math.sqrt(dx * dx + dy * dy + dz * dz);
    camera.setTarget(center);
    camera.radius = clamp(size * 1.42, 40, 800);
    camera.alpha = -Math.PI / 2.35;
    camera.beta = Math.PI / 3.1;
    return true;
  }

  async function loadHandFallback() {
    disposeFallback();
    try {
      const result = await BABYLON.SceneLoader.ImportMeshAsync('', 'img/models/', 'hand2.glb', scene);
      fallbackRoot = result.meshes[0];
      fallbackRoot.scaling = new BABYLON.Vector3(0.001, 0.001, 0.001);
      camera.setTarget(BABYLON.Vector3.Zero());
      camera.radius = 5;
    } catch (_) {}
  }

  async function reloadAssemblyFromStorage() {
    let data = null;
    try {
      const raw = localStorage.getItem(ASSEMBLY_STORAGE_KEY);
      if (raw) data = JSON.parse(raw);
    } catch (_) {}
    lastAssemblyData = data;
    const ok = data && (await loadAssemblyIntoScene(data));
    if (!ok) await loadHandFallback();
    requestAnimationFrame(() => engine.resize());
  }

  reloadAssemblyFromStorage();

  engine.runRenderLoop(() => scene.render());
  window.addEventListener('resize', () => engine.resize());
  requestAnimationFrame(() => engine.resize());

  return {
    engine,
    scene,
    camera,
    reloadAssemblyFromStorage,
    previewScene,
    playClip,
    stopClipPlayback,
  };
}

class CommandStack {
  constructor(limit = 200) {
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }
  push(cmd) {
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    cmd.undo();
    this.redoStack.push(cmd);
    return true;
  }
  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    cmd.redo();
    this.undoStack.push(cmd);
    return true;
  }
}

class EditorApp {
  constructor(canvas, ui) {
    this.canvas = canvas;
    this.ui = ui;

    this.engine = null;
    this.scene = null;
    this.camera = null;
    this.gridMesh = null;
    this.gridMat = null;

    this.assets = [];
    this.activeAsset = null; // {id, name, kind, url | file}
    this.selected = null; // TransformNode

    this.tool = 'select';
    this.snapEnabled = false;
    this.gridEnabled = true;
    this.snapStep = 1;

    this.commands = new CommandStack(300);
    this._pointerObserver = null;
    this._onKeyDown = null;
    this._transformStart = null;
    /** @type {{ axis: 'x'|'y'|'z', kind: 'move'|'rotate'|'scale', lastX: number, lastY: number, before: ReturnType<typeof transformSnapshot> } | null} */
    this._panelGizmoDrag = null;
    this._lastInspectorWrite = 0;
    this._partTintIndex = 0;
    this._hlMeshes = [];
    this._highlightLayer = null;

    /** Сцены и клипы (сохраняются в JSON сборки в `authoring`) */
    this.authoring = { scenes: [], clips: [] };
    this._clipRunId = 0;
    this._clipPlaybackObs = null;

    /** Режим «анимация»: кадры после жестов по осям в панели */
    this.animationMode = false;
    /** Снимок сцены на момент входа в режим — при выходе восстанавливаем, чтобы проигрывать клипы с «исходной» позы */
    this._animSessionBaseline = null;
    this._animFrameSeq = 0;
    this._flashKeyframeT = null;

    this._ensure();
    this._bindUI();
  }

  setHudError(msg) {
    const el = this.ui.hudError;
    if (!el) return;
    if (msg) {
      el.style.display = '';
      el.textContent = msg;
      el.style.color = '#ff6b6b';
    } else {
      el.style.display = 'none';
      el.textContent = '';
    }
  }

  _ensure() {
    if (this.engine) return;
    this.engine = new BABYLON.Engine(this.canvas, true, { preserveDrawingBuffer: true, stencil: true });
    this.scene = new BABYLON.Scene(this.engine);
    this.scene.clearColor = new BABYLON.Color4(0.04, 0.045, 0.06, 1);
    this.scene.ambientColor = new BABYLON.Color3(0.2, 0.21, 0.26);

    // Camera
    this.camera = new BABYLON.ArcRotateCamera(
      'editorCam',
      -Math.PI / 2,
      Math.PI / 3.2,
      140,
      new BABYLON.Vector3(0, 0, 0),
      this.scene
    );
    this.camera.attachControl(this.canvas, true);
    this.camera.wheelPrecision = 28;
    this.camera.panningSensibility = 55;
    this.camera.lowerRadiusLimit = 12;
    this.camera.upperRadiusLimit = 2500;

    const hem = new BABYLON.HemisphericLight('h1', new BABYLON.Vector3(0.15, 1, 0.2), this.scene);
    hem.intensity = 0.85;
    const dl = new BABYLON.DirectionalLight('d1', new BABYLON.Vector3(-0.45, -0.85, -0.35), this.scene);
    dl.intensity = 0.55;
    const fill = new BABYLON.DirectionalLight('fill', new BABYLON.Vector3(0.7, -0.2, 0.5), this.scene);
    fill.intensity = 0.22;

    try {
      this._highlightLayer = new BABYLON.HighlightLayer('hl_editor', this.scene);
      this._highlightLayer.innerGlow = true;
    } catch (_) {
      this._highlightLayer = null;
    }

    // Пол и сетка в мм: 600×600 мм рабочая зона; линии каждые 1 мм, акцент каждые 10 мм
    this.gridMesh = BABYLON.MeshBuilder.CreateGround('ground', { width: 600, height: 600 }, this.scene);
    this.gridMesh.isPickable = true;
    this.gridMesh.receiveShadows = false;
    this.gridMat = new BABYLON.GridMaterial('gridMat', this.scene);
    this.gridMat.opacity = 0.85;
    this.gridMat.gridRatio = 1;
    this.gridMat.majorUnitFrequency = 10;
    this.gridMat.minorUnitVisibility = 0.42;
    this.gridMat.mainColor = new BABYLON.Color3(0.08, 0.09, 0.11);
    this.gridMat.lineColor = new BABYLON.Color3(0.31, 0.55, 1.0);
    this.gridMesh.material = this.gridMat;

    this._setupSelection();
    this._setupToolPanelGizmo();

    this.engine.runRenderLoop(() => {
      if (this.scene) this.scene.render();
      this._syncInspectorThrottled();
    });

    window.addEventListener('resize', () => this.engine.resize());
    requestAnimationFrame(() => this.engine.resize());

    // initial
    this._setTool('select');
    this._setGrid(true);
    this._setSnap(false);
  }

  dispose() {
    if (this._clipPlaybackObs && this.scene) {
      this.scene.onBeforeRenderObservable.remove(this._clipPlaybackObs);
      this._clipPlaybackObs = null;
    }
    if (this._pointerObserver) this.scene.onPointerObservable.remove(this._pointerObserver);
    if (this._onKeyDown) window.removeEventListener('keydown', this._onKeyDown);
    this._cleanupHighlight();
    if (this.scene) this.scene.dispose();
    if (this.engine) this.engine.dispose();
    this.scene = null;
    this.engine = null;
  }

  _cleanupHighlight() {
    if (!this._highlightLayer) {
      this._hlMeshes = [];
      return;
    }
    for (const m of this._hlMeshes) {
      try {
        this._highlightLayer.removeMesh(m);
      } catch (_) {}
    }
    this._hlMeshes = [];
  }

  _applySelectionHighlight(node) {
    this._cleanupHighlight();
    if (!this._highlightLayer || !node) return;
    const col = new BABYLON.Color3(0.35, 0.62, 1);
    const meshes = node.getChildMeshes ? node.getChildMeshes(false) : [];
    for (const m of meshes) {
      if (m instanceof BABYLON.Mesh && m !== this.gridMesh) {
        try {
          this._highlightLayer.addMesh(m, col);
          this._hlMeshes.push(m);
        } catch (_) {}
      }
    }
  }

  _getPartRoots() {
    return this.scene.transformNodes.filter((n) => n && n.name && n.name.startsWith('part_'));
  }

  _refreshOutliner() {
    const root = this.ui.sceneOutliner;
    const countEl = this.ui.partCount;
    if (!root) return;
    const parts = this._getPartRoots();
    if (countEl) countEl.textContent = `(${parts.length})`;
    root.innerHTML = '';
    for (const node of parts) {
      const label = (node.metadata && node.metadata.label) || node.name.replace(/^part_/, '');
      const row = document.createElement('div');
      row.className = 'outliner-item';
      if (this.selected === node) row.classList.add('active');
      row.innerHTML = `<span class="oi-name" title="${label}">${label}</span><button type="button" class="oi-del" title="Удалить">×</button>`;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.oi-del')) return;
        this._selectNode(node);
      });
      row.querySelector('.oi-del').addEventListener('click', (e) => {
        e.stopPropagation();
        this._selectNode(node);
        this._deleteSelection();
      });
      root.appendChild(row);
    }
  }

  setCameraView(preset) {
    if (!this.camera) return;
    const t = this.camera.target.clone();
    const rBase = Math.max(this.camera.radius, 80);
    switch (preset) {
      case 'top':
        this.camera.alpha = -Math.PI / 2;
        this.camera.beta = 0.08;
        this.camera.radius = rBase;
        break;
      case 'front':
        this.camera.alpha = 0;
        this.camera.beta = Math.PI / 2.15;
        this.camera.radius = rBase;
        break;
      case 'right':
        this.camera.alpha = Math.PI / 2;
        this.camera.beta = Math.PI / 3.2;
        this.camera.radius = rBase;
        break;
      case 'iso':
      default:
        this.camera.alpha = -Math.PI / 2.35;
        this.camera.beta = Math.PI / 3.2;
        this.camera.radius = rBase;
        break;
    }
    this.camera.setTarget(t);
  }

  fitAllParts() {
    if (!this.camera) return;
    const parts = this._getPartRoots();
    if (!parts.length) {
      this.setHudError('на сцене пока нет деталей');
      setTimeout(() => this.setHudError(''), 2200);
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (const n of parts) {
      const info = n.getHierarchyBoundingVectors(true);
      minX = Math.min(minX, info.min.x);
      minY = Math.min(minY, info.min.y);
      minZ = Math.min(minZ, info.min.z);
      maxX = Math.max(maxX, info.max.x);
      maxY = Math.max(maxY, info.max.y);
      maxZ = Math.max(maxZ, info.max.z);
    }
    const center = new BABYLON.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    const dx = maxX - minX;
    const dy = maxY - minY;
    const dz = maxZ - minZ;
    const size = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.camera.setTarget(center);
    this.camera.radius = clamp(size * 1.35, 40, 2200);
  }

  clearSceneParts() {
    const parts = this._getPartRoots();
    if (!parts.length) return;
    if (!window.confirm(`Удалить все детали (${parts.length} шт.)?`)) return;
    this._abortAnimSessionWithoutRestore();
    this._clearSelection();
    for (const n of parts) n.dispose(false, true);
    this.commands.undoStack.length = 0;
    this.commands.redoStack.length = 0;
    this.authoring = { scenes: [], clips: [] };
    this._animFrameSeq = 0;
    this._refreshAuthoringList();
    this._refreshOutliner();
    this.saveToLocal();
  }

  async loadAssetsManifest() {
    const res = await fetch('img/models/stl-manifest.json', { cache: 'no-store' });
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json.assets)) return [];
    return json.assets
      .filter((a) => a && a.name && a.file)
      .map((a, idx) => ({
        id: a.id || `stl_${idx}`,
        name: String(a.name),
        kind: 'url',
        url: `img/models/${a.file}`,
        scaleHint: normalizeStlScaleHint(typeof a.scaleHint === 'number' ? a.scaleHint : null),
      }));
  }

  async reloadAssets() {
    let assets = [];
    try {
      assets = await this.loadAssetsManifest();
    } catch (_) {
      assets = [];
    }
    this.assets = assets;
    this._renderAssetList();
  }

  _renderAssetList() {
    const root = this.ui.assetList;
    root.innerHTML = '';

    if (!this.assets.length) {
      const empty = document.createElement('div');
      empty.className = 'asset-item';
      empty.style.cursor = 'default';
      empty.innerHTML = `<div class="asset-name">Пусто</div><div class="asset-meta">Добавь STL в \`img/models/\` и опиши в manifest</div>`;
      root.appendChild(empty);
      return;
    }

    for (const asset of this.assets) {
      const el = document.createElement('div');
      el.className = 'asset-item';
      el.draggable = true;
      el.dataset.assetId = asset.id;
      el.innerHTML = `<div class="asset-name">${asset.name}</div><div class="asset-meta">${asset.kind === 'url' ? 'из папки проекта' : 'локальный файл'}</div>`;

      el.addEventListener('click', () => this._setActiveAsset(asset.id));
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', asset.id);
        e.dataTransfer.effectAllowed = 'copy';
        this._setActiveAsset(asset.id);
      });
      root.appendChild(el);
    }
  }

  _setActiveAsset(assetId) {
    const asset = this.assets.find((a) => a.id === assetId) || null;
    this.activeAsset = asset;

    for (const el of this.ui.assetList.querySelectorAll('.asset-item')) {
      el.classList.toggle('active', el.dataset.assetId === assetId);
    }
    this.ui.hudHint.textContent = asset
      ? `подсказка: «${asset.name}» — «добавить», перетаскивание или Enter`
      : 'подсказка: выбери деталь слева, затем «добавить» или перетащи на сцену';
  }

  _syncHudModeLabel() {
    const suf = this.animationMode ? ' · анимация' : '';
    if (this.ui.hudMode) this.ui.hudMode.textContent = `режим: редактор · мм${suf}`;
  }

  _setTool(tool) {
    this.tool = tool;
    this._syncHudModeLabel();
    this._syncToolPanelGizmo();
    for (const btn of this.ui.toolButtons || []) {
      btn.classList.toggle('active', btn.dataset.tool === tool);
    }
  }

  _abortAnimSessionWithoutRestore() {
    this.animationMode = false;
    this._animSessionBaseline = null;
    const btn = this.ui.animModeBtn;
    if (btn) {
      btn.classList.remove('active');
      btn.setAttribute('aria-pressed', 'false');
    }
    this._syncHudModeLabel();
  }

  _restoreAnimSessionBaseline() {
    const snap = this._animSessionBaseline;
    if (!snap || !this.camera) return;
    this._applyEditorScenePayload(snap);
    this.commands.undoStack.length = 0;
    this.commands.redoStack.length = 0;
    this._refreshOutliner();
    this._writeInspectorFromSelection();
    this._flashTransientHud(
      'режим анимации выключен — модели и камера как до входа; можно ▶ проиграть клип',
      'ok'
    );
  }

  /** @param {'ok'|'neutral'} tone */
  _flashTransientHud(text, tone) {
    const h = this.ui.hudHint;
    if (!h) return;
    const prev = h.textContent;
    const prevColor = h.style.color;
    h.textContent = text;
    if (tone === 'ok') h.style.color = 'var(--accent)';
    else if (tone === 'neutral') h.style.color = 'var(--text2)';
    if (this._flashKeyframeT) clearTimeout(this._flashKeyframeT);
    this._flashKeyframeT = setTimeout(() => {
      h.textContent = prev;
      h.style.color = prevColor;
      this._flashKeyframeT = null;
    }, 2800);
  }

  _setAnimationMode(on) {
    const enable = !!on;

    if (!enable && this.animationMode) {
      if (this._animSessionBaseline) this._restoreAnimSessionBaseline();
      else this._flashTransientHud('режим анимации выключен', 'neutral');
      this._animSessionBaseline = null;
    }

    this.animationMode = enable;
    const btn = this.ui.animModeBtn;
    if (btn) {
      btn.classList.toggle('active', this.animationMode);
      btn.setAttribute('aria-pressed', String(this.animationMode));
    }

    if (this.animationMode) {
      this._animSessionBaseline = this._captureEditorScenePayload();
    }

    this._syncHudModeLabel();
  }

  _addAutoKeyframeScene() {
    if (!this._getPartRoots().length) {
      this.setHudError('на сцене нет деталей — нечего записать');
      setTimeout(() => this.setHudError(''), 2200);
      return;
    }
    this._animFrameSeq += 1;
    const name = `кадр ${String(this._animFrameSeq).padStart(2, '0')}`;
    const snap = this._captureEditorScenePayload();
    this.authoring.scenes.push({
      id: makeAuthoringId('sc'),
      name,
      camera: snap.camera,
      parts: snap.parts,
    });
    this._refreshAuthoringList();
    this.saveToLocal();
    this._flashKeyframeHud(name);
  }

  _flashKeyframeHud(name) {
    this._flashTransientHud(`анимация: записан «${name}» — дорожки осей или поля, «кадр сейчас»`, 'ok');
  }

  _setSnap(enabled) {
    this.snapEnabled = !!enabled;
    this.ui.snapBtn.setAttribute('aria-pressed', String(this.snapEnabled));
    this.ui.snapBtn.classList.toggle('active', this.snapEnabled);
  }

  _setGrid(enabled) {
    this.gridEnabled = !!enabled;
    this.ui.gridBtn.setAttribute('aria-pressed', String(this.gridEnabled));
    this.ui.gridBtn.classList.toggle('active', this.gridEnabled);
    if (this.gridMesh) this.gridMesh.setEnabled(this.gridEnabled);
  }

  _setupSelection() {
    // pick selection / place
    this._pointerObserver = this.scene.onPointerObservable.add(async (pointerInfo) => {
      if (pointerInfo.type !== BABYLON.PointerEventTypes.POINTERDOWN) return;
      if (pointerInfo.event.button !== 0) return; // left click

      // Сначала ближайший hit по сцене: если это не пол — выбираем объект (даже если в списке выбран ассет)
      const topPick = this.scene.pick(this.scene.pointerX, this.scene.pointerY);
      if (topPick && topPick.hit && topPick.pickedMesh && topPick.pickedMesh !== this.gridMesh) {
        let node = topPick.pickedMesh;
        while (node && node.parent) {
          if (node instanceof BABYLON.TransformNode && String(node.name || '').startsWith('part_')) break;
          node = node.parent;
        }
        if (node instanceof BABYLON.TransformNode && String(node.name || '').startsWith('part_')) {
          this._selectNode(node);
          return;
        }
      }

      if (topPick && topPick.hit && topPick.pickedMesh === this.gridMesh) {
        this._clearSelection();
      }
    });

    // drag/drop from list
    this.canvas.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    this.canvas.addEventListener('drop', async (e) => {
      e.preventDefault();
      const assetId = e.dataTransfer.getData('text/plain');
      const asset = this.assets.find((a) => a.id === assetId);
      if (!asset) return;
      this._setActiveAsset(assetId);

      let point = null;
      const pick = this.scene.pick(this.scene.pointerX, this.scene.pointerY, (m) => m === this.gridMesh);
      if (pick && pick.hit && pick.pickedPoint) point = pick.pickedPoint.clone();
      if (!point) {
        const ray = this.scene.createPickingRay(this.scene.pointerX, this.scene.pointerY, BABYLON.Matrix.Identity(), this.camera);
        const plane = BABYLON.Plane.FromPositionAndNormal(BABYLON.Vector3.Zero(), BABYLON.Vector3.Up());
        const t = ray.intersectsPlane(plane);
        if (t != null && t > 0) point = ray.origin.add(ray.direction.scale(t));
      }
      if (!point) return;
      await this._spawnAssetAt(asset, point);
    });
  }

  _selectNode(node) {
    if (!(node instanceof BABYLON.Node)) return;
    this.selected = node;
    this._syncToolPanelGizmo();
    this._applySelectionHighlight(node);
    this._writeInspectorFromSelection();
    this._refreshOutliner();
  }

  _clearSelection() {
    this.selected = null;
    this._syncToolPanelGizmo();
    this._cleanupHighlight();
    this._writeInspectorFromSelection();
    this._refreshOutliner();
  }

  _syncToolPanelGizmo() {
    const wrap = this.ui.toolGizmoWrap;
    const cap = this.ui.toolGizmoCaption;
    if (!wrap) return;

    const hasPart = !!(this.selected && String(this.selected.name || '').startsWith('part_'));

    wrap.classList.toggle('tool-gizmo-wrap--disabled', !hasPart);
    wrap.setAttribute('aria-hidden', hasPart ? 'false' : 'true');

    if (cap) {
      if (!hasPart) cap.textContent = 'выбери деталь в «Сцена» или кликом по модели';
      else cap.textContent = 'три блока: сдвиг · поворот · масштаб — тяни нужную ось внутри блока';
    }
  }

  _applyPanelGizmoDragStep(axis, kind, dx, dy) {
    const node = this.selected;
    if (!node || !(axis === 'x' || axis === 'y' || axis === 'z')) return;
    const dir = PANEL_GIZMO_AXIS_2D[axis];
    if (!dir) return;

    if (kind === 'move') {
      const dot = dx * dir.x + dy * dir.y;
      const mm = dot * 0.32;
      if (axis === 'x') node.position.x += mm;
      if (axis === 'y') node.position.y += mm;
      if (axis === 'z') node.position.z += mm;
      return;
    }
    if (kind === 'rotate') {
      const perp = { x: -dir.y, y: dir.x };
      const tang = dx * perp.x + dy * perp.y;
      const rad = tang * 0.009;
      if (axis === 'x') node.rotation.x += rad;
      if (axis === 'y') node.rotation.y += rad;
      if (axis === 'z') node.rotation.z += rad;
      return;
    }
    if (kind === 'scale') {
      const dot = dx * dir.x + dy * dir.y;
      const d = dot * 0.004;
      if (axis === 'x') node.scaling.x = Math.max(1e-4, node.scaling.x + d);
      if (axis === 'y') node.scaling.y = Math.max(1e-4, node.scaling.y + d);
      if (axis === 'z') node.scaling.z = Math.max(1e-4, node.scaling.z + d);
    }
  }

  _finishPanelGizmoDrag() {
    const drag = this._panelGizmoDrag;
    this._panelGizmoDrag = null;
    if (!drag || !this.selected) return;

    const node = this.selected;
    const before = drag.before;
    const kind = drag.kind;

    if (kind === 'move' && this.snapEnabled) {
      node.position.x = Math.round(node.position.x / this.snapStep) * this.snapStep;
      node.position.z = Math.round(node.position.z / this.snapStep) * this.snapStep;
    }

    const after = transformSnapshot(node);

    if (transformSnapshotsEqual(before, after)) return;

    this.commands.push({
      undo: () => applyTransformSnapshot(node, before),
      redo: () => applyTransformSnapshot(node, after),
    });

    if (this.animationMode && this.ui.animAutoKeyframe && this.ui.animAutoKeyframe.checked) {
      this._addAutoKeyframeScene();
    }

    this._writeInspectorFromSelection();
  }

  _setupToolPanelGizmo() {
    const wrap = this.ui.toolGizmoWrap;
    if (!wrap) return;
    const svgs = wrap.querySelectorAll('.tool-gizmo-block svg');
    if (!svgs.length) return;

    const pickAxisAndKind = (target) => {
      const block = target && target.closest && target.closest('.tool-gizmo-block[data-kind]');
      const kind = block && block.dataset && block.dataset.kind;
      if (kind !== 'move' && kind !== 'rotate' && kind !== 'scale') return null;
      const hit = target && target.closest && target.closest('.tg-hit');
      if (!hit) return null;
      const g = hit.closest && hit.closest('.tg-axis[data-axis]');
      const axis = g && g.dataset && g.dataset.axis ? g.dataset.axis : null;
      if (axis !== 'x' && axis !== 'y' && axis !== 'z') return null;
      return { axis, kind };
    };

    const bindSvg = (svg) => {
      const onDown = (e) => {
        if (e.button !== 0) return;
        const picked = pickAxisAndKind(e.target);
        if (!picked || !this.selected) return;
        e.preventDefault();
        this._panelGizmoDrag = {
          axis: picked.axis,
          kind: picked.kind,
          lastX: e.clientX,
          lastY: e.clientY,
          before: transformSnapshot(this.selected),
        };
        try {
          svg.setPointerCapture(e.pointerId);
        } catch (_) {}
      };

      const onMove = (e) => {
        const drag = this._panelGizmoDrag;
        if (!drag || !this.selected) return;
        const dx = e.clientX - drag.lastX;
        const dy = e.clientY - drag.lastY;
        drag.lastX = e.clientX;
        drag.lastY = e.clientY;
        this._applyPanelGizmoDragStep(drag.axis, drag.kind, dx, dy);
        this._writeInspectorFromSelection();
      };

      const onUp = (e) => {
        if (!this._panelGizmoDrag) return;
        try {
          svg.releasePointerCapture(e.pointerId);
        } catch (_) {}
        this._finishPanelGizmoDrag();
      };

      svg.addEventListener('pointerdown', onDown);
      svg.addEventListener('pointermove', onMove);
      svg.addEventListener('pointerup', onUp);
      svg.addEventListener('pointercancel', onUp);
    };

    for (const svg of svgs) bindSvg(svg);

    this._syncToolPanelGizmo();
  }

  async _spawnAssetAt(asset, point, options = {}) {
    const { restoreTransform = null, skipFocus = false, skipUndo = false, skipSelect = false } = options;
    this.setHudError('');
    const name = safeName(asset.name);
    const root = new BABYLON.TransformNode(`part_${name}_${Date.now()}`, this.scene);
    root.metadata = root.metadata || {};
    root.metadata.assetId = asset.id;
    root.metadata.label = asset.name;
    root.position.copyFrom(point);

    if (!restoreTransform && this.snapEnabled) {
      root.position.x = Math.round(root.position.x / this.snapStep) * this.snapStep;
      root.position.z = Math.round(root.position.z / this.snapStep) * this.snapStep;
    }

    let blobUrl = null;
    let revoke = null;

    let rootUrl = '';
    let sceneFilename = '';

    if (asset.kind === 'url') {
      const p = splitModelPath(asset.url);
      rootUrl = p.rootUrl;
      sceneFilename = p.filename;
    } else {
      blobUrl = URL.createObjectURL(asset.file);
      revoke = () => URL.revokeObjectURL(blobUrl);
      rootUrl = '';
      sceneFilename = blobUrl;
    }

    try {
      const res = await BABYLON.SceneLoader.ImportMeshAsync('', rootUrl, sceneFilename, this.scene);
      const toParent = (res.meshes || []).filter((m) => m && m !== this.gridMesh);
      const tint = partTintMaterial(this.scene, this._partTintIndex++);
      for (const m of toParent) {
        m.isPickable = true;
        m.parent = root;
        if (m instanceof BABYLON.Mesh) m.material = tint;
      }

      if (!toParent.length) {
        throw new Error('STL: загрузчик не вернул меши (проверь файл и путь)');
      }

      const scaleHint = normalizeStlScaleHint(asset.scaleHint);
      root.scaling.setAll(scaleHint);

      if (restoreTransform) {
        applyTransformSnapshot(root, restoreTransform);
      } else {
        const info = root.getHierarchyBoundingVectors(true);
        const minY = info.min.y;
        if (Number.isFinite(minY)) root.position.y -= minY;
      }

      if (!skipUndo) {
        this.commands.push({
          undo: () => root.dispose(),
          redo: async () => {
            await this._spawnAssetAt(asset, point, { restoreTransform, skipFocus, skipUndo: true, skipSelect });
          },
        });
      }

      if (!skipSelect) {
        this._selectNode(root);
        if (!skipFocus) requestAnimationFrame(() => this.focusSelection());
      } else {
        this._refreshOutliner();
      }
    } catch (e) {
      root.dispose();
      const msg = e && e.message ? e.message : String(e);
      console.warn('STL import failed', e);
      this.setHudError(`ошибка загрузки: ${msg}`);
    } finally {
      if (revoke) revoke();
    }
  }

  /** Вставить активный ассет у центра цели камеры на плоскости пола (Y=0) */
  async spawnActiveAtCameraTarget() {
    this.setHudError('');
    if (!this.camera) return;
    if (!this.activeAsset) {
      this.setHudError('выбери деталь в списке слева');
      return;
    }
    const t = this.camera.target ? this.camera.target.clone() : BABYLON.Vector3.Zero();
    t.y = 0;
    await this._spawnAssetAt(this.activeAsset, t);
  }

  _bindUI() {
    // tools
    for (const btn of this.ui.toolButtons || []) {
      btn.addEventListener('click', () => this._setTool(btn.dataset.tool));
    }

    this.ui.snapBtn.addEventListener('click', () => this._setSnap(!this.snapEnabled));
    this.ui.gridBtn.addEventListener('click', () => this._setGrid(!this.gridEnabled));

    // actions
    this.ui.undoBtn.addEventListener('click', () => this.commands.undo());
    this.ui.redoBtn.addEventListener('click', () => this.commands.redo());
    this.ui.saveBtn.addEventListener('click', () => this.saveToLocal());
    this.ui.exportBtn.addEventListener('click', () => this.exportJson());

    this.ui.reloadAssetsBtn.addEventListener('click', () => this.reloadAssets());
    if (this.ui.addToSceneBtn) {
      this.ui.addToSceneBtn.addEventListener('click', () => this.spawnActiveAtCameraTarget());
    }
    this.ui.fileInput.addEventListener('change', (e) => this._ingestLocalFiles(e.target.files));

    for (const b of this.ui.camViewBtns || []) {
      b.addEventListener('click', () => this.setCameraView(b.dataset.camView));
    }
    if (this.ui.fitAllBtn) this.ui.fitAllBtn.addEventListener('click', () => this.fitAllParts());
    if (this.ui.clearSceneBtn) this.ui.clearSceneBtn.addEventListener('click', () => this.clearSceneParts());
    if (this.ui.assemblyJsonInput) {
      this.ui.assemblyJsonInput.addEventListener('change', async (e) => {
        const f = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!f) return;
        try {
          await this.loadAssemblyFromJsonFile(f);
        } catch (err) {
          this.setHudError(`импорт: ${err && err.message ? err.message : err}`);
        }
      });
    }

    for (const b of this.ui.inspectorActions) {
      b.addEventListener('click', () => this._handleInspectorAction(b.dataset.action));
    }

    // inspector inputs
    for (const input of this.ui.inspectorInputs) {
      input.addEventListener('change', () => this._applyInspectorToSelection());
    }

    // hotkeys
    this._onKeyDown = (e) => {
      if (!document.body.contains(this.canvas)) return;
      const view = document.querySelector('.view.active');
      if (!view || view.dataset.view !== 'editor') return;

      const isMac = /Mac/.test(navigator.platform);
      const ctrl = isMac ? e.metaKey : e.ctrlKey;

      if (ctrl && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.commands.redo();
        else this.commands.undo();
        return;
      }
      if (ctrl && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.commands.redo();
        return;
      }
      if (ctrl && e.key.toLowerCase() === 'd') {
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        this.duplicateSelection();
        return;
      }

      if (e.key === 'Escape') {
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        this._clearSelection();
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        this.fitAllParts();
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.selected) {
          e.preventDefault();
          this._deleteSelection();
        }
        return;
      }

      const k = e.key.toLowerCase();
      if (k === 'a') {
        const tagA = e.target && e.target.tagName;
        if (tagA === 'INPUT' || tagA === 'TEXTAREA' || tagA === 'SELECT') return;
        e.preventDefault();
        this._setAnimationMode(!this.animationMode);
        return;
      }
      if (k === 's') this._setSnap(!this.snapEnabled);
      if (k === 'g') this._setGrid(!this.gridEnabled);

      if (e.key === 'Enter') {
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        this.spawnActiveAtCameraTarget();
      }
    };
    window.addEventListener('keydown', this._onKeyDown);

    this.ui.sceneSaveBtn?.addEventListener('click', () => this.saveNamedSceneFromUi());
    this.ui.clipAddBtn?.addEventListener('click', () => this.addClipFromUi());
    this.ui.animModeBtn?.addEventListener('click', () => this._setAnimationMode(!this.animationMode));
    this.ui.animKeyframeNowBtn?.addEventListener('click', () => this._addAutoKeyframeScene());
  }

  _ingestLocalFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => f && /\.stl$/i.test(f.name));
    for (const f of files) {
      this.assets.push({
        id: `local_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        name: f.name,
        kind: 'file',
        file: f,
        scaleHint: EDITOR_DEFAULT_STL_SCALE,
      });
    }
    this._renderAssetList();
  }

  _handleInspectorAction(action) {
    if (action === 'focus') this.focusSelection();
    if (action === 'duplicate') this.duplicateSelection();
    if (action === 'delete') this._deleteSelection();
  }

  focusSelection() {
    if (!this.selected || !this.camera) return;
    const info = this.selected.getHierarchyBoundingVectors(true);
    const center = info.min.add(info.max).scale(0.5);
    this.camera.setTarget(center);
    const size = info.max.subtract(info.min).length();
    this.camera.radius = clamp(size * 1.25, 18, 2200);
  }

  duplicateSelection() {
    if (!this.selected) return;
    const node = this.selected;
    const clone = node.clone(`${node.name}_copy`, null, true);
    if (!clone) return;
    if (node.metadata) clone.metadata = { ...node.metadata };
    clone.position = node.position.add(new BABYLON.Vector3(20, 0, 20));
    this.commands.push({
      undo: () => clone.dispose(),
      redo: () => {
        // простое redo: если dispose был — не восстановим; зато undo/redo по копированию работает в текущей сессии
      },
    });
    this._selectNode(clone);
  }

  _deleteSelection() {
    if (!this.selected) return;
    const node = this.selected;
    const parent = node.parent;
    const snapshot = transformSnapshot(node);
    const serialized = node.serialize ? node.serialize() : null;
    this._clearSelection();
    node.setEnabled(false);
    node.dispose(false, true);

    this.commands.push({
      undo: () => {
        if (serialized) {
          const restored = BABYLON.Node.Parse(serialized, this.scene, '');
          if (restored) {
            restored.parent = parent;
            applyTransformSnapshot(restored, snapshot);
            this._selectNode(restored);
          }
        }
      },
      redo: () => {},
    });
    this._refreshOutliner();
  }

  _writeInspectorFromSelection() {
    const node = this.selected;
    this.ui.insName.textContent = node ? node.name : '—';

    const set = (key, val) => {
      const input = this.ui.inspectorInputsByKey[key];
      if (!input) return;
      input.value = String(val);
    };

    if (!node) {
      for (const k of Object.keys(this.ui.inspectorInputsByKey)) set(k, '');
      this._updateAnimateContextHint();
      return;
    }

    set('px', node.position.x.toFixed(3));
    set('py', node.position.y.toFixed(3));
    set('pz', node.position.z.toFixed(3));
    set('rx', radToDeg(node.rotation.x).toFixed(1));
    set('ry', radToDeg(node.rotation.y).toFixed(1));
    set('rz', radToDeg(node.rotation.z).toFixed(1));
    set('sx', node.scaling.x.toFixed(4));
    set('sy', node.scaling.y.toFixed(4));
    set('sz', node.scaling.z.toFixed(4));
    this._updateAnimateContextHint();
  }

  _updateAnimateContextHint() {
    const el = this.ui.editorAnimateContext;
    if (!el) return;
    const node = this.selected;
    const tail =
      ' Между сценами плавно меняется всё, что <strong>отличается</strong>; если трогала только одну деталь — движется она.';
    if (node && node.metadata) {
      const label = String(node.metadata.label || node.name.replace(/^part_/, '') || '?');
      el.innerHTML = `Сейчас выбрана <strong>${escapeHtml(label)}</strong>. «Запомнить» = положение A → сдвинь только её → снова «запомнить» = B → клип от A к B.${tail}`;
      return;
    }
    el.innerHTML = `Выдели деталь кликом по модели или в списке слева. Затем: <strong>запомнить</strong> сцену → подвинь <strong>одну</strong> деталь → <strong>запомнить</strong> ещё раз → <strong>+ клип</strong>.${tail}`;
  }

  _applyInspectorToSelection() {
    if (!this.selected) return;
    const node = this.selected;
    const before = transformSnapshot(node);

    const read = (key) => {
      const input = this.ui.inspectorInputsByKey[key];
      const v = Number(input.value);
      return Number.isFinite(v) ? v : null;
    };

    const px = read('px');
    const py = read('py');
    const pz = read('pz');
    const rx = read('rx');
    const ry = read('ry');
    const rz = read('rz');
    const sx = read('sx');
    const sy = read('sy');
    const sz = read('sz');

    if (px != null) node.position.x = px;
    if (py != null) node.position.y = py;
    if (pz != null) node.position.z = pz;
    if (rx != null) node.rotation.x = degToRad(rx);
    if (ry != null) node.rotation.y = degToRad(ry);
    if (rz != null) node.rotation.z = degToRad(rz);
    if (sx != null) node.scaling.x = sx;
    if (sy != null) node.scaling.y = sy;
    if (sz != null) node.scaling.z = sz;

    if (this.snapEnabled) {
      node.position.x = Math.round(node.position.x / this.snapStep) * this.snapStep;
      node.position.z = Math.round(node.position.z / this.snapStep) * this.snapStep;
    }

    const after = transformSnapshot(node);
    this.commands.push({
      undo: () => applyTransformSnapshot(node, before),
      redo: () => applyTransformSnapshot(node, after),
    });

    if (this.animationMode && this.ui.animAutoKeyframe && this.ui.animAutoKeyframe.checked) {
      this._addAutoKeyframeScene();
    }
  }

  _syncInspectorThrottled() {
    const now = performance.now();
    if (now - this._lastInspectorWrite < 120) return;
    this._lastInspectorWrite = now;
    this._writeInspectorFromSelection();
  }

  _mergeEditorAuthoringFromData(data) {
    this.authoring = normalizeAuthoring(data && data.authoring);
    this._recalcAnimFrameSeqFromScenes();
  }

  _recalcAnimFrameSeqFromScenes() {
    const re = /^кадр\s*0*(\d+)$/i;
    let max = 0;
    for (const s of this.authoring.scenes) {
      const m = re.exec(String(s.name || '').trim());
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    this._animFrameSeq = max;
  }

  _captureEditorScenePayload() {
    const parts = [];
    for (const n of this._getPartRoots()) {
      const meta = n.metadata || {};
      parts.push({
        partName: n.name,
        assetId: meta.assetId || null,
        label: meta.label || n.name.replace(/^part_/, ''),
        transform: transformSnapshot(n),
      });
    }
    return {
      camera: cameraSnapshot(this.camera),
      parts,
    };
  }

  _applyEditorScenePayload(payload) {
    if (!payload || !this.camera) return;
    if (payload.camera) applyCameraSnapshot(this.camera, payload.camera);
    const pp = payload.parts || [];
    const roots = this._getPartRoots();
    if (scenePayloadUsesPartNames(pp)) {
      const map = new Map();
      for (const p of pp) {
        if (p && p.partName && p.transform && p.transform.position) map.set(p.partName, p.transform);
      }
      for (const n of roots) {
        const tr = map.get(n.name);
        if (tr) applyTransformSnapshot(n, tr);
      }
    } else {
      const n = Math.min(roots.length, pp.length);
      for (let i = 0; i < n; i++) {
        const tr = pp[i].transform;
        if (tr && tr.position) applyTransformSnapshot(roots[i], tr);
      }
    }
    this._refreshOutliner();
    this._writeInspectorFromSelection();
  }

  _editorLerpScenes(sa, sb, t) {
    if (!sa || !sb || !this.camera) return;
    const ca = sa.camera;
    const cb = sb.camera;
    if (ca && cb) {
      this.camera.alpha = lerp(ca.alpha, cb.alpha, t);
      this.camera.beta = lerp(ca.beta, cb.beta, t);
      this.camera.radius = lerp(ca.radius, cb.radius, t);
      const ta = objToVec3(ca.target, BABYLON.Vector3.Zero());
      const tb = objToVec3(cb.target, BABYLON.Vector3.Zero());
      this.camera.setTarget(BABYLON.Vector3.Lerp(ta, tb, t));
    }
    const roots = this._getPartRoots();
    for (let i = 0; i < roots.length; i++) {
      const node = roots[i];
      const tra = getPartTransformForNodeInScene(sa, node, i);
      const trb = getPartTransformForNodeInScene(sb, node, i);
      if (!tra && !trb) continue;
      const lerped = lerpTransformSnapshot(tra, trb, t);
      if (lerped && lerped.position) applyTransformSnapshot(node, lerped);
    }
    this._writeInspectorFromSelection();
  }

  _refreshAuthoringList() {
    const scenesEl = this.ui.editorScenesList;
    const clipsEl = this.ui.editorClipsList;
    const selFrom = this.ui.editorClipFrom;
    const selTo = this.ui.editorClipTo;
    if (selFrom) {
      const v = selFrom.value;
      selFrom.innerHTML = '<option value="">от —</option>';
      for (const s of this.authoring.scenes) {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.name || s.id;
        selFrom.appendChild(o);
      }
      if (v && [...selFrom.options].some((o) => o.value === v)) selFrom.value = v;
    }
    if (selTo) {
      const v = selTo.value;
      selTo.innerHTML = '<option value="">к —</option>';
      for (const s of this.authoring.scenes) {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.name || s.id;
        selTo.appendChild(o);
      }
      if (v && [...selTo.options].some((o) => o.value === v)) selTo.value = v;
    }
    if (scenesEl) {
      scenesEl.innerHTML = '';
      for (const s of this.authoring.scenes) {
        const row = document.createElement('div');
        row.className = 'authoring-item';
        const title = document.createElement('span');
        title.className = 'authoring-item-title';
        title.textContent = s.name || s.id;
        const actions = document.createElement('div');
        actions.className = 'authoring-item-actions';
        const applyBtn = document.createElement('button');
        applyBtn.type = 'button';
        applyBtn.className = 'btn btn-sm';
        applyBtn.textContent = 'применить';
        applyBtn.addEventListener('click', () => this.applySceneById(s.id));
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn btn-sm';
        delBtn.textContent = '×';
        delBtn.addEventListener('click', () => {
          this.authoring.scenes = this.authoring.scenes.filter((x) => x.id !== s.id);
          this.authoring.clips = this.authoring.clips.filter(
            (c) => c.fromSceneId !== s.id && c.toSceneId !== s.id
          );
          this._recalcAnimFrameSeqFromScenes();
          this._refreshAuthoringList();
          this.saveToLocal();
        });
        actions.appendChild(applyBtn);
        actions.appendChild(delBtn);
        row.appendChild(title);
        row.appendChild(actions);
        scenesEl.appendChild(row);
      }
    }
    if (clipsEl) {
      clipsEl.innerHTML = '';
      for (const c of this.authoring.clips) {
        const row = document.createElement('div');
        row.className = 'authoring-item';
        const fromN = this.authoring.scenes.find((x) => x.id === c.fromSceneId);
        const toN = this.authoring.scenes.find((x) => x.id === c.toSceneId);
        row.innerHTML = `<span class="authoring-item-title">${escapeHtml(c.name || c.id)}</span>
          <span class="authoring-item-meta">${escapeHtml((fromN && fromN.name) || '?')} → ${escapeHtml((toN && toN.name) || '?')} · ${Number(c.durationSec) || 2}с</span>
          <div class="authoring-item-actions">
            <button type="button" class="btn btn-sm" data-clip-act="play" data-id="${escapeHtml(c.id)}">▶</button>
            <button type="button" class="btn btn-sm" data-clip-act="del" data-id="${escapeHtml(c.id)}">×</button>
          </div>`;
        row.querySelector('[data-clip-act="play"]')?.addEventListener('click', (e) => {
          e.preventDefault();
          this.playEditorClipById(c.id);
        });
        row.querySelector('[data-clip-act="del"]')?.addEventListener('click', (e) => {
          e.preventDefault();
          this.authoring.clips = this.authoring.clips.filter((x) => x.id !== c.id);
          this._refreshAuthoringList();
          this.saveToLocal();
        });
        clipsEl.appendChild(row);
      }
    }
  }

  saveNamedSceneFromUi() {
    const inp = this.ui.editorSceneName;
    const name = inp && inp.value ? String(inp.value).trim() : '';
    if (!name) {
      this.setHudError('введи название сцены');
      setTimeout(() => this.setHudError(''), 2000);
      return;
    }
    const snap = this._captureEditorScenePayload();
    this.authoring.scenes.push({
      id: makeAuthoringId('sc'),
      name,
      camera: snap.camera,
      parts: snap.parts,
    });
    if (inp) inp.value = '';
    this._refreshAuthoringList();
    this._recalcAnimFrameSeqFromScenes();
    this.saveToLocal();
  }

  addClipFromUi() {
    const fromId = this.ui.editorClipFrom && this.ui.editorClipFrom.value;
    const toId = this.ui.editorClipTo && this.ui.editorClipTo.value;
    const durInp = this.ui.editorClipDuration;
    const nameInp = this.ui.editorClipName;
    const dur = durInp ? Number(durInp.value) : 2;
    if (!fromId || !toId || fromId === toId) {
      this.setHudError('выбери две разные сцены');
      setTimeout(() => this.setHudError(''), 2200);
      return;
    }
    const title = nameInp && nameInp.value ? String(nameInp.value).trim() : '';
    this.authoring.clips.push({
      id: makeAuthoringId('clip'),
      name: title || 'клип',
      fromSceneId: fromId,
      toSceneId: toId,
      durationSec: Number.isFinite(dur) && dur > 0 ? dur : 2,
    });
    if (nameInp) nameInp.value = '';
    this._refreshAuthoringList();
    this.saveToLocal();
  }

  applySceneById(sceneId) {
    const sc = this.authoring.scenes.find((s) => s.id === sceneId);
    if (!sc) return;
    this._applyEditorScenePayload(sc);
    this.saveToLocal();
  }

  playEditorClipById(clipId) {
    const clip = this.authoring.clips.find((c) => c.id === clipId);
    if (!clip) return;
    const a = this.authoring.scenes.find((s) => s.id === clip.fromSceneId);
    const b = this.authoring.scenes.find((s) => s.id === clip.toSceneId);
    if (!a || !b) {
      this.setHudError('клип: сцены не найдены');
      setTimeout(() => this.setHudError(''), 2200);
      return;
    }
    if (this._clipPlaybackObs && this.scene) {
      this.scene.onBeforeRenderObservable.remove(this._clipPlaybackObs);
      this._clipPlaybackObs = null;
    }
    this._clipRunId += 1;
    const run = this._clipRunId;
    const durMs = Math.max(150, (Number(clip.durationSec) || 2) * 1000);
    const t0 = performance.now();
    const scene = this.scene;
    const self = this;
    const clipObs = scene.onBeforeRenderObservable.add(() => {
      if (run !== self._clipRunId) {
        scene.onBeforeRenderObservable.remove(clipObs);
        if (self._clipPlaybackObs === clipObs) self._clipPlaybackObs = null;
        return;
      }
      const elapsed = performance.now() - t0;
      const u = Math.min(1, elapsed / durMs);
      const tt = easeInOutCubic(u);
      self._editorLerpScenes(a, b, tt);
      if (u >= 1) {
        self._editorLerpScenes(a, b, 1);
        scene.onBeforeRenderObservable.remove(clipObs);
        if (self._clipPlaybackObs === clipObs) self._clipPlaybackObs = null;
      }
    });
    this._clipPlaybackObs = clipObs;
  }

  saveToLocal() {
    const data = this.serializeAssembly();
    localStorage.setItem(ASSEMBLY_STORAGE_KEY, JSON.stringify(data));
    try {
      window.dispatchEvent(new CustomEvent('babylon-assembly-updated'));
    } catch (_) {}
  }

  exportJson() {
    const data = this.serializeAssembly();
    const text = JSON.stringify(data, null, 2);
    downloadText(`assembly_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`, text);
    localStorage.setItem(ASSEMBLY_STORAGE_KEY, text);
    try {
      window.dispatchEvent(new CustomEvent('babylon-assembly-updated'));
    } catch (_) {}
  }

  serializeAssembly() {
    const parts = [];
    for (const n of this.scene.transformNodes) {
      if (!n || !n.name || !n.name.startsWith('part_')) continue;
      const meta = n.metadata || {};
      parts.push({
        assetId: meta.assetId || null,
        label: meta.label || n.name.replace(/^part_/, ''),
        transform: transformSnapshot(n),
      });
    }
    return {
      version: 2,
      units: 'mm',
      createdAt: new Date().toISOString(),
      settings: {
        snapEnabled: this.snapEnabled,
        snapStep: this.snapStep,
        gridEnabled: this.gridEnabled,
      },
      parts,
      authoring: JSON.parse(JSON.stringify(this.authoring)),
    };
  }

  async applyAssemblyData(data) {
    if (!data) return;
    this._abortAnimSessionWithoutRestore();
    this._mergeEditorAuthoringFromData(data);

    const existing = this._getPartRoots();
    for (const n of existing) n.dispose(false, true);
    this._clearSelection();
    this.commands.undoStack.length = 0;
    this.commands.redoStack.length = 0;

    if (!Array.isArray(data.parts) || !data.parts.length) {
      this._refreshOutliner();
      this._refreshAuthoringList();
      return;
    }

    for (const p of data.parts) {
      let asset = null;
      if (p.assetId) asset = this.assets.find((a) => a.id === p.assetId);
      if (!asset && p.label) {
        asset = this.assets.find((a) => a.name === p.label || p.label.includes(a.name) || a.name.includes(p.label));
      }
      if (!asset && p.name) {
        const s = String(p.name);
        asset = this.assets.find((a) => a.file && s.includes(a.file));
        if (!asset) asset = this.assets.find((a) => s.includes(safeName(a.name)));
      }
      if (!asset) continue;
      const tr = p.transform;
      if (!tr || !tr.position) continue;
      await this._spawnAssetAt(asset, BABYLON.Vector3.Zero(), {
        restoreTransform: tr,
        skipFocus: true,
        skipUndo: true,
        skipSelect: true,
      });
    }
    this._clearSelection();
    if (this._getPartRoots().length) this.fitAllParts();
    this._refreshOutliner();
    this._refreshAuthoringList();
  }

  async tryRestoreFromLocalStorage() {
    try {
      const raw = localStorage.getItem(ASSEMBLY_STORAGE_KEY);
      if (!raw) {
        this._refreshAuthoringList();
        this._writeInspectorFromSelection();
        return;
      }
      const data = JSON.parse(raw);
      await this.applyAssemblyData(data);
      this.setHudError('');
      this._writeInspectorFromSelection();
    } catch (_) {
      this._refreshAuthoringList();
      this._writeInspectorFromSelection();
    }
  }

  async loadAssemblyFromJsonFile(file) {
    const text = await file.text();
    const data = JSON.parse(text);
    await this.applyAssemblyData(data);
    this.saveToLocal();
  }
}

function bindTabs({ onEditorEnter, onDashboardEnter }) {
  const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));
  const views = Array.from(document.querySelectorAll('.view'));

  const setActive = (key) => {
    for (const b of tabButtons) b.classList.toggle('active', b.dataset.tab === key);
    for (const v of views) v.classList.toggle('active', v.dataset.view === key);
    if (key === 'editor') onEditorEnter?.();
    if (key === 'dashboard') onDashboardEnter?.();
    window.dispatchEvent(new Event('resize'));
  };

  for (const b of tabButtons) b.addEventListener('click', () => setActive(b.dataset.tab));
  return { setActive };
}

function wireDashboardUI(reloadDashAssembly) {
  document.querySelectorAll('[data-dash-action="reload-assembly"]').forEach((btn) => {
    btn.addEventListener('click', () => reloadDashAssembly?.());
  });
  const dashJsonIn = document.getElementById('dashAssemblyJsonInput');
  if (dashJsonIn) {
    dashJsonIn.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const text = await f.text();
        JSON.parse(text);
        localStorage.setItem(ASSEMBLY_STORAGE_KEY, text);
        reloadDashAssembly?.();
        try {
          window.dispatchEvent(new CustomEvent('babylon-assembly-updated'));
        } catch (_) {}
      } catch (err) {
        console.warn('json превью', err);
      }
    });
  }
}

function main() {
  const dashCanvas = document.getElementById('dashboardCanvas');
  let reloadDashAssembly = () => {};
  let dashPreviewScene = () => false;
  let dashPlayClip = () => false;
  let dashStopClip = () => {};
  if (dashCanvas) {
    const dash = createDashboardScene(dashCanvas);
    reloadDashAssembly = () => dash.reloadAssemblyFromStorage();
    dashPreviewScene = (sceneId) => dash.previewScene(sceneId);
    dashPlayClip = (clipId) => dash.playClip(clipId);
    dashStopClip = () => dash.stopClipPlayback();
    window.addEventListener('babylon-assembly-updated', () => reloadDashAssembly());
    window.addEventListener('babylon-dash-preview-scene', (e) => {
      const id = e.detail && e.detail.sceneId;
      if (id) dashPreviewScene(id);
    });
    window.addEventListener('babylon-dash-play-clip', (e) => {
      const id = e.detail && e.detail.clipId;
      if (id) dashPlayClip(id);
    });
  }

  wireDashboardUI(reloadDashAssembly);

  document.querySelectorAll('[data-dash-action="stop-clip"]').forEach((b) => {
    b.addEventListener('click', () => dashStopClip());
  });

  const dashboardRecipe = new DashboardRecipe();
  dashboardRecipe.init();
  window.addEventListener('babylon-assembly-updated', () => {
    dashboardRecipe.renderSequence();
    dashboardRecipe.updateOutput('сборка в редакторе обновлена');
  });

  let editor = null;
  const ui = {
    assetList: document.getElementById('assetList'),
    toolButtons: Array.from(document.querySelectorAll('.tool-btn[data-tool]')),
    snapBtn: document.querySelector('.tool-btn[data-action="snap"]'),
    gridBtn: document.querySelector('.tool-btn[data-action="grid"]'),
    undoBtn: document.querySelector('[data-action="undo"]'),
    redoBtn: document.querySelector('[data-action="redo"]'),
    saveBtn: document.querySelector('[data-action="save"]'),
    exportBtn: document.querySelector('[data-action="export"]'),
    reloadAssetsBtn: document.querySelector('[data-action="reload-assets"]'),
    addToSceneBtn: document.querySelector('[data-action="add-to-scene"]'),
    camViewBtns: Array.from(document.querySelectorAll('[data-cam-view]')),
    fitAllBtn: document.querySelector('[data-action="fit-all"]'),
    clearSceneBtn: document.querySelector('[data-action="clear-scene"]'),
    assemblyJsonInput: document.getElementById('assemblyJsonInput'),
    sceneOutliner: document.getElementById('sceneOutliner'),
    partCount: document.getElementById('partCount'),
    fileInput: document.getElementById('stlFileInput'),
    hudMode: document.getElementById('hudMode'),
    hudHint: document.getElementById('hudHint'),
    hudError: document.getElementById('hudError'),
    toolGizmoWrap: document.getElementById('toolGizmoWrap'),
    toolGizmoCaption: document.getElementById('toolGizmoCaption'),
    insName: document.getElementById('insName'),
    inspectorInputs: Array.from(document.querySelectorAll('#editorManipPanel input[data-bind]')),
    inspectorActions: Array.from(document.querySelectorAll('#inspector [data-action]')),
    inspectorInputsByKey: {},
    editorSceneName: document.getElementById('editorSceneName'),
    editorScenesList: document.getElementById('editorScenesList'),
    sceneSaveBtn: document.querySelector('[data-action="scene-save"]'),
    editorClipFrom: document.getElementById('editorClipFrom'),
    editorClipTo: document.getElementById('editorClipTo'),
    editorClipDuration: document.getElementById('editorClipDuration'),
    editorClipName: document.getElementById('editorClipName'),
    clipAddBtn: document.querySelector('[data-action="clip-add"]'),
    editorClipsList: document.getElementById('editorClipsList'),
    editorAnimateContext: document.getElementById('editorAnimateContext'),
    animModeBtn: document.querySelector('[data-action="anim-mode"]'),
    animAutoKeyframe: document.getElementById('animAutoKeyframe'),
    animKeyframeNowBtn: document.querySelector('[data-action="anim-keyframe-now"]'),
  };
  for (const i of ui.inspectorInputs) ui.inspectorInputsByKey[i.dataset.bind] = i;

  bindTabs({
    onEditorEnter: async () => {
      if (editor) return;
      const canvas = document.getElementById('editorCanvas');
      editor = new EditorApp(canvas, ui);
      await editor.reloadAssets();
      await editor.tryRestoreFromLocalStorage();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (editor && editor.engine) editor.engine.resize();
        });
      });
    },
    onDashboardEnter: () => reloadDashAssembly(),
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
else main();
