/** Схема позы пальцев в pipeline / JSON (подгрузка снаружи). */

export const FINGER_KEYS = ['thumb', 'index', 'middle', 'ring', 'pinky'];

export const FINGER_LABELS = ['большой', 'указат.', 'средний', 'безым.', 'мизинец'];

export const PHALANGE_FINGER_KEYS = ['index', 'middle', 'ring', 'pinky'];

export function defaultHandPose() {
  return {
    schema: 'finger-flex-v1',
    unit: 'percent',
    range: { min: -100, max: 100 },
    keys: [...FINGER_KEYS],
    values: [0, 0, 0, 0, 0],
    phalanges: {
      keys: [...PHALANGE_FINGER_KEYS],
      middle: [0, 0, 0, 0],
      proximal: [0, 0, 0, 0],
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
      const values4 = normalizeFour(phalanges[type]);
      if (values4) out.phalanges[type] = values4;
    }
  }

  return out;
}

function normalizeFive(arr) {
  return normalizeRange(arr, 5);
}

function normalizeFour(arr) {
  return normalizeRange(arr, 4);
}

function normalizeRange(arr, length) {
  if (!Array.isArray(arr) || arr.length < length) return null;
  return arr.slice(0, length).map((v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(-100, Math.min(100, n)) : 0;
  });
}
