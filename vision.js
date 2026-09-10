// Детекция горизонта через OpenCV.js. Возвращает угол выравнивания.

const Vision = {
  ready: false,
};

// opencv.js грузится асинхронно (<script async>), и его WASM-рантайм часто успевает
// полностью инициализироваться (cv.calledRun) раньше, чем мы вешаем колбэк
// onRuntimeInitialized — колбэк одноразовый, и если он уже "выстрелил" мимо нас,
// Vision.ready так и останется false навсегда. Поэтому просто опрашиваем текущее
// состояние cv напрямую вместо того, чтобы полагаться на колбэк.
(function pollOpenCvReady() {
  if (window.cv && typeof cv.Mat === "function") {
    Vision.ready = true;
    return;
  }
  setTimeout(pollOpenCvReady, 100);
})();

// scaledCanvas: canvas с уменьшенной копией фото (для скорости, макс. сторона ~800px).
function detectLines(scaledCanvas) {
  if (!window.cv || !Vision.ready) return { horizonAngle: 0, confident: false };

  const src = cv.imread(scaledCanvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const edges = new cv.Mat();
  cv.Canny(gray, edges, 60, 160);

  const lines = new cv.Mat();
  // maxLineGap побольше (30 вместо 20) — реальная береговая линия/кромка леса на фоне неба
  // редко идеально ровная, мелкие перепады рвут её на короткие фрагменты сильнее, чем нужно
  cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 60, scaledCanvas.width * 0.15, 30);

  let horizontals = [];

  for (let i = 0; i < lines.rows; i++) {
    const x1 = lines.data32S[i * 4];
    const y1 = lines.data32S[i * 4 + 1];
    const x2 = lines.data32S[i * 4 + 2];
    const y2 = lines.data32S[i * 4 + 3];
    const dx = x2 - x1, dy = y2 - y1;
    const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const len = Math.hypot(dx, dy);

    const fromHorizontal = Math.min(Math.abs(angleDeg), Math.abs(angleDeg - 180), Math.abs(angleDeg + 180));

    if (fromHorizontal < 20) {
      const angle = angleDeg > 90 ? angleDeg - 180 : angleDeg < -90 ? angleDeg + 180 : angleDeg;
      const xc = (x1 + x2) / 2;
      const yc = (y1 + y2) / 2;
      // intercept: где эта линия пересекала бы вертикаль по центру кадра — координата "по
      // высоте", не зависящая от того, в каком месте по x лежит сам отрезок
      const intercept = yc - Math.tan((angle * Math.PI) / 180) * (xc - scaledCanvas.width / 2);
      horizontals.push({ angle, len, yc, xc, intercept });
    }
  }

  src.delete(); gray.delete(); edges.delete(); lines.delete();

  // На реальном фото почти всегда есть НЕСКОЛЬКО конкурирующих почти горизонтальных линий: сам
  // горизонт, но ещё и пляж/берег на переднем плане, кромка леса за ним, рябь на воде — и из-за
  // общего наклона камеры (крена) все они получаются под ПОХОЖИМ углом, просто на разной высоте
  // в кадре. Кластеризация только по углу (как раньше) их не различает и сваливает в одну кучу
  // отрезки от совершенно разных реальных линий — отсюда и разброс (std) внутри "кластера",
  // который на самом деле никакой не разброс кривизны одной линии, а смесь нескольких прямых.
  // Поэтому кластеризуем сразу по двум признакам — углу И высоте (intercept: где линия проходила
  // бы по центру кадра). Это надёжно разделяет параллельные, но разные по высоте линии, и внутри
  // каждого получившегося кластера std действительно отражает кривизну одной физической линии.
  let clusters = [];
  const angleWin = 1.5;
  const interceptWin = scaledCanvas.height * 0.04;
  for (let iter = 0; iter < 8 && horizontals.length; iter++) {
    let best = null;
    for (let ac = -20; ac <= 20; ac += 0.5) {
      for (let ic = 0; ic <= scaledCanvas.height; ic += scaledCanvas.height * 0.02) {
        const members = horizontals.filter(
          (h) => Math.abs(h.angle - ac) < angleWin && Math.abs(h.intercept - ic) < interceptWin
        );
        if (!members.length) continue;
        const totalLen = members.reduce((s, h) => s + h.len, 0);
        if (!best || totalLen > best.totalLen) best = { totalLen, members };
      }
    }
    if (!best || best.totalLen < scaledCanvas.width * 0.15) break;
    const members = best.members;
    const totalLen = best.totalLen;
    const meanAngle = members.reduce((s, h) => s + h.angle * h.len, 0) / totalLen;
    const meanY = members.reduce((s, h) => s + h.len * h.yc, 0) / totalLen;
    const variance = members.reduce((s, h) => s + h.len * (h.angle - meanAngle) ** 2, 0) / totalLen;
    const std = Math.sqrt(variance);
    clusters.push({ angle: meanAngle, totalLen, std, count: members.length, meanY });
    const memberSet = new Set(members);
    horizontals = horizontals.filter((h) => !memberSet.has(h));
  }

  // Теперь каждый кластер — это одна настоящая физическая линия, а не смесь нескольких, так что
  // std у всех них обычно и так низкий (естественная кривизна берега/леса укладывается в 1-1.5°).
  // Значит выбирать можно по позиции: над настоящим горизонтом почти всегда только небо (без
  // линий), а конкурирующие линии (берег, волны у ног) лежат в кадре ниже него — берём самый
  // верхний из достаточно длинных и достаточно прямых кластеров.
  const confidentClusters = clusters.filter((c) => c.std < 1.5 && c.totalLen >= scaledCanvas.width * 0.25);
  confidentClusters.sort((a, b) => a.meanY - b.meanY);
  const chosen = confidentClusters[0];

  return { horizonAngle: chosen ? chosen.angle : 0, confident: !!chosen };
}
