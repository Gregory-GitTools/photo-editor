// Детекция горизонта и вертикалей через OpenCV.js. Возвращает угол выравнивания
// и список вертикальных отрезков-подсказок (в координатах уменьшенной копии).

const Vision = {
  ready: false,
};

if (typeof cv !== "undefined") {
  cv["onRuntimeInitialized"] = () => { Vision.ready = true; };
} else {
  window.addEventListener("load", () => {
    const check = setInterval(() => {
      if (window.cv && window.cv.onRuntimeInitialized !== undefined) {
        window.cv.onRuntimeInitialized = () => { Vision.ready = true; };
        clearInterval(check);
      }
    }, 200);
  });
}

// scaledCanvas: canvas с уменьшенной копией фото (для скорости, макс. сторона ~800px).
function detectLines(scaledCanvas) {
  if (!window.cv || !Vision.ready) return { horizonAngle: 0, verticals: [] };

  const src = cv.imread(scaledCanvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const edges = new cv.Mat();
  cv.Canny(gray, edges, 60, 160);

  const lines = new cv.Mat();
  cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 60, scaledCanvas.width * 0.15, 20);

  const horizontals = [];
  const verticals = [];

  for (let i = 0; i < lines.rows; i++) {
    const x1 = lines.data32S[i * 4];
    const y1 = lines.data32S[i * 4 + 1];
    const x2 = lines.data32S[i * 4 + 2];
    const y2 = lines.data32S[i * 4 + 3];
    const dx = x2 - x1, dy = y2 - y1;
    const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const len = Math.hypot(dx, dy);

    const fromHorizontal = Math.min(Math.abs(angleDeg), Math.abs(angleDeg - 180), Math.abs(angleDeg + 180));
    const fromVertical = Math.abs(Math.abs(angleDeg) - 90);

    if (fromHorizontal < 20) {
      horizontals.push({ angle: angleDeg > 90 ? angleDeg - 180 : angleDeg < -90 ? angleDeg + 180 : angleDeg, len });
    } else if (fromVertical < 20) {
      verticals.push({ x1, y1, x2, y2, len });
    }
  }

  src.delete(); gray.delete(); edges.delete(); lines.delete();

  let horizonAngle = 0;
  if (horizontals.length) {
    const totalLen = horizontals.reduce((s, h) => s + h.len, 0);
    horizonAngle = horizontals.reduce((s, h) => s + h.angle * h.len, 0) / totalLen;
  }

  verticals.sort((a, b) => b.len - a.len);

  return { horizonAngle, verticals: verticals.slice(0, 12) };
}
