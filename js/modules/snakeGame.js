/**
 * Snake — Google-style. Mounts inside an existing element, paints on a canvas,
 * uses CSS variables for colors, supports keyboard, touch (D-pad), pause and
 * smooth interpolation between fixed logic ticks.
 *
 * Public API:
 *   window.SnakeGame.mount(containerId)
 *   window.SnakeGame.destroy()
 */
import { on, EVENTS } from './eventBus.js';

const BASE_TICK_MS = 220;
const TARGET_CELL = 64;
const MIN_COLS = 7;
const MIN_ROWS = 7;

function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const pick = (n, fb) => (cs.getPropertyValue(n).trim() || fb);
  return {
    bg: pick('--bg', '#0b0b14'),
    bg2: pick('--bg2', '#11111c'),
    border: pick('--border', 'rgba(255,255,255,0.12)'),
    accent: pick('--accent', '#ff4d1c'),
    text: pick('--text', '#f0f0fa'),
    text2: pick('--text2', '#b0b0cc'),
    text3: pick('--text3', '#606080'),
    onAccent: pick('--bg', '#0b0b14'),
    appleRed: pick('--accent', '#e63946'),
    leafGreen: pick('--green', '#16a34a'),
    stem: pick('--text3', '#7a5230'),
  };
}

function rgbaFromCss(value, alpha) {
  if (!value) return `rgba(255,255,255,${alpha})`;
  const v = value.trim();
  if (v.startsWith('rgb')) {
    const m = v.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const parts = m[1].split(',').map((s) => s.trim());
      const [r, g, b] = parts;
      return `rgba(${r},${g},${b},${alpha})`;
    }
  }
  if (v.startsWith('#')) {
    const h = v.slice(1);
    const expand = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    if (expand.length >= 6) {
      const r = parseInt(expand.slice(0, 2), 16);
      const g = parseInt(expand.slice(2, 4), 16);
      const b = parseInt(expand.slice(4, 6), 16);
      return `rgba(${r},${g},${b},${alpha})`;
    }
  }
  return v;
}

function isTouchDevice() {
  return (
    typeof window !== 'undefined' &&
    (('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0)
  );
}

function eq(a, b) { return a.x === b.x && a.y === b.y; }
function opp(a, b) { return a.x + b.x === 0 && a.y + b.y === 0; }
function snap05(v) { return Math.round(v * 2) / 2; }

let active = null;

const SnakeGame = {
  mount(containerId) {
    SnakeGame.destroy();
    const root = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
    if (!root) return false;
    active = createInstance(root);
    return true;
  },
  destroy() {
    if (active) { active.destroy(); active = null; }
  },
};

function createInstance(root) {
  root.innerHTML = '';
  const stage = document.createElement('div');
  stage.className = 'snake-stage';
  const canvas = document.createElement('canvas');
  canvas.className = 'snake-canvas';
  stage.appendChild(canvas);
  root.appendChild(stage);

  let dpad = null;
  if (isTouchDevice()) {
    dpad = document.createElement('div');
    dpad.className = 'snake-dpad';
    dpad.innerHTML = `
      <button type="button" class="pad-up" data-dir="up" aria-label="вверх">▲</button>
      <button type="button" class="pad-left" data-dir="left" aria-label="влево">◀</button>
      <button type="button" class="pad-down" data-dir="down" aria-label="вниз">▼</button>
      <button type="button" class="pad-right" data-dir="right" aria-label="вправо">▶</button>
    `;
    root.appendChild(dpad);
  }

  if (!root.hasAttribute('tabindex')) root.tabIndex = 0;

  const ctx = canvas.getContext('2d');

  let palette = readPalette();
  let dpr = 1;
  let cell = 16;
  let cols = 17;
  let rows = 17;
  let W = cols * cell;
  let H = rows * cell;

  let snake = [];
  let prev = [];
  let dir = { x: 1, y: 0 };
  let prevDir = { x: 1, y: 0 };
  let pendingDirs = [];
  let food = { x: 0, y: 0 };
  let score = 0;
  let best = 0;
  try {
    best = parseInt(localStorage.getItem('snake.best') || '0', 10) || 0;
  } catch (e) { best = 0; }

  /** 'idle' | 'play' | 'paused' | 'over' */
  let state = 'idle';
  let lastTick = 0;
  let tickMs = BASE_TICK_MS;
  let chompPhase = 0;

  function setCanvasSize() {
    const rect = stage.getBoundingClientRect();
    const padW = Math.max(48, Math.floor(stage.clientWidth || rect.width));
    const padH = Math.max(48, Math.floor(stage.clientHeight || rect.height));
    const oldCols = cols;
    const oldRows = rows;

    // Canvas is always full parent width. Column count adapts to that width,
    // then row count is whatever fits in the available height without scroll.
    cols = Math.max(MIN_COLS, Math.round(padW / TARGET_CELL));
    cell = padW / cols;
    rows = Math.max(1, Math.floor(padH / cell));
    if (rows < MIN_ROWS && padH >= MIN_ROWS * 6) {
      cell = padH / MIN_ROWS;
      cols = Math.max(MIN_COLS, Math.floor(padW / cell));
      cell = padW / cols;
      rows = Math.max(1, Math.floor(padH / cell));
    }

    W = padW;
    H = rows * cell;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (snake.length && (cols !== oldCols || rows !== oldRows)) {
      resetGame();
    }
  }

  function listTaken() {
    const t = new Set();
    for (const s of snake) t.add(`${s.x},${s.y}`);
    return t;
  }

  function placeFood() {
    const taken = listTaken();
    const free = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (!taken.has(`${x},${y}`)) free.push({ x, y });
      }
    }
    if (!free.length) { food = { x: -1, y: -1 }; return; }
    food = free[Math.floor(Math.random() * free.length)];
  }

  function resetGame() {
    const cy = Math.floor(rows / 2);
    const cx = Math.floor(cols / 2);
    snake = [
      { x: cx + 1, y: cy },
      { x: cx,     y: cy },
      { x: cx - 1, y: cy },
    ];
    prev = snake.map((s) => ({ ...s }));
    dir = { x: 1, y: 0 };
    prevDir = { x: 1, y: 0 };
    pendingDirs = [];
    score = 0;
    tickMs = BASE_TICK_MS;
    placeFood();
    lastTick = performance.now();
  }

  function startGame() {
    resetGame();
    state = 'play';
    lastTick = performance.now();
  }

  function gameOver() {
    state = 'over';
    if (score > best) {
      best = score;
      try { localStorage.setItem('snake.best', String(best)); } catch (e) { /* noop */ }
    }
  }

  function queueDir(d) {
    const last = pendingDirs.length ? pendingDirs[pendingDirs.length - 1] : dir;
    if (eq(d, last) || opp(d, last)) return;
    if (pendingDirs.length >= 2) pendingDirs.shift();
    pendingDirs.push(d);
  }

  function logicTick() {
    if (state !== 'play') return;

    // For smooth head rotation on turns.
    prevDir = { ...dir };

    if (pendingDirs.length) {
      const d = pendingDirs.shift();
      if (!opp(d, dir)) dir = d;
    }
    const head = snake[0];
    const nh = { x: head.x + dir.x, y: head.y + dir.y };
    if (nh.x < 0 || nh.x >= cols || nh.y < 0 || nh.y >= rows) { gameOver(); return; }
    const willGrow = food.x >= 0 && eq(nh, food);
    for (let i = 0; i < snake.length; i++) {
      if (!eq(snake[i], nh)) continue;
      if (!willGrow && i === snake.length - 1) continue;
      gameOver();
      return;
    }
    prev = snake.map((s) => ({ ...s }));
    snake.unshift(nh);
    if (willGrow) {
      score += 1;
      placeFood();
    } else {
      snake.pop();
    }
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function drawGrid() {
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = rgbaFromCss(palette.border, 0.3);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < cols; x++) {
      const px = Math.round(x * cell) + 0.5;
      ctx.moveTo(px, 0); ctx.lineTo(px, H);
    }
    for (let y = 1; y < rows; y++) {
      const py = Math.round(y * cell) + 0.5;
      ctx.moveTo(0, py); ctx.lineTo(W, py);
    }
    ctx.stroke();
  }

  function drawApple(cx, cy, r) {
    ctx.fillStyle = palette.appleRed;
    ctx.beginPath();
    ctx.arc(cx, cy + r * 0.05, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = palette.stem;
    ctx.lineWidth = Math.max(1.2, r * 0.18);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * 0.85);
    ctx.lineTo(cx + r * 0.18, cy - r * 1.25);
    ctx.stroke();
    ctx.fillStyle = palette.leafGreen;
    ctx.beginPath();
    ctx.ellipse(cx + r * 0.55, cy - r * 1.1, r * 0.45, r * 0.22, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = rgbaFromCss(palette.text, 0.35);
    ctx.beginPath();
    ctx.ellipse(cx - r * 0.35, cy - r * 0.25, r * 0.22, r * 0.12, -0.6, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Compute interpolated body points (cell coords -> pixels), one per segment.
   * Then build a smooth path through midpoints with quadratic curves and stroke
   * it as a thick rounded line. Head/tail are drawn separately on top.
   */
  function cellCenter(p) {
    return { x: (p.x + 0.5) * cell, y: (p.y + 0.5) * cell };
  }

  function lerp(a, b, t) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }

  function samplePolyline(points, dist) {
    let d = dist;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const seg = Math.hypot(dx, dy);
      if (seg < 1e-6) continue;
      if (d <= seg) {
        const t = d / seg;
        return { x: a.x + dx * t, y: a.y + dy * t };
      }
      d -= seg;
    }
    const last = points[points.length - 1] || { x: 0, y: 0 };
    return { x: last.x, y: last.y };
  }

  function getBodyPath(progress) {
    // Key idea: render every segment as a point sampled along ONE shared path:
    // head(t) -> prevHead -> prev[1] -> ... -> prevTail.
    // This removes index-based snapping on corners, which causes jitter.
    if (!snake.length) return [];
    const headPrev = prev[0] || snake[0];
    const headNow = snake[0];
    const headPos = lerp(cellCenter(headPrev), cellCenter(headNow), progress);

    const path = [headPos];
    for (let i = 0; i < prev.length; i++) path.push(cellCenter(prev[i]));
    return path;
  }

  function getBodyPoints(progress) {
    const path = getBodyPath(progress);
    const pts = [];
    for (let i = 0; i < snake.length; i++) {
      const p = samplePolyline(path, i * cell);
      pts.push({ x: snap05(p.x), y: snap05(p.y) });
    }
    return pts;
  }

  function pathLength(points) {
    let total = 0;
    for (let i = 0; i < points.length - 1; i++) {
      total += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    }
    return total;
  }

  function drawTubeFromPath(path, snakeLength, width, color) {
    if (path.length < 2 || snakeLength < 1) return;
    const total = Math.min(pathLength(path), Math.max(0, (snakeLength - 1) * cell));
    const step = Math.max(2, cell / 4);
    const pts = [];
    for (let d = 0; d <= total; d += step) {
      const p = samplePolyline(path, d);
      pts.push({ x: snap05(p.x), y: snap05(p.y) });
    }
    const tail = samplePolyline(path, total);
    pts.push({ x: snap05(tail.x), y: snap05(tail.y) });

    ctx.fillStyle = color;

    // Rectangular connectors between many close samples keep the tube continuous.
    const half = width / 2;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const nx = -dy / len * half;
      const ny = dx / len * half;
      ctx.beginPath();
      ctx.moveTo(a.x + nx, a.y + ny);
      ctx.lineTo(b.x + nx, b.y + ny);
      ctx.lineTo(b.x - nx, b.y - ny);
      ctx.lineTo(a.x - nx, a.y - ny);
      ctx.closePath();
      ctx.fill();
    }

    // Round caps / corners. Drawing circles at dense samples removes the corner jitter
    // without changing movement interpolation.
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, half, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function strokeTube(points, width, color) {
    if (points.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) {
      const mx = snap05((points[i].x + points[i + 1].x) / 2);
      const my = snap05((points[i].y + points[i + 1].y) / 2);
      ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }

  function drawHead(headPt, ang, sizeBase) {
    const r = sizeBase * 0.5;

    ctx.save();
    ctx.translate(headPt.x, headPt.y);
    ctx.rotate(ang);

    // Round head
    ctx.fillStyle = palette.accent;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    // Chomping mouth — wedge cut from front
    const chomp = (Math.sin(chompPhase) + 1) * 0.5; // 0..1
    const mouthOpen = 0.05 + 0.45 * chomp;
    ctx.fillStyle = palette.bg;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r * 1.02, -mouthOpen, mouthOpen, false);
    ctx.closePath();
    ctx.fill();

    // Eyes
    const eyeR = Math.max(1.5, r * 0.18);
    const pupilR = Math.max(1, eyeR * 0.55);
    const eyeOffsetX = r * 0.15;
    const eyeOffsetY = r * 0.45;
    for (const sy of [-1, 1]) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(eyeOffsetX, sy * eyeOffsetY, eyeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = palette.text3;
      ctx.beginPath();
      ctx.arc(eyeOffsetX + eyeR * 0.25, sy * eyeOffsetY, pupilR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawSnake(progress) {
    const pts = getBodyPoints(progress);
    const tubeW = Math.max(6, cell * 0.78);
    strokeTube(pts, tubeW, palette.accent);

    // Use direction interpolation for stable turning animation.
    const dx = prevDir.x + (dir.x - prevDir.x) * progress;
    const dy = prevDir.y + (dir.y - prevDir.y) * progress;
    const ang = Math.atan2(dy, dx);

    if (pts.length >= 1) {
      drawHead(pts[0], ang, tubeW);
    }
  }

  function drawScore() {
    const fs = Math.max(11, Math.round(cell * 0.85));
    ctx.fillStyle = palette.text;
    ctx.font = `600 ${fs}px var(--mono, JetBrains Mono), monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(String(score), 6, 4);
    ctx.textAlign = 'right';
    ctx.fillStyle = palette.text2;
    ctx.fillText(`★ ${best}`, W - 6, 4);
  }

  function drawCenter(lines, opts = {}) {
    ctx.fillStyle = rgbaFromCss(palette.bg, opts.alpha != null ? opts.alpha : 0.78);
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let y = H / 2 - (lines.length - 1) * 14;
    for (const ln of lines) {
      ctx.fillStyle = ln.color || palette.text;
      const fs = ln.size || Math.max(13, Math.round(cell * 0.95));
      ctx.font = `${ln.weight || 600} ${fs}px var(--sans, system-ui), sans-serif`;
      ctx.fillText(ln.text, W / 2, y);
      y += fs * 1.35;
    }
  }

  function drawScreenIdle() {
    drawCenter([
      { text: 'snake', size: Math.max(22, Math.round(cell * 1.6)), weight: 700, color: palette.accent },
      { text: 'arrow keys / WASD to move', color: palette.text2, size: Math.max(11, Math.round(cell * 0.7)) },
      { text: 'press space to start', color: palette.text, size: Math.max(11, Math.round(cell * 0.75)) },
    ]);
  }
  function drawScreenPaused() {
    drawCenter([
      { text: 'paused', size: Math.max(20, Math.round(cell * 1.4)), weight: 700, color: palette.accent },
      { text: 'press space to continue', color: palette.text, size: Math.max(11, Math.round(cell * 0.7)) },
    ]);
  }
  function drawScreenOver() {
    drawCenter([
      { text: 'game over', size: Math.max(20, Math.round(cell * 1.4)), weight: 700, color: palette.accent },
      { text: `score ${score}   best ${best}`, color: palette.text, size: Math.max(11, Math.round(cell * 0.75)) },
      { text: 'press space to restart', color: palette.text2, size: Math.max(11, Math.round(cell * 0.7)) },
    ]);
  }

  let rafId = 0;
  let simAlive = true;

  function frame(now) {
    if (!simAlive) return;

    if (state === 'play') {
      // Possibly multiple logic ticks if we lagged
      let safety = 0;
      while (state === 'play' && now - lastTick >= tickMs && safety < 4) {
        logicTick();
        lastTick += tickMs;
        safety += 1;
      }
      chompPhase += 0.18;
    }

    drawGrid();

    if (food.x >= 0) {
      const r = Math.max(3, cell * 0.36);
      drawApple(food.x * cell + cell / 2, food.y * cell + cell / 2, r);
    }

    let progress = 1;
    if (state === 'play') {
      progress = clamp((now - lastTick) / tickMs, 0, 1);
    }
    if (snake.length) drawSnake(progress);

    if (state === 'play' || state === 'paused' || state === 'over') drawScore();

    if (state === 'idle') drawScreenIdle();
    else if (state === 'paused') drawScreenPaused();
    else if (state === 'over') drawScreenOver();

    rafId = requestAnimationFrame(frame);
  }

  // ---- Input ----
  const KEYDIR = {
    ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 },
    ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
    KeyW: { x: 0, y: -1 }, KeyS: { x: 0, y: 1 },
    KeyA: { x: -1, y: 0 }, KeyD: { x: 1, y: 0 },
  };

  function focused() {
    return root.contains(document.activeElement) || hovering;
  }

  let hovering = false;
  const onEnter = () => { hovering = true; };
  const onLeave = () => { hovering = false; };
  root.addEventListener('mouseenter', onEnter);
  root.addEventListener('mouseleave', onLeave);

  const onKey = (e) => {
    if (!focused()) return;
    if (e.code === 'Space') {
      e.preventDefault(); e.stopPropagation();
      if (state === 'idle' || state === 'over') startGame();
      else if (state === 'play') state = 'paused';
      else if (state === 'paused') { state = 'play'; lastTick = performance.now(); }
      return;
    }
    const d = KEYDIR[e.code];
    if (!d) return;
    e.preventDefault(); e.stopPropagation();
    if (state === 'idle' || state === 'over') startGame();
    queueDir(d);
  };
  window.addEventListener('keydown', onKey, true);

  // D-pad / clicks
  const PAD_DIR = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
  const onPad = (e) => {
    const btn = e.target.closest?.('button[data-dir]');
    if (!btn) return;
    e.preventDefault();
    const d = PAD_DIR[btn.dataset.dir];
    if (!d) return;
    if (state === 'idle' || state === 'over') startGame();
    queueDir(d);
  };
  if (dpad) {
    dpad.addEventListener('click', onPad);
    dpad.addEventListener('touchstart', onPad, { passive: false });
  }

  const onCanvasClick = () => {
    root.focus({ preventScroll: true });
    if (state === 'idle' || state === 'over') startGame();
    else if (state === 'play') state = 'paused';
    else if (state === 'paused') { state = 'play'; lastTick = performance.now(); }
  };
  canvas.addEventListener('click', onCanvasClick);

  // ---- Resize / theme ----
  const ro = new ResizeObserver(() => { setCanvasSize(); });
  ro.observe(stage);
  const onWinResize = () => { setCanvasSize(); };
  window.addEventListener('resize', onWinResize);

  const refreshPalette = () => { palette = readPalette(); };
  const themeUnsub = on(EVENTS.THEME_CHANGED, refreshPalette);
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const onMq = () => refreshPalette();
  mq?.addEventListener?.('change', onMq);

  // ---- Init ----
  setCanvasSize();
  resetGame();
  state = 'idle';
  rafId = requestAnimationFrame(frame);

  return {
    destroy() {
      simAlive = false;
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onWinResize);
      window.removeEventListener('keydown', onKey, true);
      root.removeEventListener('mouseenter', onEnter);
      root.removeEventListener('mouseleave', onLeave);
      canvas.removeEventListener('click', onCanvasClick);
      mq?.removeEventListener?.('change', onMq);
      try { themeUnsub?.(); } catch (e) { /* noop */ }
      ro.disconnect();
      if (dpad) {
        dpad.removeEventListener('click', onPad);
        dpad.removeEventListener('touchstart', onPad);
      }
      root.innerHTML = '';
    },
  };
}

if (typeof window !== 'undefined') {
  window.SnakeGame = SnakeGame;
}

export function initSnakeGame() {
  SnakeGame.mount('snakeGameRoot');
}

export default SnakeGame;
