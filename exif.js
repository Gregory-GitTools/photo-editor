// Минимальный парсер EXIF из JPEG — только то, что нужно панели "Параметры":
// дата съёмки, камера, GPS-координаты. Без внешних библиотек.

function readExif(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return null; // не JPEG

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset, false);
    if ((marker & 0xff00) !== 0xff00) break;
    if (marker === 0xffda) break; // начало данных изображения — метаданных дальше не будет
    const size = view.getUint16(offset + 2, false);
    if (marker === 0xffe1 && view.getUint32(offset + 4, false) === 0x45786966) {
      try {
        return parseTiff(view, offset + 10);
      } catch (_) {
        return null; // повреждённый/нестандартный EXIF — просто не показываем эти поля
      }
    }
    offset += 2 + size;
  }
  return null;
}

function parseTiff(view, tiffStart) {
  const little = view.getUint16(tiffStart, false) === 0x4949;
  const get32 = (o) => view.getUint32(o, little);

  const firstIFDOffset = get32(tiffStart + 4);
  const tags = readIFD(view, tiffStart, tiffStart + firstIFDOffset, little);

  const result = {
    dateTaken: tags[0x0132] || null, // DateTime — запасной вариант, если нет DateTimeOriginal
    make: tags[0x010f] || null,
    model: tags[0x0110] || null,
  };

  if (tags._exifIFDPointer) {
    const exifTags = readIFD(view, tiffStart, tiffStart + tags._exifIFDPointer, little);
    if (exifTags[0x9003]) result.dateTaken = exifTags[0x9003];
  }

  if (tags._gpsIFDPointer) {
    const gpsTags = readIFD(view, tiffStart, tiffStart + tags._gpsIFDPointer, little);
    if (gpsTags[1] && gpsTags[2] && gpsTags[3] && gpsTags[4]) {
      result.lat = dmsToDeg(gpsTags[2]) * (gpsTags[1] === "S" ? -1 : 1);
      result.lon = dmsToDeg(gpsTags[4]) * (gpsTags[3] === "W" ? -1 : 1);
    }
  }
  return result;
}

function readIFD(view, tiffStart, ifdOffset, little) {
  const get16 = (o) => view.getUint16(o, little);
  const get32 = (o) => view.getUint32(o, little);
  const entryCount = get16(ifdOffset);
  const tags = {};

  for (let i = 0; i < entryCount; i++) {
    const entryOffset = ifdOffset + 2 + i * 12;
    const tag = get16(entryOffset);
    const type = get16(entryOffset + 2);
    const count = get32(entryOffset + 4);
    const valueOffset = entryOffset + 8;

    const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 }[type] || 4;
    const totalSize = typeSize * count;
    const dataStart = totalSize <= 4 ? valueOffset : tiffStart + get32(valueOffset);

    let value;
    if (type === 2) {
      // ASCII, включая GPSLatitudeRef/GPSLongitudeRef ("N"/"S"/"E"/"W")
      let str = "";
      for (let j = 0; j < count - 1; j++) str += String.fromCharCode(view.getUint8(dataStart + j));
      value = str;
    } else if (type === 3) {
      value = count === 1 ? get16(dataStart) : Array.from({ length: count }, (_, j) => get16(dataStart + j * 2));
    } else if (type === 4) {
      value = count === 1 ? get32(dataStart) : Array.from({ length: count }, (_, j) => get32(dataStart + j * 4));
    } else if (type === 5) {
      const readRational = (o) => get32(o) / get32(o + 4);
      value = count === 1 ? readRational(dataStart) : Array.from({ length: count }, (_, j) => readRational(dataStart + j * 8));
    }

    if (tag === 0x8769) tags._exifIFDPointer = value;
    else if (tag === 0x8825) tags._gpsIFDPointer = value;
    else tags[tag] = value;
  }
  return tags;
}

function dmsToDeg(dms) {
  return dms[0] + dms[1] / 60 + dms[2] / 3600;
}

// Запись минимального EXIF (Make/Model/DateTime/GPS) обратно в JPEG после
// canvas.toBlob() — canvas при кодировании полностью стирает метаданные,
// а нам нужно сохранить хотя бы камеру и геолокацию.

function degToDms(deg) {
  const d = Math.floor(deg);
  const minFloat = (deg - d) * 60;
  const m = Math.floor(minFloat);
  const s = (minFloat - m) * 60;
  return [[d, 1], [m, 1], [Math.round(s * 1000), 1000]]; // секунды — рациональное число с точностью 0.001"
}

function asciiBytes(str) {
  const bytes = new Uint8Array(str.length + 1); // + null-терминатор
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
  bytes[str.length] = 0;
  return bytes;
}

function buildExifApp1({ make, model, dateTaken, lat, lon }) {
  const hasGps = typeof lat === "number" && typeof lon === "number";
  const ifd0Fields = [];
  if (make) ifd0Fields.push({ tag: 0x010f, str: make });
  if (model) ifd0Fields.push({ tag: 0x0110, str: model });
  if (dateTaken) ifd0Fields.push({ tag: 0x0132, str: dateTaken });
  if (!ifd0Fields.length && !hasGps) return null;

  const TIFF_HEADER = 8;
  const ifd0Count = ifd0Fields.length + (hasGps ? 1 : 0);
  const ifd0BlockSize = 2 + ifd0Count * 12 + 4;
  const ifd0Start = TIFF_HEADER;
  let cursor = ifd0Start + ifd0BlockSize;

  const asciiOffsets = ifd0Fields.map((f) => {
    const bytes = asciiBytes(f.str);
    const entry = { tag: f.tag, bytes, offset: cursor };
    cursor += bytes.length + (bytes.length % 2); // выравнивание по чётной границе
    return entry;
  });

  let gpsIfdStart = 0, gpsLatOffset = 0, gpsLonOffset = 0;
  if (hasGps) {
    gpsIfdStart = cursor;
    const gpsBlockSize = 2 + 4 * 12 + 4; // 4 записи
    gpsLatOffset = gpsIfdStart + gpsBlockSize;
    gpsLonOffset = gpsLatOffset + 24;
    cursor = gpsLonOffset + 24;
  }

  const total = cursor;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);

  dv.setUint16(0, 0x4949, false); // "II" — little-endian TIFF
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifd0Start, true);

  let p = ifd0Start;
  dv.setUint16(p, ifd0Count, true); p += 2;
  for (const f of asciiOffsets) {
    dv.setUint16(p, f.tag, true);
    dv.setUint16(p + 2, 2, true); // ASCII
    dv.setUint32(p + 4, f.bytes.length, true);
    dv.setUint32(p + 8, f.offset, true);
    p += 12;
  }
  if (hasGps) {
    dv.setUint16(p, 0x8825, true);
    dv.setUint16(p + 2, 4, true); // LONG
    dv.setUint32(p + 4, 1, true);
    dv.setUint32(p + 8, gpsIfdStart, true);
    p += 12;
  }
  dv.setUint32(p, 0, true); // следующего IFD нет

  for (const f of asciiOffsets) bytes.set(f.bytes, f.offset);

  if (hasGps) {
    const latRef = lat >= 0 ? "N" : "S";
    const lonRef = lon >= 0 ? "E" : "W";
    const latDms = degToDms(Math.abs(lat));
    const lonDms = degToDms(Math.abs(lon));

    let gp = gpsIfdStart;
    dv.setUint16(gp, 4, true); gp += 2;

    const writeGpsAscii = (tag, ref) => {
      dv.setUint16(gp, tag, true);
      dv.setUint16(gp + 2, 2, true);
      dv.setUint32(gp + 4, 2, true); // "N\0" — 2 байта
      dv.setUint8(gp + 8, ref.charCodeAt(0));
      dv.setUint8(gp + 9, 0);
      gp += 12;
    };
    const writeGpsRational = (tag, offset) => {
      dv.setUint16(gp, tag, true);
      dv.setUint16(gp + 2, 5, true); // RATIONAL
      dv.setUint32(gp + 4, 3, true); // градусы/минуты/секунды
      dv.setUint32(gp + 8, offset, true);
      gp += 12;
    };

    writeGpsAscii(1, latRef);
    writeGpsRational(2, gpsLatOffset);
    writeGpsAscii(3, lonRef);
    writeGpsRational(4, gpsLonOffset);
    dv.setUint32(gp, 0, true);

    const writeDms = (offset, dms) => {
      dms.forEach(([num, den], i) => {
        dv.setUint32(offset + i * 8, num, true);
        dv.setUint32(offset + i * 8 + 4, den, true);
      });
    };
    writeDms(gpsLatOffset, latDms);
    writeDms(gpsLonOffset, lonDms);
  }

  const exifHeader = new TextEncoder().encode("Exif\0\0");
  const segmentLength = 2 + exifHeader.length + total;
  const out = new Uint8Array(2 + 2 + exifHeader.length + total);
  const outDv = new DataView(out.buffer);
  outDv.setUint16(0, 0xffe1, false);
  outDv.setUint16(2, segmentLength, false);
  out.set(exifHeader, 4);
  out.set(bytes, 4 + exifHeader.length);
  return out;
}

// вставляет APP1(Exif)-сегмент сразу после SOI в JPEG-блоб; если писать нечего — возвращает исходный blob
async function injectExif(blob, tags) {
  if (!tags) return blob;
  const app1 = buildExifApp1(tags);
  if (!app1) return blob;

  const buffer = await blob.arrayBuffer();
  const src = new Uint8Array(buffer);
  if (src.length < 2 || src[0] !== 0xff || src[1] !== 0xd8) return blob; // не JPEG

  const out = new Uint8Array(2 + app1.length + (src.length - 2));
  out.set(src.subarray(0, 2), 0);
  out.set(app1, 2);
  out.set(src.subarray(2), 2 + app1.length);
  return new Blob([out], { type: "image/jpeg" });
}
