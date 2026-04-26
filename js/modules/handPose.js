/** Схема позы пальцев в pipeline / JSON (подгрузка снаружи). */

export const FINGER_KEYS = ['thumb', 'index', 'middle', 'ring', 'pinky'];

export const FINGER_LABELS = ['большой', 'указат.', 'средний', 'безым.', 'мизинец'];

export function defaultHandPose() {
  return {
    schema: 'finger-flex-v1',
    unit: 'percent',
    range: { min: 0, max: 100 },
    keys: [...FINGER_KEYS],
    values: [0, 0, 0, 0, 0],
  };
}

/**
 * @param {unknown} raw
 * @returns {number[]|null} пять значений 0..100 или null
 */
export function parseHandPoseFromJson(raw) {
  if (raw == null) return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (Array.isArray(obj) && obj.length >= 5) return normalizeFive(obj);
  if (obj && typeof obj === 'object') {
    if (obj.pipeline?.handPose?.values) return normalizeFive(obj.pipeline.handPose.values);
    if (obj.handPose?.values) return normalizeFive(obj.handPose.values);
  }
  return null;
}

function normalizeFive(arr) {
  if (!Array.isArray(arr) || arr.length < 5) return null;
  return arr.slice(0, 5).map((v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
  });
}
