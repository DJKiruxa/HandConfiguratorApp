/* global BABYLON */
import {
  clamp, easeInOutCubic, lerp,
  applyTransformSnapshot, applyCameraSnapshot,
  lerpTransformSnapshot, normalizeAuthoring, getPartTransformForNodeInScene,
  objToVec3,
} from './utils.js';
import { ASSEMBLY_STORAGE_KEY, DASHBOARD_RECIPE_KEY } from './recipe.js';
import { EVENTS, on } from './eventBus.js';
import { getTheme } from './theme.js';

const ARM_GLB = 'ARM.glb';
const ARM_DIR = 'img/models/';
const ARM_PRESET_SPLIT_SEC = 4;
const ARM_PRESET_NAMES = ['Буква Г', 'Буква Ы'];
const ARM_LETTER_G_HOLD_AT_SEC = 3;
const ARM_LETTER_G_HOLD_DURATION_SEC = 2;
const MAX_PHALANGE_BEND_RAD = Math.PI / 2;
const MAX_METACARPAL_BEND_RAD = Math.PI / 2;
const PHALANGE_BONES = [
  { type: 'proximal', index: 0, name: 'Bone.019', includeFinger: false },
  { type: 'proximal', index: 4, name: 'Bone.005' },
  { type: 'middle', index: 4, name: 'Bone.006' },
  { type: 'proximal', index: 3, name: 'Bone.008' },
  { type: 'middle', index: 3, name: 'Bone.009' },
  { type: 'proximal', index: 2, name: 'Bone.011' },
  { type: 'middle', index: 2, name: 'Bone.012' },
  { type: 'proximal', index: 1, name: 'Bone.015' },
  { type: 'middle', index: 1, name: 'Bone.016' },
];
const METACARPAL_BONES = [
  { key: 'pinky', name: 'Bone.003', combo: true },
  { key: 'ring', name: 'Bone.007', combo: true, comboFollow: true },
  { key: 'thumb', name: 'Bone.018', axis: 'z', limit: 21 },
];
const ROTATION_MECHANISM_BONES = [
  { key: 'thumbProximal', name: 'Bone.020', axis: 'x', direction: -1, limit: 120 },
];
const METACARPAL_COMBO_KEY = 'pinkyRing';
const METACARPAL_RING_COMBO_PLATEAU = 44;
const PHALANGE_TO_FINGER_INDEX = {
  0: 0,
  1: 1,
  2: 2,
  3: 3,
  4: 4,
};

function readStoredHandPose() {
  try {
    const raw = localStorage.getItem(DASHBOARD_RECIPE_KEY);
    return raw ? JSON.parse(raw)?.handPose || null : null;
  } catch (_) {
    return null;
  }
}

function getPhalangePercent(handPose, type, index) {
  const value = Number(handPose?.phalanges?.[type]?.[index] ?? 0);
  return Number.isFinite(value) ? -clamp(value, -100, 100) : 0;
}

function getFingerPercent(handPose, index) {
  const value = Number(handPose?.values?.[index] ?? 0);
  return Number.isFinite(value) ? -clamp(value, -100, 100) : 0;
}

function getMetacarpalPercent(handPose, key) {
  const keys = handPose?.metacarpals?.keys;
  const index = Array.isArray(keys) ? keys.indexOf(key) : -1;
  const fallback = key === 'pinky' ? 0 : key === 'ring' ? 1 : key === 'pinkyRing' ? 2 : 3;
  const value = Number(handPose?.metacarpals?.values?.[index >= 0 ? index : fallback] ?? 0);
  return Number.isFinite(value) ? -clamp(value, -100, 100) : 0;
}

function getRotationMechanismPercent(handPose, key) {
  const keys = handPose?.rotationMechanisms?.keys;
  const index = Array.isArray(keys) ? keys.indexOf(key) : -1;
  const fallback = key === 'thumbProximal' ? 0 : -1;
  const sourceIndex = index >= 0 ? index : fallback;
  const value = Number(handPose?.rotationMechanisms?.values?.[sourceIndex] ?? 0);
  const limit = key === 'thumbProximal' ? 120 : 100;
  return Number.isFinite(value) ? -clamp(value, -limit, limit) : 0;
}

function followMetacarpalCombo(percent) {
  const value = clamp(percent, -100, 100);
  if (value === 0) return 0;
  const sign = Math.sign(value);
  const magnitude = Math.abs(value);
  return sign * METACARPAL_RING_COMBO_PLATEAU * (1 - Math.exp(-magnitude / METACARPAL_RING_COMBO_PLATEAU));
}

function findBoneByName(skeleton, name) {
  const wanted = String(name).toLowerCase();
  return skeleton?.bones?.find((b) => String(b.name).toLowerCase() === wanted) || null;
}

function getAnimationGroupFrameRate(group) {
  const fps = group?.targetedAnimations?.find((ta) => Number.isFinite(ta?.animation?.framePerSecond))
    ?.animation?.framePerSecond;
  return Number.isFinite(fps) && fps > 0 ? fps : 30;
}

function createArmAnimationPreset(group, name = group?.name, range = {}) {
  const fps = getAnimationGroupFrameRate(group);
  const from = Number.isFinite(range.from) ? range.from : Number.isFinite(group?.from) ? group.from : 0;
  const to = Number.isFinite(range.to) ? range.to : Number.isFinite(group?.to) ? group.to : from;
  const sourceDurationSec = Math.max(0, (to - from) / fps);
  const holdAtSec = Number.isFinite(range.holdAtSec)
    ? clamp(range.holdAtSec, 0, sourceDurationSec)
    : null;
  const holdDurationSec = holdAtSec === null ? 0 : Math.max(0, Number(range.holdDurationSec) || 0);
  return {
    name: name || group?.name || 'Анимация',
    group,
    from,
    to,
    fps,
    sourceDurationSec,
    holdAtSec,
    holdDurationSec,
    durationSec: sourceDurationSec + holdDurationSec,
  };
}

function createArmAnimationPresets(groups) {
  const sourceGroup = groups?.[0];
  if (!sourceGroup) return [];

  const splitFrame = sourceGroup.from + (ARM_PRESET_SPLIT_SEC * getAnimationGroupFrameRate(sourceGroup));
  if (!Number.isFinite(splitFrame) || splitFrame >= sourceGroup.to) {
    return groups.map((group) => createArmAnimationPreset(group));
  }

  return [
    createArmAnimationPreset(sourceGroup, ARM_PRESET_NAMES[0], {
      from: sourceGroup.from,
      to: splitFrame,
      holdAtSec: ARM_LETTER_G_HOLD_AT_SEC,
      holdDurationSec: ARM_LETTER_G_HOLD_DURATION_SEC,
    }),
    createArmAnimationPreset(sourceGroup, ARM_PRESET_NAMES[1], {
      from: splitFrame,
      to: sourceGroup.to,
      holdAtSec: ARM_LETTER_G_HOLD_AT_SEC,
      holdDurationSec: ARM_LETTER_G_HOLD_DURATION_SEC,
    }),
  ];
}

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
  /** Вращение вокруг модели без панорамирования, с ограниченным zoom колесиком. */
  camera.panningSensibility = 0;
  camera.angularSensibilityX = 1000;
  camera.angularSensibilityY = 1000;
  const R_LO = 20;
  const R_HI = 1200;

  function applyZoomLimits() {
    camera.lowerRadiusLimit = R_LO;
    camera.upperRadiusLimit = R_HI;
  }

  applyZoomLimits();
  camera.wheelPrecision = 45;
  camera.wheelDeltaPercentage = 0.01;
  camera.minZ = 0.1;

  hemis = new BABYLON.HemisphericLight('dashH', new BABYLON.Vector3(0.1, 1, 0.2), scene);
  hemis.intensity = 0.95;
  const dir = new BABYLON.DirectionalLight('dashD', new BABYLON.Vector3(-0.45, -0.85, -0.3), scene);
  dir.intensity = 0.55;

  const disposers = [];
  applySceneFromTheme();
  disposers.push(on(EVENTS.THEME_CHANGED, () => requestAnimationFrame(applySceneFromTheme)));

  let contentRoot = null;
  let lastAssemblyData = null;
  let clipRunId = 0;
  let dashClipRenderObs = null;
  let activeHandPose = readStoredHandPose();
  let armAnimationGroups = [];
  let activeArmAnimationIndex = -1;
  let activeArmAnimationProgress = 0;
  let armAnimationProgressObs = null;
  let armAnimationSequenceTimer = 0;
  let armAnimationSequenceRunId = 0;
  let disposed = false;
  let phalangeRig = [];
  let metacarpalRig = [];
  let rotationMechanismRig = [];
  let combinedRigByBone = new Map();
  const bendAxis = new BABYLON.Vector3(1, 0, 0);
  const thumbBendAxis = new BABYLON.Vector3(0, 0, 1);
  const metacarpalAxis = new BABYLON.Vector3(1, 0, 0);
  const bendQ = new BABYLON.Quaternion();
  const metacarpalQ = new BABYLON.Quaternion();

  const dashSceneById = (data, id) => normalizeAuthoring(data?.authoring).scenes.find((s) => s.id === id) || null;
  const dashClipById = (data, id) => normalizeAuthoring(data?.authoring).clips.find((c) => c.id === id) || null;

  function hasTransformSnapshot(snap) {
    return !!(snap && (snap.position || snap.rotation || snap.scaling));
  }

  function snapshotVec(source, fallback) {
    const pick = (axis) => {
      const value = Number(source?.[axis]);
      return Number.isFinite(value) ? value : fallback[axis];
    };
    return { x: pick('x'), y: pick('y'), z: pick('z') };
  }

  function completeTransformSnapshot(node, snap) {
    if (!node || !hasTransformSnapshot(snap)) return null;
    return {
      position: snapshotVec(snap.position, node.position),
      rotation: snapshotVec(snap.rotation, node.rotation),
      scaling: snapshotVec(snap.scaling, node.scaling),
    };
  }

  function applyNodeTransformSnapshot(node, snap) {
    const complete = completeTransformSnapshot(node, snap);
    if (complete) applyTransformSnapshot(node, complete);
  }

  function applyDashScenePayload(payload) {
    if (!payload?.camera) return false;
    applyCameraSnapshot(camera, payload.camera);
    if (!contentRoot || !Array.isArray(payload.parts)) {
      applyZoomLimits();
      return true;
    }
    const ch = contentRoot.children || [];
    for (let i = 0; i < ch.length && i < payload.parts.length; i++) {
      const tr = payload.parts[i].transform;
      if (hasTransformSnapshot(tr)) applyNodeTransformSnapshot(ch[i], tr);
    }
    applyZoomLimits();
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
      if (!hasTransformSnapshot(tra) && !hasTransformSnapshot(trb)) continue;
      const lerped = lerpTransformSnapshot(
        completeTransformSnapshot(ch[i], tra),
        completeTransformSnapshot(ch[i], trb),
        t,
      );
      applyNodeTransformSnapshot(ch[i], lerped);
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
    applyZoomLimits();
    const run = ++clipRunId;
    const durMs = Math.max(150, (Number(clip.durationSec) || 2) * 1000);
    const t0 = performance.now();
    const obs = scene.onBeforeRenderObservable.add(() => {
      if (run !== clipRunId) {
        scene.onBeforeRenderObservable.remove(obs);
        if (dashClipRenderObs === obs) dashClipRenderObs = null;
        applyZoomLimits();
        return;
      }
      const u = Math.min(1, (performance.now() - t0) / durMs);
      lerpDashScenes(a, b, easeInOutCubic(u));
      if (u >= 1) {
        lerpDashScenes(a, b, 1);
        scene.onBeforeRenderObservable.remove(obs);
        if (dashClipRenderObs === obs) dashClipRenderObs = null;
        applyZoomLimits();
      }
    });
    dashClipRenderObs = obs;
    return true;
  }

  function stopClipPlayback() {
    clipRunId += 1;
    if (dashClipRenderObs) { scene.onBeforeRenderObservable.remove(dashClipRenderObs); dashClipRenderObs = null; }
    stopArmAnimations();
    applyZoomLimits();
  }

  function notifyArmAnimationsChanged() {
    opts.onAnimationsChanged?.(armAnimationGroups, activeArmAnimationIndex, activeArmAnimationProgress);
  }

  function notifyArmAnimationProgress() {
    const preset = armAnimationGroups[activeArmAnimationIndex];
    const currentSec = Math.max(0, activeArmAnimationProgress * (Number(preset?.durationSec) || 0));
    opts.onAnimationProgress?.(activeArmAnimationIndex, activeArmAnimationProgress, currentSec);
  }

  function clearArmAnimationProgressObserver() {
    if (armAnimationProgressObs) {
      scene.onBeforeRenderObservable.remove(armAnimationProgressObs);
      armAnimationProgressObs = null;
    }
  }

  function clearArmAnimationSequence() {
    armAnimationSequenceRunId += 1;
    if (armAnimationSequenceTimer) {
      clearTimeout(armAnimationSequenceTimer);
      armAnimationSequenceTimer = 0;
    }
  }

  function getArmAnimationFrameAtProgress(preset, progress) {
    const from = preset.from ?? preset.group?.from ?? 0;
    const to = preset.to ?? preset.group?.to ?? from;
    const sourceDurationSec = Number(preset.sourceDurationSec) || Math.max(0, (to - from) / (preset.fps || 30));
    if (sourceDurationSec <= 0) return from;

    const timelineSec = clamp(progress, 0, 1) * (Number(preset.durationSec) || sourceDurationSec);
    let sourceSec = timelineSec;
    if (Number.isFinite(preset.holdAtSec) && preset.holdDurationSec > 0) {
      const holdStart = preset.holdAtSec;
      const holdEnd = holdStart + preset.holdDurationSec;
      if (timelineSec >= holdStart && timelineSec <= holdEnd) sourceSec = holdStart;
      else if (timelineSec > holdEnd) sourceSec = timelineSec - preset.holdDurationSec;
    }

    return lerp(from, to, clamp(sourceSec / sourceDurationSec, 0, 1));
  }

  function prepareArmAnimationForScrub(preset) {
    const anim = preset?.group || preset;
    if (!anim) return null;
    const from = preset.from ?? anim.from ?? 0;
    const to = preset.to ?? anim.to ?? from;
    anim.reset();
    anim.start(false, 1.0, from, to, false);
    anim.pause?.();
    return anim;
  }

  function stopArmAnimations() {
    clearArmAnimationSequence();
    clearArmAnimationProgressObserver();
    armAnimationGroups.forEach((preset) => (preset.group || preset).stop());
    activeArmAnimationIndex = -1;
    activeArmAnimationProgress = 0;
    notifyArmAnimationsChanged();
    notifyArmAnimationProgress();
  }

  function playArmAnimation(index, options = {}) {
    const preset = armAnimationGroups[index];
    const anim = preset?.group || preset;
    if (!anim) return false;
    if (!options.fromSequence) clearArmAnimationSequence();
    clearArmAnimationProgressObserver();
    armAnimationGroups.forEach((item) => (item.group || item).stop());
    prepareArmAnimationForScrub(preset);
    activeArmAnimationIndex = index;
    activeArmAnimationProgress = 0;
    anim.goToFrame?.(getArmAnimationFrameAtProgress(preset, activeArmAnimationProgress));
    notifyArmAnimationsChanged();
    notifyArmAnimationProgress();

    const durationMs = Math.max(1, (Number(preset.durationSec) || 0) * 1000);
    const startedAt = performance.now();
    armAnimationProgressObs = scene.onBeforeRenderObservable.add(() => {
      if (activeArmAnimationIndex !== index) {
        clearArmAnimationProgressObserver();
        return;
      }
      activeArmAnimationProgress = clamp((performance.now() - startedAt) / durationMs, 0, 1);
      anim.goToFrame?.(getArmAnimationFrameAtProgress(preset, activeArmAnimationProgress));
      notifyArmAnimationProgress();
      if (activeArmAnimationProgress >= 1) clearArmAnimationProgressObserver();
    });
    return true;
  }

  function playArmAnimationSequence(indices = []) {
    const queue = indices
      .map((index) => Number(index))
      .filter((index) => Number.isInteger(index) && armAnimationGroups[index]);
    if (!queue.length) return false;

    clearArmAnimationSequence();
    const run = armAnimationSequenceRunId;
    let cursor = 0;

    const playNext = () => {
      if (run !== armAnimationSequenceRunId) return;
      const index = queue[cursor];
      const preset = armAnimationGroups[index];
      if (!preset || !playArmAnimation(index, { fromSequence: true })) return;
      cursor += 1;
      if (cursor >= queue.length) return;
      const delayMs = Math.max(1, (Number(preset.durationSec) || 0) * 1000) + 80;
      armAnimationSequenceTimer = setTimeout(playNext, delayMs);
    };

    playNext();
    return true;
  }

  function seekArmAnimation(index, progress) {
    const preset = armAnimationGroups[index];
    const anim = preset?.group || preset;
    if (!anim) return false;
    clearArmAnimationSequence();
    clearArmAnimationProgressObserver();
    armAnimationGroups.forEach((item) => (item.group || item).stop());

    const wasActive = activeArmAnimationIndex === index;
    activeArmAnimationIndex = index;
    activeArmAnimationProgress = clamp(Number(progress) || 0, 0, 1);
    prepareArmAnimationForScrub(preset);
    anim.goToFrame?.(getArmAnimationFrameAtProgress(preset, activeArmAnimationProgress));

    if (!wasActive) notifyArmAnimationsChanged();
    notifyArmAnimationProgress();
    return true;
  }

  function capturePhalangeRig(skeletons) {
    const skeleton = (skeletons || scene.skeletons || []).find((sk) => sk?.bones?.length);
    phalangeRig = [];
    metacarpalRig = [];
    rotationMechanismRig = [];
    combinedRigByBone = new Map();
    if (!skeleton) return;

    for (const cfg of PHALANGE_BONES) {
      const bone = findBoneByName(skeleton, cfg.name);
      const tm = bone?.getTransformNode?.();
      if (!tm) {
        console.warn('bone controller: не найдена TransformNode', cfg.name);
        continue;
      }
      const base = tm.rotationQuaternion
        ? tm.rotationQuaternion.clone()
        : BABYLON.Quaternion.FromEulerAngles(tm.rotation.x, tm.rotation.y, tm.rotation.z);
      tm.rotationQuaternion = tm.rotationQuaternion || base.clone();
      phalangeRig.push({ ...cfg, tm, base });
      combinedRigByBone.set(cfg.name.toLowerCase(), { tm, base, phalange: null, metacarpal: null });
    }

    for (const cfg of METACARPAL_BONES) {
      const bone = findBoneByName(skeleton, cfg.name);
      const tm = bone?.getTransformNode?.();
      if (!tm) {
        console.warn('metacarpal controller: не найдена TransformNode', cfg.name);
        continue;
      }
      const base = tm.rotationQuaternion
        ? tm.rotationQuaternion.clone()
        : BABYLON.Quaternion.FromEulerAngles(tm.rotation.x, tm.rotation.y, tm.rotation.z);
      tm.rotationQuaternion = tm.rotationQuaternion || base.clone();
      metacarpalRig.push({ ...cfg, tm, base });
      const boneKey = cfg.name.toLowerCase();
      if (!combinedRigByBone.has(boneKey)) combinedRigByBone.set(boneKey, { tm, base, phalange: null, metacarpal: null });
    }

    for (const cfg of ROTATION_MECHANISM_BONES) {
      const bone = findBoneByName(skeleton, cfg.name);
      const tm = bone?.getTransformNode?.();
      if (!tm) {
        console.warn('rotation mechanism controller: не найдена TransformNode', cfg.name);
        continue;
      }
      const base = tm.rotationQuaternion
        ? tm.rotationQuaternion.clone()
        : BABYLON.Quaternion.FromEulerAngles(tm.rotation.x, tm.rotation.y, tm.rotation.z);
      tm.rotationQuaternion = tm.rotationQuaternion || base.clone();
      rotationMechanismRig.push({ ...cfg, tm, base });
      const boneKey = cfg.name.toLowerCase();
      if (!combinedRigByBone.has(boneKey)) combinedRigByBone.set(boneKey, { tm, base, phalange: null, metacarpal: null, rotationMechanism: null });
    }

    applyHandPoseToRig(activeHandPose);
  }

  function applyHandPoseToRig(handPose) {
    activeHandPose = handPose || activeHandPose;
    if (!activeHandPose || (!phalangeRig.length && !metacarpalRig.length && !rotationMechanismRig.length)) return;

    for (const rig of combinedRigByBone.values()) {
      rig.phalange = null;
      rig.metacarpal = null;
      rig.rotationMechanism = null;
    }

    for (const cfg of phalangeRig) {
      const fingerIndex = cfg.fingerIndex ?? PHALANGE_TO_FINGER_INDEX[cfg.index];
      const limit = cfg.limit ?? 100;
      const fingerPercent = cfg.includeFinger === false ? 0 : getFingerPercent(activeHandPose, fingerIndex);
      const percent = cfg.type === 'finger'
        ? getFingerPercent(activeHandPose, cfg.index)
        : clamp(fingerPercent + getPhalangePercent(activeHandPose, cfg.type, cfg.index), -limit, limit);
      const angle = (percent / 100) * MAX_PHALANGE_BEND_RAD * (cfg.direction || 1);
      BABYLON.Quaternion.RotationAxisToRef(cfg.axis ? thumbBendAxis : bendAxis, angle, bendQ);
      const rig = combinedRigByBone.get(cfg.name.toLowerCase());
      if (rig) rig.phalange = bendQ.clone();
      else cfg.base.multiplyToRef(bendQ, cfg.tm.rotationQuaternion);
    }

    for (const cfg of metacarpalRig) {
      const ownPercent = getMetacarpalPercent(activeHandPose, cfg.key);
      const comboBasePercent = getMetacarpalPercent(activeHandPose, METACARPAL_COMBO_KEY);
      const comboPercent = cfg.combo
        ? (cfg.comboFollow ? followMetacarpalCombo(comboBasePercent) : comboBasePercent)
        : 0;
      const percent = clamp(
        ownPercent + comboPercent,
        -(cfg.limit ?? 100),
        cfg.limit ?? 100,
      );
      const angle = (percent / 100) * MAX_METACARPAL_BEND_RAD;
      BABYLON.Quaternion.RotationAxisToRef(cfg.axis === 'z' ? thumbBendAxis : metacarpalAxis, angle, metacarpalQ);
      const rig = combinedRigByBone.get(cfg.name.toLowerCase());
      if (rig) rig.metacarpal = metacarpalQ.clone();
      else cfg.base.multiplyToRef(metacarpalQ, cfg.tm.rotationQuaternion);
    }

    for (const cfg of rotationMechanismRig) {
      const limit = cfg.limit ?? 100;
      const fingerPercent = cfg.key === 'thumbProximal' ? getFingerPercent(activeHandPose, 0) : 0;
      const percent = clamp(fingerPercent + getRotationMechanismPercent(activeHandPose, cfg.key), -limit, limit);
      const angle = (percent / 100) * MAX_METACARPAL_BEND_RAD * (cfg.direction || 1);
      BABYLON.Quaternion.RotationAxisToRef(cfg.axis === 'z' ? thumbBendAxis : metacarpalAxis, angle, metacarpalQ);
      const rig = combinedRigByBone.get(cfg.name.toLowerCase());
      if (rig) rig.rotationMechanism = metacarpalQ.clone();
      else cfg.base.multiplyToRef(metacarpalQ, cfg.tm.rotationQuaternion);
    }

    for (const rig of combinedRigByBone.values()) {
      rig.tm.rotationQuaternion.copyFrom(rig.base);
      if (rig.phalange) rig.tm.rotationQuaternion.multiplyInPlace(rig.phalange);
      if (rig.metacarpal) rig.tm.rotationQuaternion.multiplyInPlace(rig.metacarpal);
      if (rig.rotationMechanism) rig.tm.rotationQuaternion.multiplyInPlace(rig.rotationMechanism);
    }
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
    applyZoomLimits();
  }

  function showLoading(state) {
    opts.onLoading?.(state);
  }

  async function reloadAssemblyFromStorage() {
    showLoading(true);
    disposeContent();
    clearArmAnimationSequence();
    clearArmAnimationProgressObserver();
    armAnimationGroups = [];
    activeArmAnimationIndex = -1;
    activeArmAnimationProgress = 0;
    notifyArmAnimationsChanged();
    try {
      const raw = localStorage.getItem(ASSEMBLY_STORAGE_KEY);
      if (raw) lastAssemblyData = JSON.parse(raw);
      else lastAssemblyData = null;
    } catch (_) {
      lastAssemblyData = null;
    }

    try {
      scene.stopAllAnimations();
      const result = await BABYLON.SceneLoader.ImportMeshAsync('', ARM_DIR, ARM_GLB, scene);
      scene.stopAllAnimations();
      result.animationGroups?.forEach((group) => group.stop());
      armAnimationGroups = createArmAnimationPresets(result.animationGroups || []);
      activeArmAnimationIndex = -1;
      notifyArmAnimationsChanged();
      result.skeletons?.forEach((sk) => scene.stopAnimation(sk));
      result.transformNodes?.forEach((node) => scene.stopAnimation(node));
      result.meshes?.forEach((mesh) => scene.stopAnimation(mesh));
      const meshes = (result.meshes || []).filter(Boolean);
      meshes.forEach((mesh) => {
        mesh.alwaysSelectAsActiveMesh = true;
      });
      if (!meshes.length) {
        showLoading(false);
        requestAnimationFrame(() => { if (!disposed) engine.resize(); });
        return;
      }
      contentRoot =
        meshes.find((m) => m.name === '__root__') ||
        result.transformNodes?.find((n) => n && n.name === '__root__') ||
        result.meshes[0];
      capturePhalangeRig(result.skeletons);
      frameToContent(contentRoot);
    } catch (e) {
      console.warn('ARM.glb', e);
    } finally {
      showLoading(false);
      requestAnimationFrame(() => { if (!disposed) engine.resize(); });
    }
  }

  reloadAssemblyFromStorage();

  disposers.push(on(EVENTS.HAND_POSE_CHANGED, ({ handPose } = {}) => applyHandPoseToRig(handPose)));

  if (opts.fpsEl) {
    let acc = 0;
    scene.onAfterRenderObservable.add(() => {
      acc += 1;
      if (acc % 15 === 0) opts.fpsEl.textContent = `${engine.getFps().toFixed(0)} fps`;
    });
  }

  let resizeRaf = 0;
  let resizeObserver = null;
  const renderScene = () => scene.render();
  const resizeNow = () => {
    resizeRaf = 0;
    if (!disposed) engine.resize();
  };
  const scheduleResize = () => {
    if (disposed || resizeRaf) return;
    resizeRaf = requestAnimationFrame(resizeNow);
  };

  engine.runRenderLoop(renderScene);
  window.addEventListener('resize', scheduleResize);
  window.addEventListener('fullscreenchange', scheduleResize);
  scheduleResize();

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(scheduleResize);
    if (canvas.parentElement) resizeObserver.observe(canvas.parentElement);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clipRunId += 1;
    clearArmAnimationSequence();
    clearArmAnimationProgressObserver();
    if (dashClipRenderObs) { scene.onBeforeRenderObservable.remove(dashClipRenderObs); dashClipRenderObs = null; }
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeObserver?.disconnect();
    window.removeEventListener('resize', scheduleResize);
    window.removeEventListener('fullscreenchange', scheduleResize);
    disposers.forEach((off) => off?.());
    engine.stopRenderLoop(renderScene);
    disposeContent();
    engine.dispose();
  }

  return {
    engine,
    scene,
    camera,
    reloadAssemblyFromStorage,
    previewScene,
    playClip,
    stopClipPlayback,
    playArmAnimation,
    playArmAnimationSequence,
    seekArmAnimation,
    stopArmAnimations,
    dispose,
    applyHandPose: applyHandPoseToRig,
    resetCamera: () => {
      camera.alpha = -Math.PI / 2.35;
      camera.beta = Math.PI / 3.1;
      if (contentRoot) frameToContent(contentRoot);
    },
  };
}
