// Состояние и UI приложения: альбом в одном окне, рамка кадрирования, сохранение "на месте".

const PREVIEW_MAX = 1000;
const THUMB_MAX = 200;
const HANDLE_VISUAL_CSS = 8; // видимый радиус ручки на экране (в CSS-пикселях, не в пикселях канваса)
const HANDLE_HIT_CSS = 20; // радиус захвата ручки на экране — больше видимого, чтобы легче попадать
const HANDLE_PAD = 24; // запас в px канваса вокруг предела перетаскивания угла перспективы, чтобы кружок ручки не обрезался ровно на границе
const ASPECT_PRESETS = [
  { key: "9x16", w: 9, h: 16 },
  { key: "4x5", w: 4, h: 5 },
  { key: "1x1", w: 1, h: 1 },
  { key: "4x3", w: 4, h: 3 },
  { key: "16x9", w: 16, h: 9 },
];
const ASPECT_STORAGE_KEY = "cropAspect";
const AUTO_HORIZON_STORAGE_KEY = "autoHorizonEnabled";
const PANEL_MODE_STORAGE_KEY = "albumPanelMode";
const FOLDER_SORT_STORAGE_KEY = "folderSortOrder";
// если детектор нашёл "уверенную" линию, но угол больше этого — почти наверняка за горизонт
// приняли что-то другое (кромку предмета, диагональ переднего плана), лучше пропустить как ошибку
const AUTO_HORIZON_MAX_ANGLE = 5;
const ORIGINALS_DIR = "[Originals]";
const ALBUM_SUFFIX = "-Albom";
const DELETED_DIR = "Deleted"; // общая для всего альбома корзина, лежит в State.rootHandle (не в каждой подпапке)

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
  folderRows: new Map(), // handle -> DOM-строка в дереве, для подсветки при навигации вверх
  folderParents: new Map(), // handle -> родительский handle, для построения именного пути к узлу
  folderExpanders: new Map(), // handle -> loadChildren() этого узла, чтобы дойти до вложенной папки программно
  folderChildren: new Map(), // handle -> актуальный список дочерних handle'ов узла после последней подгрузки
  folderSortMode: "date-desc", // "date-desc" | "date-asc" | "name-asc" | "name-desc" — см. folder-sort-select, listSubdirectories
  treeBuildPromise: null, // промис текущей buildFolderTree — чтобы дождаться дерева перед восстановлением фокуса
  treeGeneration: 0, // счётчик построений дерева — если пока строилось старое, запустили новое, старое не должно дописать свой корень поверх актуального
  albumsViewActive: false, // true — дерево слева сейчас заменено плоским списком готовых альбомов (см. toggleAlbumsView)
  albumGeneration: 0, // счётчик открытий альбома — чтобы фоновая генерация миниатюр прошлого альбома не писала в чужую сетку
  albumHandle: null,
  originalsHandle: null, // создаётся лениво, только при первом сохранении
  curatedHandle: null, // папка "<альбом>-Albom" — создаётся лениво при первой звёздочке/сохранении
  deletedHandle: null, // папка DELETED_DIR в «Папке альбомов» (State.rootHandle) — создаётся лениво при первом удалении
  curatedDirName: null, // реальное имя этой папки на диске (см. scanFiles — переживает переименование родителя)
  queue: [], // [{name, handle, edited, starred, thumbUrl}]
  index: -1,
  fullBitmap: null,
  previewBitmap: null,
  previewW: 0,
  previewH: 0,
  rotationDeg: 0,
  cropRect: null, // {x,y,w,h} в координатах preview-канваса
  dragMode: null, // 'move' | 'resize' | 'perspective-corner'
  dragCorner: null, // 0..3
  dragStart: null,
  // угол рамки обрезки (0..3, TL/TR/BR/BL), зафиксированный как неподвижный анкор на время
  // текущего перетаскивания угла перспективы — см. fitCropRectToAnchor
  perspectiveCropAnchor: null,
  // true, если на начало текущего перетаскивания угла перспективы рамка обрезки была в
  // положении "по умолчанию" (см. cropIsAtDefault) — тогда её не за что бережно держать, и
  // она вместо anchor-логики просто каждый кадр пересчитывается заново как максимально
  // вписанная (см. onPointerMove/perspective-corner) — иначе при освобождении места
  // перспективой рамка так и оставалась бы в старом, уже не максимальном размере
  perspectiveCropTrackMax: false,
  dirty: false, // есть несохранённые правки текущего фото
  exifDirty: false, // отдельно: правки метаданных (дата/производитель/гео) — не сбрасываются авто-пересчётом dirty по кадру/углу
  netQuarterTurns: 0, // сумма поворотов на 90° по модулю 4 — если пользователь повернул и вернул обратно, кадр не считается изменённым
  netFlipped: false, // то же самое для разворота по горизонтали
  showGrid: false,
  autoHorizonEnabled: true, // кнопка-переключатель "⚖" — подбирать ли угол горизонта автоматически; запоминается между сессиями
  aspect: ASPECT_PRESETS[0], // формат кадра — выбирается один раз и запоминается между фото/сессиями
  cropVisible: false, // рамка обрезки видна только когда явно включена кнопкой — не мешает смотреть фото
  perspectiveMode: false,
  perspectiveQuad: null, // [{x,y}×4] TL,TR,BR,BL в координатах preview-канваса
  colorVariant: COLOR_VARIANTS[1],
  colorPickerActive: false,
  currentGeo: null, // {lat, lon} текущего фото — для кнопки "Открыть карту"
  currentExif: null, // разобранный EXIF текущего фото — чтобы вернуть камеру/GPS в файл при сохранении
  mapWindow: null, // ссылка на открытое окно карты, чтобы обновлять его при смене фото
  globeWindow: null, // ссылка на открытое окно глобуса (globe.html), см. mapWindow
  globeAlbumMode: false, // globeWindow сейчас показывает карту фото альбома (нырнули жестом зума), а не сам глобус — см. refreshMaps()
  previewZoom: 1, // масштаб превью в canvas-wrap, меняется колесом мыши
  copyMode: false, // режим редактирования параметров: кнопки копирования + редактируемые поля
  updateGpsRow: null, // колбэк, которым клик по карте обновляет отображение строки GPS
  albumGeo: [], // [{lat,lon}|null, ...] — координаты всех фото альбома, параллельно State.queue
  albumsList: [], // снимок [{handle,name,path}] из findAlbumFolders — актуален, пока активен режим "Альбомы"
  albumsGeo: [], // [{lat,lon}|null, ...] параллельно albumsList — по одной метке на альбом, для глобуса всех альбомов
  albumsGeoGeneration: 0, // счётчик — фоновое сканирование геоданных прошлого списка альбомов не должно писать поверх нового
  rootAbsolutePath: null, // путь на диске к State.rootHandle — только для кнопки "открыть в Проводнике"
  musicFiles: [], // аудиофайлы из папки "Music" в корне дерева — фон для слайдшоу, необязательны
  musicRootHandle: null, // rootHandle, для которого уже просканирована папка "Music" — чтобы не пересканировать при каждом запуске слайдшоу
  loadGeneration: 0, // счётчик вызовов loadPhoto — чтобы отменённый в процессе (быстрое пролистывание) вызов не переписал состояние поверх уже открытого следующего фото
};

const canvas = () => el("photo-canvas");
const ctx = () => canvas().getContext("2d");

// задаёт видимый размер явными px (а не transform: scale от "auto"-размера) — только так
// CSS-переход у #photo-canvas умеет плавно анимировать смену размера между фото разной
// ориентации/пропорций, вместо мгновенного скачка
function setPreviewZoom(zoom) {
  State.previewZoom = Math.max(0.05, zoom);
  const c = canvas();
  const margin = perspectiveCanvasMargin(State.previewW, State.previewH);
  c.style.width = Math.round((State.previewW + margin.left + margin.right) * State.previewZoom) + "px";
  c.style.height = Math.round((State.previewH + margin.top + margin.bottom) * State.previewZoom) + "px";
}

// когда включён режим перспективы, вокруг фото резервируется отступ в canvas — иначе холсту
// физически негде нарисовать угол/линию, утянутые за пределы фото (см. onPointerMove, где
// сам угол разрешено тянуть на ту же величину). Отступ фиксирован (не зависит от текущих
// координат quad), чтобы не менять размер канваса на каждый pointermove во время перетаскивания.
function perspectiveCanvasMargin(w, h) {
  if (!State.perspectiveMode) return { left: 0, right: 0, top: 0, bottom: 0 };
  const marginX = w * 1.5 + HANDLE_PAD, marginY = h * 1.5 + HANDLE_PAD;
  return { left: marginX, right: marginX, top: marginY, bottom: marginY };
}

// растягивает фото на всё окно альбома (canvas-wrap) при открытии, без обрезки — масштаб
// считается заранее по известным размерам превью и контейнера, а не измерением текущего
// отображаемого canvas: так не бывает промежуточного кадра с "неправильным" размером,
// который мелькал бы при каждой смене фото
function fitPreviewToWindow() {
  applyFitToWindow();
  // на самый первый вызов после открытия альбома и на самый первый вход в fullscreen layout
  // иногда ещё не устоялся (панели/дерево слева, переход в fullscreen) — размеры canvas-wrap,
  // снятые синхронно прямо тут, могут быть ещё старыми. Следующие фото и следующие входы в
  // fullscreen уже не задевает: к тому моменту layout давно устоялся. Досчитываем ещё раз
  // кадром позже, когда браузер точно применил актуальный layout — если первый расчёт и так
  // был верным, это просто безобидный повтор
  requestAnimationFrame(applyFitToWindow);
}

// то же самое, но первый расчёт применяется без CSS-анимации — специально для смены самого
// фото (см. loadPhoto). У разных фото разные пропорции кадра, а transition: width/height
// анимирует их по отдельности: ширина и высота едут к новым значениям каждая сама по себе,
// и на середине перехода мелькают "неправильные" промежуточные пропорции — новое фото на
// долю секунды выглядит сплющенным в форму предыдущего кадра. Поэтому сама смена фото должна
// вставать сразу; для одного и того же фото (вход/выход из fullscreen, resize окна, зум
// колесом) пропорция не меняется — там ширина и высота едут синхронно, деформации не бывает,
// и такие изменения по-прежнему смягчает transition через обычный fitPreviewToWindow
function fitPreviewToWindowInstant() {
  const c = canvas();
  c.style.transition = "none";
  applyFitToWindow();
  void c.offsetHeight; // форсируем reflow, чтобы размер применился без анимации до возврата transition
  c.style.transition = "";
  // подстраховочный пересчёт кадром позже (см. fitPreviewToWindow) — это уже не смена фото,
  // а уточнение по устоявшемуся layout для того же фото, там анимация уместна
  requestAnimationFrame(applyFitToWindow);
}

function applyFitToWindow() {
  const wrap = el("canvas-wrap");
  if (!State.previewW || !State.previewH || wrap.clientWidth === 0 || wrap.clientHeight === 0) return;
  // масштаб считаем строго по размеру самого фото, а не по полному канвасу вместе с отступом
  // под ручки перспективы (см. perspectiveCanvasMargin) — иначе с включённым режимом
  // перспективы фото визуально резко уменьшалось бы, освобождая место под отступ, которым
  // реально пользуются только во время активного перетаскивания угла. Сам канвас в CSS всё
  // равно шире фото на этот отступ (см. setPreviewZoom) — лишнее просто уходит за край
  // canvas-wrap (overflow: hidden), как и раньше уходило любое фото шире доступного окна
  setPreviewZoom(Math.min(wrap.clientWidth / State.previewW, wrap.clientHeight / State.previewH));
}

function setStatus(id, text) {
  el(id).textContent = text;
}

// курсор-ожидание на время долгих операций с деревом папок (перестройка/раскрытие узла может
// пересканировать большую папку — см. listSubdirectories/folderNewestFileTime). Счётчик, а не
// просто add/remove класса — эти вызовы бывают вложенными/последовательными (expandTreeToPath
// раскрывает несколько узлов подряд), и снятие курсора одним из них не должно гасить его, пока
// другой ещё не закончил
let busyCursorDepth = 0;
function pushBusyCursor() {
  busyCursorDepth++;
  document.body.classList.add("busy-cursor");
}
function popBusyCursor() {
  busyCursorDepth = Math.max(0, busyCursorDepth - 1);
  if (busyCursorDepth === 0) document.body.classList.remove("busy-cursor");
}

async function pickAlbum() {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch (e) {
    if (e.name !== "AbortError") setStatus("status-bar", "Не удалось выбрать папку: " + e.message);
    return;
  }
  State.rootHandle = null; // новый ручной выбор — новый корень дерева слева и новая «Папка альбомов» (см. openAlbum)
  // путь до сфокусированного альбома сбрасываем именно здесь (а не в openAlbum) — там же
  // проходит и восстановление сессии при запуске, которое не должно затирать сохранённый путь
  try {
    await idbSet("lastFocusedPath", []);
  } catch (_) {
    // необязательная удобная фича
  }
  await openAlbum(handle);
  // приложение всегда открывается в режиме "Альбомы" — это не запоминаемая настройка, а
  // фиксированный старт (см. project_photo_editor_albom_redesign, пункт 5)
  if (!State.albumsViewActive) await toggleAlbumsView();
}

async function openAlbum(handle) {
  const generation = ++State.albumGeneration; // помечаем это открытие — если пока грузимся, откроют ещё один альбом, наш фон должен это заметить и остановиться
  State.albumHandle = handle;
  refreshAlbumsGlobe(); // если окно глобуса открыто — подсветить каплю только что открытого альбома
  State.originalsHandle = null;
  State.curatedHandle = null;
  State.curatedDirName = null; // реальное имя папки "-Albom" на диске — узнаём при сканировании
  el("continue-album-btn").hidden = true;

  if (!State.rootHandle) {
    State.rootHandle = handle;
    State.treeBuildPromise = buildFolderTree(handle, { silent: true }).catch((e) => console.error("Ошибка построения дерева папок", e));
    el("albums-list-btn").disabled = false;
    // запоминаем корень дерева — при следующем запуске дерево слева строится от этой же папки
    try {
      await idbSet("lastRoot", handle);
    } catch (_) {
      // хранение хендла — необязательная удобная фича, не должна ломать открытие альбома
    }
  }

  await scanFiles();
  State.albumGeo = new Array(State.queue.length).fill(null);
  if (State.queue.length === 0) {
    showEmptyAlbum();
    return;
  }

  buildGrid();
  generateThumbnails(generation);
  collectAlbumGeo(generation);
  setPhotoControlsEnabled(true);
  State.index = -1;
  await selectPhoto(0);
}

// папка пустая (первое открытие альбома без фото, либо после удаления последнего фото) —
// фото с прошлого альбома должно исчезнуть, а не остаться под заставкой; обнуляем канвас
// и битмапы так же, как они выглядят до первого открытия альбома
function showEmptyAlbum() {
  setStatus("status-bar", "В этой папке нет фото (jpg/png). Выберите папку слева.");
  el("album-grid").innerHTML = "";
  clearPropertiesPanel();
  State.index = -1;
  State.previewBitmap = null;
  State.displayBitmap = null;
  State.previewW = 0;
  State.previewH = 0;
  const c = canvas();
  c.width = 0;
  c.height = 0;
  setPhotoControlsEnabled(false);
}

function setPhotoControlsEnabled(enabled) {
  // "сохранить в альбом" — в общем списке: она не про наличие несохранённых правок, а просто
  // "отправить" текущее фото (оригинал или уже отредактированное) и его отметку "избранное" в
  // альбом, так что доступна всегда, пока вообще открыто какое-то фото
  ["reset-btn", "star-btn", "prev-btn", "next-btn", "slideshow-btn", "fullscreen-btn", "rotate-slider", "rotate-toggle-btn", "auto-horizon-btn", "rotate-left-btn", "rotate-right-btn", "flip-btn", "grid-btn", "perspective-btn", "color-btn", "aspect-select", "properties-edit-btn", "save-btn", "delete-btn"].forEach((id) => {
    el(id).disabled = !enabled;
  });
  // заставка с вращающимся лого — на пустом канвасе (ни одно фото ещё не открыто, либо
  // выбранная папка оказалась без фото); прячется, как только реально показано первое фото
  el("empty-splash").hidden = enabled;
}

// временно блокирует остальные элементы управления, пока открыт подбор цветовых вариантов
function freezeEditingControls(frozen) {
  ["reset-btn", "star-btn", "prev-btn", "next-btn", "slideshow-btn", "fullscreen-btn", "rotate-slider", "rotate-toggle-btn", "auto-horizon-btn", "rotate-left-btn", "rotate-right-btn", "flip-btn", "grid-btn", "perspective-btn", "aspect-select", "save-btn", "delete-btn"].forEach((id) => {
    el(id).disabled = frozen;
  });
  if (!frozen && State.index >= 0) {
    el("restore-btn").disabled = !State.queue[State.index].edited;
  } else {
    el("restore-btn").disabled = true;
  }
}

// File System Access API не даёт дату изменения самой ПАПКИ (только у файлов через getFile()) —
// поэтому "дата папки" это дата самого свежего файла непосредственно внутри неё (без рекурсии
// в подпапки: сортировка вызывается на каждое раскрытие узла дерева, обход всего поддерева был
// бы слишком дорогим). Для обычной папки-альбома, где фото лежат прямо внутри, это и есть то,
// что пользователь интуитивно понимает под "когда это было". Папка без файлов напрямую (0) при
// сортировке "по дате" уходит в конец/начало — тай-брейк по имени ниже не даёт ей прыгать местами.
async function folderNewestFileTime(dirHandle) {
  let newest = 0;
  for await (const entry of dirHandle.values()) {
    if (entry.kind !== "file") continue;
    try {
      const file = await entry.getFile();
      if (file.lastModified > newest) newest = file.lastModified;
    } catch (_) {
      // файл мог исчезнуть между перечислением и чтением — пропускаем
    }
  }
  return newest;
}

// подпапки текущей папки для дерева слева — скрываем только служебную ORIGINALS_DIR;
// curated-подпапки "<имя>-Albom" в дереве не прячем — это тоже альбомы, их наличие должно быть видно.
// Порядок задаётся State.folderSortMode (см. folder-sort-select в тулбаре)
async function listSubdirectories(dirHandle) {
  const dirs = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind === "directory" && entry.name !== ORIGINALS_DIR) {
      dirs.push(entry);
    }
  }
  const mode = State.folderSortMode;
  if (mode === "date-desc" || mode === "date-asc") {
    const keyed = await Promise.all(dirs.map(async (d) => ({ d, t: await folderNewestFileTime(d) })));
    keyed.sort((a, b) => (a.t !== b.t ? (mode === "date-desc" ? b.t - a.t : a.t - b.t) : a.d.name.localeCompare(b.d.name)));
    return keyed.map((k) => k.d);
  }
  dirs.sort((a, b) => (mode === "name-desc" ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name)));
  return dirs;
}

// список всех папок "<...>-Albom" в дереве — на любой глубине, но не внутри уже найденной
// папки-альбома (см. комментарий у walk() ниже)
async function findAlbumFolders() {
  if (!State.rootHandle) return [];
  async function rawSubdirectories(dirHandle) {
    const dirs = [];
    for await (const entry of dirHandle.values()) {
      if (entry.kind === "directory" && entry.name !== ORIGINALS_DIR) dirs.push(entry);
    }
    return dirs;
  }
  const found = [];
  // папки-альбомы могут лежать на любой глубине дерева, но внутрь уже найденной
  // папки-альбома не заходим — вложенных альбомов в альбомах не бывает. Заодно, как и
  // обычное построение дерева, попутно заполняем State.folderParents по пройденным папкам —
  // без этого folderNamePath не смог бы достроить путь для найденных хендлов
  async function walk(dirHandle, path) {
    for (const h of await rawSubdirectories(dirHandle)) {
      State.folderParents.set(h, dirHandle);
      const childPath = [...path, h.name];
      if (h.name.endsWith(ALBUM_SUFFIX)) {
        found.push({ handle: h, name: h.name, path: childPath });
        continue;
      }
      await walk(h, childPath);
    }
  }
  await walk(State.rootHandle, []);
  // порядок подчиняется тому же State.folderSortMode, что и обычное дерево папок (folder-sort-select)
  const mode = State.folderSortMode;
  if (mode === "date-desc" || mode === "date-asc") {
    const keyed = await Promise.all(found.map(async (a) => ({ a, t: await folderNewestFileTime(a.handle) })));
    keyed.sort((x, y) => (x.t !== y.t ? (mode === "date-desc" ? y.t - x.t : x.t - y.t) : x.a.name.localeCompare(y.a.name)));
    return keyed.map((k) => k.a);
  }
  found.sort((a, b) => (mode === "name-desc" ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name)));
  return found;
}

// File System Access API не умеет переименовывать/перемещать ПАПКИ напрямую (FileSystemHandle.move()
// поддерживает только файлы) — поэтому "переименование" папки имитируется копированием всего
// содержимого под новым именем с последующим удалением оригинала (см. startFolderRename ниже)
async function copyDirectoryRecursive(srcDirHandle, destParentHandle, destName) {
  const destDirHandle = await destParentHandle.getDirectoryHandle(destName, { create: true });
  for await (const entry of srcDirHandle.values()) {
    if (entry.kind === "file") {
      const file = await entry.getFile();
      const destFileHandle = await destDirHandle.getFileHandle(entry.name, { create: true });
      const writable = await destFileHandle.createWritable();
      await writable.write(file);
      await writable.close();
    } else {
      await copyDirectoryRecursive(entry, destDirHandle, entry.name);
    }
  }
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

  if (opts.parent) State.folderParents.set(handle, opts.parent);
  State.folderRows.set(handle, row);

  let childList = null;
  let loaded = false;

  // содержимое узла подгружается лениво — только когда его раскрывают стрелкой (или это
  // корень дерева). Пересканирует подпапки заново при КАЖДОМ раскрытии (а не только при первом),
  // так что свежесозданные/удалённые/переименованные папки на диске подтягиваются каждый раз —
  // раньше при повторном раскрытии уже виденного узла просто показывался старый childList
  async function loadChildren() {
    pushBusyCursor();
    try {
      const subdirs = await listSubdirectories(handle);
      State.folderChildren.set(handle, subdirs);
      loaded = true;
      if (subdirs.length === 0) {
        // подпапки исчезли (были удалены/переименованы с прошлого раза) — прячем и стрелку, и
        // старый childList целиком, а не оставляем его висеть с уже не существующими записями
        toggle.textContent = "";
        if (childList) childList.hidden = true;
        return;
      }
      toggle.textContent = "▾";
      if (!childList) {
        childList = document.createElement("ul");
        childList.className = "folder-tree-list";
        li.appendChild(childList);
      }
      childList.innerHTML = "";
      childList.hidden = false;
      for (const sub of subdirs) {
        childList.appendChild(await createFolderNode(sub, { parent: handle }));
      }
    } finally {
      popBusyCursor();
    }
  }
  State.folderExpanders.set(handle, loadChildren);

  const initialSubdirs = await listSubdirectories(handle);
  toggle.textContent = initialSubdirs.length ? "▸" : "";

  toggle.addEventListener("click", async (evt) => {
    evt.stopPropagation();
    if (loaded && childList && !childList.hidden) {
      // уже раскрыт — просто сворачиваем; пересканировать диск имеет смысл только на раскрытие
      childList.hidden = true;
      toggle.textContent = "▸";
      return;
    }
    if (initialSubdirs.length === 0 && !loaded) return; // при создании узла подпапок не было и мы их ещё не проверяли повторно — реагировать не на что
    await loadChildren(); // раскрытие — всегда свежее пересканирование (см. loadChildren)
    // раскрытый список мог оказаться ниже видимой области дерева (особенно у последней папки,
    // рядом с растущей снизу панелью "Параметры") — довскроллить дерево так, чтобы весь новый
    // список стал виден целиком, а не только его верхушка
    if (childList && !childList.hidden) childList.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });

  // и открытие альбома по имени, и переименование папки по её имени — активируются одним и тем
  // же кликом по name, различаются только тем, была ли эта строка уже выбрана (см. ниже).
  // Порог между "это два клика подряд" (открыть в Проводнике / просто клик) и "это отдельный,
  // неспешный клик" (переименование) — не браузерный двойной клик (evt.detail), у него порог
  // завязан на системную скорость двойного клика и на глаз слишком короткий: чуть помедленнее
  // кликнешь — и вместо повторного открытия сразу улетаешь в переименование. Поэтому считаем
  // время между кликами сами.
  let lastNameClickAt = 0;
  name.addEventListener("click", async (evt) => {
    if (evt.detail > 1) return; // часть быстрого (настоящего) двойного клика — уйдёт в open-в-Проводнике, см. ниже
    const now = Date.now();
    const firstClickThisSession = lastNameClickAt === 0;
    const sincePrevClick = now - lastNameClickAt;
    lastNameClickAt = now;
    if (row.classList.contains("active")) {
      // самый первый клик по этой строке за сеанс (строка могла стать активной и без клика по
      // ней — например, фокус восстановился при старте) — это просто подтверждение фокуса, а
      // не жест переименования, даже если lastNameClickAt всё ещё 0 и формально "время с
      // прошлого клика" вышло бы огромным. Переименование — это именно ПОВТОРНЫЙ клик, и то
      // только в окне 1.5с-2с: быстрее — часть двойного клика (открытие в Проводнике), а
      // медленнее — окно уже закрылось, иначе абсолютно любой следующий клик по уже открытой
      // папке (даже через час) считался бы "повторным" и уводил в переименование
      if (firstClickThisSession || sincePrevClick < 1500 || sincePrevClick > 2000) return;
      startFolderRename();
      return;
    }
    highlightFolderRow(row);
    await loadChildren(); // всегда пересканируем — структура могла измениться с прошлого раза (а не только если !loaded)
    await openAlbum(handle);
    // путь запоминаем только по реальному клику в дереве — так восстановление фокуса
    // (которое само открывает альбомы программно) не перетирает его неполным путём
    try {
      await idbSet("lastFocusedPath", folderNamePath(handle));
    } catch (_) {
      // необязательная удобная фича
    }
  });

  // File System Access API нарочно не даёт узнать реальный путь папки на диске — поэтому
  // для открытия в Проводнике путь строится из имён (folderNamePath) поверх абсолютного пути
  // корня, который пользователя просят указать один раз (см. ensureRootAbsolutePath)
  row.addEventListener("dblclick", (evt) => {
    if (name.querySelector("input")) return; // идёт переименование — двойной клик тут для выделения слова в поле, не для Проводника
    evt.preventDefault();
    openFolderInExplorer(handle);
  });

  // переименование папки на диске — вход тем же кликом, что и открытие (см. name click выше),
  // если папка уже была выбрана. Использует FileSystemHandle.move() — переименование "на месте",
  // без пересоздания handle (тот же handle продолжает указывать на ту же папку под новым именем),
  // поэтому все Map'ы дерева (folderParents/folderRows/...), ключ которых — сам handle, остаются верны
  function startFolderRename() {
    if (name.querySelector("input")) return; // уже редактируем
    const originalName = handle.name;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "folder-rename-input";
    input.value = originalName;
    name.textContent = "";
    name.appendChild(input);
    input.focus();
    input.select();
    // клики/двойные клики внутри самого поля — это работа с текстом (выделение слова и т.п.),
    // а не новый жест выбора/открытия/переименования строки дерева
    input.addEventListener("click", (evt) => evt.stopPropagation());
    input.addEventListener("dblclick", (evt) => evt.stopPropagation());
    input.addEventListener("mousedown", (evt) => evt.stopPropagation());

    let settled = false;
    const finish = async (commit) => {
      if (settled) return;
      settled = true;
      const newName = input.value.trim();
      if (!commit || !newName || newName === originalName) {
        name.textContent = handle.name;
        name.title = handle.name;
        return;
      }
      const nativeMoveSupported = typeof handle.move === "function"; // браузеры пока не поддерживают move() для папок (только для файлов) — на практике всегда false для директорий, но проверяем на случай, если это изменится
      const parent = State.folderParents.get(handle);
      if (!nativeMoveSupported && !parent) {
        // это корень дерева: браузер не умеет переименовывать папки напрямую, а обходной путь
        // (скопировать содержимое под новым именем и удалить старую папку) требует доступа к
        // РОДИТЕЛЮ переименовываемой папки — а до родителя корня у File System Access API вообще
        // нет способа добраться (нет метода "подняться на уровень выше" от выданного handle'а)
        setStatus("status-bar", "Корневую папку дерева нельзя переименовать через приложение (нет доступа к папке-родителю). Переименуйте её в Проводнике Windows (двойной клик по строке откроет её там) и откройте альбом заново.");
        name.textContent = originalName;
        name.title = originalName;
        return;
      }
      try {
        let resultHandle = handle;
        if (nativeMoveSupported) {
          await handle.move(newName);
        } else {
          // обходной путь: скопировать всё содержимое папки под новым именем, затем удалить
          // оригинал. Если копирование прервётся ошибкой на середине — удаляем недоделанную
          // копию и не трогаем оригинал, чтобы не оставить папку-дубль с частью файлов
          setStatus("status-bar", `Переименование «${originalName}» → «${newName}»: копируем содержимое папки (браузер не умеет переименовывать папки напрямую)…`);
          try {
            await copyDirectoryRecursive(handle, parent, newName);
          } catch (copyErr) {
            try { await parent.removeEntry(newName, { recursive: true }); } catch (_) {}
            throw copyErr;
          }
          await parent.removeEntry(originalName, { recursive: true });
          // старый handle теперь указывает на удалённую папку — пересканируем родителя, чтобы
          // получить свежий handle новой папки и обновить весь поддерево в дереве слева
          const refresh = State.folderExpanders.get(parent);
          if (refresh) await refresh();
          const siblings = State.folderChildren.get(parent) || [];
          resultHandle = siblings.find((h) => h.name === newName) || null;
        }

        if (!resultHandle) {
          setStatus("status-bar", `Папка переименована в «${newName}», но не удалось обновить дерево слева — перезагрузите страницу.`);
          return;
        }

        if (nativeMoveSupported) {
          name.textContent = resultHandle.name;
          name.title = resultHandle.name;
        }
        const row = State.folderRows.get(resultHandle);
        if (row) highlightFolderRow(row);
        setStatus("status-bar", `Папка переименована: «${resultHandle.name}».`);

        // сохранённые пути/кэши хранят папку как handle или как путь имён — обновляем их на
        // случай, если переименовали корень дерева или сам текущий открытый альбом
        if (State.rootHandle === handle) {
          State.rootHandle = resultHandle;
          try { await idbSet("lastRoot", resultHandle); } catch (_) {}
        }
        if (State.albumHandle === handle) {
          try { await idbSet("lastFocusedPath", folderNamePath(resultHandle)); } catch (_) {}
          if (!nativeMoveSupported) await openAlbum(resultHandle); // старый handle недействителен — переоткрываем альбом на свежем
        }
      } catch (e) {
        name.textContent = originalName;
        name.title = originalName;
        setStatus("status-bar", "Не удалось переименовать папку: " + e.message);
      }
    };

    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") { evt.preventDefault(); finish(true); }
      else if (evt.key === "Escape") { evt.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  }

  if (opts.expanded) await loadChildren();

  return li;
}

// opts.center — только для восстановления фокуса при старте приложения (restoreFocusInTree):
// там строка ещё не была на экране, и её выгодно сразу поставить по центру дерева. При обычном
// клике мышью по строке (и вообще при любом другом вызове — переименование, смена сортировки)
// центрирование/подъём к верху ощущался как "строка убегает" из-под курсора: раньше тут всегда
// стояло block: "start", из-за чего только что кликнутая (уже видимая!) строка ещё и прыгала к
// верху дерева. block: "nearest" по умолчанию — трогает прокрутку, только если строка правда не
// видна, и никогда не дальше, чем нужно.
function highlightFolderRow(row, opts = {}) {
  el("folder-tree").querySelectorAll(".folder-node-row.active").forEach((r) => r.classList.remove("active"));
  row.classList.add("active");
  row.scrollIntoView({ block: opts.center ? "center" : "nearest", behavior: "smooth" });
}

// путь именами папок от корня дерева до данного (живого, из текущей сессии) handle'а —
// хранится и сравнивается по именам, а не по самому handle'у, так как handle'ы, прочитанные
// из IndexedDB отдельно, никогда не будут той же ссылкой, что и живые узлы дерева
function folderNamePath(handle) {
  const names = [];
  let current = handle;
  while (current && current !== State.rootHandle) {
    names.unshift(current.name);
    current = State.folderParents.get(current);
  }
  return names;
}

// File System Access API намеренно не отдаёт странице реальный путь папки на диске (это
// решение безопасности браузера, а не забытая фича) — поэтому единственный способ открыть
// Проводник на нужной папке это спросить у пользователя абсолютный путь к корню один раз
// и дальше достраивать его именами подпапок (folderNamePath). Запоминаем ответ в IndexedDB
// вместе с именем корня, чтобы при том же альбоме больше не спрашивать.
// подгружает путь, уже сохранённый в IndexedDB для этого же (по имени) корня — общая часть
// для ensureRootAbsolutePath (запрос при первом клике "Открыть в Проводнике") и для настроек
// (там путь нужно показать, даже если Проводник в этой сессии ещё ни разу не открывали)
async function loadSavedRootAbsolutePath() {
  if (State.rootAbsolutePath || !State.rootHandle) return State.rootAbsolutePath;
  try {
    const savedPath = await idbGet("rootAbsolutePath");
    const savedName = await idbGet("rootAbsolutePathName");
    if (savedPath && savedName === State.rootHandle.name) State.rootAbsolutePath = savedPath;
  } catch (_) {
    // необязательная удобная фича
  }
  return State.rootAbsolutePath;
}

async function ensureRootAbsolutePath() {
  if (await loadSavedRootAbsolutePath()) return State.rootAbsolutePath;
  const input = prompt(`Открытие в Проводнике: укажите полный путь на диске к папке "${State.rootHandle.name}" (спрашивается один раз для этой папки альбомов).`, "");
  if (!input) return null;
  State.rootAbsolutePath = input.replace(/[\\/]+$/, "");
  try {
    await idbSet("rootAbsolutePath", State.rootAbsolutePath);
    await idbSet("rootAbsolutePathName", State.rootHandle.name);
  } catch (_) {
    // необязательная удобная фича
  }
  return State.rootAbsolutePath;
}

async function openFolderInExplorer(handle) {
  const rootPath = await ensureRootAbsolutePath();
  if (!rootPath) return;
  const fullPath = [rootPath, ...folderNamePath(handle)].join("\\");
  try {
    const res = await fetch("/__open_in_explorer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fullPath }),
    });
    if (!res.ok) {
      // сохранённый абсолютный путь корня оказался неверным (папку переместили/переименовали
      // в реальном Проводнике, либо путь был введён с опечаткой при первом запросе) — забываем
      // его, чтобы при следующей попытке пользователя снова спросили путь, а не повторяли ту же
      // ошибку бесконечно
      State.rootAbsolutePath = null;
      try {
        await idbSet("rootAbsolutePath", null);
        await idbSet("rootAbsolutePathName", null);
      } catch (_) {
        // необязательная удобная фича
      }
      throw new Error(`путь не найден: "${fullPath}". Попробуйте ещё раз — сейчас переспросим путь заново.`);
    }
  } catch (e) {
    setStatus("status-bar", "Не удалось открыть Проводник: " + e.message);
  }
}

// идёт от корня вниз по именам папок, на каждом шаге дожидаясь подгрузки узла — так дерево
// визуально раскрывается до нужной папки, а на выходе получаем живой handle текущей сессии
async function expandTreeToPath(namesPath) {
  let current = State.rootHandle;
  for (const name of namesPath) {
    const expand = State.folderExpanders.get(current);
    if (!expand) break;
    await expand();
    const children = State.folderChildren.get(current) || [];
    const next = children.find((h) => h.name === name);
    if (!next) break;
    current = next;
  }
  return current;
}

async function buildFolderTree(rootHandle, opts = {}) {
  // silent: приложение всегда стартует в режиме Альбомы, поэтому первое построение дерева
  // (из openAlbum, для карт handle'ов на будущее) никогда не должно быть видно пользователю —
  // иначе перед автопереключением в Альбомы мелькает полный проводник (тот самый баг)
  const silent = !!opts.silent;
  if (!silent) el("folder-tree").innerHTML = "<p class=\"albums-list-empty\">Поиск…</p>";
  pushBusyCursor(); // построение дерева пересканирует диск (см. loadChildren) — в большой папке это заметно по времени
  try {
    const generation = ++State.treeGeneration;
    State.folderRows = new Map();
    State.folderParents = new Map();
    State.folderExpanders = new Map();
    State.folderChildren = new Map();
    const list = document.createElement("ul");
    list.className = "folder-tree-list";
    const rootLi = await createFolderNode(rootHandle, { expanded: true });
    if (generation !== State.treeGeneration) return; // альбом открыли повторно, пока строилось это дерево — устаревший результат не подменяет уже актуальное дерево
    list.appendChild(rootLi);
    if (silent) return;
    const container = el("folder-tree");
    container.innerHTML = "";
    container.appendChild(list);
    highlightFolderRow(rootLi.querySelector(".folder-node-row"));
  } finally {
    popBusyCursor();
  }
}

// хранение хендла последней открытой папки в IndexedDB, чтобы при следующем запуске
// не заставлять заново выбирать альбом через системный диалог
const IDB_NAME = "photo-editor-db";
const IDB_STORE = "handles";
const IDB_THUMB_STORE = "thumbnails"; // кэш готовых миниатюр — переживает перезапуск, не даёт перекодировать неизменившиеся фото заново

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      if (!db.objectStoreNames.contains(IDB_THUMB_STORE)) db.createObjectStore(IDB_THUMB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value, store = IDB_STORE) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key, store = IDB_STORE) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
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
    handle = await idbGet("lastRoot");
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
    await restoreFocusInTree();
    if (!State.albumsViewActive) await toggleAlbumsView();
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
        await restoreFocusInTree();
        if (!State.albumsViewActive) await toggleAlbumsView();
      } else {
        setStatus("status-bar", "Доступ к папке не разрешён.");
      }
    } catch (e) {
      setStatus("status-bar", "Не удалось открыть папку: " + e.message);
    }
  };
}

// дожидается построения дерева и раскрывает его вниз по сохранённому именному пути до
// последнего открытого альбома — раскрытый путь даёт живой handle текущей сессии, поэтому
// с ним можно и подсветить строку в дереве, и просто открыть альбом без отдельного
// запроса разрешения (это уже живой потомок корня, разрешение которого только что получено)
async function restoreFocusInTree() {
  try {
    await State.treeBuildPromise;
  } catch (_) {
    return;
  }
  let path;
  try {
    path = await idbGet("lastFocusedPath");
  } catch (_) {
    return;
  }
  if (!path || path.length === 0) return;

  const target = await expandTreeToPath(path);
  if (!target || target === State.rootHandle) return;

  const row = State.folderRows.get(target);
  // приложение только что открылось — строка ещё не была на экране, центрируем её в дереве
  // (в отличие от обычного клика мышью, см. комментарий у highlightFolderRow)
  if (row) highlightFolderRow(row, { center: true });
  await openAlbum(target);
}

async function scanFiles() {
  setStatus("status-bar", "Сканирую альбом...");
  const imageRe = /\.(jpe?g|png)$/i;
  let files = [];
  for await (const entry of State.albumHandle.values()) {
    if (entry.kind === "file" && imageRe.test(entry.name)) files.push(entry);
  }
  // порядок фото внутри альбома — всегда по имени, независимо от State.folderSortMode: тот
  // выбор влияет только на порядок папок в левой панели (дерево и список альбомов), листать
  // сами фото в другом порядке не нужно (обсуждали и вернули как было)
  files.sort((a, b) => a.name.localeCompare(b.name));

  // папку "-Albom" ищем не в открытой сейчас подпапке, а в папке альбома — прямом потомке
  // «Папки альбомов», содержащем текущую открытую подпапку (см. resolveAlbumFolder) — иначе у
  // альбома с камерами по разным подпапкам была бы своя "-Albom" на каждую подпапку; ищем по
  // факту наличия суффикса, а не по совпадению с именем родителя — если саму папку альбома
  // переименовали в проводнике, подпапка сохранит старое имя
  const curatedParent = resolveAlbumFolder(State.albumHandle);
  let curatedDirName = null;
  for await (const entry of curatedParent.values()) {
    if (entry.kind === "directory" && entry.name.endsWith(ALBUM_SUFFIX)) { curatedDirName = entry.name; break; }
  }
  State.curatedDirName = curatedDirName;

  let originalsHandle = null;
  const backupNames = new Set();
  try {
    originalsHandle = await State.albumHandle.getDirectoryHandle(ORIGINALS_DIR);
    for await (const entry of originalsHandle.values()) {
      if (entry.kind === "file") backupNames.add(entry.name);
    }
  } catch (_) {
    // папки бэкапов ещё нет — значит ничего не редактировали
  }

  const curatedNames = new Set();
  if (curatedDirName) {
    try {
      const curatedHandle = await curatedParent.getDirectoryHandle(curatedDirName);
      for await (const entry of curatedHandle.values()) {
        if (entry.kind === "file") curatedNames.add(entry.name);
      }
    } catch (_) {
      // не должно случиться — только что нашли эту папку в перечислении выше
    }
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

// "Отредактировано" значит не просто "есть файл с таким именем в папке бэкапов",
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
    btn.dataset.index = i;
    const img = document.createElement("img");
    img.alt = item.name;
    btn.appendChild(img);
    if (item.edited) btn.appendChild(makeEditedBadge());
    if (item.starred) btn.appendChild(makeStarBadge());
    // без этого клик мышью оставляет на кнопке нативную рамку фокуса — она никуда не девается
    // при листании стрелками (та листает фото глобальным keydown, а не тем, что реально
    // сфокусировано), и в итоге рядом с нашей синей рамкой активного кадра виснет ещё и белая
    // на когда-то кликнутой миниатюре; preventDefault на mousedown убирает фокус только по
    // клику мышью — Tab с клавиатуры по-прежнему фокусирует кнопку как обычно
    btn.addEventListener("mousedown", (evt) => evt.preventDefault());
    btn.addEventListener("click", () => goToPhoto(i));
    grid.appendChild(btn);
  });
  // раскладка по столбикам в боковом режиме зависит от количества миниатюр — пересчитываем
  // при каждой перестройке ленты, а не только при изменении границы
  updateThumbSizing();
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

// находит кнопку-миниатюру по индексу фото в очереди (data-index), а не по позиции среди
// детей #album-grid (grid.children[i]) — индекс фото не всегда совпадает с позицией в DOM
function thumbAt(i) {
  return el("album-grid").querySelector(`.thumb[data-index="${i}"]`);
}

function updateThumbImg(i) {
  const btn = thumbAt(i);
  const img = btn && btn.querySelector("img");
  if (img && State.queue[i].thumbUrl) {
    img.src = State.queue[i].thumbUrl;
    img.classList.add("loaded");
  }
}

function updateThumbBadge(i) {
  const btn = thumbAt(i);
  if (!btn) return;
  const existing = btn.querySelector(".edited-badge");
  if (State.queue[i].edited && !existing) {
    btn.appendChild(makeEditedBadge());
  } else if (!State.queue[i].edited && existing) {
    existing.remove();
  }
}

function updateThumbStar(i) {
  const btn = thumbAt(i);
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
  // find() тут не подходит — он останавливается на первом совпадении и не доходит до
  // миниатюр после него, поэтому при движении назад подсветка с них не снималась
  let active = null;
  grid.querySelectorAll(".thumb").forEach((c) => {
    const isActive = +c.dataset.index === State.index;
    c.classList.toggle("active", isActive);
    if (isActive) active = c;
  });
  // в длинных альбомах активная миниатюра может быть за пределами видимой ленты — центрируем
  // прокрутку на ней, иначе непонятно, на каком фото сейчас фокус. Ось листания зависит от
  // режима: в нижнем и в боковом многостолбцовом (столбцы растянуты на всю высоту ленты) —
  // по горизонтали; в боковом одностолбцовом (.single-column, см. updateColumnMode()) — как
  // обычный список, по вертикали
  if (active) {
    const vertical = grid.classList.contains("single-column");
    active.scrollIntoView({
      inline: vertical ? "nearest" : "center",
      block: vertical ? "center" : "nearest",
      behavior: "smooth",
    });
  }
}

async function regenerateThumbFromFile(item, fileOrBlob, cacheKey) {
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
  if (cacheKey) {
    try { await idbSet(cacheKey, blob, IDB_THUMB_STORE); } catch (_) {}
  }
}

// ключ по имени+размеру+дате изменения — при реальном изменении файла (правка, восстановление
// оригинала) он меняется сам собой, так что кэш не может "залипнуть" на устаревшей миниатюре
function thumbCacheKey(item, file) {
  return `${item.name}|${file.size}|${file.lastModified}`;
}

async function generateThumbnails(generation) {
  const queue = State.queue; // фиксируем ссылку — State.queue может смениться, если пока грузимся, откроют другой альбом
  const CONCURRENCY = 4; // несколько фото decode/encode'ятся параллельно вместо строго по одному — заметно быстрее на больших альбомах
  let nextIndex = 0;

  async function worker() {
    while (true) {
      if (State.albumGeneration !== generation) return;
      const i = nextIndex++;
      if (i >= queue.length) return;
      const item = queue[i];
      try {
        const file = await item.handle.getFile();
        const cacheKey = thumbCacheKey(item, file);
        let cached = null;
        try { cached = await idbGet(cacheKey, IDB_THUMB_STORE); } catch (_) {}
        if (State.albumGeneration !== generation) return;
        if (cached) {
          if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
          item.thumbUrl = URL.createObjectURL(cached);
        } else {
          await regenerateThumbFromFile(item, file, cacheKey);
        }
        if (State.albumGeneration !== generation) return;
        updateThumbImg(i);
      } catch (e) {
        // пропускаем неудачную миниатюру, не прерывая остальные
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
}

// сканирует GPS всех фото альбома в фоне (не только открытого сейчас) — нужно, чтобы карта
// сразу показывала метки всего альбома, а не только текущего снимка
async function collectAlbumGeo(generation) {
  const queue = State.queue;
  const CONCURRENCY = 4;
  let nextIndex = 0;

  async function worker() {
    while (true) {
      if (State.albumGeneration !== generation) return;
      const i = nextIndex++;
      if (i >= queue.length) return;
      const item = queue[i];
      try {
        const file = await item.handle.getFile();
        const exif = readExif(await file.arrayBuffer());
        if (State.albumGeneration !== generation) return;
        if (exif && exif.lat != null && exif.lon != null) {
          State.albumGeo[i] = { lat: exif.lat, lon: exif.lon };
          refreshMaps();
        }
      } catch (e) {
        // пропускаем фото без читаемого EXIF, не прерывая остальные
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
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
  await loadPhoto(item); // сам подбирает масштаб под окно, как только известны размеры превью
}

// три исхода вместо стандартного OK/Cancel — "Отмена" должна реально останавливать переход,
// а не просто пропускать сохранение
function askUnsavedChanges(name) {
  return new Promise((resolve) => {
    const modal = el("unsaved-modal");
    el("unsaved-modal-text").textContent = `Сохранить изменения в «${name}» перед переходом?`;
    const saveBtn = el("unsaved-save-btn");
    const discardBtn = el("unsaved-discard-btn");
    const cancelBtn = el("unsaved-cancel-btn");

    const cleanup = (result) => {
      modal.hidden = true;
      saveBtn.removeEventListener("click", onSave);
      discardBtn.removeEventListener("click", onDiscard);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      modal.removeEventListener("keydown", onKeydown);
      resolve(result);
    };
    const onSave = () => cleanup("save");
    const onDiscard = () => cleanup("discard");
    const onCancel = () => cleanup("cancel");
    // клик мимо диалога — безопасный дефолт "не терять правки", как и закрытие модалки "О программе"
    const onBackdrop = (evt) => {
      if (evt.target.id === "unsaved-modal") cleanup("cancel");
    };
    // фокус на "Сохранить" виден пользователю (обводка primary-кнопки), но обычный <button> сам
    // по себе фокус при открытии модалки не получает — без явного focus() Enter не долетал
    // до кнопки и срабатывал только клик мышью
    const onKeydown = (evt) => {
      if (evt.key === "Enter") { evt.preventDefault(); onSave(); }
      else if (evt.key === "Escape") { evt.preventDefault(); onCancel(); }
    };

    saveBtn.addEventListener("click", onSave);
    discardBtn.addEventListener("click", onDiscard);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
    modal.addEventListener("keydown", onKeydown);
    modal.hidden = false;
    saveBtn.focus();
  });
}

// переход между фото с проверкой несохранённых правок — предлагает сохранить перед уходом.
// Проверку на выход за пределы альбома делаем ПОСЛЕ (а не вместо) проверки на несохранённые
// правки: "следующего" фото после последнего (или "предыдущего" перед первым) не существует,
// но нажатие "дальше"/"назад" на границе альбома всё равно должно предложить сохранить —
// иначе правки последнего фото молча остаются несохранёнными, ведь дальше идти всё равно
// некуда, и никакой другой переход, который спросил бы про сохранение, для него не наступит
async function goToPhoto(i) {
  if (i === State.index) return;
  if (State.dirty) {
    const name = State.queue[State.index].name;
    const choice = await askUnsavedChanges(name);
    if (choice === "cancel") return; // остаёмся на текущем фото
    if (choice === "save") await saveCurrent();
  }
  if (i < 0 || i >= State.queue.length) return; // некуда переходить — но правки уже сохранены/подтверждены выше
  await selectPhoto(i);
}

function prevPhoto() {
  goToPhoto(State.index - 1);
}

function nextPhoto() {
  goToPhoto(State.index + 1);
}

// presetFile — если данные уже есть в памяти (после restoreOriginal/saveCurrent), берём их
// напрямую вместо повторного чтения только что записанного файла с диска: сразу после
// createWritable().close() getFile() иногда ещё отдаёт старое содержимое (кэш хэндла), из-за
// чего "восстановленное"/только что сохранённое фото визуально не обновлялось
async function loadPhoto(item, presetFile) {
  // если пока грузим это фото (await ниже) пользователь успеет пролистнуть дальше, начнётся ещё
  // один loadPhoto с более новым номером — тогда этот вызов, доделав работу позже того, более
  // нового, не должен переписать поверх него состояние/статус-бар устаревшими результатами
  const myGen = ++State.loadGeneration;
  const file = presetFile || await item.handle.getFile();
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  if (myGen !== State.loadGeneration) return; // устарело — за это время открыли другое фото
  State.fullBitmap = bitmap;
  renderPropertiesPanel(item, file, bitmap);

  // цветовой вариант — тоже часть "чистого" состояния только что открытого файла;
  // сбрасываем здесь (а не только в selectPhoto), чтобы после saveCurrent() -> loadPhoto()
  // кнопка "сохранить" не оставалась включённой из-за уже применённого варианта
  State.colorVariant = COLOR_VARIANTS[1];
  await rebuildPreviewBitmap();
  if (myGen !== State.loadGeneration) return; // устарело — за это время открыли другое фото
  fitPreviewToWindowInstant(); // масштаб под новые размеры превью выставляем сразу, до отрисовки, и без анимации — иначе новое фото на долю секунды деформируется в пропорции старого

  // включённые регулировки (открытый ползунок поворота, рамка обрезки, режим перспективы)
  // переходят на новое фото как есть — сбрасываются только сами значения (угол, квад,
  // рамка кропа), завязанные на конкретное изображение, а не то, что регулировка включена
  State.rotationDeg = 0;
  el("rotate-slider").value = 0;
  State.perspectiveQuad = null;
  if (State.perspectiveMode) {
    // тот же дефолтный квад — от истинных краёв фото, что и при первом включении режима
    const w = State.previewW, h = State.previewH;
    State.perspectiveQuad = [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ];
  }
  el("perspective-btn").classList.toggle("active", State.perspectiveMode);
  syncCropFrameUI();
  State.exifDirty = false;
  State.netQuarterTurns = 0;
  State.netFlipped = false;
  // горизонт автоматически подбирается как стартовая точка для ручной подстройки — но только
  // если включена кнопка "⚖" и у фото ещё нет сохранённой правки (см. maybeAutoDetectHorizon);
  // она же делает resetCropRect/refreshDirty/render в любом случае
  await maybeAutoDetectHorizon(item, myGen);
}

// пересобирает уменьшенную копию для редактирования (State.previewBitmap/previewW/previewH)
// из текущего State.fullBitmap — нужно и при открытии фото, и после жёсткого поворота/отражения
async function rebuildPreviewBitmap() {
  const bitmap = State.fullBitmap;
  const scale = Math.min(1, PREVIEW_MAX / Math.max(bitmap.width, bitmap.height));
  State.previewW = Math.round(bitmap.width * scale);
  State.previewH = Math.round(bitmap.height * scale);
  State.previewBitmap = await createImageBitmap(bitmap, {
    resizeWidth: State.previewW,
    resizeHeight: State.previewH,
    resizeQuality: "high",
  });
  refreshDisplayBitmap();
}

// применяет текущий State.colorVariant к previewBitmap и кладёт результат в State.displayBitmap —
// именно его рисует render(). Отдельный шаг (не «на лету» в render()), потому что
// getImageData/putImageData по всему кадру на каждый rAF было бы избыточно дорого во время
// перетаскивания ползунка поворота, а сам цветовой вариант меняется редко — только по клику
function refreshDisplayBitmap() {
  const w = State.previewW, h = State.previewH;
  if (!State.previewBitmap || !w || !h) {
    State.displayBitmap = State.previewBitmap;
    return;
  }
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const cctx = c.getContext("2d");
  cctx.drawImage(State.previewBitmap, 0, 0);
  if (State.colorVariant.key !== COLOR_VARIANTS[1].key) {
    const imgData = cctx.getImageData(0, 0, w, h);
    applyColorTreatment(imgData, {
      saturationBoost: State.colorVariant.saturationBoost,
      clipPercent: State.colorVariant.clipPercent,
      warm: State.colorVariant.warm,
    });
    cctx.putImageData(imgData, 0, 0);
  }
  State.displayBitmap = c;
}

// автоматически определяет угол горизонта (OpenCV) и выставляет его как стартовую точку перед
// ручной подстройкой — сама по себе ничего не решает про то, нужно ли её вызывать (это делает
// maybeAutoDetectHorizon), только детектирует и применяет
async function autoDetectHorizon(item) {
  if (!State.fullBitmap) return;
  // статус-бар — единственная строка, но пользователю нужно и видеть, какое фото открыто, и
  // что с ним сделал автогоризонт, поэтому имя файла всегда идёт первым, а результат детекции
  // дописывается следом, а не заменяет его целиком
  const namePrefix = item ? item.name + " — " : "";
  // строим канвас для детекции заново из fullBitmap, а не копируем State.previewBitmap: у
  // него resizeQuality "high" (нужно для красивого превью), а этот сглаживающий ресемплинг
  // на реальных фото ощутимо смещает под-пиксельное положение линии горизонта в Canny/Hough
  // и может увести угол на несколько градусов от истинного
  const scale = Math.min(1, PREVIEW_MAX / Math.max(State.fullBitmap.width, State.fullBitmap.height));
  const detectW = Math.round(State.fullBitmap.width * scale);
  const detectH = Math.round(State.fullBitmap.height * scale);
  const detectCanvas = document.createElement("canvas");
  detectCanvas.width = detectW;
  detectCanvas.height = detectH;
  detectCanvas.getContext("2d").drawImage(State.fullBitmap, 0, 0, detectW, detectH);
  const { horizonAngle, confident } = detectLines(detectCanvas);

  // явной линии горизонта на фото может не быть вообще — тогда лучше не трогать угол, чем
  // крутить фото по случайному краю предмета или текстуре (см. detectLines); но рамку кропа и
  // рендер всё равно надо обновить — это тот же вызов, которым rotateQuarter/flipHorizontal
  // синхронизируют её с новыми (после жёсткого поворота/зеркала) размерами превью
  if (confident && Math.abs(horizonAngle) > AUTO_HORIZON_MAX_ANGLE) {
    // настоящий горизонт редко бывает завален больше чем на несколько градусов — такой большой
    // угол значит, что за горизонт приняли что-то другое (край предмета, диагональ переднего
    // плана), и лучше пропустить это как ошибку детектора, чем радикально повернуть фото
    setStatus("status-bar", `${namePrefix}Похоже, за горизонт приняли что-то другое (угол ${round1(horizonAngle)}° — это больше ${AUTO_HORIZON_MAX_ANGLE}°), угол не менял.`);
  } else if (confident) {
    // detectLines считает угол в координатах изображения (y вниз): положительный angle —
    // горизонт опускается вправо. ctx.rotate с тем же знаком крутит картинку ПО часовой —
    // то есть ещё сильнее опускает правый край. Чтобы выровнять, крутить нужно в обратную
    // сторону, отсюда минус.
    State.rotationDeg = clamp(round1(-horizonAngle), -90, 90);
    el("rotate-slider").value = State.rotationDeg;
    // явно подтверждаем, что и почему применили — иначе сообщение об ошибке с предыдущего
    // фото (не нашли горизонт / угол слишком большой) повиснет в статус-баре и будет
    // противоречить реально применённому углу
    setStatus("status-bar", `${namePrefix}Горизонт выровнен автоматически (угол ${State.rotationDeg}°).`);
    if (State.rotationDeg !== 0) {
      State.showGrid = true;
      // как и при ручной подстройке — ненулевой угол даёт чёрные уголки по краям, рамку
      // обрезки нужно показать сразу, а не полагаться, что пользователь вспомнит нажать её сам
      showCropFrame();
    }
    el("grid-btn").classList.toggle("active", State.showGrid);
  } else {
    setStatus("status-bar", `${namePrefix}Не нашёл явной линии горизонта — угол не менял.`);
  }

  resetCropRect();
  // угол горизонта уже подобран автоматически — это реальная правка, а не нейтральный старт,
  // поэтому при ненулевом угле сразу считаем фото несохранённым (спросит перед уходом с фото)
  refreshDirty();
  render();
}

// решает, нужно ли вообще запускать автогоризонт, и либо делает это, либо просто синхронизирует
// рамку кропа/рендер (тот минимум, что иначе делала бы сама autoDetectHorizon в конце) — общая
// точка входа для loadPhoto/rotateQuarter/flipHorizontal и для клика по кнопке "⚖". myGen — номер
// поколения (State.loadGeneration на момент старта вызывающей функции, до её await'ов); если за
// это время (пока читался файл/пересобиралось превью) успела начаться более новая операция —
// эта уже устарела и не должна ничего применять/рендерить поверх неё
async function maybeAutoDetectHorizon(item, myGen) {
  if (myGen !== State.loadGeneration) return;
  // кнопка выключена — автогоризонт вообще не трогаем; но сообщение об ошибке детектора
  // с предыдущего фото (если было) относится уже не к этому фото — заменяем на имя текущего,
  // иначе оно повиснет и будет путать
  if (!State.autoHorizonEnabled) {
    setStatus("status-bar", item ? item.name : "");
    resetCropRect();
    refreshDirty();
    render();
    return;
  }
  // у фото уже есть сохранённая правка (был бэкап оригинала) — значит угол/кадр уже когда-то
  // подобрали руками и сохранили; автогоризонт не должен переигрывать это заново при каждом
  // открытии, иначе намеренно оставленный "неровный" горизонт будет постоянно сбрасываться
  if (item && item.edited) {
    setStatus("status-bar", item.name);
    resetCropRect();
    refreshDirty();
    render();
    return;
  }
  await autoDetectHorizon(item);
}

function toggleAutoHorizon() {
  State.autoHorizonEnabled = !State.autoHorizonEnabled;
  localStorage.setItem(AUTO_HORIZON_STORAGE_KEY, State.autoHorizonEnabled ? "1" : "0");
  el("auto-horizon-btn").classList.toggle("active", State.autoHorizonEnabled);
  if (State.index < 0) return;
  if (State.autoHorizonEnabled) {
    // включили — сразу применяем к уже открытому фото, а не только при следующем открытии
    const myGen = ++State.loadGeneration;
    maybeAutoDetectHorizon(State.queue[State.index], myGen);
  } else {
    // выключили — угол, который был подобран автогоризонтом, тоже сбрасывается в 0
    resetRotationAngle();
  }
}

// State.perspectiveQuad задаёт, куда должны деться 4 угла ТЕКУЩЕГО кадра (previewW×previewH) —
// жёсткий поворот на 90° меняет сам кадр (а для 90°/270° ещё и переставляет местами его
// ширину/высоту), поэтому уже заданную пользователем деформацию (в т.ч. с углами, утянутыми
// за пределы фото — это осознанная правка дисторсии объектива, а не случайность) нужно
// провернуть вместе с кадром, а не оставить как есть (числа будут отсчитаны от уже
// несуществующей системы координат) и не сбросить в дефолт (тогда правка молча пропадёт)
function rotateQuadQuarter(quad, w, h, quarterTurns) {
  const q = ((quarterTurns % 4) + 4) % 4;
  if (q === 0) return quad;
  const transform = (pt) => {
    if (q === 1) return { x: h - pt.y, y: pt.x };
    if (q === 2) return { x: w - pt.x, y: h - pt.y };
    return { x: pt.y, y: w - pt.x }; // q === 3
  };
  const out = new Array(4);
  for (let i = 0; i < 4; i++) out[i] = transform(quad[(i - q + 4) % 4]);
  return out;
}

// то же самое для зеркального отражения (см. flipBitmapHorizontal) — ширина/высота кадра не
// меняются, но левая и правая половины меняются местами, поэтому и квад надо отразить, а не
// просто переставить местами x-координаты внутри тех же самых 4 индексов
function flipQuadHorizontal(quad, w) {
  const transform = (pt) => ({ x: w - pt.x, y: pt.y });
  const swapIdx = [1, 0, 3, 2];
  return swapIdx.map((srcIdx) => transform(quad[srcIdx]));
}

// жёсткий поворот на 90°: quarterTurns 1 = по часовой, -1 = против часовой — впечатывается
// прямо в пиксели (в отличие от State.rotationDeg — это точная подстройка угла горизонта)
async function rotateQuarter(quarterTurns) {
  if (!State.fullBitmap) return;
  // отдельное "поколение" операции — как в loadPhoto, чтобы более новое действие (например,
  // быстрый переход к другому фото) не дало этому, более старому и медленному вызову, переписать
  // состояние своими устаревшими результатами после того, как оно уже применит свои
  const myGen = ++State.loadGeneration;
  // старые размеры кадра нужны до пересборки превью — именно в них ещё выражен текущий
  // (дорисованный до поворота) State.perspectiveQuad
  const oldW = State.previewW, oldH = State.previewH;
  State.fullBitmap = await createImageBitmap(rotateBitmapQuarter(State.fullBitmap, quarterTurns));
  await rebuildPreviewBitmap();
  if (myGen !== State.loadGeneration) return;
  if (State.perspectiveQuad) {
    State.perspectiveQuad = rotateQuadQuarter(State.perspectiveQuad, oldW, oldH, quarterTurns);
  }
  // на 90°/270° ширина и высота превью меняются местами — CSS-размер canvas (задан в px,
  // см. setPreviewZoom) остаётся от старой, уже неверной пропорции, пока explicitly не
  // пересчитать его под новые previewW/previewH; иначе браузер растягивает новый кадр
  // в старую рамку
  fitPreviewToWindowInstant();
  // жёсткий поворот сам по себе обратим — если по сумме поворотов фото вернулось в исходную
  // ориентацию (например, 4×90° или 90° затем -90°), пиксели идентичны оригиналу, и запрос
  // на сохранение показывать не за что; поэтому считаем не "тронули — значит грязно", а
  // накопленный поворот по модулю 4
  State.netQuarterTurns = ((State.netQuarterTurns + quarterTurns) % 4 + 4) % 4;
  // старый угол был подобран под прежнюю ориентацию пикселей и для новой уже бессмыслен;
  // без сброса он застревал бы от прошлой ориентации, если для новой автогоризонт не
  // уверен и оставит угол как есть — тогда даже вернувшись полным кругом к исходной
  // ориентации, фото так и осталось бы помеченным изменённым
  State.rotationDeg = 0;
  el("rotate-slider").value = 0;
  showCropFrame();
  // ориентация сменилась — угол горизонта для неё подбираем заново, как при открытии фото
  await maybeAutoDetectHorizon(State.queue[State.index], myGen);
}

async function flipHorizontal() {
  if (!State.fullBitmap) return;
  const myGen = ++State.loadGeneration;
  State.fullBitmap = await createImageBitmap(flipBitmapHorizontal(State.fullBitmap));
  await rebuildPreviewBitmap();
  if (myGen !== State.loadGeneration) return;
  // ширина кадра при зеркале не меняется — можно отразить квад уже по новому previewW
  if (State.perspectiveQuad) {
    State.perspectiveQuad = flipQuadHorizontal(State.perspectiveQuad, State.previewW);
  }
  // как и с поворотом — два разворота подряд возвращают исходные пиксели, поэтому
  // отслеживаем чётность, а не выставляем "грязно" безусловно
  State.netFlipped = !State.netFlipped;
  // тот же резон, что и в rotateQuarter — старый угол относился к зеркально другой картинке
  State.rotationDeg = 0;
  el("rotate-slider").value = 0;
  showCropFrame();
  await maybeAutoDetectHorizon(State.queue[State.index], myGen);
}

async function renderPropertiesPanel(item, file, bitmap) {
  const list = el("properties-list");
  list.innerHTML = "";

  const addRow = (label, { noCopy = false } = {}) => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    list.appendChild(dt);
    list.appendChild(dd);

    if (noCopy) return { dd, copyBtn: null };
    // кнопка копирования — оверлей внутри самого значения (с прозрачным фоном), а не
    // отдельная колонка сетки, чтобы короткие значения не оставляли пустую полосу у края
    const copyBtn = document.createElement("button");
    copyBtn.className = "properties-copy-btn";
    copyBtn.title = "Скопировать";
    copyBtn.innerHTML = '<img src="icons/Copy WIT.png" alt="">';
    copyBtn.style.visibility = State.copyMode ? "visible" : "hidden";
    return { dd, copyBtn };
  };

  const addStaticRow = (label, value, opts) => {
    const { dd, copyBtn } = addRow(label, opts);
    dd.textContent = value || "—";
    dd.classList.toggle("empty", !value);
    if (copyBtn) {
      dd.appendChild(copyBtn); // добавляем после текста, чтобы textContent выше его не стёр
      copyBtn.disabled = !value;
      copyBtn.addEventListener("click", () => copyToClipboard(value, copyBtn));
    }
  };

  let exif = null;
  try {
    exif = readExif(await file.arrayBuffer());
  } catch (_) {
    // повреждённый/нестандартный EXIF — просто не показываем эти поля
  }

  addStaticRow("Файл", item.name);
  addStaticRow("Размер", formatFileSize(file.size), { noCopy: true });
  addStaticRow("Разрешение", `${bitmap.width} × ${bitmap.height}`, { noCopy: true });

  // сохраняем для восстановления в файл при экспорте — canvas.toBlob() стирает весь EXIF;
  // {} ведёт себя как null для injectExif, пока пользователь ничего не поправил вручную
  State.currentExif = exif || {};

  // Дата съёмки — единое поле datetime-local: его нативный попап уже показывает
  // и календарь, и время; title подсказывает порядок ч/мин/с внутри поля
  {
    const { dd, copyBtn } = addRow("Дата съёмки");
    const input = document.createElement("input");
    input.type = "datetime-local";
    input.step = "1";
    input.title = "чч:мм:сс — часы : минуты : секунды";
    input.className = "properties-edit-input";
    input.disabled = !State.copyMode;

    const parts = splitExifDate(exif && exif.dateTaken) || splitExifDate(fileDateToExifDate(file.lastModified));
    input.value = `${parts.y}-${parts.mo}-${parts.d}T${parts.h}:${parts.mi}:${parts.se}`;
    dd.appendChild(input);
    dd.appendChild(copyBtn);

    // нативный значок календаря спрятан (наезжал на кнопку копирования) — открываем
    // тот же попап по двойному клику на поле
    input.addEventListener("dblclick", () => {
      if (!input.disabled && input.showPicker) input.showPicker();
    });

    const readExifDate = () => {
      const m = input.value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
      if (!m) return null;
      const [, y, mo, d, h, mi, se] = m;
      return buildExifDate(y, mo, d, h, mi, se || "0");
    };

    copyBtn.addEventListener("click", () => {
      copyToClipboard(formatExifDate(readExifDate()) || "", copyBtn);
    });

    input.addEventListener("change", () => {
      const exifValue = readExifDate();
      if (exifValue) {
        State.currentExif.dateTaken = exifValue;
        State.exifDirty = true;
        refreshDirty();
      }
    });
  }

  // Камера — свободный текст, можно вставить (Ctrl+V) поверх в режиме редактирования
  {
    const { dd, copyBtn } = addRow("Камера");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "properties-edit-input";
    input.disabled = !State.copyMode;
    input.value = [exif && exif.make, exif && exif.model].filter(Boolean).join(" ");
    dd.appendChild(input);
    dd.appendChild(copyBtn);
    copyBtn.disabled = !input.value;
    copyBtn.addEventListener("click", () => copyToClipboard(input.value, copyBtn));
    input.addEventListener("input", () => {
      copyBtn.disabled = !input.value;
      State.currentExif.make = input.value;
      State.currentExif.model = "";
      State.exifDirty = true;
      refreshDirty();
    });
  }

  // GPS — координаты не набираются руками, а проставляются кликом по карте (см. setCurrentGeo)
  {
    const { dd, copyBtn } = addRow("GPS");
    const span = document.createElement("span");
    dd.appendChild(span);
    dd.appendChild(copyBtn);
    State.updateGpsRow = (lat, lon) => {
      const has = lat != null && lon != null;
      span.textContent = has ? `${lat.toFixed(6)}, ${lon.toFixed(6)}` : "—";
      dd.classList.toggle("empty", !has);
      copyBtn.disabled = !has;
    };
    copyBtn.addEventListener("click", () => copyToClipboard(span.textContent, copyBtn));
    State.updateGpsRow(exif && exif.lat, exif && exif.lon);
  }

  // карту можно открыть и без GPS — чтобы проставить координаты кликом впервые
  // (актуально для сканов плёнок, у которых EXIF изначально пустой)
  setMapButtonsEnabled(true);

  if (exif && exif.lat != null && exif.lon != null) {
    State.currentGeo = { lat: exif.lat, lon: exif.lon };
  } else {
    State.currentGeo = null;
  }
  // читаем EXIF этого фото уже здесь — не ждём фоновый collectAlbumGeo, у него может
  // быть устаревшее значение, если координаты только что изменили и ещё не сохранили
  if (State.index >= 0 && State.index < State.albumGeo.length) State.albumGeo[State.index] = State.currentGeo;
  refreshMaps();
}

// формат EXIF-даты: "YYYY:MM:DD HH:MM:SS"
function fileDateToExifDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function splitExifDate(s) {
  const m = s && s.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  return { y, mo, d, h, mi, se };
}

function buildExifDate(y, mo, d, h, mi, se) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${y}:${pad(mo)}:${pad(d)} ${pad(h)}:${pad(mi)}:${pad(se)}`;
}

// краткая вспышка кнопки — единственная обратная связь при копирании в буфер
function copyToClipboard(text, btn) {
  navigator.clipboard
    .writeText(text)
    .then(() => {
      btn.classList.add("copy-flash");
      setTimeout(() => btn.classList.remove("copy-flash"), 350);
    })
    .catch(() => {});
}

// координаты берутся кликом по встроенной или внешней карте, а не набором вручную
function setCurrentGeo(lat, lon) {
  State.currentGeo = { lat, lon };
  if (State.index >= 0) State.albumGeo[State.index] = { lat, lon };
  if (!State.currentExif) State.currentExif = {};
  State.currentExif.lat = lat;
  State.currentExif.lon = lon;
  State.exifDirty = true;
  refreshDirty();
  if (State.updateGpsRow) State.updateGpsRow(lat, lon);
  refreshMaps();
}

// кнопки карты никогда не скрываются — только блокируются, когда у фото нет геоданных
function setMapButtonsEnabled(enabled) {
  el("properties-map-btn").disabled = !enabled;
  el("properties-map-new-btn").disabled = !enabled;
}

// кнопка глобуса не привязана к текущему фото — она значит "все готовые альбомы, по одной
// метке на каждый", поэтому включена ровно тогда, когда активен режим "Альбомы" (см.
// toggleAlbumsView). Выключение обязано закрыть окно глобуса и забыть список альбомов —
// иначе при повторном входе в режим окно осталось бы с меток прошлого списка
function setGlobeButtonEnabled(enabled) {
  el("globe-btn").disabled = !enabled;
  if (!enabled) {
    if (State.globeWindow && !State.globeWindow.closed) State.globeWindow.close();
    onGlobeWindowClosed();
    State.albumsList = [];
    State.albumsGeo = [];
  }
}

// единая точка обновления обеих карт — так они всегда показывают один и тот же набор
// меток текущего альбома и одинаково подсвечивают текущее фото (у глобуса — см. refreshAlbumsGlobe)
function refreshMaps() {
  const payload = { points: State.albumGeo, activeIndex: State.index, copyMode: State.copyMode };
  if (State.mapWindow && !State.mapWindow.closed) {
    State.mapWindow.postMessage(payload, "*");
  }
  // глобус получает те же точки, только пока внутри него открыт режим альбома (см.
  // "globe-entered-album" в обработчике message ниже) — иначе на "глобус всех альбомов" впустую
  // капал бы трафик о фото того альбома, что открыт в фоне
  if (State.globeWindow && !State.globeWindow.closed && State.globeAlbumMode) {
    State.globeWindow.postMessage(payload, "*");
  }
  const embedWrap = el("properties-map-embed");
  if (embedWrap && !embedWrap.hidden) refreshEmbeddedMapMarkers();
}

// встроенная карта в панели параметров — своя интерактивная Leaflet-карта (не iframe с
// openstreetmap.org), потому что клики внутри чужого iframe браузер не отдаёт скрипту
// из-за cross-origin — без этого нельзя было бы проставлять GPS кликом
let embeddedMap = null;
const embeddedMarkersRef = { list: [] }; // все капли альбома на встроенной карте (см. geo-markers.js)

function ensureEmbeddedMap() {
  if (embeddedMap) return embeddedMap;
  embeddedMap = L.map("properties-map-embed-frame", { attributionControl: true, zoomControl: false });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap",
  }).addTo(embeddedMap);
  // вид должен существовать ДО того как на карту попадут метки — без него Leaflet
  // добавляет их с временным pixelOrigin и они остаются смещены на тысячи пикселей
  // за пределы видимой области, даже когда на первый взгляд карта выглядит нормально
  embeddedMap.setView([20, 0], 2);
  embeddedMap.on("click", (e) => {
    if (!State.copyMode) return; // ставим точку только в режиме редактирования
    setCurrentGeo(e.latlng.lat, e.latlng.lng);
  });
  return embeddedMap;
}

// расставляет капли всего альбома и подводит вид карты к текущему фото (или ко всем
// известным точкам, если у текущего фото геоданных нет)
function refreshEmbeddedMapMarkers() {
  const map = ensureEmbeddedMap();
  // вид выставляем до расстановки меток (см. комментарий в ensureEmbeddedMap) —
  // иначе новые капли ложатся с неверным смещением
  const cur = State.index >= 0 ? State.albumGeo[State.index] : null;
  if (cur) {
    map.setView([cur.lat, cur.lon], 16);
  } else if (State.albumGeo.some(Boolean)) {
    map.fitBounds(L.latLngBounds(State.albumGeo.filter(Boolean).map((g) => [g.lat, g.lon])).pad(0.2));
  } else {
    map.setView([20, 0], 2);
  }
  // клик по капле переводит фокус на следующее фото в группе — как и в отдельном окне карты
  // (map.html), это работает независимо от режима редактирования GPS: там точку по клику на
  // саму каплю тоже не ставят, только по клику мимо капель (см. embeddedMap.on("click") выше)
  syncGeoMarkers(L, map, embeddedMarkersRef, State.albumGeo, State.index, (indexes) => goToPhoto(pickClusterTarget(indexes, State.index)));
  requestAnimationFrame(() => map.invalidateSize());
}

function toggleEmbeddedMap() {
  const wrap = el("properties-map-embed");
  if (!wrap.hidden) {
    wrap.hidden = true;
    el("properties-map-btn").classList.remove("active");
    return;
  }
  wrap.hidden = false;
  el("properties-map-btn").classList.add("active");
  refreshEmbeddedMapMarkers();
}

let mapWindowWatcher = null; // следит за окном карты, чтобы погасить кнопку, если его закрыли крестиком, а не повторным кликом

function toggleLocationMapWindow() {
  if (State.mapWindow && !State.mapWindow.closed) {
    State.mapWindow.close();
    onMapWindowClosed();
    return;
  }
  // без query-параметров — окно само сообщит о готовности ("map-ready"), и мы пришлём
  // ему актуальные точки; так у обеих карт ровно один источник данных и код отрисовки
  State.mapWindow = window.open("map.html", "albom_map");
  el("properties-map-new-btn").classList.add("active");
  clearInterval(mapWindowWatcher);
  mapWindowWatcher = setInterval(() => {
    if (!State.mapWindow || State.mapWindow.closed) onMapWindowClosed();
  }, 500);
}

function onMapWindowClosed() {
  clearInterval(mapWindowWatcher);
  mapWindowWatcher = null;
  State.mapWindow = null;
  el("properties-map-new-btn").classList.remove("active");
}

let globeWindowWatcher = null; // следит за окном глобуса, чтобы погасить кнопку, если его закрыли крестиком

function toggleGlobeWindow() {
  if (State.globeWindow && !State.globeWindow.closed) {
    State.globeWindow.close();
    onGlobeWindowClosed();
    return;
  }
  State.globeWindow = window.open("globe.html", "albom_globe");
  el("globe-btn").classList.add("active");
  clearInterval(globeWindowWatcher);
  globeWindowWatcher = setInterval(() => {
    if (!State.globeWindow || State.globeWindow.closed) onGlobeWindowClosed();
  }, 500);
}

function onGlobeWindowClosed() {
  clearInterval(globeWindowWatcher);
  globeWindowWatcher = null;
  State.globeWindow = null;
  State.globeAlbumMode = false;
  el("globe-btn").classList.remove("active");
}

// сканирует геоданные готовых альбомов в фоне для глобуса — по одной точке на альбом (первое
// найденное фото с GPS в самой папке "-Albom", без вложенных подпапок — она всегда плоская,
// см. scanFiles), а не по одной на каждое фото, как у collectAlbumGeo
async function collectAlbumsGeo(generation) {
  const list = State.albumsList;
  const imageRe = /\.(jpe?g|png)$/i;
  const CONCURRENCY = 4;
  let nextIndex = 0;

  async function worker() {
    while (true) {
      if (State.albumsGeoGeneration !== generation) return;
      const i = nextIndex++;
      if (i >= list.length) return;
      try {
        for await (const entry of list[i].handle.values()) {
          if (State.albumsGeoGeneration !== generation) return;
          if (entry.kind !== "file" || !imageRe.test(entry.name)) continue;
          const file = await entry.getFile();
          const exif = readExif(await file.arrayBuffer());
          if (State.albumsGeoGeneration !== generation) return;
          if (exif && exif.lat != null && exif.lon != null) {
            State.albumsGeo[i] = { lat: exif.lat, lon: exif.lon };
            refreshAlbumsGlobe();
            break;
          }
        }
      } catch (e) {
        // пропускаем альбом с нечитаемыми файлами, не прерывая остальные
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
}

// шлёт в открытое окно глобуса метки всех готовых альбомов, у которых нашлась точка — по
// одной на альбом, в отличие от refreshMaps(), который шлёт все фото ТЕКУЩЕГО альбома
function refreshAlbumsGlobe() {
  if (!(State.globeWindow && !State.globeWindow.closed)) return;
  const albums = State.albumsList
    .map((a, i) => (State.albumsGeo[i]
      ? { index: i, name: a.name.endsWith(ALBUM_SUFFIX) ? a.name.slice(0, -ALBUM_SUFFIX.length) : a.name, lat: State.albumsGeo[i].lat, lon: State.albumsGeo[i].lon }
      : null))
    .filter(Boolean);
  // index у элементов albums — это исходный индекс в State.albumsList (не смещается фильтром
  // .filter(Boolean) выше), поэтому глобус может сравнивать его с activeIndex напрямую
  const activeIndex = State.albumsList.findIndex((a) => a.handle === State.albumHandle);
  State.globeWindow.postMessage({ albums, activeIndex }, "*");
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

function clearPropertiesPanel() {
  el("properties-list").innerHTML = "";
  State.currentGeo = null;
  State.currentExif = null;
  State.updateGpsRow = null;
  State.copyMode = false; // без фото редактировать нечего — карандаш гаснет вместе с панелью
  setMapButtonsEnabled(false);
  el("properties-map-embed").hidden = true;
  embeddedMarkersRef.list.forEach((m) => m.remove());
  embeddedMarkersRef.list = [];
}

function resetCropRect() {
  // размеры именно новой картинки, а не то что осталось на canvas от предыдущего кадра;
  // учитываем и поворот, и (если активна) коррекцию перспективы — рамка вписывается в
  // истинно видимую область фото, а не только в её повёрнутый вариант, иначе сразу залезает
  // в пустые (прозрачные/чёрные) зоны, оставленные любым из этих двух искажений. Дополнительно
  // ограничена пределами самого фото [0,previewW]x[0,previewH] — угол квада можно утянуть
  // далеко наружу, но и варп, и поворот при рендере всё равно обрезаны строго по этим границам
  // (см. warpRectToQuad/drawRotatedAt), так что рамка не должна залезать за них тоже
  const quad = photoVisibleQuad(State.previewW, State.previewH, State.rotationDeg, State.perspectiveQuad);
  State.cropRect = rectForAspectInQuad(quad, State.aspect.w, State.aspect.h, State.previewW, State.previewH);
}

function cropIsAtDefault() {
  const quad = photoVisibleQuad(State.previewW, State.previewH, State.rotationDeg, State.perspectiveQuad);
  const base = rectForAspectInQuad(quad, State.aspect.w, State.aspect.h, State.previewW, State.previewH);
  const r = State.cropRect;
  const eps = 0.5;
  return Math.abs(r.x - base.x) < eps && Math.abs(r.y - base.y) < eps
    && Math.abs(r.w - base.w) < eps && Math.abs(r.h - base.h) < eps;
}

// режим перспективы сам по себе (кнопка включена) — это ещё не правка: реальная правка
// появляется только когда хотя бы один угол реально сдвинут от истинных краёв фото
function perspectiveIsAtDefault() {
  const q = State.perspectiveQuad;
  if (!q) return true;
  const w = State.previewW, h = State.previewH;
  const base = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const eps = 0.5;
  return q.every((p, i) => Math.abs(p.x - base[i].x) < eps && Math.abs(p.y - base[i].y) < eps);
}

// пересчитывает флаг "есть несохранённые правки" из фактического состояния, а не из факта
// "было какое-то взаимодействие" — иначе, вернув угол/рамку обратно в исходное положение,
// пользователь всё равно получал бы лишний вопрос "сохранить?" при уходе с фото
function refreshDirty() {
  // строгое сравнение с 0 ломалось из-за того, что ползунок (step 0.1) при перетаскивании
  // мышью может дать не ровно 0, а что-то вроде 0.09999999999999964 — визуально те же "0.0°",
  // но dirty никогда не сбрасывался; берём с допуском, как и для рамки кропа
  // нейтральны оба конца шкалы цветокоррекции: "Авто" — стартовый вариант по умолчанию для
  // любого свежеоткрытого фото, а "Оригинал" — явный отказ от какой-либо обработки, то есть
  // тот же необработанный файл, что и так лежит на диске; правкой считается только выбор
  // конкретного цветового пресета (контраст/ч-б/тепло)
  const colorIsNeutral = State.colorVariant.key === COLOR_VARIANTS[0].key
    || State.colorVariant.key === COLOR_VARIANTS[1].key;
  const visuallyNeutral = Math.abs(State.rotationDeg) < 0.05
    && perspectiveIsAtDefault()
    && colorIsNeutral
    && cropIsAtDefault()
    && State.netQuarterTurns === 0
    && !State.netFlipped;
  State.dirty = State.exifDirty || !visuallyNeutral;
}

// подстраховка: рамка кадрирования никогда не должна вылезать за пределы канваса —
// иначе экспорт кропа рисует чёрные полосы там, где рамка выходит за пределы фото
function clampCropRectToCanvas(r, w, h) {
  r.w = Math.min(r.w, w);
  r.h = Math.min(r.h, h);
  r.x = clamp(r.x, 0, w - r.w);
  r.y = clamp(r.y, 0, h - r.h);
}

// true, если все 4 угла рамки кадрирования лежат внутри quad (видимой области фото) и в
// пределах [0,clipW]x[0,clipH] — используется, чтобы отличить "перспектива ушла наружу, рамка
// всё ещё умещается" (её трогать не надо) от "перспектива ушла внутрь, рамка теперь торчит за
// новую видимую границу" (её нужно уменьшить, см. onPointerMove/perspective-corner)
function cropRectFitsQuad(r, quad, clipW, clipH) {
  const eps = 0.5;
  const corners = [
    { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
  ];
  const edges = quadEdges(quad);
  for (const c of corners) {
    if (c.x < -eps || c.x > clipW + eps || c.y < -eps || c.y > clipH + eps) return false;
    for (const { v, e, sign } of edges) {
      if ((e.x * (c.y - v.y) - e.y * (c.x - v.x)) * sign < -eps) return false;
    }
  }
  return true;
}

// настоящая видимая (непрозрачная) граница фото на экране — учитывает ОБА фактора,
// способных нарушить целостность прямоугольника: поворот (чёрные уголки) и коррекцию
// перспективы (деформация всей картинки в произвольный четырёхугольник). Сначала строим
// угол повёрнутого (но ещё не деформированного перспективой) прямоугольника — как и раньше,
// это просто поворот вокруг центра канваса; если перспектива активна и реально отличается
// от исходной формы — дополнительно прогоняем эти же 4 точки через ту же гомографию, что и
// сам рендер (renderWarpedPerspective/mapUnitSquareToQuad), поскольку варп применяется именно
// к уже повёрнутой картинке. Результат — выпуклый четырёхугольник, за пределы которого рамка
// обрезки не должна выходить ни при каких сочетаниях этих двух факторов
function photoVisibleQuad(w, h, angleDeg, perspectiveQuad) {
  const cx = w / 2, cy = h / 2;
  const rad = (angleDeg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const rotCorner = (sx, sy) => ({
    x: cx + ((sx * w) / 2) * c - ((sy * h) / 2) * s,
    y: cy + ((sx * w) / 2) * s + ((sy * h) / 2) * c,
  });
  const rotatedRect = [rotCorner(-1, -1), rotCorner(1, -1), rotCorner(1, 1), rotCorner(-1, 1)];
  if (!perspectiveQuad || perspectiveIsAtDefault()) return rotatedRect;
  const mapUV = mapUnitSquareToQuad(perspectiveQuad);
  return rotatedRect.map((p) => mapUV(p.x / w, p.y / h));
}

// true, если quad — простой выпуклый четырёхугольник (без самопересечений и вогнутых углов):
// у всех 4 последовательных поворотов (векторное произведение соседних рёбер) один и тот же
// знак. Вся остальная геометрия рамки обрезки (quadEdges и всё, что на нём построено) трактует
// quad как пересечение 4 полуплоскостей — это верно только для выпуклого случая; для вогнутого
// или самопересекающегося ("бабочка") quad та же формула молча считает неверный, но формально
// проходящий проверки результат (см. clampCornerToConvexQuad, где это используется, чтобы не
// пускать перспективу в такое положение вообще)
function isConvexQuad(quad) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4], c = quad[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-6) continue; // почти коллинеарные точки — само по себе не нарушение
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

// не даёт перетаскиванию угла перспективы завести quad в вогнутое/самопересекающееся положение
// (см. isConvexQuad) — предыдущий кадр гарантированно валиден (это инвариант, поддерживаемый
// каждый вызов), поэтому вместо жёсткого запрета ищем бинарным поиском вдоль отрезка
// "старая точка -> курсор" самую дальнюю ещё допустимую точку: угол свободно тянется куда
// угодно, пока это не ломает выпуклость, а на границе плавно "упирается", а не дёргается
function clampCornerToConvexQuad(quad, cornerIdx, candidate) {
  const old = quad[cornerIdx];
  const isValid = (pt) => {
    const q = quad.slice();
    q[cornerIdx] = pt;
    return isConvexQuad(q);
  };
  if (isValid(candidate)) return candidate;
  let lo = 0, hi = 1; // lo — доля пути от old к candidate, гарантированно валидная
  for (let i = 0; i < 20; i++) {
    const t = (lo + hi) / 2;
    const pt = { x: old.x + (candidate.x - old.x) * t, y: old.y + (candidate.y - old.y) * t };
    if (isValid(pt)) lo = t; else hi = t;
  }
  return { x: old.x + (candidate.x - old.x) * lo, y: old.y + (candidate.y - old.y) * lo };
}

// для выпуклого четырёхугольника quad возвращает его 4 ребра с единым (согласованным)
// направлением обхода — знак sign подобран так, что "cross(e, P-v)*sign >= 0" верно для
// ЛЮБОЙ точки P внутри quad, независимо от того, в какую сторону (по часовой/против) заданы
// исходные вершины
function quadEdges(quad) {
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  return quad.map((v, i) => {
    const v2 = quad[(i + 1) % 4];
    const e = { x: v2.x - v.x, y: v2.y - v.y };
    const cross = e.x * (cy - v.y) - e.y * (cx - v.x);
    return { v, e, sign: cross >= 0 ? 1 : -1 };
  });
}

// клэмпит точку внутрь пересечения полуплоскостей (по одной на каждое условие
// { ex, ey, vx, vy, sign, margin }, где условие "внутри" — это
// (ex*(y-vy) - ey*(x-vx))*sign + margin >= 0) — несколько проходов проекции точки на
// каждое нарушенное условие по очереди (стандартный POCS), для выпуклого пересечения всего
// 3-4 полуплоскостей нескольких проходов достаточно для визуально точной сходимости
function clampPointToHalfplanes(x, y, constraints) {
  for (let pass = 0; pass < 8; pass++) {
    let violated = false;
    for (const cst of constraints) {
      const g = (cst.ex * (y - cst.vy) - cst.ey * (x - cst.vx)) * cst.sign + cst.margin;
      if (g < 0) {
        violated = true;
        const gx = -cst.ey * cst.sign, gy = cst.ex * cst.sign;
        const gradLenSq = gx * gx + gy * gy;
        if (gradLenSq > 1e-9) {
          const t = -g / gradLenSq;
          x += t * gx;
          y += t * gy;
        }
      }
    }
    if (!violated) break;
  }
  return { x, y };
}

// допустимое положение рамки заданного размера (rw x rh) при переносе внутри произвольного
// выпуклого четырёхугольника quad (видимой границы фото — см. photoVisibleQuad). Рамка
// остаётся осе-выровненной на экране, но все её 4 угла должны оставаться внутри quad; для
// каждого ребра quad "самый выступающий" угол рамки (в направлении наружу этого ребра)
// определяет, насколько нужно поджать ребро внутрь — получаем полуплоскости уже
// непосредственно для положения (x,y) рамки, а не для её углов
function clampMoveToQuad(x, y, rw, rh, quad) {
  const corners = [{ x: 0, y: 0 }, { x: rw, y: 0 }, { x: 0, y: rh }, { x: rw, y: rh }];
  const constraints = quadEdges(quad).map(({ v, e, sign }) => {
    let margin = Infinity;
    for (const o of corners) {
      const val = (e.x * o.y - e.y * o.x) * sign;
      if (val < margin) margin = val;
    }
    return { ex: e.x, ey: e.y, vx: v.x, vy: v.y, sign, margin };
  });
  return clampPointToHalfplanes(x, y, constraints);
}

// та же идея для растягивания за угол: анкорный (противоположный) угол рамки неподвижен
// (и уже лежит внутри quad), размер растёт от него к курсору — для каждого ребра quad и
// каждого из 3 движущихся углов рамки условие "остаться внутри" линейно по доле роста t,
// берём наименьшую допустимую t по всем этим условиям сразу. Принимает уже готовый список
// рёбер (edges), а не сам quad — так его же можно переиспользовать и с добавленными рёбрами
// клип-прямоугольника (см. fitCropRectToAnchor), не только с рёбрами одного четырёхугольника
function clampResizeToEdges(anchor, rawW, rawH, signX, signY, edges) {
  if (rawW <= 0 || rawH <= 0) return { w: rawW, h: rawH };
  const movingCorners = [{ i: 1, j: 0 }, { i: 0, j: 1 }, { i: 1, j: 1 }];
  let maxT = 1;
  for (const { v, e, sign } of edges) {
    const gAnchor = (e.x * (anchor.y - v.y) - e.y * (anchor.x - v.x)) * sign;
    for (const { i, j } of movingCorners) {
      const dx = i * signX * rawW, dy = j * signY * rawH;
      const slope = (e.x * dy - e.y * dx) * sign;
      if (slope < 0) maxT = Math.min(maxT, gAnchor / -slope);
    }
  }
  maxT = clamp(maxT, 0, 1);
  return { w: rawW * maxT, h: rawH * maxT };
}

function clampResizeToQuad(anchor, rawW, rawH, signX, signY, quad) {
  return clampResizeToEdges(anchor, rawW, rawH, signX, signY, quadEdges(quad));
}

// какой угол рамки обрезки держать неподвижным, если её край сейчас "поджимает" перспектива —
// это угол, диагонально противоположный тому, что реально вылез за границу сильнее всего
// (гарантированно дальше всего от места вторжения). Выбирать анкор так заново на КАЖДОМ кадре
// перетаскивания небезопасно: как только рамка уже плотно вписана, margin у всех 4 углов
// почти одинаково мал, и сравнение между ними — уже сравнение шума, из-за которого анкор
// "перескакивал" с угла на угол и рамка со временем схлопывалась в случайном месте (см.
// onPointerMove/perspective-corner — там анкор фиксируется один раз на весь жест перетаскивания)
function pickCropShrinkAnchor(r, quad, clipW, clipH) {
  const edges = cropQuadClipEdges(quad, clipW, clipH);
  const corners = cropRectCorners(r);
  const marginOf = (c) => {
    let m = Infinity;
    for (const { v, e, sign } of edges) {
      const g = (e.x * (c.y - v.y) - e.y * (c.x - v.x)) * sign;
      if (g < m) m = g;
    }
    return m;
  };
  let violIdx = 0, worstMargin = Infinity;
  for (let i = 0; i < 4; i++) {
    const m = marginOf(corners[i]);
    if (m < worstMargin) { worstMargin = m; violIdx = i; }
  }
  return (violIdx + 2) % 4; // порядок corners — TL,TR,BR,BL: TL<->BR и TR<->BL
}

function cropQuadClipEdges(quad, clipW, clipH) {
  let edges = quadEdges(quad);
  if (clipW != null && clipH != null) {
    const clipRect = [{ x: 0, y: 0 }, { x: clipW, y: 0 }, { x: clipW, y: clipH }, { x: 0, y: clipH }];
    edges = edges.concat(quadEdges(clipRect));
  }
  return edges;
}

function cropRectCorners(r) {
  return [
    { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
  ];
}

// подгоняет рамку обрезки под текущий quad, держа неподвижным конкретный (уже выбранный,
// см. pickCropShrinkAnchor) угол рамки — в отличие от pickCropShrinkAnchor, вызывается на
// каждом кадре перетаскивания с одним и тем же anchorIdx, поэтому одинаково хорошо и сжимает
// рамку (перспектива поджала сильнее), и растит её обратно (перспектива отпустила): в обоих
// случаях считаем настоящий максимальный размер для этого анкора, а не только уменьшаем
// текущий
function fitCropRectToAnchor(r, quad, clipW, clipH, anchorIdx) {
  const edges = cropQuadClipEdges(quad, clipW, clipH);
  const corners = cropRectCorners(r);
  // знак направления, в котором рамка простирается от анкорного угла (TL/TR/BR/BL) —
  // противоположный (подвижный) угол лежит в сторону +signX/+signY от анкора
  const signXFor = [1, -1, -1, 1], signYFor = [1, 1, -1, -1];
  const anchor = corners[anchorIdx];
  const signX = signXFor[anchorIdx], signY = signYFor[anchorIdx];
  // clampResizeToEdges считает maxT не больше 1 (она сделана для живого перетаскивания ручки,
  // где rawW/rawH — это предел, дальше которого сам курсор не тянет) — передав ей текущий
  // r.w/r.h, мы бы разрешили только сжаться ещё сильнее и никогда не вырасти обратно, даже
  // если анкор теперь допускает больший прямоугольник. Поэтому передаём заведомо большой
  // размер той же пропорции — благодаря тому, что вся формула maxT линейна по rawW/rawH,
  // результат (rawW*maxT) от масштаба этого "большого" размера не зависит и равен настоящему
  // максимуму для данного анкора/направления
  const ratio = r.w / r.h;
  const bigW = (Math.max(clipW || 0, clipH || 0, r.w, r.h) + 1000) * 4;
  const bigH = bigW / ratio;
  const safe = clampResizeToEdges(anchor, bigW, bigH, signX, signY, edges);
  r.w = safe.w;
  r.h = safe.h;
  r.x = signX > 0 ? anchor.x : anchor.x - safe.w;
  r.y = signY > 0 ? anchor.y : anchor.y - safe.h;
}

// решает систему из трёх линейных уравнений A_i*x + B_i*y + C_i*z = -K_i (правило Крамера) —
// нужна для поиска вершин многогранника ограничений в maxInscribedRectInEdges
function solveLinear3(c1, c2, c3) {
  const M = [[c1.A, c1.B, c1.C], [c2.A, c2.B, c2.C], [c3.A, c3.B, c3.C]];
  const rhs = [-c1.K, -c2.K, -c3.K];
  const det = M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1])
    - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0])
    + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  if (Math.abs(det) < 1e-9) return null;
  const detX = rhs[0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1])
    - M[0][1] * (rhs[1] * M[2][2] - M[1][2] * rhs[2])
    + M[0][2] * (rhs[1] * M[2][1] - M[1][1] * rhs[2]);
  const detY = M[0][0] * (rhs[1] * M[2][2] - M[1][2] * rhs[2])
    - rhs[0] * (M[1][0] * M[2][2] - M[1][2] * M[2][0])
    + M[0][2] * (M[1][0] * rhs[2] - rhs[1] * M[2][0]);
  const detZ = M[0][0] * (M[1][1] * rhs[2] - rhs[1] * M[2][1])
    - M[0][1] * (M[1][0] * rhs[2] - rhs[1] * M[2][0])
    + rhs[0] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  return { x: detX / det, y: detY / det, z: detZ / det };
}

// перебором троек ограничений { A, B, C, K } вида "A*x + B*y + C*z + K >= 0" находит вершину
// многогранника, максимизирующую z — общий солвер линейной программы с 3 переменными,
// используется и для поиска максимального размера рамки, и (со своим набором ограничений)
// для последующего центрирования при уже найденном размере (см. maxInscribedRectInEdges)
function solveLP3Max(constraints) {
  const EPS = 1e-6;
  let best = null;
  const n = constraints.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        const sol = solveLinear3(constraints[i], constraints[j], constraints[k]);
        if (!sol) continue;
        let feasible = true;
        for (let m = 0; m < n; m++) {
          const c = constraints[m];
          if (c.A * sol.x + c.B * sol.y + c.C * sol.z + c.K < -EPS) { feasible = false; break; }
        }
        if (feasible && (!best || sol.z > best.z)) best = sol;
      }
    }
  }
  return best;
}

// вписывает НАИБОЛЬШИЙ по площади прямоугольник заданного соотношения сторон в выпуклую
// область, заданную списком полуплоскостей edges (обычно рёбра quad, при необходимости плюс
// рёбра клип-прямоугольника — см. rectForAspectInQuad). Центр рамки (cx, cy) — тоже свободная
// переменная наравне с размером: если сама область сильно несимметрична (сильная коррекция
// перспективы), рамка, прибитая к центроиду области, может быть в разы меньше реально
// помещающейся, просто сдвинутой в сторону свободного места.
//
// Максимальный размер часто достигается не в одной-единственной точке, а на целом отрезке/грани
// (например, простой прямоугольник, чьи пропорции не совпадают ровно с 9:16, — высота уже
// упёрлась в оба свои предела, а по ширине есть свободный ход в обе стороны). Первый проход
// (максимизация s) при переборе вершин многогранника может как раз попасть в один из краёв
// этого отрезка — рамку тогда прижмёт к углу, хотя вдоль одной из осей она могла бы стоять по
// центру. Поэтому вторым проходом, уже при найденном максимальном s, вместо произвольной вершины
// первого прохода ищем самую "центральную" точку — усредняем все вершины оставшейся (уже
// двумерной, при зафиксированном s) области допустимых позиций (см. ниже).
function maxInscribedRectInEdges(edges, aspectW, aspectH) {
  const ratio = aspectW / aspectH;
  const offsets = [
    { x: ratio, y: -1 }, { x: -ratio, y: -1 },
    { x: ratio, y: 1 }, { x: -ratio, y: 1 },
  ];
  // каждое ограничение — A*cx + B*cy + C*s + K >= 0
  const constraints = [];
  for (const { v, e, sign } of edges) {
    const A = -e.y * sign, B = e.x * sign;
    const K = sign * (e.y * v.x - e.x * v.y);
    for (const o of offsets) {
      const C = (e.x * o.y - e.y * o.x) * sign;
      constraints.push({ A, B, C, K });
    }
  }
  constraints.push({ A: 0, B: 0, C: 1, K: 0 }); // s >= 0

  const stage1 = solveLP3Max(constraints);
  if (!stage1 || stage1.z < -1e-6) return { x: 0, y: 0, w: 0, h: 0 }; // вырожденная (пустая) область
  const sMax = Math.max(0, stage1.z);

  // при зафиксированном sMax каждое ограничение "A*cx+B*cy+C*s+K>=0" превращается в плоское
  // "A*cx+B*cy+(K+C*sMax)>=0" — область допустимых (cx,cy) теперь двумерна (обычно вырождена
  // до отрезка или точки: как минимум одно направление уже "уперлось" в свой предел, раз s
  // максимален). Берём просто среднее по всем вершинам ЭТОЙ области (пересечениям пар прямых,
  // прошедшим проверку на допустимость) — для отрезка это его середина (то самое центрирование
  // вдоль ещё свободного направления), для одной точки — она и есть, для настоящего
  // многоугольника — среднее его вершин, тоже разумный, визуально центрированный выбор
  // (не пытаемся максимизировать общий отступ по Чебышёву: если один из двух исходных
  // размеров уже без запаса — как обычно и бывает при максимальном s, — общий минимальный
  // отступ по всем ограничениям всё равно упрётся в 0, и такая "центровка" вырождается в тот
  // же произвольный угол, что мы и чиним)
  const posConstraints = [];
  for (const c of constraints) {
    const L = Math.hypot(c.A, c.B);
    if (L < 1e-9) continue; // не зависит от cx,cy (это и есть само условие s>=0) — тут не участвует
    posConstraints.push({ A: c.A, B: c.B, K: c.K + c.C * sMax });
  }
  const EPS = 1e-6;
  let sumX = 0, sumY = 0, count = 0;
  const n2 = posConstraints.length;
  for (let i = 0; i < n2; i++) {
    for (let j = i + 1; j < n2; j++) {
      const a1 = posConstraints[i], a2 = posConstraints[j];
      const det = a1.A * a2.B - a2.A * a1.B;
      if (Math.abs(det) < 1e-9) continue;
      const x = (-a1.K * a2.B + a2.K * a1.B) / det;
      const y = (-a1.A * a2.K + a2.A * a1.K) / det;
      let feasible = true;
      for (const c of posConstraints) {
        if (c.A * x + c.B * y + c.K < -EPS) { feasible = false; break; }
      }
      if (feasible) { sumX += x; sumY += y; count++; }
    }
  }
  const cx = count > 0 ? sumX / count : stage1.x;
  const cy = count > 0 ? sumY / count : stage1.y;

  const h = 2 * sMax;
  const w = h * ratio;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

// вписывает наибольший (по площади, а не только по центру) прямоугольник заданного соотношения
// сторон в произвольный выпуклый quad (видимую границу фото — см. photoVisibleQuad).
// clipW/clipH — необязательные доп. пределы (обычно previewW/previewH): рамка ограничена не
// только рёбрами quad, но и этим прямоугольником, потому что сам рендер (варп/поворот) всегда
// физически обрезан по [0,clipW]x[0,clipH] — угол quad можно утянуть далеко наружу, а видимые
// (реально отрисованные) пиксели фото всё равно не выходят за эти границы
function rectForAspectInQuad(quad, aspectW, aspectH, clipW, clipH) {
  let edges = quadEdges(quad);
  if (clipW != null && clipH != null) {
    const clipRect = [{ x: 0, y: 0 }, { x: clipW, y: 0 }, { x: clipW, y: clipH }, { x: 0, y: clipH }];
    edges = edges.concat(quadEdges(clipRect));
  }
  return maxInscribedRectInEdges(edges, aspectW, aspectH);
}

// схлопывает частые вызовы (например, при перетаскивании ползунка поворота) в один
// перерисовку за кадр — иначе при быстром вводе canvas не успевает за событиями и "дёргается"
let renderRafId = null;
function requestRender() {
  if (renderRafId !== null) return;
  renderRafId = requestAnimationFrame(() => {
    renderRafId = null;
    render();
  });
}

function render() {
  const c = canvas();
  const cctx = ctx();
  const w = State.previewW, h = State.previewH;

  // в режиме перспективы canvas расширяется на фиксированный отступ вокруг фото (см.
  // perspectiveCanvasMargin) — иначе холсту физически негде рисовать углы/линии, утянутые за
  // пределы фото. Отступ фиксирован и меняется только при входе/выходе из режима перспективы,
  // повороте/зеркале или смене фото — не на каждый pointermove при перетаскивании.
  const margin = perspectiveCanvasMargin(w, h);
  const totalW = w + margin.left + margin.right;
  const totalH = h + margin.top + margin.bottom;
  if (c.width !== totalW) c.width = totalW;
  if (c.height !== totalH) c.height = totalH;
  const scale = canvasScale();

  el("rotate-value").textContent = State.rotationDeg.toFixed(1) + "°";

  cctx.fillStyle = "#0e0e10";
  cctx.fillRect(0, 0, totalW, totalH);

  cctx.save();
  cctx.translate(margin.left, margin.top);

  cctx.fillStyle = "#000";
  cctx.fillRect(0, 0, w, h);

  const baseBitmap = State.displayBitmap || State.previewBitmap;
  if (State.perspectiveMode && State.perspectiveQuad && !perspectiveIsAtDefault()) {
    renderWarpedPerspective(cctx, baseBitmap, w, h);
  } else {
    drawRotatedAt(cctx, baseBitmap, State.rotationDeg, 0, 0);
  }

  if (State.cropVisible) renderCropDarken(cctx, w, h);

  if (State.showGrid) renderGrid(cctx, w, h);

  if (State.cropVisible) renderCropFrame(cctx, scale, w, h);
  if (State.perspectiveMode) renderPerspectiveFrame(cctx, scale, w, h);

  cctx.restore();
}

function renderCropDarken(cctx, w, h) {
  cctx.fillStyle = "rgba(0,0,0,0.55)";
  const r = State.cropRect;
  cctx.fillRect(0, 0, w, r.y);
  cctx.fillRect(0, r.y + r.h, w, h - r.y - r.h);
  cctx.fillRect(0, r.y, r.x, r.h);
  cctx.fillRect(r.x + r.w, r.y, w - r.x - r.w, r.h);
}

function renderCropFrame(cctx, scale, w, h) {
  const r = State.cropRect;
  cctx.strokeStyle = "#4da3ff";
  cctx.lineWidth = 2;
  cctx.strokeRect(r.x, r.y, r.w, r.h);

  // угловые ручки — размер в единицах канваса, но зависит от масштаба показа,
  // чтобы визуально оставаться постоянного размера на экране
  cctx.fillStyle = "#4da3ff";
  const handleVisualR = HANDLE_VISUAL_CSS * scale;
  for (const [hx, hy] of cornerPoints(r)) {
    const [cxp, cyp] = insetIntoCanvas(hx, hy, handleVisualR, w, h);
    cctx.beginPath();
    cctx.arc(cxp, cyp, handleVisualR, 0, Math.PI * 2);
    cctx.fill();
  }
}

// не даёт кругу ручки вылезти за пределы canvas и срезаться его краем —
// центр чуть подвигаем внутрь, сам круг при этом рисуется целиком
function insetIntoCanvas(x, y, r, w, h) {
  return [clamp(x, r, w - r), clamp(y, r, h - r)];
}

// печёт поворот (State.rotationDeg) в отдельный канвас нужного размера (как это делает
// drawRotatedAt для основного render), а затем прогоняет его через настоящий проективный
// варп — углы прямоугольника фото переходят в State.perspectiveQuad. Это и есть сама
// коррекция перспективы: деформация всей картинки целиком (аналогично тому, как поворот
// деформирует всю картинку и даёт чёрные уголки), а не вырезание/обрезка по контуру quad —
// финальную обрезку получившихся пустых мест делает уже обычная рамка кропа
function renderWarpedPerspective(cctx, bitmap, w, h) {
  const rotated = document.createElement("canvas");
  rotated.width = w;
  rotated.height = h;
  drawRotatedAt(rotated.getContext("2d"), bitmap, State.rotationDeg, 0, 0);
  const warped = warpRectToQuad(rotated, State.perspectiveQuad, w, h);
  cctx.drawImage(warped, 0, 0);
}

function renderPerspectiveFrame(cctx, scale, w, h) {
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
  const handleVisualR = HANDLE_VISUAL_CSS * scale;
  // канвас теперь резервирует отступ вокруг фото (см. perspectiveCanvasMargin), так что
  // ручку можно рисовать прямо в её настоящей точке, даже далеко за пределами фото
  for (const pt of q) {
    cctx.beginPath();
    cctx.arc(pt.x, pt.y, handleVisualR, 0, Math.PI * 2);
    cctx.fill();
  }
}

function renderGrid(cctx, w, h) {
  cctx.save();

  cctx.strokeStyle = "rgba(255,255,255,0.25)";
  cctx.lineWidth = 1.5;
  for (let i = 1; i < 30; i++) {
    if (i % 10 === 0) continue;
    const x = (w * i) / 30;
    cctx.beginPath();
    cctx.moveTo(x, 0);
    cctx.lineTo(x, h);
    cctx.stroke();
    const y = (h * i) / 30;
    cctx.beginPath();
    cctx.moveTo(0, y);
    cctx.lineTo(w, y);
    cctx.stroke();
  }

  cctx.strokeStyle = "rgba(77,163,255,0.85)";
  cctx.lineWidth = 2.5;
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

// координаты события в системе координат ФОТО (0..previewW/0..previewH) — та же система, что
// и у State.perspectiveQuad/State.cropRect. Канвас в режиме перспективы физически шире фото
// на отступ (см. perspectiveCanvasMargin), поэтому отступ вычитается здесь же, один раз, а не
// в каждом месте, которое читает координаты события. НЕ прижимаем их к границам фото —
// перетаскивание угла коррекции перспективы должно уметь выходить за пределы фото (иначе
// невозможно вытянуть угол наружу для устранения перспективных искажений), а рамка обрезки
// сама клэмпится ниже, в onPointerMove, по месту
function canvasPointFromEvent(evt) {
  const c = canvas();
  const rect = c.getBoundingClientRect();
  const scaleX = c.width / rect.width;
  const scaleY = c.height / rect.height;
  const margin = perspectiveCanvasMargin(State.previewW, State.previewH);
  return {
    x: (evt.clientX - rect.left) * scaleX - margin.left,
    y: (evt.clientY - rect.top) * scaleY - margin.top,
  };
}

function onPointerDown(evt) {
  const p = canvasPointFromEvent(evt);

  // обе рамки могут быть видны одновременно — сперва проверяем ручки перспективы
  // (у неё нет переноса всей рамки, только углы), и если промах — пробуем рамку обрезки
  if (State.perspectiveMode && State.perspectiveQuad) {
    const quad = State.perspectiveQuad;
    const scale = canvasScale();
    for (let i = 0; i < quad.length; i++) {
      if (Math.hypot(p.x - quad[i].x, p.y - quad[i].y) <= HANDLE_HIT_CSS * scale) {
        State.dragMode = "perspective-corner";
        State.dragCorner = i;
        State.perspectiveCropAnchor = null; // якорь рамки обрезки выбирается заново на новый жест
        // рамка ещё нигде вручную не подвинута — весь этот жест держим её максимально вписанной
        State.perspectiveCropTrackMax = !State.cropRect || cropIsAtDefault();
        canvas().setPointerCapture(evt.pointerId);
        return;
      }
    }
  }

  if (!State.cropVisible) return;

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
    // угол коррекции перспективы намеренно можно тянуть за пределы фото — именно это и
    // создаёт нужную деформацию (устранение перспективных искажений, в т.ч. сильных, широкоугольных),
    // а не обрезку; предел — щедрый, но конечный отступ от канваса, чтобы не получить
    // вырожденный (самопересекающийся) четырёхугольник
    const marginX = w * 1.5, marginY = h * 1.5;
    const candidate = {
      x: clamp(p.x, -marginX, w + marginX),
      y: clamp(p.y, -marginY, h + marginY),
    };
    // не позволяем quad'у стать вогнутым/самопересекающимся — иначе вся геометрия рамки
    // обрезки (построенная на предположении о выпуклом quad, см. quadEdges) даёт молчаливо
    // неверный результат, из-за которого рамка могла "замереть" в неверном положении до тех
    // пор, пока пользователь не пересоздаст её вручную (см. isConvexQuad)
    State.perspectiveQuad[State.dragCorner] = clampCornerToConvexQuad(State.perspectiveQuad, State.dragCorner, candidate);
    if (!perspectiveIsAtDefault()) showCropFrame();
    if (State.cropRect) {
      const visibleQuad = photoVisibleQuad(w, h, State.rotationDeg, State.perspectiveQuad);
      if (State.perspectiveCropTrackMax) {
        // рамка на начало этого жеста была в положении "по умолчанию" (максимально вписана) —
        // значит нет никакой ручной правки, которую нужно бережно сохранять от кадра к кадру,
        // и рамку просто держим равной настоящему максимуму на каждом кадре: тогда она
        // одинаково естественно и сжимается, когда перспектива поджимает, и растёт обратно,
        // когда место освобождается (в т.ч. сразу с самого начала жеста, а не только после
        // того, как её один раз пришлось ужать)
        const best = rectForAspectInQuad(visibleQuad, State.aspect.w, State.aspect.h, w, h);
        State.cropRect.x = best.x;
        State.cropRect.y = best.y;
        State.cropRect.w = best.w;
        State.cropRect.h = best.h;
      } else {
        // рамку обрезки трогаем, только если перспектива увела видимую область ВНУТРЬ настолько,
        // что рамка перестала в неё помещаться — тогда её нужно ужать до максимально возможного
        // размера. Если же угол потянули НАРУЖУ и рамка по-прежнему целиком внутри видимой
        // области — её не трогаем вообще, она остаётся ровно там, где её оставил пользователь
        // (эта ветка — только для рамки, уже вручную подвинутой/подрезанной пользователем, см.
        // perspectiveCropTrackMax)
        // анкор (какой угол рамки неподвижен) выбирается один раз за весь жест — на первом кадре,
        // где рамка перестала помещаться, — и дальше держится тем же все кадры подряд: так рамка
        // может не только сжиматься (перспектива поджимает сильнее), но и расти обратно
        // (перспектива отпускает), а не только в одну сторону (см. pickCropShrinkAnchor)
        if (State.perspectiveCropAnchor == null && !cropRectFitsQuad(State.cropRect, visibleQuad, w, h)) {
          State.perspectiveCropAnchor = pickCropShrinkAnchor(State.cropRect, visibleQuad, w, h);
        }
        if (State.perspectiveCropAnchor != null) {
          fitCropRectToAnchor(State.cropRect, visibleQuad, w, h, State.perspectiveCropAnchor);
          // fitCropRectToAnchor держит угол рамки, выбранный анкором ещё в начале жеста, как
          // неподвижную точку отсчёта — вся её математика верна только пока эта точка сама лежит
          // внутри видимой области. Когда перспектива меняется достаточно резко (например угол
          // одной из сторон переходит через ноль и меняет знак наклона), сам анкор может выйти за
          // новую границу — тогда результат получается уже не просто неоптимальным, а вообще
          // недопустимым (торчит за пределы), причём иногда даже БОЛЬШИМ по размеру, чем настоящий
          // максимум — поэтому сравнивать площади тут недостаточно, нужно явно проверять
          // геометрическую годность результата. В этом случае просто пересчитываем рамку заново
          // тем же способом, что и сброс (rectForAspectInQuad), и отпускаем анкор — он подберётся
          // заново, когда/если рамка в следующий раз перестанет помещаться
          if (!cropRectFitsQuad(State.cropRect, visibleQuad, w, h)) {
            const best = rectForAspectInQuad(visibleQuad, State.aspect.w, State.aspect.h, w, h);
            State.cropRect.x = best.x;
            State.cropRect.y = best.y;
            State.cropRect.w = best.w;
            State.cropRect.h = best.h;
            State.perspectiveCropAnchor = null;
          }
        }
      }
    }
    refreshDirty();
    requestRender();
    return;
  }

  const r = State.cropRect;
  // истинная видимая область фото учитывает и поворот, и (если активна) коррекцию
  // перспективы — рамка обрезки не должна вылезать ни за одну из этих двух границ
  const visibleQuad = photoVisibleQuad(w, h, State.rotationDeg, State.perspectiveQuad);

  if (State.dragMode === "move") {
    // сперва свободно (в пределах канваса), затем поджимаем к реально видимой
    // области фото — рамка может скользить вдоль её краёв, а не залипать в
    // одном-единственном центрированном положении
    const x = clamp(p.x - State.dragStart.x, 0, w - r.w);
    const y = clamp(p.y - State.dragStart.y, 0, h - r.h);
    const safe = clampMoveToQuad(x, y, r.w, r.h, visibleQuad);
    r.x = safe.x;
    r.y = safe.y;
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

    // не выходить за пределы канваса
    const maxW = signX > 0 ? w - anchor.x : anchor.x;
    const maxH = signY > 0 ? h - anchor.y : anchor.y;
    if (newW > maxW) { newW = maxW; newH = newW / ratio; }
    if (newH > maxH) { newH = maxH; newW = newH * ratio; }

    // и отдельно — за пределы реально видимой области фото
    const safe = clampResizeToQuad(anchor, newW, newH, signX, signY, visibleQuad);
    newW = safe.w; newH = safe.h;
    if (newW < 30) { newW = 30; newH = newW / ratio; }

    r.w = newW; r.h = newH;
    r.x = signX > 0 ? anchor.x : anchor.x - newW;
    r.y = signY > 0 ? anchor.y : anchor.y - newH;
  }
  clampCropRectToCanvas(r, w, h);
  requestRender();
}

function onPointerUp(evt) {
  if (State.dragMode === "move" || State.dragMode === "resize") {
    refreshDirty();
  }
  State.dragMode = null;
  State.perspectiveCropAnchor = null;
  try { canvas().releasePointerCapture(evt.pointerId); } catch (_) {}
}

async function ensureOriginalsHandle() {
  if (!State.originalsHandle) {
    State.originalsHandle = await State.albumHandle.getDirectoryHandle(ORIGINALS_DIR, { create: true });
  }
  return State.originalsHandle;
}

// «Папка альбомов» (State.rootHandle) может содержать несколько альбомов как прямых
// подпапок, каждый — произвольной глубины внутри себя (Camera 1/Camera 2/…). Альбом для
// данного handle'а — тот прямой потомок rootHandle, что является им самим или его предком;
// именно на его уровне должны жить "-Albom" и ничего глубже. Идём вверх по State.folderParents
// (a не вниз от rootHandle) — так не нужен отдельный обход дерева.
function resolveAlbumFolder(handle) {
  if (!handle || !State.rootHandle || handle === State.rootHandle) return State.rootHandle;
  let current = handle;
  let parent = State.folderParents.get(current);
  while (parent && parent !== State.rootHandle) {
    current = parent;
    parent = State.folderParents.get(current);
  }
  return parent ? current : State.rootHandle;
}

async function ensureCuratedHandle() {
  if (!State.curatedHandle) {
    // если такая папка уже найдена при сканировании (пусть и под старым именем после
    // переименования альбома) — используем её, иначе создаём новую на уровне альбома
    const parent = resolveAlbumFolder(State.albumHandle);
    const folderName = State.curatedDirName || parent.name + ALBUM_SUFFIX;
    const isNewFolder = !State.curatedDirName;
    State.curatedHandle = await parent.getDirectoryHandle(folderName, { create: true });
    State.curatedDirName = folderName;
    // если "-Albom" создаётся впервые, у родительской папки трипа появляется первый дочерний
    // узел — но стрелку раскрытия дерева слева посчитали один раз при построении узла и без
    // явного обновления она так и останется пустой (см. createFolderNode/initialSubdirs)
    if (isNewFolder) {
      const refresh = State.folderExpanders.get(parent);
      if (refresh) await refresh();
    }
  }
  return State.curatedHandle;
}

async function ensureDeletedHandle() {
  if (!State.deletedHandle) {
    // одна общая корзина на всю «Папку альбомов», а не на каждый альбом отдельно
    State.deletedHandle = await State.rootHandle.getDirectoryHandle(DELETED_DIR, { create: true });
  }
  return State.deletedHandle;
}

// перемещает текущее фото из рабочей папки в общую корзину DELETED_DIR в корне альбома
// (State.rootHandle) — бэкап в [Originals] и куррейтед-копию в "-Albom" не трогаем, они не
// про "показывать это фото", а про историю правок/избранное, удаление файла их не отменяет
async function deleteCurrentPhoto() {
  if (State.index < 0) return;
  const item = State.queue[State.index];
  setStatus("status-bar", "Удаляю " + item.name + "...");

  try {
    const deletedHandle = await ensureDeletedHandle();
    if (typeof item.handle.move === "function") {
      await item.handle.move(deletedHandle, item.name);
    } else {
      const file = await item.handle.getFile();
      const destHandle = await deletedHandle.getFileHandle(item.name, { create: true });
      const writable = await destHandle.createWritable();
      await writable.write(file);
      await writable.close();
      await verifyWrittenSize(destHandle, file.size, "перемещение в «Deleted»: " + item.name);
      await State.albumHandle.removeEntry(item.name);
    }

    const removedIndex = State.index;
    const generation = ++State.albumGeneration;
    await scanFiles();
    State.albumGeo = new Array(State.queue.length).fill(null);
    if (State.queue.length === 0) {
      showEmptyAlbum();
      return;
    }
    buildGrid();
    generateThumbnails(generation);
    collectAlbumGeo(generation);
    State.index = -1;
    await selectPhoto(Math.min(removedIndex, State.queue.length - 1));
    setStatus("status-bar", "Удалено: " + item.name);
  } catch (e) {
    console.error("Ошибка удаления", item.name, e);
    setStatus("status-bar", "Ошибка удаления " + item.name + ": " + describeSaveError(e));
  }
}

// createWritable() отказывает характерной формулировкой Chromium'а, когда у файла на диске
// стоит атрибут Windows "только для чтения" — сама File System Access API не даёт странице
// снять этот атрибут (в ней нет аналога chmod), это можно сделать только вне браузера.
// Вместо сырого текста ошибки показываем понятную инструкцию, что делать руками
function describeSaveError(e) {
  if (/read-only file/i.test(e.message)) {
    return "файл помечен «только для чтения» в Windows — сам браузер не может это снять. "
      + "В Проводнике: правой кнопкой по файлу → Свойства → снять галочку «Только для чтения» → ОК, и повторить";
  }
  return e.message;
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
    setStatus("status-bar", "Ошибка: " + describeSaveError(e));
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

    // коррекция перспективы, как и поворот, деформирует всё изображение целиком (в fullCanvas,
    // ещё до кропа) — итоговую вырезку из получившегося результата делает та же самая, уже
    // существующая рамка обрезки, что и для обычного (без перспективы) фото, без отдельной ветки
    let sourceCanvas = fullCanvas;
    if (State.perspectiveMode && State.perspectiveQuad && !perspectiveIsAtDefault()) {
      setStatus("status-bar", "Обрабатываю перспективу " + item.name + "...");
      const fullQuad = State.perspectiveQuad.map((pt) => ({ x: pt.x * scale, y: pt.y * scale }));
      sourceCanvas = warpRectToQuad(fullCanvas, fullQuad, fullCanvas.width, fullCanvas.height);
    }
    // рамка обрезки скрыта (State.cropVisible === false) — значит пользователь кроп не
    // использует, и сохранять нужно фото целиком (после поворота/перспективы, но без
    // навязанного пресетного кадра), а не то, что осталось в State.cropRect от предыдущего
    // показа рамки (например, ещё до её выключения)
    let fullRect;
    if (State.cropVisible) {
      clampCropRectToCanvas(State.cropRect, State.previewW, State.previewH);
      fullRect = {
        x: State.cropRect.x * scale,
        y: State.cropRect.y * scale,
        w: State.cropRect.w * scale,
        h: State.cropRect.h * scale,
      };
    } else {
      fullRect = { x: 0, y: 0, w: sourceCanvas.width, h: sourceCanvas.height };
    }
    const outCanvas = exportCrop(sourceCanvas, fullRect, colorOpts);
    const rawBlob = await new Promise((resolve) => outCanvas.toBlob(resolve, "image/jpeg", 0.92));
    // canvas.toBlob() стирает весь EXIF — возвращаем камеру/дату/GPS исходного фото
    const blob = await injectExif(rawBlob, State.currentExif);

    const originalsHandle = await ensureOriginalsHandle();
    if (!item.edited) {
      // первое сохранение этого фото — уводим нетронутый оригинал в папку бэкапов
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
    await loadPhoto(item, blob); // blob уже в памяти — не перечитываем только что записанный файл с диска

    setStatus("status-bar", "Сохранено: " + item.name);
  } catch (e) {
    console.error("Ошибка сохранения", item.name, e);
    setStatus("status-bar", "Ошибка сохранения " + item.name + ": " + describeSaveError(e));
  }
}

// сразу после createWritable().close() чтение через тот же хэндл иногда на миг отдаёт
// не до конца прилетевший размер (кэш ФС/антивирус) — пара коротких повторов вместо
// немедленного отказа убирает ложные "восстановление/сохранение не удалось"
async function verifyWrittenSize(fileHandle, expectedSize, label) {
  const delays = [0, 60, 200];
  let lastSize = -1;
  for (const delay of delays) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const writtenFile = await fileHandle.getFile();
    lastSize = writtenFile.size;
    if (lastSize === expectedSize) return;
  }
  throw new Error(
    `после записи "${label}" размер файла не совпал (ожидался ${expectedSize} байт, на диске ${lastSize} байт)`
  );
}

async function restoreOriginal() {
  const item = State.queue[State.index];
  if (!item.edited) return;
  setStatus("status-bar", "Восстанавливаю оригинал " + item.name + "...");

  let originalsHandle, backupFile;
  try {
    originalsHandle = await ensureOriginalsHandle();
    backupFile = await (await originalsHandle.getFileHandle(item.name)).getFile();

    const writable = await item.handle.createWritable();
    await writable.write(backupFile);
    await writable.close();
    await verifyWrittenSize(item.handle, backupFile.size, item.name);
  } catch (e) {
    console.error("Ошибка восстановления", item.name, e);
    setStatus("status-bar", "Ошибка восстановления " + item.name + ": " + describeSaveError(e));
    return;
  }

  // главное сделано — файл на диске восстановлен; дальше обновляем состояние и вид
  // независимо от того, получится ли подчистить сопутствующие копии ниже — иначе сбой
  // уборки в папке бэкапов/куррейтед-папке (например, файл на миг занят антивирусом) откатывал
  // бы уже состоявшееся восстановление, и альбом с превью оставались бы необновлёнными
  const wasStarred = item.starred;
  item.edited = false;
  updateThumbBadge(State.index);
  el("restore-btn").disabled = true;
  if (wasStarred) {
    item.starred = false;
    updateThumbStar(State.index);
    updateStarButton(item);
  }

  await regenerateThumbFromFile(item, backupFile);
  updateThumbImg(State.index);
  await loadPhoto(item, backupFile); // backupFile уже в памяти — не перечитываем с диска
  setStatus("status-bar", "Оригинал восстановлен: " + item.name);

  // бэкап и куррейтед-копия больше не нужны — уборка не критична для результата,
  // поэтому её сбой только логируется, не мешая уже показанному восстановлению
  try {
    await originalsHandle.removeEntry(item.name);
  } catch (e) {
    console.warn("Не удалось удалить резервную копию из папки бэкапов", item.name, e);
  }
  if (wasStarred) {
    try {
      const curatedHandle = await ensureCuratedHandle();
      await curatedHandle.removeEntry(item.name);
    } catch (e) {
      console.warn("Не удалось удалить копию из куррейтед-альбома", item.name, e);
    }
  }
}

// выбор формата кадра без видимой рамки обрезки непонятен — не видно, что́ он вообще
// обрежет, поэтому select показываем синхронно с самой рамкой, а не отдельным переключателем
function syncCropFrameUI() {
  el("reset-btn").classList.toggle("active", State.cropVisible);
  el("aspect-control").hidden = !State.cropVisible;
}

// рамка обрезки скрыта по умолчанию — эта кнопка включает/выключает её показ; сбрасывает
// рамку на формат по умолчанию в обе стороны (и при включении, и при выключении) — иначе
// после ручной правки рамки, скрытой и показанной заново, оставалось бы старое положение,
// которое пользователь уже не видел и не ожидает найти
function toggleCropFrame() {
  State.cropVisible = !State.cropVisible;
  syncCropFrameUI();
  resetCropRect();
  refreshDirty();
  render();
}

// поворот (жёсткий на 90°/зеркало или точная подстройка угла) почти всегда требует потом
// подрезать съехавшие края — сразу показываем рамку обрезки, чтобы не заставлять искать
// эту кнопку отдельно каждый раз после поворота
function showCropFrame() {
  if (State.cropVisible) return;
  State.cropVisible = true;
  syncCropFrameUI();
}

// полноэкранный просмотр (двойной клик по фото, кнопка "Полный экран" или слайдшоу — все три
// ведут в один и тот же настоящий Fullscreen API на canvas-wrap) — только сама фотография,
// без панелей; переход между фото — стрелками/колесом (см. onViewerKeydown/canvas-wrap wheel)
function enterFullscreen() {
  if (!State.fullBitmap || document.fullscreenElement) return;
  el("canvas-wrap").requestFullscreen();
}

function isFullscreenViewer() {
  return document.fullscreenElement === el("canvas-wrap");
}

function toggleFullscreenBtn() {
  if (isFullscreenViewer()) document.exitFullscreen();
  else enterFullscreen();
}

// вход и выход из fullscreen пересчитывают масштаб одним и тем же fitPreviewToWindow — раньше
// вход отдавали чистому CSS (object-fit: contain), а это давало canvas шириной/высотой во весь
// экран с картинкой внутри "в рамке" (letterbox); getBoundingClientRect() такого canvas
// возвращал размер всего экрана, а не видимой части фото — из-за этого при первом переходе
// слайдшоу снимок для наплыва (snapshotFadeFrame) растягивался на весь экран. Явный px-размер
// от fitPreviewToWindow всегда точно облегает видимую картинку, этой рассинхронизации не будет
function onFullscreenChange() {
  const active = isFullscreenViewer();
  el("fullscreen-btn").classList.toggle("active", active);
  fitPreviewToWindow();
  if (!active) {
    // Esc/системный выход из fullscreen во время слайдшоу — гасим его вместе с ним; проверяем
    // класс кнопки, а не slideshowTimer — таймер ещё не выставлен, пока startSlideshow ждёт
    // сканирование папки "Music", но кнопка уже помечена активной
    if (el("slideshow-btn").classList.contains("active")) stopSlideshow();
  }
}

let slideshowTimer = null;
let slideshowGeneration = 0; // растёт при каждом старте/остановке — отличает актуальный запуск от отменённого во время await
const MUSIC_EXT = /\.(mp3|m4a|aac|ogg|wav|flac)$/i;
let musicObjectUrl = null; // текущий URL проигрываемого трека — освобождаем перед каждой заменой

// слайдшоу — тот же настоящий Fullscreen API, что и обычный полноэкранный просмотр,
// плюс автопереход по таймеру; поэтому Esc сам его останавливает через onFullscreenChange
function toggleSlideshow() {
  if (el("slideshow-btn").classList.contains("active")) stopSlideshow();
  else startSlideshow();
}

// папка "Music" в корне дерева (рядом с папками альбома) — необязательная: если её нет,
// слайдшоу просто идёт без звука; результат кэшируется на State.rootHandle, чтобы не
// пересканировать диск при каждом запуске/остановке слайдшоу в одной и той же сессии
async function ensureMusicPlaylist() {
  if (State.musicRootHandle === State.rootHandle) return State.musicFiles;
  State.musicRootHandle = State.rootHandle;
  State.musicFiles = [];
  if (!State.rootHandle) return State.musicFiles;
  try {
    const musicHandle = await State.rootHandle.getDirectoryHandle("Music");
    const files = [];
    for await (const entry of musicHandle.values()) {
      if (entry.kind === "file" && MUSIC_EXT.test(entry.name)) files.push(entry);
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    State.musicFiles = files;
  } catch (_) {
    // папки "Music" нет в корне альбома — фоновая музыка необязательна
  }
  return State.musicFiles;
}

async function playMusicTrack(index) {
  const files = State.musicFiles;
  if (files.length === 0) return;
  const audio = el("slideshow-audio");
  const file = await files[index % files.length].getFile();
  if (musicObjectUrl) URL.revokeObjectURL(musicObjectUrl);
  musicObjectUrl = URL.createObjectURL(file);
  audio.src = musicObjectUrl;
  // без пользовательского жеста браузер мог бы заблокировать автовоспроизведение, но
  // слайдшоу и так запускается по клику — жест уже есть
  audio.play().catch(() => {});
}

function stopMusic() {
  const audio = el("slideshow-audio");
  audio.onended = null;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  if (musicObjectUrl) {
    URL.revokeObjectURL(musicObjectUrl);
    musicObjectUrl = null;
  }
}

async function startSlideshow() {
  if (slideshowTimer || State.queue.length === 0) return;
  const myGeneration = ++slideshowGeneration;
  el("slideshow-btn").classList.add("active");
  if (!isFullscreenViewer()) el("canvas-wrap").requestFullscreen();

  const playlist = await ensureMusicPlaylist();
  if (myGeneration !== slideshowGeneration) return; // слайдшоу уже остановили, пока читали папку "Music"
  if (playlist.length > 0) {
    const audio = el("slideshow-audio");
    let trackIndex = Math.floor(Math.random() * playlist.length);
    audio.onended = () => {
      trackIndex = (trackIndex + 1) % playlist.length;
      playMusicTrack(trackIndex);
    };
    playMusicTrack(trackIndex);
  }

  slideshowTimer = setInterval(async () => {
    // при несохранённых правках молча останавливаемся, а не выскакиваем с диалогом
    // "сохранить?" поверх слайдшоу без присмотра пользователя
    if (State.dirty) { stopSlideshow(); return; }
    snapshotFadeFrame(); // накрываем текущий кадр его собственным снимком — сейчас под ним начнёт рисоваться следующий
    await selectPhoto((State.index + 1) % State.queue.length); // основной canvas уже перерисован под снимком, зритель этого не видит
    dissolveFadeFrame(); // и только теперь плавно растворяем снимок сверху — наплыв, а не затухание в чёрное
  }, 4000);
}

// копирует текущий кадр в наложенный сверху canvas (пиксели один в один, тот же видимый размер)
// и мгновенно показывает его непрозрачным — без анимации, это лишь подготовка к наплыву
function snapshotFadeFrame() {
  const src = canvas();
  const fade = el("slideshow-fade-canvas");
  fade.width = src.width;
  fade.height = src.height;
  fade.getContext("2d").drawImage(src, 0, 0);
  // берём фактический отображаемый размер (getBoundingClientRect), а не style.width/height —
  // в fullscreen размер задаёт CSS (object-fit: contain), инлайновых width/height там нет
  const rect = src.getBoundingClientRect();
  fade.style.width = rect.width + "px";
  fade.style.height = rect.height + "px";
  fade.style.transition = "none"; // без этого прыжок в opacity:1 сам мгновенно анимировался бы transition'ом ниже
  fade.style.opacity = "1";
  void fade.offsetHeight; // форсируем reflow, чтобы браузер применил opacity:1 без анимации до возврата transition
  fade.style.transition = "";
}

// плавно растворяет снимок предыдущего кадра, открывая уже отрисованный под ним следующий — наплыв
function dissolveFadeFrame() {
  el("slideshow-fade-canvas").style.opacity = "0";
}

// безопасно вызывать в любой момент — в том числе пока startSlideshow ещё не успел выставить
// slideshowTimer (ждёт ensureMusicPlaylist): все шаги ниже — идемпотентные no-op на пустом состоянии
function stopSlideshow() {
  slideshowGeneration++; // отменяет незавершённый запуск, если он есть
  clearInterval(slideshowTimer);
  slideshowTimer = null;
  el("slideshow-btn").classList.remove("active");
  el("slideshow-fade-canvas").style.opacity = "0"; // на случай остановки посреди наплыва
  stopMusic();
  if (isFullscreenViewer()) document.exitFullscreen();
}

// панели слева/снизу можно скрыть вручную кнопками в верхней панели состояния — независимо
// от полноэкранного просмотра, просто чтобы освободить место под фото в обычном окне
function toggleLeftPanel() {
  const shown = document.body.classList.toggle("hide-left") === false;
  el("toggle-left-btn").classList.toggle("active", shown);
}

// кнопки "низ"/"вправо" переключают, где стоит лента привью — не независимая пара
// показать/скрыть, а взаимоисключающий выбор стороны: клик по уже активной стороне просто
// прячет/показывает ленту там же (старое поведение), клик по другой стороне переносит ленту
// туда (и включает её, если до этого была скрыта)
function toggleBottomPanel() {
  const body = document.body;
  if (body.classList.contains("panel-right")) {
    body.classList.remove("panel-right");
    body.classList.remove("hide-bottom");
    // ширина ленты (её собственный "боковой" размер) больше не действует в нижнем режиме —
    // иначе унаследованный inline-стиль ужимает ленту, растянутую по CSS на всю ширину
    el("album-grid").style.width = "";
  } else {
    body.classList.toggle("hide-bottom");
  }
  syncPreviewPanelButtons();
  savePanelMode();
  updateThumbSizing();
}

function toggleRightPanel() {
  const body = document.body;
  if (!body.classList.contains("panel-right")) {
    body.classList.add("panel-right");
    body.classList.remove("hide-bottom");
    // и наоборот — высота, унаследованная от нижнего режима, не должна мешать ленте
    // растянуться на всю доступную высоту в боковом режиме
    el("album-grid").style.height = "";
  } else {
    body.classList.toggle("hide-bottom");
  }
  syncPreviewPanelButtons();
  savePanelMode();
  updateThumbSizing();
}

function syncPreviewPanelButtons() {
  const body = document.body;
  const shown = !body.classList.contains("hide-bottom");
  const right = body.classList.contains("panel-right");
  el("toggle-bottom-btn").classList.toggle("active", shown && !right);
  el("toggle-right-btn").classList.toggle("active", shown && right);
}

// запоминает текущее положение ленты (снизу/сбоку, показана/скрыта), чтобы при следующем
// открытии редактора она открылась там же, где её оставили — раньше всегда стартовала снизу
function savePanelMode() {
  const body = document.body;
  const right = body.classList.contains("panel-right") ? "right" : "bottom";
  const hidden = body.classList.contains("hide-bottom") ? "-hidden" : "";
  localStorage.setItem(PANEL_MODE_STORAGE_KEY, right + hidden);
}

// пересчитывает высоту миниатюр под текущую высоту ленты в нижнем режиме (одна строка,
// перенос не нужен — лишнее уезжает по горизонтали, см. .thumb в style.css). В боковом режиме
// размер миниатюр не считается тут вообще — ширина фиксирована (3см), высота идёт от
// пропорций кадра, всё через CSS (см. .thumb в style.css) — вместо этого пересчитывается
// одностолбцовый режим (см. updateColumnMode)
function updateThumbSizing() {
  const grid = el("album-grid");
  if (document.body.classList.contains("panel-right")) {
    updateColumnMode(grid);
    return;
  }
  const h = grid.getBoundingClientRect().height;
  const size = Math.max(30, h - 20);
  grid.style.setProperty("--thumb-size", size + "px");
}

// если по ширине ленты помещается только один столбец миниатюр, второй (недоступный) столбец
// не имеет смысла — вместо обрезанной по ширине сетки со скроллом на пару пикселей включаем
// единый список в один столбец с обычной вертикальной прокруткой (см. .single-column в
// style.css); как только ширины хватает на два столбца — возвращаемся к обычной раскладке
// столбцами с горизонтальной прокруткой между ними
function updateColumnMode(grid) {
  const thumb = grid.querySelector(".thumb");
  const single = !!thumb && grid.clientWidth < thumb.getBoundingClientRect().width * 2 + 2;
  grid.classList.toggle("single-column", single);
}

// стрелки листают фото по всей ленте — и в обычном окне, и в полноэкранном просмотре/слайдшоу
// (переход всегда идёт через goToPhoto, так что спросит про сохранение, если в текущем фото
// есть несохранённые правки); не перехватываем стрелки, когда они нужны для чего-то другого —
// ползунок угла, выпадающий список формата, поля ввода, модалки, палитра
function onViewerKeydown(evt) {
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Delete"].includes(evt.key)) return;
  if (!State.fullBitmap) return;
  if (!el("unsaved-modal").hidden || !el("about-modal").hidden) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

  // Delete отправляет текущее фото в корзину сразу, без подтверждения — по просьбе Григория
  // это должно ускорять отбор кадров, а не тормозить его лишним диалогом
  if (evt.key === "Delete") {
    if (State.colorPickerActive) return;
    evt.preventDefault();
    deleteCurrentPhoto();
    return;
  }

  // в подборе цвета лента показывает не фото альбома, а варианты текущего кадра — тем же
  // порядком стрелок листаем их, а не State.queue
  if (State.colorPickerActive) {
    const current = el("album-grid").querySelector(".variant-thumb.active") || el("album-grid").querySelector(".variant-thumb");
    const next = current && findGridNeighbor(current, evt.key);
    if (!next) return;
    evt.preventDefault();
    next.click();
    return;
  }

  const current = thumbAt(State.index);
  const next = current && findGridNeighbor(current, evt.key);
  if (!next) return;
  evt.preventDefault();
  goToPhoto(+next.dataset.index);
}

// находит соседнюю миниатюру по стрелке. В нижнем режиме миниатюры — один горизонтальный ряд,
// сосед по стрелке влево/вправо — это просто соседний элемент по DOM (вверх/вниз там смысла не
// имеют).
// В боковом режиме — настоящие столбцы (flex-wrap), там нужны все четыре стрелки: вверх/вниз —
// сосед в том же столбце, влево/вправо — переход в соседний столбец. DOM-порядок тут не годится
// ни для одной из осей (на границе столбца следующий элемент по DOM — это первый элемент
// СЛЕДУЮЩЕГО столбца, а не сосед снизу/сверху; а элементы одного столбца в DOM вообще не соседи
// элементов соседнего). Поэтому ищем геометрически: для вверх/вниз — среди элементов, чей
// горизонтальный диапазон пересекается с текущим (тот же столбец), ближайший по вертикали; для
// влево/вправо — среди элементов, чей вертикальный диапазон пересекается с текущим (та же
// "строка"), ближайший по горизонтали. Если геометрического соседа нет (упёрлись в верх/низ
// столбца) — вверх/вниз продолжают листать по порядку фото (DOM-порядок в боковом режиме и есть
// порядок фото: сверху вниз по столбцу, затем с начала следующего столбца), пока не кончится
// альбом. Для влево/вправо такого запасного варианта нет — если соседней "строки" нет, стрелка
// просто ничего не делает (без зацикливания)
function findGridNeighbor(current, key) {
  const right = document.body.classList.contains("panel-right");
  if (!right && (key === "ArrowUp" || key === "ArrowDown")) return null;
  const items = [...current.parentElement.children];
  if (!right) {
    const idx = items.indexOf(current);
    return items[idx + (key === "ArrowLeft" ? -1 : 1)] || null;
  }
  const vertical = key === "ArrowUp" || key === "ArrowDown";
  const forward = key === "ArrowDown" || key === "ArrowRight";
  const cur = current.getBoundingClientRect();
  let best = null, bestDist = Infinity;
  for (const item of items) {
    if (item === current) continue;
    const r = item.getBoundingClientRect();
    if (vertical) {
      if (r.left >= cur.right || r.right <= cur.left) continue;
      const dist = forward ? r.top - cur.top : cur.top - r.top;
      if (dist > 0 && dist < bestDist) { bestDist = dist; best = item; }
    } else {
      if (r.top >= cur.bottom || r.bottom <= cur.top) continue;
      const dist = forward ? r.left - cur.left : cur.left - r.left;
      if (dist > 0 && dist < bestDist) { bestDist = dist; best = item; }
    }
  }
  if (vertical && !best) {
    const idx = items.indexOf(current);
    best = items[idx + (forward ? 1 : -1)] || null;
  }
  return best;
}

// сброс угла в 0 без статус-сообщения "задан вручную" (в отличие от onRotateInput) — используется,
// когда угол сбрасывается автоматически (скрыли ползунок точной настройки, выключили автогоризонт),
// а не пользователем через сам ползунок
function resetRotationAngle() {
  State.rotationDeg = 0;
  el("rotate-slider").value = 0;
  resetCropRect();
  refreshDirty();
  requestRender();
}

function onRotateInput(evt) {
  State.rotationDeg = parseFloat(evt.target.value);
  // пользователь сам поправил угол вручную — сообщение об ошибке автогоризонта (не нашёл
  // линию / угол слишком большой) больше не актуально и будет противоречить видимому углу;
  // явно говорим, что дальше это уже ручная правка, а не оценка автогоризонта
  setStatus("status-bar", "Угол задан вручную — не проверял.");
  // рамка динамически следит за реально видимым (без чёрных углов) краем повёрнутого фото —
  // при увеличении угла она уменьшается, чтобы показывать только целую картинку; должна
  // пересчитаться РАНЬШЕ refreshDirty(), иначе cropIsAtDefault() сравнивает новый угол со
  // старой (ещё не пересчитанной) рамкой и застревает в dirty:true даже при возврате к 0
  resetCropRect();
  // текст лейбла обновляем в render() (раз за кадр), а не на каждое сырое input-событие —
  // нативный слайдер при перетаскивании может слать их гораздо чаще кадра, и текстовый
  // reflow на каждое из них заметно подтормаживал сам ползунок
  refreshDirty();
  if (!State.showGrid) {
    State.showGrid = true;
    el("grid-btn").classList.add("active");
  }
  // ненулевой угол заваливает чёрные уголки по краям — без рамки обрезки их легко забыть
  // подрезать и сохранить фото прямо с ними
  showCropFrame();
  requestRender();
}

// смена формата рамки — выбор запоминается (localStorage) и действует для всех фото альбома,
// пока пользователь не сменит его вручную ещё раз
function onAspectChange(evt) {
  const preset = ASPECT_PRESETS.find((p) => p.key === evt.target.value) || ASPECT_PRESETS[0];
  State.aspect = preset;
  localStorage.setItem(ASPECT_STORAGE_KEY, preset.key);
  // выбор формата кадра без видимой рамки обрезки непонятен — не видно, что вообще изменилось
  State.cropVisible = true;
  syncCropFrameUI();
  resetCropRect();
  refreshDirty();
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
  if (State.perspectiveMode) {
    // рамку перспективы стартуем от истинных краёв фото (а не от узкой рамки обрезки под
    // выбранный формат) — коррекцию перспективы обычно делают на всём кадре, до кропа
    const w = State.previewW, h = State.previewH;
    State.perspectiveQuad = [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ];
  } else {
    // выключили режим — сама правка (утянутые углы) тоже сбрасывается, а не просто прячется;
    // при следующем включении квад стартует заново от истинных краёв фото (см. выше)
    State.perspectiveQuad = null;
  }
  // рамку обрезки включение/выключение перспективы не трогает (см. onPointerMove) — она
  // остаётся там, где её оставил пользователь
  refreshDirty();
  // канвас при входе/выходе из режима перспективы резко меняет размер (появляется/пропадает
  // отступ под ручки, см. perspectiveCanvasMargin) — это не плавная подстройка под окно (как при
  // ресайзе браузера), а мгновенная смена режима, поэтому и вписываем в окно без CSS-анимации
  // (см. fitPreviewToWindowInstant/loadPhoto) — иначе на время transition канвас с уже
  // перерисованным (новым) содержимым пришлось бы силой втискивать в старый CSS-размер, и
  // фото на глазах "сплющивалось/растягивалось" все 0.2с анимации.
  // Важно сделать это ДО render(): canvasScale() (радиус ручек) считает соотношение
  // canvas.width к реальному CSS-размеру на экране — если сначала отрисовать (новый большой
  // canvas.width), а CSS-размер ещё старый (маленький, без отступа), ручки на один кадр
  // получаются в разы крупнее нормального
  fitPreviewToWindowInstant();
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
  grid.classList.add("color-picker-mode");
  grid.innerHTML = "";
  const variants = await generateColorVariants();
  grid.innerHTML = "";
  variants.forEach(({ preset, url }, i) => {
    const btn = document.createElement("button");
    btn.className = "thumb variant-thumb";
    btn.dataset.index = i;
    if (State.colorVariant.key === preset.key) btn.classList.add("active");
    btn.title = preset.label;

    const img = document.createElement("img");
    img.src = url;
    img.alt = preset.label;
    img.classList.add("loaded"); // без этого класса миниатюра остаётся opacity:0 (чёрный квадрат) —
    // "loaded" обычно навешивается при подгрузке фонового thumbUrl, а тут картинка уже готова сразу
    btn.appendChild(img);

    const label = document.createElement("span");
    label.className = "variant-label";
    label.textContent = preset.label;
    btn.appendChild(label);

    btn.addEventListener("click", () => selectColorVariant(preset, btn));
    // один клик — примерка варианта без выхода из подбора (чтобы можно было сравнивать
    // несколько подряд), двойной клик — явное "выбрал, закрываю"
    btn.addEventListener("dblclick", () => exitColorVariantPicker());
    grid.appendChild(btn);
  });
  // вариантов обычно меньше, чем фото в альбоме — число строк на столбец в боковом режиме
  // пересчитываем под новое количество элементов ленты
  updateThumbSizing();
}

// собирает миниатюру текущего фото с уже применённым цветовым вариантом — не трогая диск,
// только для показа в альбоме после возврата из подбора (см. loadPhoto: та же логика
// "записать в память, затем показать", что и после сохранения/восстановления)
function buildColoredCroppedCanvas() {
  const canvas = getCroppedPreviewCanvas();
  if (State.colorVariant.key === COLOR_VARIANTS[0].key) return canvas; // "Оригинал" — обработка не нужна
  const ctx = canvas.getContext("2d");
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  applyColorTreatment(imgData, {
    saturationBoost: State.colorVariant.saturationBoost,
    clipPercent: State.colorVariant.clipPercent,
    warm: State.colorVariant.warm,
  });
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

async function selectColorVariant(preset, btn) {
  State.colorVariant = preset;
  refreshDirty();
  refreshDisplayBitmap();
  requestRender();
  // сетка сейчас показывает варианты, а не фото альбома — подсвечиваем выбранный вариант,
  // а не тянем highlightActiveThumb()/updateThumbImg(), которые перепутали бы содержимое кнопок
  el("album-grid").querySelectorAll(".variant-thumb").forEach((b) => b.classList.toggle("active", b === btn));
  const item = State.queue[State.index];
  if (item) await regenerateThumbFromFile(item, buildColoredCroppedCanvas());
}

function exitColorVariantPicker() {
  State.colorPickerActive = false;
  el("color-btn").classList.remove("active");
  el("album-grid").classList.remove("color-picker-mode");
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

async function openAboutModal() {
  el("about-modal").hidden = false;
  const input = el("root-path-input");
  input.disabled = !State.rootHandle;
  // раньше значение бралось из State.rootAbsolutePath без загрузки из IndexedDB — оно
  // подгружалось лениво только через ensureRootAbsolutePath/openFolderInExplorer, поэтому
  // поле в настройках выглядело пустым (как будто сброшенным) до первого клика "Открыть в
  // Проводнике" в новой сессии, хотя сохранённое значение никуда не пропадало
  await loadSavedRootAbsolutePath();
  input.value = State.rootAbsolutePath || "";
}
function closeAboutModal() { el("about-modal").hidden = true; }

// режим просмотра готовых альбомов: дерево слева временно заменяется плоским списком
// папок "…-Albom" (найденных findAlbumFolders на любой глубине). Строки — те же
// createFolderNode, что и в обычном дереве, поэтому открытие/переименование/двойной клик
// в Проводник работают одинаково и там, и там
async function renderAlbumsView() {
  const container = el("folder-tree");
  container.innerHTML = "<p class=\"albums-list-empty\">Поиск…</p>";
  pushBusyCursor();
  try {
    // findAlbumFolders обходит дерево заново и по пути сама заполняет folderParents
    // (см. её реализацию) — поэтому карты сбрасываем перед вызовом, как и buildFolderTree
    State.folderRows = new Map();
    State.folderParents = new Map();
    State.folderExpanders = new Map();
    State.folderChildren = new Map();
    const albums = await findAlbumFolders();
    State.albumsList = albums;
    container.innerHTML = "";
    if (albums.length === 0) {
      container.innerHTML = "<p class=\"albums-list-empty\">Папки «…-Albom» не найдены</p>";
      return;
    }
    const list = document.createElement("ul");
    list.className = "folder-tree-list";
    for (const album of albums) {
      list.appendChild(await createFolderNode(album.handle));
    }
    container.appendChild(list);
  } finally {
    popBusyCursor();
  }
}

async function toggleAlbumsView() {
  if (!State.rootHandle) return;
  if (!State.albumsViewActive) {
    State.albumsViewActive = true;
    el("albums-list-btn").classList.add("active");
    await renderAlbumsView();
    // глобус теперь всегда значит "все готовые альбомы, по одной метке на каждый" — включаем
    // его вместе с режимом "Альбомы" и сразу запускаем фоновый поиск геоданных по списку
    setGlobeButtonEnabled(true);
    State.albumsGeo = new Array(State.albumsList.length).fill(null);
    collectAlbumsGeo(++State.albumsGeoGeneration);
    return;
  }
  State.albumsViewActive = false;
  el("albums-list-btn").classList.remove("active");
  setGlobeButtonEnabled(false);
  // путь берём ДО перестройки дерева (buildFolderTree сбрасывает folderParents) — на этот
  // момент карта ещё та, что построил findAlbumFolders внутри renderAlbumsView, и в ней уже
  // есть цепочка предков и для альбома, открытого кликом по строке списка альбомов
  const activePath = State.albumHandle ? folderNamePath(State.albumHandle) : [];
  State.treeBuildPromise = buildFolderTree(State.rootHandle).catch((e) => console.error("Ошибка построения дерева папок", e));
  await State.treeBuildPromise;
  const target = await expandTreeToPath(activePath);
  const row = State.folderRows.get(target);
  if (row) highlightFolderRow(row);
}

// путь, который пользователь вручную набрал/поправил в настройках — тот же путь, что раньше
// спрашивался всплывающим prompt() только при первом клике "Открыть в Проводнике" (см.
// ensureRootAbsolutePath), теперь его можно увидеть и поменять в любой момент
async function saveRootAbsolutePathFromInput() {
  if (!State.rootHandle) return;
  const input = el("root-path-input");
  const path = input.value.replace(/[\\/]+$/, "");
  State.rootAbsolutePath = path || null;
  input.value = State.rootAbsolutePath || "";
  try {
    await idbSet("rootAbsolutePath", State.rootAbsolutePath);
    await idbSet("rootAbsolutePathName", State.rootHandle.name);
  } catch (_) {
    // необязательная удобная фича
  }
}

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
  opts.onResize?.();

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
      opts.onResize?.();
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
  // клик мышью по любой кнопке тулбара (сменить фото, включить рамку/перспективу и т.п.)
  // иначе оставляет на ней нативную рамку фокуса, которая никуда не девается при дальнейшей
  // работе — как и для миниатюр альбома (см. buildGrid), гасим фокус только по клику мышью;
  // Tab с клавиатуры по-прежнему фокусирует кнопки как обычно
  document.addEventListener("mousedown", (evt) => {
    if (evt.target.closest("button")) evt.preventDefault();
  });

  // панель параметров всегда подстраивается под контент (см. CSS) — высота
  // больше не сохраняется вручную; убираем инлайн-высоту, оставшуюся от
  // старого перетаскиваемого разделителя, если она есть в localStorage
  localStorage.removeItem("folderTreeHeight");
  localStorage.removeItem("propertiesPanelHeight");
  el("folder-tree").style.height = "";
  el("properties-panel").style.height = "";

  const savedAspectKey = localStorage.getItem(ASPECT_STORAGE_KEY);
  State.aspect = ASPECT_PRESETS.find((p) => p.key === savedAspectKey) || ASPECT_PRESETS[0];
  el("aspect-select").value = State.aspect.key;
  el("aspect-select").addEventListener("change", onAspectChange);

  const savedAutoHorizon = localStorage.getItem(AUTO_HORIZON_STORAGE_KEY);
  State.autoHorizonEnabled = savedAutoHorizon === null ? true : savedAutoHorizon === "1";
  el("auto-horizon-btn").classList.toggle("active", State.autoHorizonEnabled);
  el("auto-horizon-btn").addEventListener("click", toggleAutoHorizon);

  // положение ленты привью (снизу/сбоку, показана/скрыта) запоминается между сеансами —
  // см. savePanelMode() в toggleBottomPanel/toggleRightPanel; без сохранённого значения лента
  // остаётся в исходном нижнем режиме, заданном в разметке
  const savedPanelMode = localStorage.getItem(PANEL_MODE_STORAGE_KEY);
  if (savedPanelMode) {
    document.body.classList.toggle("panel-right", savedPanelMode.startsWith("right"));
    document.body.classList.toggle("hide-bottom", savedPanelMode.endsWith("-hidden"));
  }
  syncPreviewPanelButtons();

  // порядок папок в дереве слева — по умолчанию "сначала новые" (State.folderSortMode),
  // выбор запоминается между сеансами; смена варианта перестраивает дерево целиком (дёшево:
  // buildFolderTree подгружает только корень, вложенные узлы — лениво по клику, как обычно)
  const savedSortMode = localStorage.getItem(FOLDER_SORT_STORAGE_KEY);
  if (savedSortMode) State.folderSortMode = savedSortMode;
  el("folder-sort-select").value = State.folderSortMode;
  el("folder-sort-select").addEventListener("change", async (evt) => {
    State.folderSortMode = evt.target.value;
    localStorage.setItem(FOLDER_SORT_STORAGE_KEY, State.folderSortMode);
    evt.target.blur(); // без этого выбранный option оставляет вокруг select синее кольцо фокуса, будто кнопка залипла
    if (State.albumsViewActive) {
      // Раньше здесь ошибочно вызывался toggleAlbumsView() — это тумблер, и вызов посреди
      // активного режима Альбомы попросту выключал его. Сортировка касается только списка
      // папок ("Проводник"): плоского списка альбомов (findAlbumFolders учитывает
      // State.folderSortMode) — его просто перерисовываем; порядок фото внутри уже открытого
      // альбома сортировкой не затрагивается (scanFiles всегда по имени), поэтому там делать нечего.
      // Перерисовываем всегда, а не только при State.index < 0 — открытие альбома кликом по
      // строке списка не выключает albumsViewActive (см. клик по name в createFolderNode), так
      // что список остаётся на экране и при открытом альбоме; старая проверка из-за этого молча
      // игнорировала смену сортировки в этом, самом частом, случае.
      await renderAlbumsView();
      if (State.albumHandle) {
        const row = State.folderRows.get(State.albumHandle);
        if (row) highlightFolderRow(row);
      }
      return;
    }
    if (State.rootHandle) {
      // перестройка дерева сбрасывает раскрытые узлы к одному корню — сразу же раскрываем его
      // обратно до текущего открытого альбома (folderNamePath/expandTreeToPath — тот же приём,
      // что и restoreFocusInTree при старте), чтобы пользователь не терял место в дереве
      const activePath = State.albumHandle ? folderNamePath(State.albumHandle) : [];
      State.treeBuildPromise = buildFolderTree(State.rootHandle).catch((e) => console.error("Ошибка построения дерева папок", e));
      await State.treeBuildPromise;
      const target = await expandTreeToPath(activePath);
      const row = State.folderRows.get(target);
      if (row) highlightFolderRow(row);
    }
  });

  el("settings-btn").addEventListener("click", openAboutModal);
  el("about-close-btn").addEventListener("click", closeAboutModal);
  el("about-modal").addEventListener("click", (evt) => {
    if (evt.target.id === "about-modal") closeAboutModal();
  });

  el("albums-list-btn").addEventListener("click", toggleAlbumsView);
  el("root-path-input").addEventListener("blur", saveRootAbsolutePathFromInput);
  el("root-path-input").addEventListener("keydown", (evt) => {
    if (evt.key === "Enter") { evt.preventDefault(); el("root-path-input").blur(); }
  });

  // "Установить на рабочий стол" — сама кнопка живёт всегда (см. правило про disabled вместо
  // hidden), но реально включается только когда браузер сам решил, что приложение
  // устанавливаемо, и прислал beforeinstallprompt; без него/после установки — остаётся disabled
  let deferredInstallPrompt = null;
  window.addEventListener("beforeinstallprompt", (evt) => {
    evt.preventDefault();
    deferredInstallPrompt = evt;
    el("install-btn").disabled = false;
  });
  el("install-btn").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    el("install-btn").disabled = true;
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    el("install-btn").disabled = true;
  });
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  el("properties-edit-btn").addEventListener("click", () => {
    State.copyMode = !State.copyMode;
    el("properties-edit-btn").classList.toggle("active", State.copyMode);
    document.querySelectorAll("#properties-list .properties-copy-btn").forEach((b) => {
      b.style.visibility = State.copyMode ? "visible" : "hidden";
    });
    document.querySelectorAll("#properties-list .properties-edit-input").forEach((input) => {
      input.disabled = !State.copyMode;
    });
    // обе карты должны узнать о смене режима сразу — от неё зависит, кликабельны ли
    // капли (встроенная карта) и разрешено ли ставить точку кликом по фону (окно карты)
    refreshMaps();
  });
  el("properties-map-btn").addEventListener("click", toggleEmbeddedMap);
  el("properties-map-new-btn").addEventListener("click", toggleLocationMapWindow);
  el("globe-btn").addEventListener("click", toggleGlobeWindow);
  // сообщения из отдельных окон map.html/globe.html: готовность к получению точек, клик по
  // капле карты (переход к фото или геопривязка) или клик по метке глобуса (открыть альбом)
  window.addEventListener("message", async (e) => {
    if (e.source !== State.mapWindow && e.source !== State.globeWindow) return;
    const data = e.data || {};
    if (data.type === "map-ready") {
      refreshMaps();
      return;
    }
    if (data.type === "globe-ready") {
      refreshAlbumsGlobe();
      return;
    }
    if (data.type === "globe-entered-album") {
      // Нырок с глобуса шлёт openAlbumIndex и globe-entered-album ОДНИМ сообщением (не
      // двумя раздельными postMessage, как было раньше) — раньше это был реальный источник
      // бага: слушатель "message" async, и каждое сообщение диспетчится своим отдельным
      // вызовом, так что ветка globe-entered-album успевала вызвать refreshMaps() ДО того,
      // как соседний вызов для openAlbumIndex дожидался открытия альбома — глобус получал
      // activeIndex ещё от предыдущего состояния (или -1, если альбом вообще не был открыт),
      // из-за чего его внутренняя логика фокуса необратимо ломалась на весь сеанс режима
      // альбома (переставал срабатывать зум-выход). Открытие альбома теперь всегда
      // дожидаемся здесь же, ДО того как включить globeAlbumMode и позвать refreshMaps().
      if (typeof data.openAlbumIndex === "number") {
        const entry = State.albumsList[data.openAlbumIndex];
        if (entry) {
          const row = State.folderRows.get(entry.handle);
          if (row) highlightFolderRow(row);
          await openAlbum(entry.handle);
          try {
            await idbSet("lastFocusedPath", folderNamePath(entry.handle));
          } catch (_) {
            // необязательная удобная фича
          }
        }
      }
      State.globeAlbumMode = true;
      refreshMaps(); // сразу шлём точки текущего альбома — иначе первая карта пуста до смены фото
      return;
    }
    if (data.type === "globe-left-album") {
      State.globeAlbumMode = false;
      return;
    }
    if (data.type === "globe-preview-album") {
      // Лёгкая подсветка строки альбома-кандидата в проводнике во время "зоны принятия
      // решения" на глобусе (см. Часть C плана) — намеренно НЕ вызывает openAlbum():
      // полное открытие сканирует диск и перестраивает сетку фото на каждую смену цели
      // при простом вращении, это было бы слишком дорого для живого отклика.
      if (typeof data.index === "number") {
        const entry = State.albumsList[data.index];
        const row = entry && State.folderRows.get(entry.handle);
        if (row) highlightFolderRow(row);
      }
      return;
    }
    if (data.type === "globe-preview-clear") {
      // вышли из зоны принятия решения без нырка/клика — вернуть подсветку строке
      // реально открытого сейчас альбома (если есть), а не оставлять чужую строку
      // подсвеченной без основания
      const row = State.albumHandle && State.folderRows.get(State.albumHandle);
      if (row) highlightFolderRow(row);
      else el("folder-tree").querySelectorAll(".folder-node-row.active").forEach((r) => r.classList.remove("active"));
      return;
    }
    if (typeof data.focusIndex === "number") {
      goToPhoto(data.focusIndex);
      return;
    }
    if (typeof data.openAlbumIndex === "number") {
      const entry = State.albumsList[data.openAlbumIndex];
      if (!entry) return;
      const row = State.folderRows.get(entry.handle);
      if (row) highlightFolderRow(row);
      await openAlbum(entry.handle);
      try {
        await idbSet("lastFocusedPath", folderNamePath(entry.handle));
      } catch (_) {
        // необязательная удобная фича
      }
      return;
    }
    if (e.source === State.mapWindow && typeof data.lat === "number" && typeof data.lon === "number") {
      setCurrentGeo(data.lat, data.lon);
    }
  });
  // окно глобуса — отдельная вкладка ОС, она не закрывается сама вместе с этой страницей;
  // без этого при закрытии приложения глобус остаётся висеть и больше не получает сообщений
  window.addEventListener("pagehide", () => {
    if (State.globeWindow && !State.globeWindow.closed) State.globeWindow.close();
  });

  el("open-album-btn").addEventListener("click", pickAlbum);

  el("rotate-slider").addEventListener("input", onRotateInput);
  el("rotate-toggle-btn").addEventListener("click", () => {
    const slider = el("rotate-slider");
    slider.hidden = !slider.hidden;
    el("rotate-toggle-btn").classList.toggle("active", !slider.hidden);
    // сетка помогает выставлять угол по линиям — включаем её вместе со слайдером поворота,
    // как и при автогоризонте (см. autoDetectHorizon); выключать при скрытии слайдера не
    // нужно — так же сетка не гасится сама нигде больше в редакторе
    if (!slider.hidden) {
      if (!State.showGrid) {
        State.showGrid = true;
        el("grid-btn").classList.add("active");
      }
      // открыли точную настройку угла — значит вот-вот появятся чёрные уголки по краям,
      // рамку обрезки показываем заранее, а не только когда угол реально станет ненулевым
      showCropFrame();
      render();
    } else {
      // закрыли точную настройку угла — сама правка тоже сбрасывается, а не просто прячется
      resetRotationAngle();
    }
  });
  el("rotate-value").addEventListener("click", () => {
    if (el("rotate-slider").disabled) return;
    el("rotate-slider").value = 0;
    onRotateInput({ target: el("rotate-slider") });
  });
  el("rotate-left-btn").addEventListener("click", () => rotateQuarter(-1));
  el("rotate-right-btn").addEventListener("click", () => rotateQuarter(1));
  el("flip-btn").addEventListener("click", flipHorizontal);
  el("reset-btn").addEventListener("click", toggleCropFrame);
  el("grid-btn").addEventListener("click", toggleGrid);
  el("perspective-btn").addEventListener("click", togglePerspectiveMode);
  el("color-btn").addEventListener("click", toggleColorPicker);
  el("restore-btn").addEventListener("click", restoreOriginal);
  el("star-btn").addEventListener("click", toggleStar);
  el("prev-btn").addEventListener("click", prevPhoto);
  el("next-btn").addEventListener("click", nextPhoto);
  el("save-btn").addEventListener("click", saveCurrent);
  el("delete-btn").addEventListener("click", deleteCurrentPhoto);
  el("slideshow-btn").addEventListener("click", toggleSlideshow);
  el("fullscreen-btn").addEventListener("click", toggleFullscreenBtn);
  el("toggle-left-btn").addEventListener("click", toggleLeftPanel);
  el("toggle-bottom-btn").addEventListener("click", toggleBottomPanel);
  el("toggle-right-btn").addEventListener("click", toggleRightPanel);
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("keydown", onViewerKeydown);
  // настоящее изменение размера окна браузера (в т.ч. и то, которым сопровождается сам вход
  // в fullscreen/выход из него — оно может занять больше кадра, поэтому это ещё и подстраховка
  // для onFullscreenChange) — перетаскивание внутренних разделителей панелей это событие не
  // поднимает (см. makeResizable — те двигают только свои элементы через inline-стили), поэтому
  // у них ниже свой отдельный вызов fitPreviewToWindowInstant через onResize
  window.addEventListener("resize", () => { fitPreviewToWindow(); updateThumbSizing(); });

  makeResizable(el("resizer-vertical"), el("left-column"), "x", {
    sign: 1, storageKey: "folderTreeWidth", onResize: fitPreviewToWindowInstant,
  });
  makeResizable(el("resizer-horizontal"), el("album-grid"), "y", {
    sign: -1, storageKey: "albumGridHeight",
    onResize: () => { updateThumbSizing(); fitPreviewToWindowInstant(); },
  });
  makeResizable(el("resizer-right"), el("album-grid"), "x", {
    sign: -1, max: 2000, storageKey: "albumGridWidth",
    onResize: () => { updateThumbSizing(); fitPreviewToWindowInstant(); },
  });
  // ширина ленты (только что восстановленная выше из localStorage через storageKey) имеет
  // смысл только в боковом режиме — в нижнем лента и так растягивается на всю ширину через
  // flex, а унаследованный инлайн-стиль только мешал бы этому; и наоборот — сохранённая высота
  // нижнего режима, если восстановились сразу в боковой (см. savedPanelMode выше), обрезала бы
  // ленту по высоте прошлой сессии нижнего режима вместо того, чтобы растянуться на всю боковую
  // панель — раньше это не всплывало, потому что toggleRightPanel() всегда сбрасывал высоту
  // сам, а восстановление режима при старте идёт в обход него
  if (document.body.classList.contains("panel-right")) {
    el("album-grid").style.height = "";
  } else {
    el("album-grid").style.width = "";
  }
  updateThumbSizing();

  const c = canvas();
  c.addEventListener("pointerdown", onPointerDown);
  c.addEventListener("pointermove", onPointerMove);
  c.addEventListener("pointerup", onPointerUp);
  c.addEventListener("pointercancel", onPointerUp);
  c.addEventListener("dblclick", enterFullscreen);

  el("canvas-wrap").addEventListener("wheel", (evt) => {
    if (!State.fullBitmap) return;
    evt.preventDefault();
    // в полноэкранном просмотре (и слайдшоу — он тот же fullscreen) колесо листает фото вместо зума
    if (isFullscreenViewer()) {
      const delta = Math.abs(evt.deltaX) > Math.abs(evt.deltaY) ? evt.deltaX : evt.deltaY;
      if (delta > 0) nextPhoto(); else if (delta < 0) prevPhoto();
      return;
    }
    setPreviewZoom(State.previewZoom * (evt.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  el("album-grid").addEventListener("wheel", (evt) => {
    if (evt.deltaX === 0 && evt.deltaY === 0) return;
    evt.preventDefault();
    const grid = el("album-grid");
    // позиция в альбоме листается по той оси, у которой сейчас есть прокрутка: в нижнем режиме
    // и в боковом многостолбцовом — это scrollLeft (столбцы растянуты на всю высоту ленты,
    // движение происходит между ними по горизонтали); в боковом одностолбцовом (.single-column,
    // см. updateColumnMode()) — обычный список, там прокрутка вертикальная, scrollTop. Обычное
    // колесо мыши (deltaY) и горизонтальный свайп/колесо (deltaX) одинаково листают альбом — вне
    // зависимости от того, каким физически было движение, они складываются в одну актуальную ось.
    if (grid.classList.contains("single-column")) {
      grid.scrollTop += evt.deltaY + evt.deltaX;
    } else {
      grid.scrollLeft += evt.deltaY + evt.deltaX;
    }
  }, { passive: false });

  if (!window.showDirectoryPicker) {
    setStatus("status-bar", "Этот браузер не поддерживает File System Access API. Откройте страницу в Chrome или Edge.");
    el("open-album-btn").disabled = true;
    return;
  }

  tryRestoreLastAlbum();
}

init();
