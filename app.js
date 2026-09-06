// Состояние и UI приложения: альбом в одном окне, рамка кадрирования, сохранение "на месте".

const PREVIEW_MAX = 1000;
const THUMB_MAX = 200;
const HANDLE_VISUAL_CSS = 8; // видимый радиус ручки на экране (в CSS-пикселях, не в пикселях канваса)
const HANDLE_HIT_CSS = 20; // радиус захвата ручки на экране — больше видимого, чтобы легче попадать
const ASPECT_PRESETS = [
  { key: "9x16", w: 9, h: 16 },
  { key: "4x5", w: 4, h: 5 },
  { key: "1x1", w: 1, h: 1 },
  { key: "4x3", w: 4, h: 3 },
  { key: "16x9", w: 16, h: 9 },
];
const ASPECT_STORAGE_KEY = "cropAspect";
const ORIGINALS_DIR = ".Originals";
const ALBUM_SUFFIX = "-Albom";

const COLOR_VARIANTS = [
  { key: "original", label: "Оригинал", clipPercent: 0, saturationBoost: 1, warm: 0 },
  { key: "auto", label: "Авто", clipPercent: 0.005, saturationBoost: 1.15, warm: 0 },
  { key: "contrast", label: "Контраст+", clipPercent: 0.02, saturationBoost: 1.15, warm: 0 },
  { key: "bw", label: "Ч/Б", clipPercent: 0.005, saturationBoost: 0, warm: 0 },
  { key: "warm", label: "Тепло", clipPercent: 0.005, saturationBoost: 1.15, warm: 12 },
];

const el = (id) => document.getElementById(id);

const State = {
  rootHandle: null, // верхняя папка, выбранная через "Открыть альбом" — корень дерева слева
  folderParents: new Map(), // handle подпапки -> handle родителя, для кнопки "уровень выше"
  folderRows: new Map(), // handle -> DOM-строка в дереве, для подсветки при навигации вверх
  albumHandle: null,
  originalsHandle: null, // создаётся лениво, только при первом сохранении
  curatedHandle: null, // папка "<альбом>-Albom" — создаётся лениво при первой звёздочке/сохранении
  queue: [], // [{name, handle, edited, starred, thumbUrl}]
  index: -1,
  fullBitmap: null,
  previewBitmap: null,
  previewW: 0,
  previewH: 0,
  rotationDeg: 0,
  cropRect: null, // {x,y,w,h} в координатах preview-канваса
  verticals: [],
  dragMode: null, // 'move' | 'resize' | 'perspective-corner'
  dragCorner: null, // 0..3
  dragStart: null,
  dirty: false, // есть несохранённые правки текущего фото
  showGrid: false,
  aspect: ASPECT_PRESETS[0], // формат кадра — выбирается один раз и запоминается между фото/сессиями
  perspectiveMode: false,
  perspectiveQuad: null, // [{x,y}×4] TL,TR,BR,BL в координатах preview-канваса
  colorVariant: COLOR_VARIANTS[1],
  colorPickerActive: false,
};

const canvas = () => el("photo-canvas");
const ctx = () => canvas().getContext("2d");

function setStatus(id, text) {
  el(id).textContent = text;
}

async function pickAlbum() {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch (e) {
    if (e.name !== "AbortError") setStatus("status-bar", "Не удалось выбрать папку: " + e.message);
    return;
  }
  State.rootHandle = null; // новый ручной выбор — новый корень дерева слева
  await openAlbum(handle);
}

async function openAlbum(handle) {
  State.albumHandle = handle;
  State.originalsHandle = null;
  State.curatedHandle = null;
  el("refresh-album-btn").hidden = false;
  el("continue-album-btn").hidden = true;

  if (!State.rootHandle) {
    State.rootHandle = handle;
    buildFolderTree(handle).catch((e) => console.error("Ошибка построения дерева папок", e));
  }
  el("up-dir-btn").disabled = !State.folderParents.has(handle);

  await scanFiles();
  if (State.queue.length === 0) {
    setStatus("status-bar", "В этой папке нет фото (jpg/png). Выберите папку слева.");
    el("album-grid").innerHTML = "";
    clearPropertiesPanel();
    State.index = -1;
    setPhotoControlsEnabled(false);
    return;
  }

  buildGrid();
  generateThumbnails();
  setPhotoControlsEnabled(true);
  State.index = -1;
  await selectPhoto(0);

  try {
    await idbSet("lastAlbum", handle);
  } catch (_) {
    // хранение хендла — необязательная удобная фича, не должна ломать открытие альбома
  }
}

function setPhotoControlsEnabled(enabled) {
  ["reset-btn", "star-btn", "prev-btn", "next-btn", "save-btn", "rotate-slider", "rotate-toggle-btn", "grid-btn", "perspective-btn", "color-btn", "aspect-select"].forEach((id) => {
    el(id).disabled = !enabled;
  });
}

// временно блокирует остальные элементы управления, пока открыт подбор цветовых вариантов
function freezeEditingControls(frozen) {
  ["reset-btn", "star-btn", "prev-btn", "next-btn", "save-btn", "rotate-slider", "rotate-toggle-btn", "grid-btn", "perspective-btn", "aspect-select"].forEach((id) => {
    el(id).disabled = frozen;
  });
  if (!frozen && State.index >= 0) {
    el("restore-btn").disabled = !State.queue[State.index].edited;
  } else {
    el("restore-btn").disabled = true;
  }
}

// подпапки текущей папки для дерева слева — служебные ".Originals" и "*-Albom" в дереве не нужны
async function listSubdirectories(dirHandle) {
  const dirs = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind === "directory" && entry.name !== ORIGINALS_DIR && !entry.name.endsWith(ALBUM_SUFFIX)) {
      dirs.push(entry);
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  return dirs;
}

async function createFolderNode(handle, opts = {}) {
  const li = document.createElement("li");
  li.className = "folder-node";

  const row = document.createElement("div");
  row.className = "folder-node-row";

  const toggle = document.createElement("span");
  toggle.className = "folder-toggle";

  const name = document.createElement("span");
  name.className = "folder-name";
  name.textContent = handle.name;
  name.title = handle.name;

  row.appendChild(toggle);
  row.appendChild(name);
  li.appendChild(row);

  State.folderRows.set(handle, row);

  // сканируем подпапки сразу при создании узла, чтобы стрелка раскрытия
  // с самого начала показывала, есть ли вложенные папки, а не пропадала после клика
  const subdirs = await listSubdirectories(handle);
  for (const sub of subdirs) State.folderParents.set(sub, handle);
  toggle.textContent = subdirs.length ? "▸" : "";

  let childList = null;
  let loaded = false;

  async function loadChildren() {
    if (loaded || subdirs.length === 0) return;
    loaded = true;
    childList = document.createElement("ul");
    childList.className = "folder-tree-list";
    for (const sub of subdirs) {
      childList.appendChild(await createFolderNode(sub));
    }
    li.appendChild(childList);
    toggle.textContent = "▾";
  }

  toggle.addEventListener("click", async (evt) => {
    evt.stopPropagation();
    if (subdirs.length === 0) return;
    if (!loaded) {
      await loadChildren();
      return;
    }
    if (childList) {
      childList.hidden = !childList.hidden;
      toggle.textContent = childList.hidden ? "▸" : "▾";
    }
  });

  name.addEventListener("click", async () => {
    highlightFolderRow(row);
    await openAlbum(handle);
  });

  if (opts.expanded) await loadChildren();

  return li;
}

async function navigateUp() {
  const parent = State.folderParents.get(State.albumHandle);
  if (!parent) return;
  const row = State.folderRows.get(parent);
  if (row) highlightFolderRow(row);
  await openAlbum(parent);
}

function highlightFolderRow(row) {
  el("folder-tree").querySelectorAll(".folder-node-row.active").forEach((r) => r.classList.remove("active"));
  row.classList.add("active");
}

async function buildFolderTree(rootHandle) {
  State.folderParents = new Map();
  State.folderRows = new Map();
  const container = el("folder-tree");
  container.innerHTML = "";
  const list = document.createElement("ul");
  list.className = "folder-tree-list";
  const rootLi = await createFolderNode(rootHandle, { expanded: true });
  list.appendChild(rootLi);
  container.appendChild(list);
  highlightFolderRow(rootLi.querySelector(".folder-node-row"));
}

// хранение хендла последней открытой папки в IndexedDB, чтобы при следующем запуске
// не заставлять заново выбирать альбом через системный диалог
const IDB_NAME = "photo-editor-db";
const IDB_STORE = "handles";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// при запуске пробуем открыть тот же альбом, что был в прошлый раз —
// если браузер уже дал разрешение, читаем сразу без диалога; иначе показываем
// кнопку "Продолжить: <папка>", так как повторный запрос доступа требует клика пользователя
async function tryRestoreLastAlbum() {
  let handle;
  try {
    handle = await idbGet("lastAlbum");
  } catch (_) {
    return;
  }
  if (!handle) return;

  let perm;
  try {
    perm = await handle.queryPermission({ mode: "readwrite" });
  } catch (_) {
    return; // хендл больше не валиден (папка удалена/переименована и т.п.)
  }

  if (perm === "granted") {
    State.rootHandle = null;
    await openAlbum(handle);
    return;
  }

  const btn = el("continue-album-btn");
  btn.title = "Продолжить: " + handle.name;
  btn.hidden = false;
  btn.onclick = async () => {
    try {
      const granted = await handle.requestPermission({ mode: "readwrite" });
      if (granted === "granted") {
        btn.hidden = true;
        State.rootHandle = null;
        await openAlbum(handle);
      } else {
        setStatus("status-bar", "Доступ к папке не разрешён.");
      }
    } catch (e) {
      setStatus("status-bar", "Не удалось открыть папку: " + e.message);
    }
  };
}

async function refreshAlbum() {
  if (!State.albumHandle) return;
  const currentName = State.index >= 0 ? State.queue[State.index].name : null;

  await scanFiles();
  if (State.queue.length === 0) {
    setStatus("status-bar", "В этой папке нет фото (jpg/png).");
    el("album-grid").innerHTML = "";
    clearPropertiesPanel();
    State.index = -1;
    setPhotoControlsEnabled(false);
    return;
  }

  buildGrid();
  generateThumbnails();
  setPhotoControlsEnabled(true);
  const idx = currentName ? State.queue.findIndex((q) => q.name === currentName) : -1;
  State.index = -1;
  await selectPhoto(idx >= 0 ? idx : 0);
}

async function scanFiles() {
  setStatus("status-bar", "Сканирую альбом...");
  const imageRe = /\.(jpe?g|png)$/i;
  const files = [];
  for await (const entry of State.albumHandle.values()) {
    if (entry.kind === "file" && imageRe.test(entry.name)) files.push(entry);
  }
  files.sort((a, b) => a.name.localeCompare(b.name));

  let originalsHandle = null;
  const backupNames = new Set();
  try {
    originalsHandle = await State.albumHandle.getDirectoryHandle(ORIGINALS_DIR);
    for await (const entry of originalsHandle.values()) {
      if (entry.kind === "file") backupNames.add(entry.name);
    }
  } catch (_) {
    // подпапки .Originals ещё нет — значит ничего не редактировали
  }

  const curatedNames = new Set();
  try {
    const curatedHandle = await State.albumHandle.getDirectoryHandle(State.albumHandle.name + ALBUM_SUFFIX);
    for await (const entry of curatedHandle.values()) {
      if (entry.kind === "file") curatedNames.add(entry.name);
    }
  } catch (_) {
    // папки "-Albom" ещё нет — значит ничего не отмечали звёздочкой
  }

  State.queue = [];
  for (const handle of files) {
    const edited = backupNames.has(handle.name)
      ? await isDifferentFromBackup(handle, originalsHandle, handle.name)
      : false;
    State.queue.push({ name: handle.name, handle, edited, starred: curatedNames.has(handle.name), thumbUrl: null });
  }
  setStatus("status-bar", `В альбоме ${State.queue.length} фото.`);
}

// "Отредактировано" значит не просто "есть файл с таким именем в .Originals",
// а именно "рабочий файл сейчас отличается от резервной копии по размеру" —
// иначе совпадение имён (например, IMG_0001.jpg с разных карт памяти) даст ложную галочку.
async function isDifferentFromBackup(workingHandle, originalsHandle, name) {
  try {
    const [workingFile, backupFile] = await Promise.all([
      workingHandle.getFile(),
      originalsHandle.getFileHandle(name).then((h) => h.getFile()),
    ]);
    return workingFile.size !== backupFile.size;
  } catch (_) {
    return false;
  }
}

function buildGrid() {
  const grid = el("album-grid");
  grid.innerHTML = "";
  State.queue.forEach((item, i) => {
    const btn = document.createElement("button");
    btn.className = "thumb";
    const img = document.createElement("img");
    img.alt = item.name;
    btn.appendChild(img);
    if (item.edited) btn.appendChild(makeEditedBadge());
    if (item.starred) btn.appendChild(makeStarBadge());
    btn.addEventListener("click", () => goToPhoto(i));
    grid.appendChild(btn);
  });
}

function makeEditedBadge() {
  const badge = document.createElement("span");
  badge.className = "edited-badge";
  const img = document.createElement("img");
  img.src = "icons/OK BLU.png";
  img.alt = "";
  badge.appendChild(img);
  return badge;
}

function makeStarBadge() {
  const badge = document.createElement("span");
  badge.className = "star-badge";
  const img = document.createElement("img");
  img.src = "icons/Star YLW.png";
  img.alt = "";
  badge.appendChild(img);
  return badge;
}

function updateThumbImg(i) {
  const btn = el("album-grid").children[i];
  const img = btn && btn.querySelector("img");
  if (img && State.queue[i].thumbUrl) img.src = State.queue[i].thumbUrl;
}

function updateThumbBadge(i) {
  const btn = el("album-grid").children[i];
  if (!btn) return;
  const existing = btn.querySelector(".edited-badge");
  if (State.queue[i].edited && !existing) {
    btn.appendChild(makeEditedBadge());
  } else if (!State.queue[i].edited && existing) {
    existing.remove();
  }
}

function updateThumbStar(i) {
  const btn = el("album-grid").children[i];
  if (!btn) return;
  const existing = btn.querySelector(".star-badge");
  if (State.queue[i].starred && !existing) {
    btn.appendChild(makeStarBadge());
  } else if (!State.queue[i].starred && existing) {
    existing.remove();
  }
}

function updateStarButton(item) {
  const btn = el("star-btn");
  btn.classList.toggle("active", item.starred);
  btn.title = item.starred ? "В альбоме (нажмите, чтобы убрать)" : "Добавить в альбом";
}

function highlightActiveThumb() {
  const grid = el("album-grid");
  [...grid.children].forEach((c, i) => c.classList.toggle("active", i === State.index));
}

async function regenerateThumbFromFile(item, fileOrBlob) {
  const bitmap = await createImageBitmap(fileOrBlob, { imageOrientation: "from-image" });
  const scale = Math.min(1, THUMB_MAX / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise((resolve) => c.toBlob(resolve, "image/jpeg", 0.7));
  if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
  item.thumbUrl = URL.createObjectURL(blob);
}

async function generateThumbnails() {
  for (let i = 0; i < State.queue.length; i++) {
    const item = State.queue[i];
    try {
      const file = await item.handle.getFile();
      await regenerateThumbFromFile(item, file);
      updateThumbImg(i);
    } catch (e) {
      // пропускаем неудачную миниатюру, не прерывая остальные
    }
  }
}

async function selectPhoto(i) {
  if (i < 0 || i >= State.queue.length) return;
  State.index = i;
  State.colorVariant = COLOR_VARIANTS[1];
  highlightActiveThumb();
  const item = State.queue[i];
  el("progress-label").textContent = `${i + 1} / ${State.queue.length}`;
  el("restore-btn").disabled = !item.edited;
  updateStarButton(item);
  await loadPhoto(item);
}

// переход между фото с проверкой несохранённых правок — предлагает сохранить перед уходом
async function goToPhoto(i) {
  if (i < 0 || i >= State.queue.length || i === State.index) return;
  if (State.dirty) {
    const name = State.queue[State.index].name;
    if (confirm(`Сохранить изменения в «${name}» перед переходом?`)) {
      await saveCurrent();
    }
  }
  await selectPhoto(i);
}

function prevPhoto() {
  goToPhoto(State.index - 1);
}

function nextPhoto() {
  goToPhoto(State.index + 1);
}

async function loadPhoto(item) {
  const file = await item.handle.getFile();
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  State.fullBitmap = bitmap;
  renderPropertiesPanel(item, file, bitmap);

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
  if (State.rotationDeg !== 0) State.showGrid = true;
  el("grid-btn").classList.toggle("active", State.showGrid);

  State.perspectiveMode = false;
  State.perspectiveQuad = null;
  el("perspective-btn").classList.remove("active");

  resetCropRect();
  State.dirty = false;
  render();
}

async function renderPropertiesPanel(item, file, bitmap) {
  const list = el("properties-list");
  list.innerHTML = "";

  const addRow = (label, value) => {
    if (!value) return;
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    list.appendChild(dt);
    list.appendChild(dd);
  };

  let exif = null;
  try {
    exif = readExif(await file.arrayBuffer());
  } catch (_) {
    // повреждённый/нестандартный EXIF — просто не показываем эти поля
  }

  addRow("Файл", item.name);
  addRow("Размер", formatFileSize(file.size));
  addRow("Разрешение", `${bitmap.width} × ${bitmap.height}`);
  addRow("Дата съёмки", formatExifDate(exif && exif.dateTaken) || formatFileDate(file.lastModified));
  addRow("Камера", [exif && exif.make, exif && exif.model].filter(Boolean).join(" "));

  const mapWrap = el("properties-map");
  const mapFrame = el("properties-map-frame");
  if (exif && exif.lat != null && exif.lon != null) {
    const d = 0.01;
    const bbox = [exif.lon - d, exif.lat - d, exif.lon + d, exif.lat + d].join("%2C");
    mapFrame.src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&marker=${exif.lat}%2C${exif.lon}`;
    mapWrap.hidden = false;
  } else {
    mapFrame.src = "";
    mapWrap.hidden = true;
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " Б";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " КБ";
  return (bytes / (1024 * 1024)).toFixed(2) + " МБ";
}

// формат EXIF-даты: "YYYY:MM:DD HH:MM:SS"
function formatExifDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return s;
  const [, y, mo, d, h, mi] = m;
  return `${d}.${mo}.${y} ${h}:${mi}`;
}

function formatFileDate(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString("ru-RU") + " " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function clearPropertiesPanel() {
  el("properties-list").innerHTML = "";
  el("properties-map-frame").src = "";
  el("properties-map").hidden = true;
}

function resetCropRect() {
  // размеры именно новой картинки, а не то что осталось на canvas от предыдущего кадра
  State.cropRect = rectForAspect(State.previewW, State.previewH, State.aspect.w, State.aspect.h);
}

// подстраховка: рамка кадрирования никогда не должна вылезать за пределы канваса —
// иначе экспорт кропа рисует чёрные полосы там, где рамка выходит за пределы фото
function clampCropRectToCanvas(r, w, h) {
  r.w = Math.min(r.w, w);
  r.h = Math.min(r.h, h);
  r.x = clamp(r.x, 0, w - r.w);
  r.y = clamp(r.y, 0, h - r.h);
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

  if (State.perspectiveMode) {
    renderPerspectiveDarken(cctx, w, h);
  } else {
    renderCropDarken(cctx, w, h);
  }

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

  if (State.showGrid) renderGrid(cctx, w, h);

  if (State.perspectiveMode) {
    renderPerspectiveFrame(cctx);
  } else {
    renderCropFrame(cctx);
  }
}

function renderCropDarken(cctx, w, h) {
  cctx.fillStyle = "rgba(0,0,0,0.55)";
  const r = State.cropRect;
  cctx.fillRect(0, 0, w, r.y);
  cctx.fillRect(0, r.y + r.h, w, h - r.y - r.h);
  cctx.fillRect(0, r.y, r.x, r.h);
  cctx.fillRect(r.x + r.w, r.y, w - r.x - r.w, r.h);
}

function renderCropFrame(cctx) {
  const r = State.cropRect;
  cctx.strokeStyle = "#4da3ff";
  cctx.lineWidth = 2;
  cctx.strokeRect(r.x, r.y, r.w, r.h);

  // угловые ручки — размер в единицах канваса, но зависит от масштаба показа,
  // чтобы визуально оставаться постоянного размера на экране
  cctx.fillStyle = "#4da3ff";
  const handleVisualR = HANDLE_VISUAL_CSS * canvasScale();
  for (const [hx, hy] of cornerPoints(r)) {
    cctx.beginPath();
    cctx.arc(hx, hy, handleVisualR, 0, Math.PI * 2);
    cctx.fill();
  }
}

function renderPerspectiveDarken(cctx, w, h) {
  const q = State.perspectiveQuad;
  if (!q) return;
  cctx.save();
  cctx.fillStyle = "rgba(0,0,0,0.55)";
  cctx.beginPath();
  cctx.rect(0, 0, w, h);
  cctx.moveTo(q[0].x, q[0].y);
  cctx.lineTo(q[1].x, q[1].y);
  cctx.lineTo(q[2].x, q[2].y);
  cctx.lineTo(q[3].x, q[3].y);
  cctx.closePath();
  cctx.fill("evenodd");
  cctx.restore();
}

function renderPerspectiveFrame(cctx) {
  const q = State.perspectiveQuad;
  if (!q) return;
  cctx.strokeStyle = "#ffb020";
  cctx.lineWidth = 2;
  cctx.beginPath();
  cctx.moveTo(q[0].x, q[0].y);
  cctx.lineTo(q[1].x, q[1].y);
  cctx.lineTo(q[2].x, q[2].y);
  cctx.lineTo(q[3].x, q[3].y);
  cctx.closePath();
  cctx.stroke();

  cctx.fillStyle = "#ffb020";
  const handleVisualR = HANDLE_VISUAL_CSS * canvasScale();
  for (const pt of q) {
    cctx.beginPath();
    cctx.arc(pt.x, pt.y, handleVisualR, 0, Math.PI * 2);
    cctx.fill();
  }
}

function renderGrid(cctx, w, h) {
  cctx.save();
  cctx.strokeStyle = "rgba(255,255,255,0.5)";
  cctx.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    const x = (w * i) / 3;
    cctx.beginPath();
    cctx.moveTo(x, 0);
    cctx.lineTo(x, h);
    cctx.stroke();
    const y = (h * i) / 3;
    cctx.beginPath();
    cctx.moveTo(0, y);
    cctx.lineTo(w, y);
    cctx.stroke();
  }
  cctx.restore();
}

function canvasScale() {
  const c = canvas();
  const rect = c.getBoundingClientRect();
  if (!rect.width) return 1;
  return c.width / rect.width;
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

  if (State.perspectiveMode) {
    const quad = State.perspectiveQuad;
    if (!quad) return;
    for (let i = 0; i < quad.length; i++) {
      if (Math.hypot(p.x - quad[i].x, p.y - quad[i].y) <= HANDLE_HIT_CSS * canvasScale()) {
        State.dragMode = "perspective-corner";
        State.dragCorner = i;
        canvas().setPointerCapture(evt.pointerId);
        return;
      }
    }
    return; // в режиме перспективы двигаем только углы, без переноса всей рамки
  }

  const r = State.cropRect;
  const corners = cornerPoints(r);
  for (let i = 0; i < corners.length; i++) {
    const [hx, hy] = corners[i];
    if (Math.hypot(p.x - hx, p.y - hy) <= HANDLE_HIT_CSS * canvasScale()) {
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

  if (State.dragMode === "perspective-corner") {
    // угол коррекции перспективы не ограничиваем размером самого фото —
    // именно выход угла за пределы кадра и создаёт нужную деформацию (устранение перспективных искажений),
    // а не просто обрезку; единственная граница — сам канвас (обеспечена в canvasPointFromEvent)
    State.perspectiveQuad[State.dragCorner] = p;
    State.dirty = true;
    render();
    return;
  }

  const r = State.cropRect;

  if (State.dragMode === "move") {
    r.x = clamp(p.x - State.dragStart.x, 0, w - r.w);
    r.y = clamp(p.y - State.dragStart.y, 0, h - r.h);
  } else if (State.dragMode === "resize") {
    const anchorIdx = 3 - State.dragCorner; // противоположный угол
    const corners = cornerPoints(r);
    const anchor = { x: corners[anchorIdx][0], y: corners[anchorIdx][1] };
    const ratio = State.aspect.w / State.aspect.h;

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
  clampCropRectToCanvas(r, w, h);
  render();
}

function onPointerUp(evt) {
  if (State.dragMode === "move" || State.dragMode === "resize") {
    State.dirty = true;
  }
  State.dragMode = null;
  try { canvas().releasePointerCapture(evt.pointerId); } catch (_) {}
}

async function ensureOriginalsHandle() {
  if (!State.originalsHandle) {
    State.originalsHandle = await State.albumHandle.getDirectoryHandle(ORIGINALS_DIR, { create: true });
  }
  return State.originalsHandle;
}

async function ensureCuratedHandle() {
  if (!State.curatedHandle) {
    const folderName = State.albumHandle.name + ALBUM_SUFFIX;
    State.curatedHandle = await State.albumHandle.getDirectoryHandle(folderName, { create: true });
  }
  return State.curatedHandle;
}

async function syncCuratedCopy(item, fileOrBlob) {
  const curatedHandle = await ensureCuratedHandle();
  const destHandle = await curatedHandle.getFileHandle(item.name, { create: true });
  const w = await destHandle.createWritable();
  await w.write(fileOrBlob);
  await w.close();
}

async function toggleStar() {
  const item = State.queue[State.index];
  try {
    if (item.starred) {
      const curatedHandle = await ensureCuratedHandle();
      await curatedHandle.removeEntry(item.name);
      item.starred = false;
      setStatus("status-bar", "Убрано из альбома: " + item.name);
    } else {
      const file = await item.handle.getFile();
      await syncCuratedCopy(item, file);
      item.starred = true;
      setStatus("status-bar", "Добавлено в альбом: " + item.name);
    }
    updateThumbStar(State.index);
    updateStarButton(item);
  } catch (e) {
    console.error("Ошибка звезды", item.name, e);
    setStatus("status-bar", "Ошибка: " + e.message);
  }
}

async function saveCurrent() {
  const item = State.queue[State.index];
  setStatus("status-bar", "Сохраняю " + item.name + "...");

  try {
    const scale = State.fullBitmap.width / State.previewW;
    const colorOpts = {
      saturationBoost: State.colorVariant.saturationBoost,
      clipPercent: State.colorVariant.clipPercent,
      warm: State.colorVariant.warm,
    };

    const fullCanvas = document.createElement("canvas");
    const fullCtx = fullCanvas.getContext("2d");
    fullCtx.fillStyle = "#000";
    fullCanvas.width = State.fullBitmap.width;
    fullCanvas.height = State.fullBitmap.height;
    fullCtx.fillRect(0, 0, fullCanvas.width, fullCanvas.height);
    drawRotated(fullCtx, State.fullBitmap, State.rotationDeg);

    let outCanvas;
    if (State.perspectiveMode && State.perspectiveQuad) {
      setStatus("status-bar", "Обрабатываю перспективу " + item.name + "...");
      const fullQuad = State.perspectiveQuad.map((pt) => ({ x: pt.x * scale, y: pt.y * scale }));
      outCanvas = exportPerspectiveCrop(fullCanvas, fullQuad, State.aspect.w, State.aspect.h, colorOpts);
    } else {
      clampCropRectToCanvas(State.cropRect, State.previewW, State.previewH);
      const fullRect = {
        x: State.cropRect.x * scale,
        y: State.cropRect.y * scale,
        w: State.cropRect.w * scale,
        h: State.cropRect.h * scale,
      };
      outCanvas = exportCrop(fullCanvas, fullRect, colorOpts);
    }
    const blob = await new Promise((resolve) => outCanvas.toBlob(resolve, "image/jpeg", 0.92));

    const originalsHandle = await ensureOriginalsHandle();
    if (!item.edited) {
      // первое сохранение этого фото — уводим нетронутый оригинал в .Originals
      const originalFile = await item.handle.getFile();
      const backupHandle = await originalsHandle.getFileHandle(item.name, { create: true });
      const backupWritable = await backupHandle.createWritable();
      await backupWritable.write(originalFile);
      await backupWritable.close();
      await verifyWrittenSize(backupHandle, originalFile.size, "резервная копия " + item.name);
    }

    const writable = await item.handle.createWritable();
    await writable.write(blob);
    await writable.close();
    await verifyWrittenSize(item.handle, blob.size, item.name);

    item.edited = await isDifferentFromBackup(item.handle, originalsHandle, item.name);
    updateThumbBadge(State.index);
    el("restore-btn").disabled = !item.edited;

    // редактирование всегда автоматически добавляет фото в куррейтед-альбом (и держит копию там в актуальном виде)
    await syncCuratedCopy(item, blob);
    item.starred = true;
    updateThumbStar(State.index);
    updateStarButton(item);

    await regenerateThumbFromFile(item, blob);
    updateThumbImg(State.index);
    await loadPhoto(item); // подтягиваем в редактор реально сохранённый файл, а не только миниатюру

    setStatus("status-bar", "Сохранено: " + item.name);
  } catch (e) {
    console.error("Ошибка сохранения", item.name, e);
    setStatus("status-bar", "Ошибка сохранения " + item.name + ": " + e.message);
  }
}

async function verifyWrittenSize(fileHandle, expectedSize, label) {
  const writtenFile = await fileHandle.getFile();
  if (writtenFile.size !== expectedSize) {
    throw new Error(
      `после записи "${label}" размер файла не совпал (ожидался ${expectedSize} байт, на диске ${writtenFile.size} байт)`
    );
  }
}

async function restoreOriginal() {
  const item = State.queue[State.index];
  if (!item.edited) return;
  setStatus("status-bar", "Восстанавливаю оригинал " + item.name + "...");

  try {
    const originalsHandle = await ensureOriginalsHandle();
    const backupFile = await (await originalsHandle.getFileHandle(item.name)).getFile();

    const writable = await item.handle.createWritable();
    await writable.write(backupFile);
    await writable.close();
    await verifyWrittenSize(item.handle, backupFile.size, item.name);

    // бэкап больше не нужен — после удаления имя в .Originals однозначно означает "сейчас отредактировано"
    await originalsHandle.removeEntry(item.name);
    item.edited = false;
    updateThumbBadge(State.index);
    el("restore-btn").disabled = true;

    if (item.starred) {
      await syncCuratedCopy(item, backupFile);
    }

    await regenerateThumbFromFile(item, backupFile);
    updateThumbImg(State.index);
    await loadPhoto(item);

    setStatus("status-bar", "Оригинал восстановлен: " + item.name);
  } catch (e) {
    console.error("Ошибка восстановления", item.name, e);
    setStatus("status-bar", "Ошибка восстановления " + item.name + ": " + e.message);
  }
}

function resetFrame() {
  resetCropRect();
  State.dirty = true;
  render();
}

function onRotateInput(evt) {
  State.rotationDeg = parseFloat(evt.target.value);
  el("rotate-value").textContent = State.rotationDeg.toFixed(1) + "°";
  State.dirty = true;
  if (!State.showGrid) {
    State.showGrid = true;
    el("grid-btn").classList.add("active");
  }
  render();
}

// смена формата рамки — выбор запоминается (localStorage) и действует для всех фото альбома,
// пока пользователь не сменит его вручную ещё раз
function onAspectChange(evt) {
  const preset = ASPECT_PRESETS.find((p) => p.key === evt.target.value) || ASPECT_PRESETS[0];
  State.aspect = preset;
  localStorage.setItem(ASPECT_STORAGE_KEY, preset.key);
  resetCropRect();
  State.dirty = true;
  render();
}

function toggleGrid() {
  State.showGrid = !State.showGrid;
  el("grid-btn").classList.toggle("active", State.showGrid);
  render();
}

function togglePerspectiveMode() {
  State.perspectiveMode = !State.perspectiveMode;
  el("perspective-btn").classList.toggle("active", State.perspectiveMode);
  if (State.perspectiveMode && !State.perspectiveQuad) {
    const r = State.cropRect;
    State.perspectiveQuad = [
      { x: r.x, y: r.y },
      { x: r.x + r.w, y: r.y },
      { x: r.x + r.w, y: r.y + r.h },
      { x: r.x, y: r.y + r.h },
    ];
  }
  render();
}

// плоский (без рамки/затемнения) кроп текущего превью — основа для миниатюр цветовых вариантов
function getCroppedPreviewCanvas() {
  const tmp = document.createElement("canvas");
  tmp.width = State.previewW;
  tmp.height = State.previewH;
  drawRotated(tmp.getContext("2d"), State.previewBitmap, State.rotationDeg);

  const r = State.cropRect;
  const cropped = document.createElement("canvas");
  cropped.width = Math.max(1, Math.round(r.w));
  cropped.height = Math.max(1, Math.round(r.h));
  cropped.getContext("2d").drawImage(tmp, r.x, r.y, r.w, r.h, 0, 0, cropped.width, cropped.height);
  return cropped;
}

async function generateColorVariants() {
  const baseCanvas = getCroppedPreviewCanvas();
  const thumbW = 90;
  const thumbH = Math.max(1, Math.round((thumbW * baseCanvas.height) / baseCanvas.width));

  const variants = [];
  for (const preset of COLOR_VARIANTS) {
    const c = document.createElement("canvas");
    c.width = thumbW;
    c.height = thumbH;
    const cctx = c.getContext("2d");
    cctx.drawImage(baseCanvas, 0, 0, thumbW, thumbH);
    const imgData = cctx.getImageData(0, 0, thumbW, thumbH);
    if (preset.clipPercent > 0) autoContrast(imgData, preset.clipPercent);
    if (preset.saturationBoost !== 1) boostSaturation(imgData, preset.saturationBoost);
    if (preset.warm) applyWarmth(imgData, preset.warm);
    cctx.putImageData(imgData, 0, 0);
    const blob = await new Promise((resolve) => c.toBlob(resolve, "image/jpeg", 0.8));
    variants.push({ preset, url: URL.createObjectURL(blob) });
  }
  return variants;
}

async function showColorVariantPicker() {
  State.colorPickerActive = true;
  el("color-btn").classList.add("active");
  freezeEditingControls(true);

  const grid = el("album-grid");
  grid.innerHTML = "";
  const variants = await generateColorVariants();
  grid.innerHTML = "";
  variants.forEach(({ preset, url }) => {
    const btn = document.createElement("button");
    btn.className = "thumb variant-thumb";
    if (State.colorVariant.key === preset.key) btn.classList.add("active");
    btn.title = preset.label;

    const img = document.createElement("img");
    img.src = url;
    img.alt = preset.label;
    btn.appendChild(img);

    const label = document.createElement("span");
    label.className = "variant-label";
    label.textContent = preset.label;
    btn.appendChild(label);

    btn.addEventListener("click", () => selectColorVariant(preset));
    grid.appendChild(btn);
  });
}

function selectColorVariant(preset) {
  State.colorVariant = preset;
  State.dirty = true;
  exitColorVariantPicker();
}

function exitColorVariantPicker() {
  State.colorPickerActive = false;
  el("color-btn").classList.remove("active");
  freezeEditingControls(false);
  buildGrid();
  State.queue.forEach((_, i) => updateThumbImg(i));
  highlightActiveThumb();
}

function toggleColorPicker() {
  if (State.colorPickerActive) exitColorVariantPicker();
  else showColorVariantPicker();
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function round1(v) { return Math.round(v * 10) / 10; }

function openAboutModal() { el("about-modal").hidden = false; }
function closeAboutModal() { el("about-modal").hidden = true; }

// перетаскиваемая граница между панелями: sign=1, если targetEl — первая (левая/верхняя)
// панель у разделителя (растёт в сторону движения), sign=-1 — если вторая (растёт в обратную)
function makeResizable(resizerEl, targetEl, axis, opts = {}) {
  const min = opts.min ?? 0;
  const max = opts.max ?? Infinity;
  const sign = opts.sign ?? 1;
  const storageKey = opts.storageKey;
  const prop = axis === "x" ? "width" : "height";

  if (storageKey) {
    const saved = localStorage.getItem(storageKey);
    if (saved) targetEl.style[prop] = clamp(parseInt(saved, 10), min, max) + "px";
  }

  resizerEl.addEventListener("pointerdown", (evt) => {
    evt.preventDefault();
    resizerEl.setPointerCapture(evt.pointerId);
    resizerEl.classList.add("dragging");
    document.body.classList.add("resizing");
    const startPos = axis === "x" ? evt.clientX : evt.clientY;
    const rect = targetEl.getBoundingClientRect();
    const startSize = axis === "x" ? rect.width : rect.height;

    function onMove(e) {
      const pos = axis === "x" ? e.clientX : e.clientY;
      const newSize = clamp(startSize + sign * (pos - startPos), min, max);
      targetEl.style[prop] = newSize + "px";
    }
    function onUp() {
      resizerEl.classList.remove("dragging");
      document.body.classList.remove("resizing");
      resizerEl.removeEventListener("pointermove", onMove);
      resizerEl.removeEventListener("pointerup", onUp);
      if (storageKey) {
        localStorage.setItem(storageKey, Math.round(targetEl.getBoundingClientRect()[prop]));
      }
    }
    resizerEl.addEventListener("pointermove", onMove);
    resizerEl.addEventListener("pointerup", onUp);
  });
}

function init() {
  const savedAspectKey = localStorage.getItem(ASPECT_STORAGE_KEY);
  State.aspect = ASPECT_PRESETS.find((p) => p.key === savedAspectKey) || ASPECT_PRESETS[0];
  el("aspect-select").value = State.aspect.key;
  el("aspect-select").addEventListener("change", onAspectChange);

  el("settings-btn").addEventListener("click", openAboutModal);
  el("about-close-btn").addEventListener("click", closeAboutModal);
  el("about-modal").addEventListener("click", (evt) => {
    if (evt.target.id === "about-modal") closeAboutModal();
  });

  el("open-album-btn").addEventListener("click", pickAlbum);
  el("refresh-album-btn").addEventListener("click", refreshAlbum);
  el("up-dir-btn").addEventListener("click", navigateUp);

  el("rotate-slider").addEventListener("input", onRotateInput);
  el("rotate-toggle-btn").addEventListener("click", () => {
    el("rotate-slider").hidden = !el("rotate-slider").hidden;
  });
  el("rotate-value").addEventListener("click", () => {
    if (el("rotate-slider").disabled) return;
    el("rotate-slider").value = 0;
    onRotateInput({ target: el("rotate-slider") });
  });
  el("reset-btn").addEventListener("click", resetFrame);
  el("grid-btn").addEventListener("click", toggleGrid);
  el("perspective-btn").addEventListener("click", togglePerspectiveMode);
  el("color-btn").addEventListener("click", toggleColorPicker);
  el("restore-btn").addEventListener("click", restoreOriginal);
  el("star-btn").addEventListener("click", toggleStar);
  el("prev-btn").addEventListener("click", prevPhoto);
  el("next-btn").addEventListener("click", nextPhoto);
  el("save-btn").addEventListener("click", saveCurrent);

  makeResizable(el("resizer-vertical"), el("left-column"), "x", {
    sign: 1, storageKey: "folderTreeWidth",
  });
  makeResizable(el("resizer-properties"), el("folder-tree"), "y", {
    sign: 1, storageKey: "folderTreeHeight",
  });
  makeResizable(el("resizer-horizontal"), el("album-grid"), "y", {
    sign: -1, storageKey: "albumGridHeight",
  });

  const c = canvas();
  c.addEventListener("pointerdown", onPointerDown);
  c.addEventListener("pointermove", onPointerMove);
  c.addEventListener("pointerup", onPointerUp);
  c.addEventListener("pointercancel", onPointerUp);

  if (!window.showDirectoryPicker) {
    setStatus("status-bar", "Этот браузер не поддерживает File System Access API. Откройте страницу в Chrome или Edge.");
    el("open-album-btn").disabled = true;
    return;
  }

  tryRestoreLastAlbum();
}

init();
