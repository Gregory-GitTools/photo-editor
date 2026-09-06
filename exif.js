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
