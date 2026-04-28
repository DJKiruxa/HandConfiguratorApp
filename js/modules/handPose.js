/** Схема позы пальцев в pipeline / JSON (подгрузка снаружи). */

export const FINGER_KEYS = ['thumb', 'index', 'middle', 'ring', 'pinky'];

export const FINGER_LABELS = ['большой', 'указат.', 'средний', 'безым.', 'мизинец'];

export const PHALANGE_FINGER_KEYS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const LEGACY_PHALANGE_FINGER_KEYS = ['index', 'middle', 'ring', 'pinky'];
export const METACARPAL_KEYS = ['pinky', 'ring', 'pinkyRing', 'thumb'];
const LEGACY_METACARPAL_KEYS = ['pinky', 'ring', 'pinkyRing'];
export const ROTATION_MECHANISM_KEYS = ['thumbProximal'];
const COMPACT_HAND_POSE_SCHEMA = 'babylon.handPose.v3';
export const PHALANGE_TYPES = ['middle', 'proximal'];

export function getPhalangeLimit(type, index) {
  return 100;
}

export function clampPhalangeValue(type, value, index) {
  const n = Number(value);
  const limit = getPhalangeLimit(type, index);
  return Number.isFinite(n) ? Math.max(-limit, Math.min(limit, n)) : 0;
}

export function getRotationMechanismLimit(keyOrIndex) {
  return keyOrIndex === 'thumbProximal' || Number(keyOrIndex) === 0 ? 120 : 100;
}

export function clampRotationMechanismValue(keyOrIndex, value) {
  const n = Number(value);
  const limit = getRotationMechanismLimit(keyOrIndex);
  return Number.isFinite(n) ? Math.max(-limit, Math.min(limit, n)) : 0;
}

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
    rotationMechanisms: {
      keys: [...ROTATION_MECHANISM_KEYS],
      values: [0],
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

  if (obj?.schema === COMPACT_HAND_POSE_SCHEMA || obj?.fingers) {
    return parseCompactHandPose(obj);
  }

  const pose = Array.isArray(obj) ? { values: obj } : (obj?.pipeline?.handPose || obj?.handPose || null);
  if (!pose?.values) return null;

  const values = normalizeFive(pose.values);
  if (!values) return null;

  const out = defaultHandPose();
  out.values = values;

  const phalanges = pose.phalanges;
  if (phalanges && typeof phalanges === 'object') {
    for (const type of PHALANGE_TYPES) {
      const values = normalizePhalangeValues(phalanges[type], phalanges.keys, type);
      if (values) out.phalanges[type] = values;
    }
  }

  const metacarpals = pose.metacarpals;
  const metacarpalValues = Array.isArray(metacarpals)
    ? normalizeMetacarpalValues(metacarpals)
    : normalizeMetacarpalValues(metacarpals?.values, metacarpals?.keys);
  if (metacarpalValues) out.metacarpals.values = metacarpalValues;

  const rotationMechanisms = pose.rotationMechanisms;
  const rotationMechanismValues = Array.isArray(rotationMechanisms)
    ? normalizeRotationMechanismValues(rotationMechanisms)
    : normalizeRotationMechanismValues(rotationMechanisms?.values, rotationMechanisms?.keys);
  if (rotationMechanismValues) out.rotationMechanisms.values = rotationMechanismValues;

  return out;
}

export function buildCompactHandPose(handPose) {
  const normalized = parseHandPosePayloadFromJson({ handPose }) || defaultHandPose();
  return {
    schema: COMPACT_HAND_POSE_SCHEMA,
    unit: 'percent',
    fingers: valuesToObject(normalized.values, FINGER_KEYS),
    phalanges: {
      middle: valuesToObject(normalized.phalanges.middle, PHALANGE_FINGER_KEYS, 'middle'),
      proximal: valuesToObject(normalized.phalanges.proximal, PHALANGE_FINGER_KEYS, 'proximal'),
    },
    metacarpals: valuesToObject(normalized.metacarpals.values, METACARPAL_KEYS),
    rotationMechanisms: rotationMechanismValuesToObject(normalized.rotationMechanisms.values),
  };
}

function parseCompactHandPose(obj) {
  if (!obj?.fingers || typeof obj.fingers !== 'object') return null;
  const values = objectToValues(obj.fingers, FINGER_KEYS);
  if (!values) return null;

  const out = defaultHandPose();
  out.values = values;

  const middle = objectToValues(obj.phalanges?.middle, PHALANGE_FINGER_KEYS, 'middle');
  if (middle) out.phalanges.middle = middle;

  const proximal = objectToValues(obj.phalanges?.proximal, PHALANGE_FINGER_KEYS, 'proximal');
  if (proximal) out.phalanges.proximal = proximal;

  const metacarpals = objectToValues(obj.metacarpals, METACARPAL_KEYS);
  if (metacarpals) out.metacarpals.values = metacarpals;

  const rotationMechanisms = rotationMechanismObjectToValues(obj.rotationMechanisms);
  if (rotationMechanisms) out.rotationMechanisms.values = rotationMechanisms;

  return out;
}

function valuesToObject(values, keys, type = '') {
  return keys.reduce((acc, key) => {
    const index = keyIndex(key);
    const sourceIndex = index >= 0 && values.length === PHALANGE_FINGER_KEYS.length ? index : keys.indexOf(key);
    acc[key] = clampPhalangeValue(type, values[sourceIndex] ?? 0, index);
    return acc;
  }, {});
}

function objectToValues(obj, keys, type = '') {
  if (!obj || typeof obj !== 'object') return null;
  const out = keys.map((key) => {
    return clampPhalangeValue(type, obj[key] ?? 0, keyIndex(key));
  });
  return out;
}

function rotationMechanismValuesToObject(values) {
  return ROTATION_MECHANISM_KEYS.reduce((acc, key, index) => {
    acc[key] = clampRotationMechanismValue(key, values[index] ?? 0);
    return acc;
  }, {});
}

function rotationMechanismObjectToValues(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return ROTATION_MECHANISM_KEYS.map((key) => clampRotationMechanismValue(key, obj[key] ?? 0));
}

function keyIndex(key) {
  return PHALANGE_FINGER_KEYS.indexOf(key);
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

export function normalizePhalangeValues(arr, keys, type = '') {
  if (!Array.isArray(arr)) return null;
  const sourceKeys = Array.isArray(keys) && keys.length
    ? keys
    : (arr.length >= PHALANGE_FINGER_KEYS.length ? PHALANGE_FINGER_KEYS : LEGACY_PHALANGE_FINGER_KEYS);
  if (arr.length < sourceKeys.length) return null;

  const out = [0, 0, 0, 0, 0];
  sourceKeys.slice(0, arr.length).forEach((key, i) => {
    const targetIndex = PHALANGE_FINGER_KEYS.indexOf(key);
    if (targetIndex < 0) return;
    out[targetIndex] = clampPhalangeValue(type, arr[i], targetIndex);
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

export function normalizeRotationMechanismValues(arr, keys) {
  if (!Array.isArray(arr)) return null;
  const sourceKeys = Array.isArray(keys) && keys.length ? keys : ROTATION_MECHANISM_KEYS;
  if (arr.length < sourceKeys.length) return null;

  const out = [0];
  sourceKeys.slice(0, arr.length).forEach((key, i) => {
    const targetIndex = ROTATION_MECHANISM_KEYS.indexOf(key);
    if (targetIndex < 0) return;
    out[targetIndex] = clampRotationMechanismValue(key, arr[i]);
  });
  return out;
}
