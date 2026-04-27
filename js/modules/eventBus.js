/** Lightweight pub/sub event bus + DOM CustomEvent bridge. */
const listeners = new Map();

export const EVENTS = {
  ASSEMBLY_UPDATED: 'babylon-assembly-updated',
  PREVIEW_SCENE: 'babylon-dash-preview-scene',
  PLAY_CLIP: 'babylon-dash-play-clip',
  TOAST: 'babylon-toast',
  THEME_CHANGED: 'babylon-theme-changed',
  RECIPE_CHANGED: 'babylon-recipe-changed',
  /** { handPose } — live-состояние позы руки, включая фаланги. */
  HAND_POSE_CHANGED: 'babylon-hand-pose-changed',
  /** { index: 0..4, value: 0..100 } — заготовка под кинематику пальцев */
  FINGER_VALUE: 'babylon-finger-value',
};

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  const handler = (e) => fn(e.detail);
  window.addEventListener(event, handler);
  return () => {
    listeners.get(event)?.delete(fn);
    window.removeEventListener(event, handler);
  };
}

export function emit(event, detail) {
  try {
    window.dispatchEvent(new CustomEvent(event, { detail }));
  } catch (_) { /* ignore */ }
}
