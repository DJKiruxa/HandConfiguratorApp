/* global BABYLON */
import {
  clamp, easeInOutCubic, lerp,
  applyTransformSnapshot, applyCameraSnapshot,
  lerpTransformSnapshot, normalizeAuthoring, getPartTransformForNodeInScene,
  objToVec3,
} from './utils.js';
import { ASSEMBLY_STORAGE_KEY } from './recipe.js';
import { EVENTS, on } from './eventBus.js';
import { getTheme } from './theme.js';

const ARM_GLB = 'ARM.glb';
const ARM_DIR = 'img/models/';

export function createDashboardScene(canvas, opts = {}) {
  const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true, antialias: true });
  const scene = new BABYLON.Scene(engine);

  let hemis = null;
  function applySceneFromTheme() {
    const t = getTheme();
    if (t === 'light') {
      scene.clearColor = new BABYLON.Color4(0.93, 0.94, 0.97, 1);
      scene.ambientColor = new BABYLON.Color3(0.48, 0.5, 0.55);
    } else {
      scene.clearColor = new BABYLON.Color4(0.04, 0.045, 0.06, 1);
      scene.ambientColor = new BABYLON.Color3(0.18, 0.2, 0.24);
    }
    if (hemis) hemis.intensity = t === 'light' ? 0.88 : 0.95;
  }

  const camera = new BABYLON.ArcRotateCamera('dashCam', -Math.PI / 2.35, Math.PI / 3.1, 180, new BABYLON.Vector3(0, 0, 0), scene);
  camera.attachControl(canvas, true);
  /** Только вращение вокруг модели: без панорами и зума. */
  camera.panningSensibility = 0;
  camera.angularSensibilityX = 1000;
  camera.angularSensibilityY = 1000;
  const R_LO = 20;
  const R_HI = 1200;

  function lockOrbitNoZoom() {
    const r = Math.max(1, camera.radius);
    camera.lowerRadiusLimit = r;
    camera.upperRadiusLimit = r;
  }

  function unlockRadius() {
    camera.lowerRadiusLimit = R_LO;
    camera.upperRadiusLimit = R_HI;
  }

  lockOrbitNoZoom();

  if (camera.inputs) {
    try {
      if (typeof camera.inputs.removeByType === 'function') {
        camera.inputs.removeByType('ArcRotateCameraMouseWheelInput');
      } else {
        const attached = camera.inputs.attached;
        for (const k of Object.keys(attached || {})) {
          if (k.toLowerCase().includes('wheel')) camera.inputs.remove(attached[k]);
        }
      }
    } catch (_) { /* ignore */ }
  }

  camera.wheelPrecision = 1e6;
  camera.minZ = 0.1;

  hemis = new BABYLON.HemisphericLight('dashH', new BABYLON.Vector3(0.1, 1, 0.2), scene);
  hemis.intensity = 0.95;
  const dir = new BABYLON.DirectionalLight('dashD', new BABYLON.Vector3(-0.45, -0.85, -0.3), scene);
  dir.intensity = 0.55;

  applySceneFromTheme();
  on(EVENTS.THEME_CHANGED, () => requestAnimationFrame(applySceneFromTheme));

  let contentRoot = null;
  let lastAssemblyData = null;
  let clipRunId = 0;
  let dashClipRenderObs = null;

  const dashSceneById = (data, id) => normalizeAuthoring(data?.authoring).scenes.find((s) => s.id === id) || null;
  const dashClipById = (data, id) => normalizeAuthoring(data?.authoring).clips.find((c) => c.id === id) || null;

  function applyDashScenePayload(payload) {
    if (!payload?.camera) return false;
    applyCameraSnapshot(camera, payload.camera);
    if (!contentRoot || !Array.isArray(payload.parts)) {
      lockOrbitNoZoom();
      return true;
    }
    const ch = contentRoot.children || [];
    for (let i = 0; i < ch.length && i < payload.parts.length; i++) {
      const tr = payload.parts[i].transform;
      if (tr?.position) applyTransformSnapshot(ch[i], tr);
    }
    lockOrbitNoZoom();
    return true;
  }

  function lerpDashScenes(a, b, t) {
    if (!a?.camera || !b?.camera) return;
    camera.alpha = lerp(a.camera.alpha, b.camera.alpha, t);
    camera.beta = lerp(a.camera.beta, b.camera.beta, t);
    camera.radius = lerp(a.camera.radius, b.camera.radius, t);
    const ta = objToVec3(a.camera.target, BABYLON.Vector3.Zero());
    const tb = objToVec3(b.camera.target, BABYLON.Vector3.Zero());
    camera.setTarget(BABYLON.Vector3.Lerp(ta, tb, t));
    if (!contentRoot) return;
    const ch = contentRoot.children || [];
    for (let i = 0; i < ch.length; i++) {
      const tra = getPartTransformForNodeInScene(a, ch[i], i);
      const trb = getPartTransformForNodeInScene(b, ch[i], i);
      if (!tra && !trb) continue;
      const lerped = lerpTransformSnapshot(tra, trb, t);
      if (lerped?.position) applyTransformSnapshot(ch[i], lerped);
    }
  }

  function previewScene(sceneId) {
    if (!lastAssemblyData) return false;
    const sc = dashSceneById(lastAssemblyData, sceneId);
    if (!sc) return false;
    clipRunId += 1;
    if (dashClipRenderObs) { scene.onBeforeRenderObservable.remove(dashClipRenderObs); dashClipRenderObs = null; }
    return applyDashScenePayload(sc);
  }

  function playClip(clipId) {
    if (!lastAssemblyData) return false;
    const clip = dashClipById(lastAssemblyData, clipId);
    if (!clip) return false;
    const a = dashSceneById(lastAssemblyData, clip.fromSceneId);
    const b = dashSceneById(lastAssemblyData, clip.toSceneId);
    if (!a || !b) return false;
    if (dashClipRenderObs) { scene.onBeforeRenderObservable.remove(dashClipRenderObs); dashClipRenderObs = null; }
    unlockRadius();
    const run = ++clipRunId;
    const durMs = Math.max(150, (Number(clip.durationSec) || 2) * 1000);
    const t0 = performance.now();
    const obs = scene.onBeforeRenderObservable.add(() => {
      if (run !== clipRunId) {
        scene.onBeforeRenderObservable.remove(obs);
        if (dashClipRenderObs === obs) dashClipRenderObs = null;
        lockOrbitNoZoom();
        return;
      }
      const u = Math.min(1, (performance.now() - t0) / durMs);
      lerpDashScenes(a, b, easeInOutCubic(u));
      if (u >= 1) {
        lerpDashScenes(a, b, 1);
        scene.onBeforeRenderObservable.remove(obs);
        if (dashClipRenderObs === obs) dashClipRenderObs = null;
        lockOrbitNoZoom();
      }
    });
    dashClipRenderObs = obs;
    return true;
  }

  function stopClipPlayback() {
    clipRunId += 1;
    if (dashClipRenderObs) { scene.onBeforeRenderObservable.remove(dashClipRenderObs); dashClipRenderObs = null; }
    lockOrbitNoZoom();
  }

  const disposeContent = () => {
    if (contentRoot) {
      contentRoot.dispose(false, true);
      contentRoot = null;
    }
  };

  function frameToContent(root) {
    if (!root) return;
    const info = root.getHierarchyBoundingVectors(true);
    const center = info.min.add(info.max).scale(0.5);
    const dx = info.max.x - info.min.x, dy = info.max.y - info.min.y, dz = info.max.z - info.min.z;
    const size = Math.sqrt(dx * dx + dy * dy + dz * dz);
    camera.setTarget(center);
    camera.radius = clamp(size * 1.42, 40, 800);
    camera.alpha = -Math.PI / 2.35;
    camera.beta = Math.PI / 3.1;
    lockOrbitNoZoom();
  }

  function showLoading(state) {
    opts.onLoading?.(state);
  }

  async function reloadAssemblyFromStorage() {
    showLoading(true);
    disposeContent();
    try {
      const raw = localStorage.getItem(ASSEMBLY_STORAGE_KEY);
      if (raw) lastAssemblyData = JSON.parse(raw);
      else lastAssemblyData = null;
    } catch (_) {
      lastAssemblyData = null;
    }

    try {
      const result = await BABYLON.SceneLoader.ImportMeshAsync('', ARM_DIR, ARM_GLB, scene);
      const meshes = (result.meshes || []).filter(Boolean);
      if (!meshes.length) {
        showLoading(false);
        requestAnimationFrame(() => engine.resize());
        return;
      }
      contentRoot =
        meshes.find((m) => m.name === '__root__') ||
        result.transformNodes?.find((n) => n && n.name === '__root__') ||
        result.meshes[0];
      frameToContent(contentRoot);
    } catch (e) {
      console.warn('ARM.glb', e);
    } finally {
      showLoading(false);
      requestAnimationFrame(() => engine.resize());
    }
  }

  reloadAssemblyFromStorage();

  if (opts.fpsEl) {
    let acc = 0;
    scene.onAfterRenderObservable.add(() => {
      acc += 1;
      if (acc % 15 === 0) opts.fpsEl.textContent = `${engine.getFps().toFixed(0)} fps`;
    });
  }

  engine.runRenderLoop(() => scene.render());
  const onResize = () => engine.resize();
  window.addEventListener('resize', onResize);
  requestAnimationFrame(onResize);

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => engine.resize());
    if (canvas.parentElement) ro.observe(canvas.parentElement);
  }

  return {
    engine,
    scene,
    camera,
    reloadAssemblyFromStorage,
    previewScene,
    playClip,
    stopClipPlayback,
    resetCamera: () => {
      camera.alpha = -Math.PI / 2.35;
      camera.beta = Math.PI / 3.1;
      if (contentRoot) frameToContent(contentRoot);
    },
  };
}
