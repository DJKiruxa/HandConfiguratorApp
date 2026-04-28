import { clamp, downloadText } from './utils.js';
import {
  METACARPAL_KEYS,
  PHALANGE_FINGER_KEYS,
  buildCompactHandPose,
  defaultHandPose,
  normalizeMetacarpalValues,
  normalizePhalangeValues,
  parseHandPosePayloadFromJson,
} from './handPose.js';
import { EVENTS, emit, on } from './eventBus.js';
import { toast } from './toast.js';

export const ASSEMBLY_STORAGE_KEY = 'babylon_editor_assembly';
export const DASHBOARD_RECIPE_KEY = 'babylon_dashboard_recipe';

function defaultPayload() {
  return {
    version: 2,
    handPose: defaultHandPose(),
  };
}

export class DashboardRecipe {
  constructor(opts = {}) {
    this.state = null;
    this.onHandPoseChanged = opts.onHandPoseChanged || null;
    this.history = [];
    this.future = [];
    this.MAX_HISTORY = 50;
  }

  load() {
    const def = defaultPayload();
    try {
      const raw = localStorage.getItem(DASHBOARD_RECIPE_KEY);
      this.state = raw ? this.merge(JSON.parse(raw), def) : structuredClone(def);
    } catch (_) {
      this.state = structuredClone(def);
    }
  }

  merge(data, def) {
    const out = structuredClone(def);
    if (!data || typeof data !== 'object') return out;

    if (data.handPose?.values?.length === 5) {
      for (let i = 0; i < 5; i++) {
        const v = Number(data.handPose.values[i]);
        out.handPose.values[i] = Number.isFinite(v) ? clamp(v, -100, 100) : 0;
      }
    }
    const phalanges = data.handPose?.phalanges;
    if (phalanges && typeof phalanges === 'object') {
      for (const type of ['middle', 'proximal']) {
        const values = normalizePhalangeValues(phalanges[type], phalanges.keys);
        if (values) out.handPose.phalanges[type] = values;
      }
    }
    const metacarpals = data.handPose?.metacarpals;
    const metacarpalValues = Array.isArray(metacarpals)
      ? normalizeMetacarpalValues(metacarpals)
      : normalizeMetacarpalValues(metacarpals?.values, metacarpals?.keys);
    if (metacarpalValues) out.handPose.metacarpals.values = metacarpalValues;
    return out;
  }

  pushHistory() {
    this.history.push(JSON.stringify(this.state));
    if (this.history.length > this.MAX_HISTORY) this.history.shift();
    this.future.length = 0;
  }

  undo() {
    if (!this.history.length) return false;
    this.future.push(JSON.stringify(this.state));
    this.state = JSON.parse(this.history.pop());
    this.save(false);
    this.renderAll();
    toast('отменено', { type: 'info' });
    return true;
  }

  redo() {
    if (!this.future.length) return false;
    this.history.push(JSON.stringify(this.state));
    this.state = JSON.parse(this.future.pop());
    this.save(false);
    this.renderAll();
    toast('повтор', { type: 'info' });
    return true;
  }

  save() {
    localStorage.setItem(DASHBOARD_RECIPE_KEY, JSON.stringify(this.state));
    emit(EVENTS.RECIPE_CHANGED, { state: this.state });
    this.notifyHandPoseChanged();
  }

  notifyHandPoseChanged() {
    const handPose = structuredClone(this.state.handPose);
    this.onHandPoseChanged?.(handPose);
    emit(EVENTS.HAND_POSE_CHANGED, { handPose });
  }

  setFingerValue(index, value) {
    if (!this.state?.handPose?.values) return;
    const i = clamp(Number(index), 0, 4);
    this.state.handPose.values[i] = clamp(Number(value), -100, 100);
  }

  setPhalangeValue(type, index, value) {
    const arr = this.state?.handPose?.phalanges?.[type];
    if (!arr) return;
    const i = clamp(Number(index), 0, PHALANGE_FINGER_KEYS.length - 1);
    arr[i] = clamp(Number(value), -100, 100);
  }

  setMetacarpalValue(index, value) {
    const arr = this.state?.handPose?.metacarpals?.values;
    if (!arr) return;
    const i = clamp(Number(index), 0, METACARPAL_KEYS.length - 1);
    arr[i] = clamp(Number(value), -100, 100);
  }

  resetHandPose() {
    this.pushHistory();
    this.state.handPose = defaultHandPose();
    this.save();
    this.renderHandPose();
    this.renderPhalanges();
    this.renderMetacarpals();
    this.updateOutput('поза: сброс');
    emit(EVENTS.FINGER_VALUE, { all: this.state.handPose.values.slice() });
    toast('пальцы в 0%');
  }

  applyHandPoseFromValues(values) {
    if (!Array.isArray(values) || values.length < 5) return false;
    this.pushHistory();
    for (let i = 0; i < 5; i++) {
        this.state.handPose.values[i] = clamp(Number(values[i]), -100, 100);
    }
    this.save();
    this.renderHandPose();
    this.updateOutput('поза из JSON');
    this.state.handPose.values.forEach((v, j) => emit(EVENTS.FINGER_VALUE, { index: j, value: v }));
    toast('поза применена', { type: 'success' });
    return true;
  }

  applyHandPoseFromPayload(handPose) {
    if (!handPose?.values) return false;
    this.pushHistory();
    this.state.handPose = this.merge({ handPose }, defaultPayload()).handPose;
    this.save();
    this.renderHandPose();
    this.renderPhalanges();
    this.renderMetacarpals();
    this.updateOutput('поза из JSON');
    toast('поза применена', { type: 'success' });
    return true;
  }

  buildExport() {
    return buildCompactHandPose(this.state.handPose);
  }

  computeStats() {
    const v = this.state.handPose.values;
    const avg = v.reduce((a, b) => a + b, 0) / 5;
    const max = Math.max(...v);
    return { fingers: 5, avg: Math.round(avg), max };
  }

  updateOutput(note) {
    const ta = document.getElementById('recipeOutput');
    const st = document.getElementById('recipeStatus');
    const stats = document.getElementById('recipeStats');
    if (ta) ta.value = JSON.stringify(this.buildExport(), null, 2);
    if (st) st.textContent = note || `обновлено ${new Date().toLocaleTimeString()}`;
    if (stats) {
      const s = this.computeStats();
      stats.innerHTML = `<span>пальцы: <b>${s.fingers}</b></span><span>·</span><span>ср. <b>${s.avg}</b>%</span><span>·</span><span>макс. <b>${s.max}</b>%</span>`;
    }
  }

  renderHandPose() {
    for (let i = 0; i < 5; i++) {
      const input = document.getElementById(`f${i}`);
      const row = input?.closest('.finger-row');
      const out = row?.querySelector('.finger-out');
      const v = this.state.handPose.values[i];
      if (input) input.value = String(v);
      if (out) out.textContent = String(v);
    }
  }

  renderPhalanges() {
    for (const [type, prefix] of [['middle', 'hm'], ['proximal', 'hp']]) {
      const values = this.state.handPose.phalanges?.[type] || [];
      for (let i = 0; i < PHALANGE_FINGER_KEYS.length; i++) {
        const input = document.getElementById(`${prefix}${i}`);
        const row = input?.closest('.phalange-row');
        const out = row?.querySelector('.phalange-out');
        const v = values[i] ?? 0;
        if (input) input.value = String(v);
        if (out) out.textContent = String(v);
      }
    }
  }

  renderMetacarpals() {
    const values = this.state.handPose.metacarpals?.values || [];
    METACARPAL_KEYS.forEach((key, i) => {
      const input = document.querySelector(`.metacarpal-range[data-metacarpal-key="${key}"]`);
      const row = input?.closest('.metacarpal-row');
      const out = row?.querySelector('.phalange-out');
      const v = values[i] ?? 0;
      if (input) input.value = String(v);
      if (out) out.textContent = String(v);
    });
  }

  renderAll() {
    this.renderHandPose();
    this.renderPhalanges();
    this.renderMetacarpals();
    this.updateOutput('готово');
  }

  bindFingers() {
    for (let i = 0; i < 5; i++) {
      const input = document.getElementById(`f${i}`);
      if (!input) continue;
      const row = input.closest('.finger-row');
      const out = row?.querySelector('.finger-out');
      input.addEventListener('input', () => {
        this.setFingerValue(i, input.value);
        if (out) out.textContent = String(this.state.handPose.values[i]);
        emit(EVENTS.FINGER_VALUE, { index: i, value: this.state.handPose.values[i] });
        this.notifyHandPoseChanged();
      });
      input.addEventListener('change', () => {
        this.pushHistory();
        this.save();
        this.updateOutput('поза');
      });
    }
  }

  bindPhalanges() {
    document.querySelectorAll('.phalange-range').forEach((input) => {
      const row = input.closest('.phalange-row');
      const out = row?.querySelector('.phalange-out');
      input.addEventListener('input', () => {
        this.setPhalangeValue(input.dataset.phalangeType, input.dataset.phalange, input.value);
        const values = this.state.handPose.phalanges?.[input.dataset.phalangeType];
        const v = values?.[Number(input.dataset.phalange)] ?? 0;
        if (out) out.textContent = String(v);
        this.notifyHandPoseChanged();
      });
      input.addEventListener('change', () => {
        this.pushHistory();
        this.save();
        this.updateOutput('фаланги');
      });
    });
  }

  bindMetacarpals() {
    document.querySelectorAll('.metacarpal-range[data-metacarpal-index]').forEach((input) => {
      const row = input.closest('.metacarpal-row');
      const out = row?.querySelector('.phalange-out');
      input.addEventListener('input', () => {
        this.setMetacarpalValue(input.dataset.metacarpalIndex, input.value);
        const v = this.state.handPose.metacarpals?.values?.[Number(input.dataset.metacarpalIndex)] ?? 0;
        if (out) out.textContent = String(v);
        this.notifyHandPoseChanged();
      });
      input.addEventListener('change', () => {
        this.pushHistory();
        this.save();
        this.updateOutput('пястные');
      });
    });
  }

  bind() {
    document.querySelector('[data-hand-action="pose-reset"]')?.addEventListener('click', () => this.resetHandPose());

    const fileIn = document.getElementById('handPoseJsonInput');
    fileIn?.addEventListener('change', async (e) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (!f) return;
      try {
        const text = await f.text();
        const handPose = parseHandPosePayloadFromJson(text);
        if (handPose) this.applyHandPoseFromPayload(handPose);
        else toast('В JSON нет pipeline.handPose.values (5 чисел -100..100)', { type: 'warn' });
      } catch (err) {
        console.warn(err);
        toast('не удалось прочитать', { type: 'error' });
      }
    });

    document.querySelector('[data-recipe-action="refresh-output"]')?.addEventListener('click', () => { this.updateOutput('вручную'); toast('обновлено'); });

    const exportJson = () => {
      const fname = `hand_pose_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
      const text = JSON.stringify(this.buildExport(), null, 2);
      downloadText(fname, text);
      toast('экспорт .json', { type: 'success' });
    };
    const exportTxt = () => {
      const fname = `hand_pose_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
      const text = JSON.stringify(this.buildExport(), null, 2);
      downloadText(fname, text, 'text/plain;charset=utf-8');
      toast('экспорт .txt', { type: 'success' });
    };
    document.querySelector('[data-recipe-action="export-json"]')?.addEventListener('click', exportJson);
    document.querySelector('[data-recipe-action="export-txt"]')?.addEventListener('click', exportTxt);

    on(EVENTS.ASSEMBLY_UPDATED, () => { this.updateOutput('сборка GLB/JSON'); });
  }

  init() {
    this.load();
    this.bindFingers();
    this.bindPhalanges();
    this.bindMetacarpals();
    this.bind();
    this.renderAll();
  }
}
