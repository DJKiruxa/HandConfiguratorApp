/** Схема позы пальцев в pipeline / JSON (подгрузка снаружи). */

export const FINGER_KEYS = ['thumb', 'index', 'middle', 'ring', 'pinky'];

export const FINGER_LABELS = ['большой', 'указат.', 'средний', 'безым.', 'мизинец'];

export const PHALANGE_FINGER_KEYS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const LEGACY_PHALANGE_FINGER_KEYS = ['index', 'middle', 'ring', 'pinky'];
export const METACARPAL_KEYS = ['pinky', 'ring', 'pinkyRing', 'thumb'];
const LEGACY_METACARPAL_KEYS = ['pinky', 'ring', 'pinkyRing'];

export function defaultHandPose() {
  return {
    schema: 'finger-flex-v1',
    unit: 'percent',
    range: { min: -100, max: 100 },
    keys: [...FINGER_KEYS],
    values: [0, 0, 0, 0, 0],
    phalanges: {
      keys: [...PHALANGE_FINGER_KEYS],
      middle: [0, 0, 0, 0, 0],
      proximal: [0, 0, 0, 0, 0],
    },
    metacarpals: {
      keys: [...METACARPAL_KEYS],
      values: [0, 0, 0, 0],
    },
  };
}

/**
 * @param {unknown} raw
 * @returns {number[]|null} пять значений -100..100 или null
 */
export function parseHandPoseFromJson(raw) {
  return parseHandPosePayloadFromJson(raw)?.values || null;
}

/**
 * @param {unknown} raw
 * @returns {ReturnType<typeof defaultHandPose>|null}
 */
export function parseHandPosePayloadFromJson(raw) {
  if (raw == null) return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }

  const pose = Array.isArray(obj) ? { values: obj } : (obj?.pipeline?.handPose || obj?.handPose || null);
  if (!pose?.values) return null;

  const values = normalizeFive(pose.values);
  if (!values) return null;

  const out = defaultHandPose();
  out.values = values;

  const phalanges = pose.phalanges;
  if (phalanges && typeof phalanges === 'object') {
    for (const type of ['middle', 'proximal']) {
      const values = normalizePhalangeValues(phalanges[type], phalanges.keys);
      if (values) out.phalanges[type] = values;
    }
  }

  const metacarpals = pose.metacarpals;
  const metacarpalValues = Array.isArray(metacarpals)
    ? normalizeMetacarpalValues(metacarpals)
    : normalizeMetacarpalValues(metacarpals?.values, metacarpals?.keys);
  if (metacarpalValues) out.metacarpals.values = metacarpalValues;

  return out;
}

function normalizeFive(arr) {
  return normalizeRange(arr, 5);
}

function normalizeRange(arr, length) {
  if (!Array.isArray(arr) || arr.length < length) return null;
  return arr.slice(0, length).map((v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(-100, Math.min(100, n)) : 0;
  });
}

export function normalizePhalangeValues(arr, keys) {
  if (!Array.isArray(arr)) return null;
  const sourceKeys = Array.isArray(keys) && keys.length
    ? keys
    : (arr.length >= PHALANGE_FINGER_KEYS.length ? PHALANGE_FINGER_KEYS : LEGACY_PHALANGE_FINGER_KEYS);
  if (arr.length < sourceKeys.length) return null;

  const out = [0, 0, 0, 0, 0];
  sourceKeys.slice(0, arr.length).forEach((key, i) => {
    const targetIndex = PHALANGE_FINGER_KEYS.indexOf(key);
    if (targetIndex < 0) return;
    const n = Number(arr[i]);
    out[targetIndex] = Number.isFinite(n) ? Math.max(-100, Math.min(100, n)) : 0;
  });
  return out;
}

export function normalizeMetacarpalValues(arr, keys) {
  if (!Array.isArray(arr)) return null;
  const sourceKeys = Array.isArray(keys) && keys.length
    ? keys
    : (arr.length >= METACARPAL_KEYS.length ? METACARPAL_KEYS : LEGACY_METACARPAL_KEYS);
  if (arr.length < sourceKeys.length) return null;

  const out = [0, 0, 0, 0];
  sourceKeys.slice(0, arr.length).forEach((key, i) => {
    const targetIndex = METACARPAL_KEYS.indexOf(key);
    if (targetIndex < 0) return;
    const n = Number(arr[i]);
    out[targetIndex] = Number.isFinite(n) ? Math.max(-100, Math.min(100, n)) : 0;
  });
  return out;
}
