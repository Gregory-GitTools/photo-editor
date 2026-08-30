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
function exportCrop(sourceCanvas, rect, { saturationBoost = 1.15, clipPercent = 0.005 } = {}) {
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
  autoContrast(imgData, clipPercent);
  boostSaturation(imgData, saturationBoost);
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
