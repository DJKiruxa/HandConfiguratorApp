import { clamp, downloadText } from './utils.js';
import { defaultHandPose, parseHandPoseFromJson } from './handPose.js';
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
  constructor() {
    this.state = null;
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
        out.handPose.values[i] = Number.isFinite(v) ? clamp(v, 0, 100) : 0;
      }
    }
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
  }

  setFingerValue(index, value) {
    if (!this.state?.handPose?.values) return;
    const i = clamp(Number(index), 0, 4);
    this.state.handPose.values[i] = clamp(Number(value), 0, 100);
  }

  resetHandPose() {
    this.pushHistory();
    this.state.handPose = defaultHandPose();
    this.save();
    this.renderHandPose();
    this.updateOutput('поза: сброс');
    emit(EVENTS.FINGER_VALUE, { all: this.state.handPose.values.slice() });
    toast('пальцы в 0%');
  }

  applyHandPoseFromValues(values) {
    if (!Array.isArray(values) || values.length < 5) return false;
    this.pushHistory();
    for (let i = 0; i < 5; i++) {
      this.state.handPose.values[i] = clamp(Number(values[i]), 0, 100);
    }
    this.save();
    this.renderHandPose();
    this.updateOutput('поза из JSON');
    this.state.handPose.values.forEach((v, j) => emit(EVENTS.FINGER_VALUE, { index: j, value: v }));
    toast('поза применена', { type: 'success' });
    return true;
  }

  buildExport() {
    let assembly = null;
    try {
      const raw = localStorage.getItem(ASSEMBLY_STORAGE_KEY);
      if (raw) assembly = JSON.parse(raw);
    } catch (_) {}
    return {
      exportedAt: new Date().toISOString(),
      schema: 'babylon.hand-pipeline+v2',
      assembly,
      pipeline: {
        version: this.state.version,
        handPose: structuredClone(this.state.handPose),
      },
    };
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

  renderAll() {
    this.renderHandPose();
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
      });
      input.addEventListener('change', () => {
        this.pushHistory();
        this.save();
        this.updateOutput('поза');
      });
    }
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
        const vals = parseHandPoseFromJson(text);
        if (vals) this.applyHandPoseFromValues(vals);
        else toast('В JSON нет pipeline.handPose.values (5×0–100)', { type: 'warn' });
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
    this.bind();
    this.renderAll();
  }
}
