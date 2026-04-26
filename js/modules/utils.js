/* global BABYLON */

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function easeInOutCubic(t) {
  const u = clamp(t, 0, 1);
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}

export function downloadText(filename, text, type = 'application/json;charset=utf-8') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function safeName(str) {
  return String(str || '')
    .trim()
    .replace(/[^\p{L}\p{N}\-_\. ]/gu, '_')
    .slice(0, 80) || 'object';
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatDurationSec(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  if (sec < 60) return `${Math.round(sec)} с`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s ? `${m} мин ${s} с` : `${m} мин`;
}

export function makeStepId() {
  return `st_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

export function splitModelPath(fullPath) {
  const u = String(fullPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const idx = u.lastIndexOf('/');
  if (idx <= 0) return { rootUrl: '/', filename: u };
  return { rootUrl: u.slice(0, idx + 1), filename: u.slice(idx + 1) };
}

export function vec3ToObj(v) {
  return { x: v.x, y: v.y, z: v.z };
}

export function objToVec3(o, fallback) {
  if (!o) return fallback.clone();
  return new BABYLON.Vector3(Number(o.x) || 0, Number(o.y) || 0, Number(o.z) || 0);
}

export function applyTransformSnapshot(node, snap) {
  node.position.set(snap.position.x, snap.position.y, snap.position.z);
  node.rotation.set(snap.rotation.x, snap.rotation.y, snap.rotation.z);
  node.scaling.set(snap.scaling.x, snap.scaling.y, snap.scaling.z);
}

export function applyCameraSnapshot(cam, snap) {
  if (!cam || !snap) return;
  if (Number.isFinite(snap.alpha)) cam.alpha = snap.alpha;
  if (Number.isFinite(snap.beta)) cam.beta = snap.beta;
  if (Number.isFinite(snap.radius)) cam.radius = snap.radius;
  cam.setTarget(objToVec3(snap.target, BABYLON.Vector3.Zero()));
}

export function lerpTransformSnapshot(a, b, t) {
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
      rx = e.x; ry = e.y; rz = e.z;
    } catch (_) { /* fallback */ }
  }
  return {
    position: { x: L(a.position.x, b.position.x), y: L(a.position.y, b.position.y), z: L(a.position.z, b.position.z) },
    rotation: { x: rx, y: ry, z: rz },
    scaling: { x: L(a.scaling.x, b.scaling.x), y: L(a.scaling.y, b.scaling.y), z: L(a.scaling.z, b.scaling.z) },
  };
}

export function normalizeAuthoring(raw) {
  if (!raw || typeof raw !== 'object') return { scenes: [], clips: [] };
  return {
    scenes: Array.isArray(raw.scenes) ? raw.scenes : [],
    clips: Array.isArray(raw.clips) ? raw.clips : [],
  };
}

export function scenePayloadUsesPartNames(parts) {
  return Array.isArray(parts) && parts.some((p) => p && p.partName);
}

export function getPartTransformForNodeInScene(scenePayload, node, index) {
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
