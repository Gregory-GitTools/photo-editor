// Чистые функции: поворот, кроп, автоулучшение, экспорт. Не зависят от DOM-состояния приложения.

function rectForAspect(photoW, photoH, aspectW, aspectH) {
  const targetRatio = aspectW / aspectH;
  let w = photoW;
  let h = w / targetRatio;
  if (h > photoH) {
    h = photoH;
    w = h * targetRatio;
  }
  return {
    x: (photoW - w) / 2,
    y: (photoH - h) / 2,
    w,
    h,
  };
}

function drawRotated(ctx, bitmap, angleDeg) {
  const w = bitmap.width;
  const h = bitmap.height;
  ctx.canvas.width = w;
  ctx.canvas.height = h;
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
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

// Проекция единичного квадрата (0,0)-(1,0)-(1,1)-(0,1) на произвольный четырёхугольник quad
// (углы в том же порядке: TL, TR, BR, BL). Классическая формула Хекберта для перспективного варпа.
function computeSquareToQuad(quad) {
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

  return (u, v) => {
    const denom = g * u + h * v + 1;
    return { x: (a * u + b * v + c) / denom, y: (d * u + e * v + f) / denom };
  };
}

// Переносит область quad (произвольный четырёхугольник в координатах sourceCanvas)
// в прямоугольник outW×outH с исправлением перспективы (билинейная выборка пикселей).
function warpQuadToRect(sourceCanvas, quad, outW, outH) {
  const sw = sourceCanvas.width, sh = sourceCanvas.height;
  const srcData = sourceCanvas.getContext("2d").getImageData(0, 0, sw, sh).data;

  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const octx = out.getContext("2d");
  const outImg = octx.createImageData(outW, outH);
  const outData = outImg.data;

  const mapUV = computeSquareToQuad(quad);

  for (let py = 0; py < outH; py++) {
    const v = (py + 0.5) / outH;
    for (let px = 0; px < outW; px++) {
      const u = (px + 0.5) / outW;
      const { x, y } = mapUV(u, v);
      const outIdx = (py * outW + px) * 4;

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

// Коррекция перспективы + принудительное соотношение сторон aspectW:aspectH + цветокоррекция —
// высота результата берётся из средней длины левой/правой стороны четырёхугольника.
function exportPerspectiveCrop(sourceCanvas, quad, aspectW, aspectH, colorOpts = {}) {
  const leftLen = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y);
  const rightLen = Math.hypot(quad[2].x - quad[1].x, quad[2].y - quad[1].y);
  const outH = Math.max(1, Math.round((leftLen + rightLen) / 2));
  const outW = Math.max(1, Math.round(outH * (aspectW / aspectH)));

  const out = warpQuadToRect(sourceCanvas, quad, outW, outH);
  const octx = out.getContext("2d");
  const imgData = octx.getImageData(0, 0, out.width, out.height);
  applyColorTreatment(imgData, colorOpts);
  octx.putImageData(imgData, 0, 0);
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
