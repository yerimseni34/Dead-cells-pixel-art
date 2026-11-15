// Ham render (albedo + normal + derinlik) -> pixel art frame.
// Saf fonksiyonlar: DOM / WebGL bağımlılığı yok, Node'da test edilebilir.

import { shadeColor } from './color.js';

const DX = [0, -1, 1, 0];
const DY = [1, 0, 0, -1];

export function lightVector(angleDeg, heightDeg) {
  const a = (angleDeg * Math.PI) / 180;
  const h = (heightDeg * Math.PI) / 180;
  return [Math.cos(a) * Math.cos(h), Math.sin(a) * Math.cos(h), Math.sin(h)];
}

/**
 * @param raw  {w,h, albedo:RGBA, normal:RGBA, depth:Uint8Array}  satırlar yukarıdan aşağı,
 *             depth: büyük = kameraya yakın
 * @param opts işlem ayarları (bkz. main.js DEFAULTS)
 * @param ctx  {palette, match, finalMatch?}  tüm frame'ler için ortak
 * @returns {color:RGBA, normal:RGBA}
 */
export function processFrame(raw, opts, ctx) {
  const { w, h } = raw;
  const n = w * h;
  const albedo = new Uint8ClampedArray(raw.albedo);
  const normal = new Uint8ClampedArray(raw.normal);
  const depth = new Uint8Array(raw.depth);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = albedo[i * 4 + 3] >= 128 ? 1 : 0;

  const opaqueAt = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;

  // 1) Siluet temizliği: tek başına kalan pikselleri sil, tek piksellik delikleri doldur.
  if (opts.cleanSilhouette) {
    const next = new Uint8Array(mask);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let c = 0;
        for (let d = 0; d < 4; d++) if (opaqueAt(x + DX[d], y + DY[d])) c++;
        if (mask[i] && c === 0) next[i] = 0;
        else if (!mask[i] && c === 4) {
          next[i] = 1;
          const j = i - 1; // sol komşudan kopyala
          for (let k = 0; k < 4; k++) { albedo[i * 4 + k] = albedo[j * 4 + k]; normal[i * 4 + k] = normal[j * 4 + k]; }
          depth[i] = depth[j];
        }
      }
    }
    mask.set(next);
  }

  // 2) Palete oturtma (taban renk indeksleri)
  const idx = new Int16Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (mask[i]) idx[i] = ctx.match(albedo[i * 4], albedo[i * 4 + 1], albedo[i * 4 + 2]);
  }

  // 3) Renk temizliği: 8 komşusunun hiçbiriyle aynı renkte olmayan pikseli çoğunluğa uydur.
  if (opts.cleanColors) {
    const next = new Int16Array(idx);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        const counts = new Map();
        let same = false, any = false;
        for (let oy = -1; oy <= 1 && !same; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if ((ox || oy) && opaqueAt(x + ox, y + oy)) {
              const v = idx[(y + oy) * w + x + ox];
              if (v === idx[i]) { same = true; break; }
              any = true;
              counts.set(v, (counts.get(v) || 0) + 1);
            }
          }
        }
        if (same || !any) continue;
        let best = idx[i], bc = 0;
        for (const [v, c] of counts) if (c > bc) { bc = c; best = v; }
        next[i] = best;
      }
    }
    idx.set(next);
  }

  // 4) İç çizgiler: derinlik sıçraması olan yerde arkadaki pikseli koyulaştır
  //    (kol gövdenin önünden geçerken ayrışsın diye).
  const line = new Uint8Array(n);
  if (opts.innerLines) {
    const thr = opts.innerThreshold;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d], ny = y + DY[d];
          if (opaqueAt(nx, ny) && depth[ny * w + nx] - depth[i] > thr) { line[i] = 1; break; }
        }
      }
    }
  }

  // 5) Gölgelendirme: normalden kademeli (toon) ton seç.
  const steps = Math.max(1, opts.steps | 0);
  const L = lightVector(opts.lightAngle, opts.lightHeight);
  const cache = new Map();
  const shaded = (pi, k) => {
    const key = pi * 64 + Math.round((k + 2) * 8);
    let c = cache.get(key);
    if (!c) {
      c = shadeColor(ctx.palette[pi], k, opts.contrast, opts.hueShift);
      if (ctx.finalMatch) c = ctx.palette[ctx.finalMatch(c[0], c[1], c[2])];
      cache.set(key, c);
    }
    return c;
  };
  const bandK = (i) => {
    if (!opts.bake || steps === 1) return 0;
    const nx = normal[i * 4] / 127.5 - 1;
    const ny = normal[i * 4 + 1] / 127.5 - 1;
    const nz = normal[i * 4 + 2] / 127.5 - 1;
    const t = (nx * L[0] + ny * L[1] + nz * L[2] + 1) / 2;
    const band = Math.max(0, Math.min(steps - 1, Math.floor(t * steps)));
    return (band / (steps - 1)) * 2 - 1;
  };

  const color = new Uint8ClampedArray(n * 4);
  const outNormal = new Uint8ClampedArray(n * 4);
  const put = (i, c) => { color[i * 4] = c[0]; color[i * 4 + 1] = c[1]; color[i * 4 + 2] = c[2]; color[i * 4 + 3] = 255; };
  const putNormal = (i, j) => {
    outNormal[i * 4] = normal[j * 4]; outNormal[i * 4 + 1] = normal[j * 4 + 1];
    outNormal[i * 4 + 2] = normal[j * 4 + 2]; outNormal[i * 4 + 3] = 255;
  };
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    put(i, line[i] ? shaded(idx[i], -1.5) : shaded(idx[i], bandK(i)));
    putNormal(i, i);
  }

  // 6) Dış çizgi (outline)
  if (opts.outline !== 'none') {
    const outer = opts.outline === 'outer';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (outer) {
          if (mask[i]) continue;
          for (let d = 0; d < 4; d++) {
            const nx = x + DX[d], ny = y + DY[d];
            if (!opaqueAt(nx, ny)) continue;
            const j = ny * w + nx;
            put(i, opts.outlineColored ? shaded(idx[j], -1.8) : opts.outlineColor);
            putNormal(i, j);
            break;
          }
        } else if (mask[i]) {
          let edge = false;
          for (let d = 0; d < 4; d++) if (!opaqueAt(x + DX[d], y + DY[d])) { edge = true; break; }
          if (edge) put(i, opts.outlineColored ? shaded(idx[i], -1.8) : opts.outlineColor);
        }
      }
    }
  }

  return { w, h, color, normal: outNormal };
}

/** Frame'leri ızgara halinde tek bir RGBA sheet'e dizer. */
export function packSheet(frames, key, columns) {
  const { w, h } = frames[0];
  const cols = Math.min(columns, frames.length);
  const rows = Math.ceil(frames.length / cols);
  const W = cols * w, H = rows * h;
  const out = new Uint8ClampedArray(W * H * 4);
  frames.forEach((f, fi) => {
    const ox = (fi % cols) * w, oy = Math.floor(fi / cols) * h;
    const src = f[key];
    for (let y = 0; y < h; y++) {
      out.set(src.subarray(y * w * 4, (y + 1) * w * 4), ((oy + y) * W + ox) * 4);
    }
  });
  return { width: W, height: H, data: out, columns: cols, rows };
}
