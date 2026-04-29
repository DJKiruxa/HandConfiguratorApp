import { EVENTS, on } from './eventBus.js';

const BAUD_RATE = 9600;
const SEND_INTERVAL_MS = 60;
const FINGER_LABELS = ['большой', 'указат.', 'средний', 'безым.', 'мизинец'];

let port = null;
let writer = null;
let isConnected = false;
let isWriting = false;
let queuedAngle = null;
let lastSentAngle = null;
let lastSendAt = 0;
let selectedFinger = 0;
let sendTimer = 0;

const encoder = new TextEncoder();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// UI slider -100..100 -> Arduino angle 0..180.
// Если мотор едет наоборот, замени последнюю строку на: return 180 - angle;
function sliderValueToAngle(value) {
  const v = clamp(Number(value) || 0, -100, 100);
  const angle = Math.round(((v + 100) / 200) * 180);
  return angle;
}

function getSelectedFingerValue() {
  const input = document.getElementById(`f${selectedFinger}`);
  return Number(input?.value || 0);
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setConnectedUI(connected) {
  const btn = document.getElementById('arduinoConnectBtn');
  const stopBtn = document.getElementById('arduinoStopBtn');
  if (btn) btn.textContent = connected ? 'отключить' : 'подключить COM';
  if (stopBtn) stopBtn.disabled = !connected;
  setText(
    'arduinoStatus',
    connected
      ? `подключено · ${FINGER_LABELS[selectedFinger]}`
      : 'не подключено',
  );
}

async function writeLine(line) {
  if (!writer || !isConnected) return false;
  try {
    await writer.write(encoder.encode(line));
    return true;
  } catch (err) {
    console.warn('Arduino serial write error:', err);
    setText('arduinoStatus', 'ошибка записи');
    return false;
  }
}

async function flushQueuedAngle(force = false) {
  if (!writer || !isConnected || queuedAngle == null || isWriting) return;

  const now = performance.now();
  const wait = SEND_INTERVAL_MS - (now - lastSendAt);
  if (!force && wait > 0) {
    clearTimeout(sendTimer);
    sendTimer = window.setTimeout(() => flushQueuedAngle(true), wait);
    return;
  }

  const angle = queuedAngle;
  queuedAngle = null;

  // Не засыпаем Arduino одинаковыми числами.
  if (angle === lastSentAngle) return;

  isWriting = true;
  const ok = await writeLine(`${angle}\n`);
  isWriting = false;

  if (ok) {
    lastSentAngle = angle;
    lastSendAt = performance.now();
    setText('arduinoAngleOut', `${angle}°`);
    setText('arduinoStatus', `COM → ${angle}°`);
  }

  if (queuedAngle != null) {
    flushQueuedAngle();
  }
}

function sendAngle(angle, force = false) {
  queuedAngle = clamp(Math.round(Number(angle) || 0), 0, 180);
  flushQueuedAngle(force);
}

async function disconnectArduino() {
  clearTimeout(sendTimer);
  try {
    if (writer) {
      writer.releaseLock();
      writer = null;
    }
    if (port) {
      await port.close();
      port = null;
    }
  } catch (err) {
    console.warn('Arduino disconnect error:', err);
  }

  isConnected = false;
  queuedAngle = null;
  lastSentAngle = null;
  setConnectedUI(false);
}

async function connectArduino(toast) {
  if (!('serial' in navigator)) {
    toast?.('Web Serial не поддерживается. Открой в Chrome или Edge.', { type: 'error' });
    setText('arduinoStatus', 'нет Web Serial');
    return;
  }

  try {
    // Браузер покажет список портов. Выбери Arduino / COM.
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: BAUD_RATE });
    writer = port.writable.getWriter();
    isConnected = true;
    lastSentAngle = null;
    setConnectedUI(true);
    toast?.('Arduino подключена. Если порт COM занят - закрой Serial Monitor.', { type: 'success' });

    // Arduino часто перезагружается при открытии Serial.
    await sleep(1600);
    sendAngle(sliderValueToAngle(getSelectedFingerValue()), true);
  } catch (err) {
    console.warn('Arduino connect error:', err);
    setText('arduinoStatus', 'не удалось подключить');
    toast?.('Не удалось открыть COM. Закрой Serial Monitor / Arduino IDE и попробуй снова.', { type: 'error' });
    await disconnectArduino();
  }
}

export function initArduinoSerialBridge({ toast } = {}) {
  const select = document.getElementById('arduinoFingerSelect');
  const connectBtn = document.getElementById('arduinoConnectBtn');
  const stopBtn = document.getElementById('arduinoStopBtn');
  if (!select || !connectBtn) return;

  const savedFinger = Number(localStorage.getItem('arduino_finger_index') || 0);
  selectedFinger = clamp(Number.isFinite(savedFinger) ? savedFinger : 0, 0, 4);
  select.value = String(selectedFinger);
  setText('arduinoAngleOut', `${sliderValueToAngle(getSelectedFingerValue())}°`);
  setConnectedUI(false);

  if (!('serial' in navigator)) {
    connectBtn.disabled = true;
    setText('arduinoStatus', 'только Chrome/Edge + localhost');
    return;
  }

  select.addEventListener('change', () => {
    selectedFinger = clamp(Number(select.value) || 0, 0, 4);
    localStorage.setItem('arduino_finger_index', String(selectedFinger));
    setConnectedUI(isConnected);
    sendAngle(sliderValueToAngle(getSelectedFingerValue()), true);
  });

  connectBtn.addEventListener('click', async () => {
    if (isConnected) {
      await disconnectArduino();
      toast?.('Arduino отключена');
    } else {
      await connectArduino(toast);
    }
  });

  stopBtn?.addEventListener('click', async () => {
    // В Arduino-коде команда s = stop here and hold.
    await writeLine('s\n');
    toast?.('Arduino: stop/hold');
  });

  // Главная привязка: двигаешь выбранный палец -> в Arduino летит угол.
  on(EVENTS.FINGER_VALUE, ({ index, value, all } = {}) => {
    let v = value;
    if (Array.isArray(all)) {
      v = all[selectedFinger];
      index = selectedFinger;
    }
    if (Number(index) !== selectedFinger) return;

    const angle = sliderValueToAngle(v);
    setText('arduinoAngleOut', `${angle}°`);
    sendAngle(angle);
  });

  navigator.serial.addEventListener?.('disconnect', async () => {
    if (port) {
      await disconnectArduino();
      toast?.('Arduino отключилась', { type: 'warn' });
    }
  });
}
