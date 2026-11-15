import test from 'node:test';
import assert from 'node:assert/strict';
import { processFrame, packSheet } from '../src/pixel.js';
import { buildHistogram, quantizeHistogram, makeMatcher } from '../src/palette.js';
import { parsePalette, rgbToOklab, oklabToRgb } from '../src/color.js';

// '#' = kırmızı opak piksel, '.' = boş. Normaller düz (kameraya bakıyor).
function frame(rows, colorAt = () => [200, 40, 40]) {
  const h = rows.length, w = rows[0].length;
  const albedo = new Uint8ClampedArray(w * h * 4);
  const normal = new Uint8ClampedArray(w * h * 4);
  const depth = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (rows[y][x] === '.') continue;
    const i = y * w + x;
    albedo.set([...colorAt(x, y, rows[y][x]), 255], i * 4);
    normal.set([128, 128, 255, 255], i * 4);
    depth[i] = rows[y][x] === 'N' ? 250 : 100;
  }
  return { w, h, albedo, normal, depth };
}
const base = {
  cleanSilhouette: false, cleanColors: false, bake: false, steps: 3, lightAngle: 125, lightHeight: 35,
  contrast: 0.14, hueShift: 0.2, outline: 'none', outlineColor: [0, 0, 0], outlineColored: false,
  innerLines: false, innerThreshold: 20,
};
function ctxFor(raw, n = 8) {
  const palette = quantizeHistogram(buildHistogram([raw]), n);
  return { palette, match: makeMatcher(palette), finalMatch: null };
}
const alpha = (f, x, y) => f.color[(y * f.w + x) * 4 + 3];
const rgb = (f, x, y) => Array.from(f.color.slice((y * f.w + x) * 4, (y * f.w + x) * 4 + 3));

test('oklab gidiş-dönüş rengi korur', () => {
  for (const c of [[0, 0, 0], [255, 255, 255], [200, 40, 40], [12, 180, 99]]) {
    assert.deepEqual(oklabToRgb(...rgbToOklab(...c)), c);
  }
});

test('palet ayrıştırma hex listesi okur', () => {
  assert.deepEqual(parsePalette('1a1c2c\n#5D275D, ff0000'), [[26, 28, 44], [93, 39, 93], [255, 0, 0]]);
});

test('az renkli modelde palet renkleri aynen korur', () => {
  const raw = frame(['##', '##'], (x) => (x ? [10, 20, 30] : [200, 40, 40]));
  const { palette } = ctxFor(raw);
  assert.equal(palette.length, 2);
  assert.ok(palette.some((c) => c.join() === '200,40,40'));
});

test('palet istenen renk sayısını aşmaz', () => {
  const raw = frame(['########'], (x) => [x * 30, 255 - x * 30, 128]);
  assert.equal(ctxFor(raw, 3).palette.length, 3);
});

test('dış outline siluetin etrafına 1 piksel ekler', () => {
  const raw = frame(['.....', '.....', '..#..', '.....', '.....']);
  const f = processFrame(raw, { ...base, outline: 'outer', outlineColor: [1, 2, 3] }, ctxFor(raw));
  assert.deepEqual(rgb(f, 2, 1), [1, 2, 3]);
  assert.deepEqual(rgb(f, 1, 2), [1, 2, 3]);
  assert.equal(alpha(f, 1, 1), 0, 'köşegen boş kalır (ince outline)');
  assert.deepEqual(rgb(f, 2, 2), [200, 40, 40]);
  assert.equal(f.normal[(1 * 5 + 2) * 4 + 3], 255, 'outline pikselinin normali de var');
});

test('iç outline kenar piksellerini boyar, silueti büyütmez', () => {
  const raw = frame(['.....', '.###.', '.###.', '.###.', '.....']);
  const f = processFrame(raw, { ...base, outline: 'inner', outlineColor: [1, 2, 3] }, ctxFor(raw));
  assert.equal(alpha(f, 0, 0), 0);
  assert.deepEqual(rgb(f, 1, 1), [1, 2, 3]);
  assert.deepEqual(rgb(f, 2, 2), [200, 40, 40]);
});

test('siluet temizliği yetim pikseli siler ve deliği kapatır', () => {
  const raw = frame(['#....', '.....', '..###', '..#.#', '..###']);
  const f = processFrame(raw, { ...base, cleanSilhouette: true }, ctxFor(raw));
  assert.equal(alpha(f, 0, 0), 0);
  assert.equal(alpha(f, 3, 3), 255);
});

test('renk temizliği tek piksellik lekeyi komşu renge çevirir', () => {
  const raw = frame(['###', '#o#', '###'], (x, y, ch) => (ch === 'o' ? [10, 20, 240] : [200, 40, 40]));
  const f = processFrame(raw, { ...base, cleanColors: true }, ctxFor(raw));
  assert.deepEqual(rgb(f, 1, 1), [200, 40, 40]);
});

test('gölge gömme renk sayısını kademe sayısıyla sınırlar', () => {
  const raw = frame(['####', '####']);
  // normalleri soldan sağa döndür
  for (let i = 0; i < 8; i++) raw.normal.set([(i % 4) * 80, 128, 180, 255], i * 4);
  const f = processFrame(raw, { ...base, bake: true, steps: 2, lightAngle: 0, lightHeight: 0 }, ctxFor(raw));
  const colors = new Set();
  for (let i = 0; i < 8; i++) colors.add(rgb(f, i % 4, (i / 4) | 0).join());
  assert.equal(colors.size, 2);
});

test('kilitli palette gölge tonları da paletten seçilir', () => {
  const raw = frame(['####']);
  for (let i = 0; i < 4; i++) raw.normal.set([i * 80, 128, 180, 255], i * 4);
  const palette = [[20, 10, 30], [200, 40, 40], [255, 200, 180]];
  const match = makeMatcher(palette);
  const f = processFrame(raw, { ...base, bake: true, steps: 3, lightAngle: 0, lightHeight: 0, contrast: 0.3 },
    { palette, match, finalMatch: match });
  for (let x = 0; x < 4; x++) assert.ok(palette.some((c) => c.join() === rgb(f, x, 0).join()));
});

test('iç çizgi derinlik sıçramasında arkadaki pikseli koyulaştırır', () => {
  const raw = frame(['#N']);
  const f = processFrame(raw, { ...base, innerLines: true }, ctxFor(raw));
  assert.ok(rgb(f, 0, 0)[0] < 200, 'arkadaki piksel koyulaştı');
  assert.deepEqual(rgb(f, 1, 0), [200, 40, 40]);
});

test('sheet paketleme frame konumlarını korur', () => {
  const a = { w: 2, h: 1, color: new Uint8ClampedArray([1, 1, 1, 255, 2, 2, 2, 255]) };
  const b = { w: 2, h: 1, color: new Uint8ClampedArray([3, 3, 3, 255, 4, 4, 4, 255]) };
  const s = packSheet([a, b, a], 'color', 2);
  assert.deepEqual([s.width, s.height, s.columns, s.rows], [4, 2, 2, 2]);
  assert.equal(s.data[2 * 4], 3);
  assert.equal(s.data[4 * 4], 1);
  assert.equal(s.data[6 * 4 + 3], 0);
});
