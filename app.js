// Состояние и UI приложения: работа с папками, очередь фото, рамка кадрирования, сохранение.

const PREVIEW_MAX = 1000;
const HANDLE_R = 14;
const ASPECT = { w: 9, h: 16 };

const el = (id) => document.getElementById(id);

const State = {
  sourceHandle: null,
  outputHandle: null,
  outputName: "9x16",
  queue: [], // [{name, handle}]
  index: -1,
  fullBitmap: null,
  previewBitmap: null,
  previewW: 0,
  previewH: 0,
  rotationDeg: 0,
  cropRect: null, // {x,y,w,h} в координатах preview-канваса
  verticals: [],
  dragMode: null, // 'move' | 'resize'
  dragCorner: null, // 0..3
  dragStart: null,
};

const canvas = () => el("photo-canvas");
const ctx = () => canvas().getContext("2d");

function setStatus(id, text) {
  el(id).textContent = text;
}

async function pickSource() {
  try {
    State.sourceHandle = await window.showDirectoryPicker({ mode: "read" });
    el("source-label").textContent = State.sourceHandle.name;
    el("pick-output-btn").disabled = false;
  } catch (e) {
    if (e.name !== "AbortError") setStatus("setup-status", "Не удалось выбрать папку: " + e.message);
  }
}

async function pickOutput() {
  try {
    State.outputHandle = await State.sourceHandle.getDirectoryHandle(State.outputName, { create: true });
    el("output-label").textContent = State.sourceHandle.name + " / " + State.outputName;
    el("start-btn").disabled = false;
  } catch (e) {
    setStatus("setup-status", "Не удалось создать/открыть папку результата: " + e.message);
  }
}

async function scanFiles() {
  setStatus("setup-status", "Сканирую папку...");
  const imageRe = /\.(jpe?g|png)$/i;
  const all = [];
  for await (const entry of State.sourceHandle.values()) {
    if (entry.kind === "file" && imageRe.test(entry.name)) all.push(entry);
  }
  const remaining = [];
  for (const handle of all) {
    const done = await State.outputHandle.getFileHandle(handle.name).then(() => true).catch(() => false);
    if (!done) remaining.push({ name: handle.name, handle });
  }
  remaining.sort((a, b) => a.name.localeCompare(b.name));
  State.queue = remaining;
  setStatus("setup-status", `Найдено ${all.length} фото, осталось обработать: ${remaining.length}.`);
  return remaining.length > 0;
}

async function startEditing() {
  const hasWork = await scanFiles();
  if (!hasWork) {
    setStatus("setup-status", "Все фото в этой папке уже обработаны.");
    return;
  }
  el("setup-screen").hidden = true;
  el("editor-screen").hidden = false;
  State.index = -1;
  await nextPhoto();
}

async function loadPhoto(item) {
  const file = await item.handle.getFile();
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  State.fullBitmap = bitmap;

  const scale = Math.min(1, PREVIEW_MAX / Math.max(bitmap.width, bitmap.height));
  State.previewW = Math.round(bitmap.width * scale);
  State.previewH = Math.round(bitmap.height * scale);
  State.previewBitmap = await createImageBitmap(bitmap, {
    resizeWidth: State.previewW,
    resizeHeight: State.previewH,
    resizeQuality: "high",
  });

  const detectCanvas = document.createElement("canvas");
  detectCanvas.width = State.previewW;
  detectCanvas.height = State.previewH;
  detectCanvas.getContext("2d").drawImage(State.previewBitmap, 0, 0);
  const { horizonAngle, verticals } = detectLines(detectCanvas);

  State.rotationDeg = clamp(round1(horizonAngle), -15, 15);
  State.verticals = verticals;
  el("rotate-slider").value = State.rotationDeg;
  el("rotate-value").textContent = State.rotationDeg.toFixed(1) + "°";

  resetCropRect();
  render();
}

function resetCropRect() {
  const c = canvas();
  State.cropRect = rectForAspect(c.width || State.previewW, c.height || State.previewH, ASPECT.w, ASPECT.h);
}

async function nextPhoto() {
  State.index++;
  if (State.index >= State.queue.length) {
    setStatus("editor-status", "Готово — все фото обработаны.");
    el("progress-label").textContent = `${State.queue.length} / ${State.queue.length}`;
    ctx().clearRect(0, 0, canvas().width, canvas().height);
    return;
  }
  el("progress-label").textContent = `${State.index + 1} / ${State.queue.length}`;
  setStatus("editor-status", State.queue[State.index].name);
  await loadPhoto(State.queue[State.index]);
}

async function backPhoto() {
  if (State.index <= 0) return;
  State.index--;
  el("progress-label").textContent = `${State.index + 1} / ${State.queue.length}`;
  setStatus("editor-status", State.queue[State.index].name);
  await loadPhoto(State.queue[State.index]);
}

function rotatePoint(x, y, cx, cy, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const dx = x - cx, dy = y - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

function render() {
  const c = canvas();
  const cctx = ctx();
  const w = State.previewW, h = State.previewH;
  c.width = w;
  c.height = h;

  cctx.fillStyle = "#000";
  cctx.fillRect(0, 0, w, h);
  drawRotated(cctx, State.previewBitmap, State.rotationDeg);

  // затемнение вне рамки
  cctx.fillStyle = "rgba(0,0,0,0.55)";
  const r = State.cropRect;
  cctx.fillRect(0, 0, w, r.y);
  cctx.fillRect(0, r.y + r.h, w, h - r.y - r.h);
  cctx.fillRect(0, r.y, r.x, r.h);
  cctx.fillRect(r.x + r.w, r.y, w - r.x - r.w, r.h);

  // направляющие вертикали (перенесены в координаты повёрнутого фото)
  cctx.strokeStyle = "rgba(255,210,80,0.7)";
  cctx.lineWidth = 1.5;
  const cx = w / 2, cy = h / 2;
  for (const v of State.verticals) {
    const p1 = rotatePoint(v.x1, v.y1, cx, cy, State.rotationDeg);
    const p2 = rotatePoint(v.x2, v.y2, cx, cy, State.rotationDeg);
    cctx.beginPath();
    cctx.moveTo(p1.x, p1.y);
    cctx.lineTo(p2.x, p2.y);
    cctx.stroke();
  }

  // рамка
  cctx.strokeStyle = "#4da3ff";
  cctx.lineWidth = 2;
  cctx.strokeRect(r.x, r.y, r.w, r.h);

  // угловые ручки
  cctx.fillStyle = "#4da3ff";
  for (const [hx, hy] of cornerPoints(r)) {
    cctx.beginPath();
    cctx.arc(hx, hy, 7, 0, Math.PI * 2);
    cctx.fill();
  }
}

function cornerPoints(r) {
  return [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x, r.y + r.h],
    [r.x + r.w, r.y + r.h],
  ];
}

function canvasPointFromEvent(evt) {
  const c = canvas();
  const rect = c.getBoundingClientRect();
  const scaleX = c.width / rect.width;
  const scaleY = c.height / rect.height;
  return {
    x: clamp((evt.clientX - rect.left) * scaleX, 0, c.width),
    y: clamp((evt.clientY - rect.top) * scaleY, 0, c.height),
  };
}

function onPointerDown(evt) {
  const p = canvasPointFromEvent(evt);
  const r = State.cropRect;
  const corners = cornerPoints(r);
  for (let i = 0; i < corners.length; i++) {
    const [hx, hy] = corners[i];
    if (Math.hypot(p.x - hx, p.y - hy) <= HANDLE_R) {
      State.dragMode = "resize";
      State.dragCorner = i;
      canvas().setPointerCapture(evt.pointerId);
      return;
    }
  }
  if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) {
    State.dragMode = "move";
    State.dragStart = { x: p.x - r.x, y: p.y - r.h < 0 ? p.y - r.y : p.y - r.y };
    canvas().setPointerCapture(evt.pointerId);
  }
}

function onPointerMove(evt) {
  if (!State.dragMode) return;
  const p = canvasPointFromEvent(evt);
  const w = State.previewW, h = State.previewH;
  const r = State.cropRect;

  if (State.dragMode === "move") {
    r.x = clamp(p.x - State.dragStart.x, 0, w - r.w);
    r.y = clamp(p.y - State.dragStart.y, 0, h - r.h);
  } else if (State.dragMode === "resize") {
    const anchorIdx = 3 - State.dragCorner; // противоположный угол
    const corners = cornerPoints(r);
    const anchor = { x: corners[anchorIdx][0], y: corners[anchorIdx][1] };
    const ratio = ASPECT.w / ASPECT.h;

    const dx = p.x - anchor.x;
    const dy = p.y - anchor.y;
    const wFromDx = Math.abs(dx);
    const hFromDx = wFromDx / ratio;
    const hFromDy = Math.abs(dy);
    const wFromDy = hFromDy * ratio;

    let newW, newH;
    if (hFromDx <= Math.abs(dy) || dy === 0) {
      newW = wFromDx; newH = hFromDx;
    } else {
      newW = wFromDy; newH = hFromDy;
    }

    const signX = dx >= 0 ? 1 : -1;
    const signY = dy >= 0 ? 1 : -1;

    // не выходить за границы канваса
    const maxW = signX > 0 ? w - anchor.x : anchor.x;
    const maxH = signY > 0 ? h - anchor.y : anchor.y;
    if (newW > maxW) { newW = maxW; newH = newW / ratio; }
    if (newH > maxH) { newH = maxH; newW = newH * ratio; }
    if (newW < 30) { newW = 30; newH = newW / ratio; }

    r.w = newW; r.h = newH;
    r.x = signX > 0 ? anchor.x : anchor.x - newW;
    r.y = signY > 0 ? anchor.y : anchor.y - newH;
  }
  render();
}

function onPointerUp(evt) {
  State.dragMode = null;
  try { canvas().releasePointerCapture(evt.pointerId); } catch (_) {}
}

async function saveCurrent() {
  const item = State.queue[State.index];
  setStatus("editor-status", "Сохраняю " + item.name + "...");

  const scale = State.fullBitmap.width / State.previewW;
  const fullRect = {
    x: State.cropRect.x * scale,
    y: State.cropRect.y * scale,
    w: State.cropRect.w * scale,
    h: State.cropRect.h * scale,
  };

  const fullCanvas = document.createElement("canvas");
  const fullCtx = fullCanvas.getContext("2d");
  fullCtx.fillStyle = "#000";
  fullCanvas.width = State.fullBitmap.width;
  fullCanvas.height = State.fullBitmap.height;
  fullCtx.fillRect(0, 0, fullCanvas.width, fullCanvas.height);
  drawRotated(fullCtx, State.fullBitmap, State.rotationDeg);

  const outCanvas = exportCrop(fullCanvas, fullRect);
  const blob = await new Promise((resolve) => outCanvas.toBlob(resolve, "image/jpeg", 0.92));

  const fileHandle = await State.outputHandle.getFileHandle(item.name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();

  await nextPhoto();
}

async function skipCurrent() {
  await nextPhoto();
}

function resetFrame() {
  resetCropRect();
  render();
}

function onRotateInput(evt) {
  State.rotationDeg = parseFloat(evt.target.value);
  el("rotate-value").textContent = State.rotationDeg.toFixed(1) + "°";
  render();
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function round1(v) { return Math.round(v * 10) / 10; }

function init() {
  el("pick-source-btn").addEventListener("click", pickSource);
  el("pick-output-btn").addEventListener("click", pickOutput);
  el("start-btn").addEventListener("click", startEditing);

  el("rotate-slider").addEventListener("input", onRotateInput);
  el("reset-btn").addEventListener("click", resetFrame);
  el("back-btn").addEventListener("click", backPhoto);
  el("skip-btn").addEventListener("click", skipCurrent);
  el("save-btn").addEventListener("click", saveCurrent);

  const c = canvas();
  c.addEventListener("pointerdown", onPointerDown);
  c.addEventListener("pointermove", onPointerMove);
  c.addEventListener("pointerup", onPointerUp);
  c.addEventListener("pointercancel", onPointerUp);

  if (!window.showDirectoryPicker) {
    setStatus("setup-status", "Этот браузер не поддерживает File System Access API. Откройте страницу в Chrome или Edge.");
    el("pick-source-btn").disabled = true;
  }
}

init();
