import { rgbToOklab, oklabToRgb } from './color.js';

/**
 * Tüm frame'lerin opak piksellerinden renk histogramı çıkarır.
 * Paletin BÜTÜN animasyonlar için ortak olması şart: frame başına palet
 * çıkarılırsa renkler kareden kareye titrer.
 */
export function buildHistogram(frames) {
  const hist = new Map();
  for (const f of frames) {
    const a = f.albedo;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i + 3] < 128) continue;
      const key = (a[i] << 16) | (a[i + 1] << 8) | a[i + 2];
      hist.set(key, (hist.get(key) || 0) + 1);
    }
  }
  return hist;
}

/** Ağırlıklı median-cut + birkaç k-means turu (OKLab uzayında). */
export function quantizeHistogram(hist, maxColors) {
  const pts = [];
  for (const [key, w] of hist) {
    const lab = rgbToOklab((key >> 16) & 255, (key >> 8) & 255, key & 255);
    pts.push({ lab, w });
  }
  if (pts.length === 0) return [[0, 0, 0]];
  if (pts.length <= maxColors) return sortPalette(pts.map((p) => oklabToRgb(...p.lab)));

  let boxes = [pts];
  while (boxes.length < maxColors) {
    // en geniş kutuyu (aralık * ağırlık) böl
    let best = -1, bestScore = 0, bestAxis = 0;
    boxes.forEach((box, bi) => {
      if (box.length < 2) return;
      for (let ax = 0; ax < 3; ax++) {
        let mn = Infinity, mx = -Infinity;
        for (const p of box) { mn = Math.min(mn, p.lab[ax]); mx = Math.max(mx, p.lab[ax]); }
        const score = (mx - mn) * Math.sqrt(box.length);
        if (score > bestScore) { bestScore = score; best = bi; bestAxis = ax; }
      }
    });
    if (best < 0) break;
    const box = boxes[best].slice().sort((p, q) => p.lab[bestAxis] - q.lab[bestAxis]);
    const total = box.reduce((s, p) => s + p.w, 0);
    let acc = 0, cut = 1;
    for (let i = 0; i < box.length - 1; i++) {
      acc += box[i].w;
      if (acc >= total / 2) { cut = i + 1; break; }
    }
    boxes.splice(best, 1, box.slice(0, cut), box.slice(cut));
  }

  let cents = boxes.map(centroid);
  for (let iter = 0; iter < 6; iter++) {
    const groups = cents.map(() => []);
    for (const p of pts) groups[nearestLab(cents, p.lab)].push(p);
    cents = groups.map((g, i) => (g.length ? centroid(g) : cents[i]));
  }
  return sortPalette(cents.map((c) => oklabToRgb(...c)));
}

function centroid(box) {
  let L = 0, a = 0, b = 0, w = 0;
  for (const p of box) { L += p.lab[0] * p.w; a += p.lab[1] * p.w; b += p.lab[2] * p.w; w += p.w; }
  return [L / w, a / w, b / w];
}

function nearestLab(cents, lab) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < cents.length; i++) {
    const c = cents[i];
    const d = (c[0] - lab[0]) ** 2 + (c[1] - lab[1]) ** 2 + (c[2] - lab[2]) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

function sortPalette(colors) {
  const seen = new Set();
  return colors
    .filter((c) => { const k = c.join(','); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((p, q) => rgbToOklab(...p)[0] - rgbToOklab(...q)[0]);
}

/** RGB -> palet indeksi; sonuçları önbelleğe alan eşleyici. */
export function makeMatcher(palette) {
  const labs = palette.map((c) => rgbToOklab(c[0], c[1], c[2]));
  const cache = new Map();
  return (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    let idx = cache.get(key);
    if (idx === undefined) {
      idx = nearestLab(labs, rgbToOklab(r, g, b));
      cache.set(key, idx);
    }
    return idx;
  };
}
