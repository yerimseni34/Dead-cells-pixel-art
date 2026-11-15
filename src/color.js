// Renk yardımcıları: sRGB <-> OKLab. Palet işlemleri algısal uzayda (OKLab) yapılır,
// yoksa "en yakın renk" seçimi göze yanlış gelir.

const toLinear = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const toSrgb = (c) => {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
};

export function rgbToOklab(r, g, b) {
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToRgb(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '').trim();
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Lospec .hex dosyası ya da serbest metinden hex renkleri ayıklar. */
export function parsePalette(text) {
  const out = [];
  for (const m of text.matchAll(/#?\b([0-9a-fA-F]{6})\b/g)) out.push(hexToRgb(m[1]));
  return out;
}

/**
 * Bir taban rengin gölge/ışık tonunu üretir. k: -1 (gölge) .. +1 (ışık).
 * Pixel art'taki "hue shifting": gölgeler mor-maviye, ışıklar sarıya kayar;
 * sadece karartmak rengi çamurlaştırır.
 */
export function shadeColor(rgb, k, contrast, hueShift) {
  if (k === 0) return rgb;
  let [L, a, b] = rgbToOklab(rgb[0], rgb[1], rgb[2]);
  let C = Math.hypot(a, b);
  let h = Math.atan2(b, a);
  const target = k < 0 ? (285 * Math.PI) / 180 : (95 * Math.PI) / 180;
  // en kısa açı farkı üzerinden hedef tona doğru kaydır
  let d = target - h;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  const amt = Math.min(1, Math.abs(k)) * hueShift;
  h += d * amt;
  // gri renklerde de hafif renk tonu oluşsun
  C = C * (1 + (k < 0 ? 0.1 : -0.05) * Math.abs(k)) + 0.03 * amt;
  L = Math.max(0.02, Math.min(0.99, L + k * contrast));
  return oklabToRgb(L, C * Math.cos(h), C * Math.sin(h));
}
