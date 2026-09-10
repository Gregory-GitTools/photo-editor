// Общая логика меток на карте альбома — используется и встроенной картой в панели
// параметров (app.js), и отдельным окном карты (map.html), чтобы поведение обеих карт
// совпадало один в один.

// снимки, сделанные почти в одной точке (в пределах ~11 м — обычный разброс GPS-фикса между
// кадрами одной серии), сливаются в одну каплю с числом кадров вместо метки на каждое фото
function clusterGeoPoints(points) {
  const GRID = 10000; // округление до 0.0001° ≈ 11 м на средних широтах — ключ группировки
  const groups = new Map();
  points.forEach((p, i) => {
    if (!p) return;
    const key = Math.round(p.lat * GRID) + "|" + Math.round(p.lon * GRID);
    let g = groups.get(key);
    if (!g) {
      g = { latSum: 0, lonSum: 0, indexes: [] };
      groups.set(key, g);
    }
    g.latSum += p.lat;
    g.lonSum += p.lon;
    g.indexes.push(i);
  });
  return Array.from(groups.values(), (g) => ({
    lat: g.latSum / g.indexes.length,
    lon: g.lonSum / g.indexes.length,
    indexes: g.indexes,
  }));
}

// какое фото открыть по клику на каплю: если текущее фото уже входит в эту группу
// (частый случай — все кадры серии стоят в одной точке), переходим к следующему в группе,
// а не всегда к первому — иначе клик по капле текущего фото выглядит так, будто ничего
// не произошло, если текущее фото и есть indexes[0]
function pickClusterTarget(indexes, currentIndex) {
  const pos = indexes.indexOf(currentIndex);
  if (pos === -1) return indexes[0];
  return indexes[(pos + 1) % indexes.length];
}

function makeClusterIcon(L, count, active) {
  const html = `<div class="geo-pin-wrap${active ? " active" : ""}"><div class="geo-pin"></div><div class="geo-pin-num">${count}</div></div>`;
  return L.divIcon({ className: "geo-pin-icon", html, iconSize: [30, 44], iconAnchor: [15, 30] });
}

// пересобирает капли альбома на карте с нуля — их немного (десятки, не тысячи за раз),
// поэтому проще каждый раз убрать старые и расставить новые, чем вычислять разницу;
// ref — { list: [] }, переживающий между вызовами для одной и той же карты;
// onMarkerClick(indexes) — необязательный колбэк, вызывается при клике по капле с индексами
// фото в этой группе (первый — самый близкий кандидат для перехода фокуса)
function syncGeoMarkers(L, map, ref, points, activeIndex, onMarkerClick) {
  ref.list.forEach((m) => m.remove());
  ref.list = clusterGeoPoints(points).map((c) => {
    const active = c.indexes.includes(activeIndex);
    const marker = L.marker([c.lat, c.lon], {
      icon: makeClusterIcon(L, c.indexes.length, active),
      interactive: !!onMarkerClick, // без колбэка клик не перехватываем — пусть проходит к фону карты
      keyboard: false,
      // капля с фокусом не должна теряться за соседними — поднимаем её над остальными
      // независимо от широты (обычный порядок отрисовки Leaflet — по Y-координате)
      zIndexOffset: active ? 1000 : 0,
    });
    if (onMarkerClick) {
      marker.on("click", (e) => {
        L.DomEvent.stopPropagation(e); // не даём клику долететь до обработчика фона карты
        onMarkerClick(c.indexes);
      });
    }
    marker.addTo(map);
    return marker;
  });
}
