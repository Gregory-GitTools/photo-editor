// Чистые функции: поворот, кроп, автоулучшение, экспорт. Не зависят от DOM-состояния приложения.

// поворачивает bitmap на 90°×quarterTurns (1 = по часовой, -1/3 = против часовой) —
// возвращает canvas с уже впечатанным в пиксели новым положением (для жёсткого поворота,
// в отличие от drawRotatedAt, который крутит только при отрисовке, не меняя сами данные)
function rotateBitmapQuarter(bitmap, quarterTurns) {
  const q = ((quarterTurns % 4) + 4) % 4;
  const swapped = q === 1 || q === 3;
  const w = bitmap.width, h = bitmap.height;
  const out = document.createElement("canvas");
  out.width = swapped ? h : w;
  out.height = swapped ? w : h;
  const octx = out.getContext("2d");
  octx.translate(out.width / 2, out.height / 2);
  octx.rotate((q * 90 * Math.PI) / 180);
  octx.drawImage(bitmap, -w / 2, -h / 2);
  return out;
}

// зеркально отражает bitmap по горизонтали (впечатывая в пиксели, как rotateBitmapQuarter)
function flipBitmapHorizontal(bitmap) {
  const w = bitmap.width, h = bitmap.height;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d");
  octx.translate(w, 0);
  octx.scale(-1, 1);
  octx.drawImage(bitmap, 0, 0);
  return out;
}

function drawRotated(ctx, bitmap, angleDeg) {
  const w = bitmap.width;
  const h = bitmap.height;
  ctx.canvas.width = w;
  ctx.canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  drawRotatedAt(ctx, bitmap, angleDeg, 0, 0);
}

// как drawRotated, но не трогает размер canvas и рисует со смещением (offsetX, offsetY) —
// нужно, когда canvas больше самого изображения (например, из-за отступа под ручки рамки)
function drawRotatedAt(ctx, bitmap, angleDeg, offsetX, offsetY) {
  const w = bitmap.width;
  const h = bitmap.height;
  ctx.save();
  ctx.translate(offsetX + w / 2, offsetY + h / 2);
  ctx.rotate((angleDeg * Math.PI) / 180);
  ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
  ctx.restore();
}

// Кроп из исходного canvas + автоулучшение (перцентильный автоконтраст по каналам + лёгкая насыщенность).
function exportCrop(sourceCanvas, rect, { saturationBoost = 1.15, clipPercent = 0.005, warm = 0 } = {}) {
  const out = document.createElement("canvas");
  out.width = Math.round(rect.w);
  out.height = Math.round(rect.h);
  const octx = out.getContext("2d");
  octx.drawImage(
    sourceCanvas,
    rect.x, rect.y, rect.w, rect.h,
    0, 0, out.width, out.height
  );

  const imgData = octx.getImageData(0, 0, out.width, out.height);
  applyColorTreatment(imgData, { saturationBoost, clipPercent, warm });
  octx.putImageData(imgData, 0, 0);

  return out;
}

function applyColorTreatment(imgData, { saturationBoost = 1.15, clipPercent = 0.005, warm = 0 } = {}) {
  if (clipPercent > 0) autoContrast(imgData, clipPercent);
  if (saturationBoost !== 1) boostSaturation(imgData, saturationBoost);
  if (warm) applyWarmth(imgData, warm);
}

function applyWarmth(imgData, amount) {
  const { data } = imgData;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = clamp255(data[i] + amount);
    data[i + 2] = clamp255(data[i + 2] - amount);
  }
}

// Коэффициенты перспективной проекции единичного квадрата (0,0)-(1,0)-(1,1)-(0,1) на
// произвольный четырёхугольник quad (углы TL, TR, BR, BL) — классическая формула Хекберта.
// Задают проективную матрицу M = [[a,b,c],[d,e,f],[g,h,1]]: [x,y,w]^T ~ M·[u,v,1]^T.
function squareToQuadCoeffs(quad) {
  const [p0, p1, p2, p3] = quad;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;

  let a, b, c, d, e, f, g, h;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    a = p1.x - p0.x; b = p2.x - p1.x; c = p0.x;
    d = p1.y - p0.y; e = p2.y - p1.y; f = p0.y;
    g = 0; h = 0;
  } else {
    const denom = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / denom;
    h = (dx1 * dy3 - dx3 * dy1) / denom;
    a = p1.x - p0.x + g * p1.x;
    b = p3.x - p0.x + h * p3.x;
    c = p0.x;
    d = p1.y - p0.y + g * p1.y;
    e = p3.y - p0.y + h * p3.y;
    f = p0.y;
  }
  return { a, b, c, d, e, f, g, h };
}

// Прямое отображение: по точке (u,v) единичного квадрата [0,1]x[0,1] находит соответствующую
// точку внутри quad — нужно не для сэмплинга пикселей (см. warpRectToQuad/computeQuadToSquare
// для этого), а для того, чтобы узнать, куда деформация переносит ЛЮБУЮ конкретную точку
// исходного прямоугольника (например, его собственные углы или углы уже повёрнутого фото) —
// то есть где на экране в итоге оказывается видимая (непрозрачная) граница фото.
function mapUnitSquareToQuad(quad) {
  const { a, b, c, d, e, f, g, h } = squareToQuadCoeffs(quad);
  return (u, v) => {
    const denom = g * u + h * v + 1;
    return { x: (a * u + b * v + c) / denom, y: (d * u + e * v + f) / denom };
  };
}

// Обратное отображение: по точке на выходном канвасе находит (u,v) в исходном
// неповёрнутом прямоугольнике [0,1]x[0,1], который перспективная проекция переводит в эту
// точку quad — то есть инверсия squareToQuadCoeffs как проективной 3x3-матрицы. Нужна для
// рендера: для каждого пикселя ВЫХОДНОГО изображения ищем, какой пиксель ИСХОДНОГО (фото)
// туда попадает, а не наоборот.
function computeQuadToSquare(quad) {
  const { a, b, c, d, e, f, g, h } = squareToQuadCoeffs(quad);
  // M = [[a,b,c],[d,e,f],[g,h,1]], аналитическая инверсия 3x3 через матрицу кофакторов
  const det = a * (e * 1 - f * h) - b * (d * 1 - f * g) + c * (d * h - e * g);
  const i00 = (e * 1 - f * h) / det, i01 = (c * h - b * 1) / det, i02 = (b * f - c * e) / det;
  const i10 = (f * g - d * 1) / det, i11 = (a * 1 - c * g) / det, i12 = (c * d - a * f) / det;
  const i20 = (d * h - e * g) / det, i21 = (b * g - a * h) / det, i22 = (a * e - b * d) / det;

  return (x, y) => {
    const w = i20 * x + i21 * y + i22;
    return { u: (i00 * x + i01 * y + i02) / w, v: (i10 * x + i11 * y + i12) / w };
  };
}

// Деформирует всё изображение sourceCanvas целиком так, что его собственные 4 угла
// (прямоугольник 0..sw x 0..sh) переходят в точки quad (заданные в тех же координатах,
// сами точки могут лежать и за пределами sourceCanvas — это тянет угол наружу).
// Результат — канвас outW×outH (как правило, того же размера, что и исходный, без обрезки):
// это аналог поворота фото — искажает картинку целиком, а получившиеся пустые места
// (прозрачные) обрезает уже отдельная, уже существующая рамка обрезки, а не сама эта функция.
function warpRectToQuad(sourceCanvas, quad, outW, outH) {
  const sw = sourceCanvas.width, sh = sourceCanvas.height;
  const srcData = sourceCanvas.getContext("2d").getImageData(0, 0, sw, sh).data;

  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const octx = out.getContext("2d");
  const outImg = octx.createImageData(outW, outH);
  const outData = outImg.data;

  const invUV = computeQuadToSquare(quad);

  for (let py = 0; py < outH; py++) {
    for (let px = 0; px < outW; px++) {
      const { u, v } = invUV(px + 0.5, py + 0.5);
      const outIdx = (py * outW + px) * 4;

      if (u < 0 || u > 1 || v < 0 || v > 1) {
        outData[outIdx + 3] = 0;
        continue;
      }
      const x = u * sw, y = v * sh;
      if (x < 0 || x >= sw - 1 || y < 0 || y >= sh - 1) {
        outData[outIdx + 3] = 0;
        continue;
      }

      const x0 = Math.floor(x), y0 = Math.floor(y);
      const fx = x - x0, fy = y - y0;
      const x1 = x0 + 1, y1 = y0 + 1;
      for (let ch = 0; ch < 4; ch++) {
        const v00 = srcData[(y0 * sw + x0) * 4 + ch];
        const v10 = srcData[(y0 * sw + x1) * 4 + ch];
        const v01 = srcData[(y1 * sw + x0) * 4 + ch];
        const v11 = srcData[(y1 * sw + x1) * 4 + ch];
        const top = v00 * (1 - fx) + v10 * fx;
        const bottom = v01 * (1 - fx) + v11 * fx;
        outData[outIdx + ch] = top * (1 - fy) + bottom * fy;
      }
    }
  }

  octx.putImageData(outImg, 0, 0);
  return out;
}

function autoContrast(imgData, clipPercent) {
  const { data } = imgData;
  const n = data.length / 4;
  for (const channel of [0, 1, 2]) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[data[i * 4 + channel]]++;

    const clip = Math.max(1, Math.floor(n * clipPercent));
    let lo = 0, acc = 0;
    while (lo < 255 && (acc += hist[lo]) < clip) lo++;
    let hi = 255; acc = 0;
    while (hi > 0 && (acc += hist[hi]) < clip) hi--;
    if (hi <= lo) continue;

    const scale = 255 / (hi - lo);
    for (let i = 0; i < n; i++) {
      const idx = i * 4 + channel;
      const v = (data[idx] - lo) * scale;
      data[idx] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
}

function boostSaturation(imgData, factor) {
  const { data } = imgData;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    data[i] = clamp255(gray + (r - gray) * factor);
    data[i + 1] = clamp255(gray + (g - gray) * factor);
    data[i + 2] = clamp255(gray + (b - gray) * factor);
  }
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
