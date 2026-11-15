import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { Capturer } from './capture.js';
import { createDemoCharacter } from './demo.js';
import { buildHistogram, quantizeHistogram, makeMatcher } from './palette.js';
import { processFrame, packSheet, reduceFlicker } from './pixel.js';
import { hexToRgb, rgbToHex, parsePalette } from './color.js';

const $ = (id) => document.getElementById(id);
const PADDING = 2; // outline için hücre kenarında boşluk

const capturer = new Capturer();
const state = {
  clipStates: [],   // {clip, include}
  current: 0,       // önizlenen klip (clipStates indeksi)
  raw: [],          // [{clip, name, frames:[raw]}]  yalnızca dahil edilen klipler
  final: [],        // raw ile aynı yapı, işlenmiş frame'ler
  palette: [],
  ctx: null,
  layout: null,
  playing: true,
  mouseLight: null,
};

// ---------- ayarlar ----------
const CAPTURE_IDS = ['charHeight', 'fps', 'yaw', 'pitch', 'flatNormals'];
const PROCESS_IDS = ['paletteMode', 'colorCount', 'customPalette', 'bake', 'steps', 'lightAngle', 'lightHeight',
  'contrast', 'hueShift', 'outline', 'outlineColor', 'outlineColored', 'innerLines', 'innerThreshold',
  'cleanSilhouette', 'cleanColors', 'deflicker', 'columns'];

const num = (id) => parseFloat($(id).value);
const on = (id) => $(id).checked;

function processOptions() {
  const L = state.layout;
  return {
    cleanSilhouette: on('cleanSilhouette'),
    cleanColors: on('cleanColors'),
    bake: on('bake'),
    steps: num('steps'),
    lightAngle: num('lightAngle'),
    lightHeight: num('lightHeight'),
    contrast: num('contrast'),
    hueShift: num('hueShift'),
    outline: $('outline').value,
    outlineColor: hexToRgb($('outlineColor').value),
    outlineColored: on('outlineColored'),
    innerLines: on('innerLines'),
    // eşik: karakter boyunun yüzdesi -> 0..255 derinlik birimi
    innerThreshold: ((num('innerThreshold') / 100) * L.refHeight / L.depthRange) * 255,
  };
}

// ---------- boru hattı ----------
function recapture() {
  if (!capturer.root) return;
  const included = state.clipStates.filter((c) => c.include);
  const clips = included.map((c) => c.clip);
  const fps = num('fps');
  state.layout = capturer.computeLayout({
    clips, fps, charHeight: num('charHeight'), yaw: num('yaw'), pitch: num('pitch'), padding: PADDING,
  });
  const list = clips.length ? clips : [null];
  state.raw = list.map((clip) => ({
    clip,
    loop: included.find((c) => c.clip === clip)?.loop ?? true,
    name: clip ? clip.name : 'pose',
    frames: capturer.sampleTimes(clip, fps).map((t) => capturer.captureFrame(clip, t, on('flatNormals'))),
  }));
  reprocess();
}

function reprocess() {
  if (!state.raw.length) return;
  const allRaw = state.raw.flatMap((c) => c.frames);
  const custom = $('paletteMode').value === 'custom' ? parsePalette($('customPalette').value) : [];
  const locked = custom.length >= 2;
  state.palette = locked ? custom : quantizeHistogram(buildHistogram(allRaw), num('colorCount'));
  const match = makeMatcher(state.palette);
  // Kendi paletin varsa gölge tonları da o paletin içinden seçilir.
  state.ctx = { palette: state.palette, match, finalMatch: locked ? match : null };

  const opts = processOptions();
  state.final = state.raw.map((c) => {
    const frames = c.frames.map((f) => processFrame(f, opts, state.ctx));
    return { ...c, frames: on('deflicker') ? reduceFlicker(frames, c.loop) : frames };
  });
  drawSwatches();
  drawSheets();
  updateInfo();
}

function allFinalFrames() { return state.final.flatMap((c) => c.frames); }

// ---------- çizim ----------
function putPixels(canvas, data, w, h, scale = 1) {
  const tmp = putPixels.tmp ??= document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  tmp.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
  canvas.width = w * scale; canvas.height = h * scale;
  const g = canvas.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(tmp, 0, 0, w * scale, h * scale);
}

function drawSheets() {
  const frames = allFinalFrames();
  const cols = num('columns');
  for (const [id, key] of [['sheetColor', 'color'], ['sheetNormal', 'normal']]) {
    const s = packSheet(frames, key, cols);
    putPixels($(id), s.data, s.width, s.height, 2);
  }
}

function drawSwatches() {
  $('swatches').replaceChildren(...state.palette.map((c) => {
    const i = document.createElement('i');
    i.style.background = rgbToHex(c);
    i.title = rgbToHex(c);
    return i;
  }));
}

function updateInfo() {
  const L = state.layout;
  const n = allFinalFrames().length;
  const colors = new Set();
  for (const f of allFinalFrames()) {
    for (let i = 0; i < f.color.length; i += 4) if (f.color[i + 3]) colors.add((f.color[i] << 16) | (f.color[i + 1] << 8) | f.color[i + 2]);
  }
  $('info').textContent = `Hücre ${L.w}×${L.h} px · ${n} frame · ${colors.size} renk`;
}

function previewClipIndex() {
  // state.current, clipStates indeksi; raw/final yalnızca dahil edilenleri içerir
  const target = state.clipStates[state.current]?.clip ?? null;
  const i = state.final.findIndex((c) => c.clip === target);
  return i < 0 ? 0 : i;
}

function tick(now) {
  requestAnimationFrame(tick);
  if (!state.final.length) return;
  const ci = previewClipIndex();
  const clip = state.final[ci];
  const fps = num('fps');
  if (state.playing) state.frame = Math.floor((now / 1000) * fps) % clip.frames.length;
  const fi = Math.min(state.frame || 0, clip.frames.length - 1);
  const view = $('view').value;
  let f = clip.frames[fi];
  if (view === 'light' && state.mouseLight) {
    // Oyundaki dinamik ışığın taklidi: aynı ham veriyi fare yönünden gelen ışıkla yeniden gölgele
    f = processFrame(state.raw[ci].frames[fi], { ...processOptions(), bake: true, steps: Math.max(2, num('steps')), ...state.mouseLight }, state.ctx);
  }
  putPixels($('preview'), view === 'normal' ? f.normal : f.color, f.w, f.h, num('zoom'));
}

// ---------- model yükleme ----------
function setModel(root, clips, label) {
  capturer.setModel(root, clips);
  // Tek seferlik hareketler (saldırı, zıplama, ölüm...) varsayılan olarak döngüsüz
  const oneShot = /attack|atk|hit|hurt|die|death|dead|jump|land|roll|dodge|slash|shoot|cast/i;
  state.clipStates = clips.map((clip) => ({ clip, include: true, loop: !oneShot.test(clip.name || '') }));
  renderPartList();
  state.current = 0;
  $('modelInfo').textContent = `${label} · ${clips.length} animasyon`;
  renderClipList();
  recapture();
}

function renderClipList() {
  const box = $('clips');
  if (!state.clipStates.length) { box.textContent = 'Animasyon yok: tek poz çıkarılır.'; return; }
  box.replaceChildren(...state.clipStates.map((cs, i) => {
    const row = document.createElement('div');
    row.className = 'clip' + (i === state.current ? ' active' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = cs.include;
    cb.onclick = (e) => { e.stopPropagation(); cs.include = cb.checked; recapture(); };
    const name = document.createElement('span');
    name.textContent = cs.clip.name || `clip_${i}`;
    const dur = document.createElement('small');
    dur.textContent = `${cs.clip.duration.toFixed(2)} sn`;
    const loop = document.createElement('label');
    loop.className = 'loop';
    loop.title = "Unity'de döngülü oynat";
    const loopCb = document.createElement('input');
    loopCb.type = 'checkbox'; loopCb.checked = cs.loop;
    loopCb.onclick = (e) => { e.stopPropagation(); cs.loop = loopCb.checked; schedule(recapture); };
    loop.onclick = (e) => e.stopPropagation();
    loop.append(loopCb, '↻');
    row.append(cb, name, dur, loop);
    row.onclick = () => { state.current = i; renderClipList(); };
    return row;
  }));
}

function renderPartList() {
  const meshes = capturer.meshes;
  $('partsSection').hidden = meshes.length < 2;
  // İsimli parça varsa yalnızca onları listele (isimsizler genelde gövdenin alt parçaları)
  const named = meshes.filter((m) => m.name);
  $('parts').replaceChildren(...(named.length ? named : meshes).map((mesh, i) => {
    const row = document.createElement('label');
    row.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = mesh.visible;
    cb.oninput = () => {
      // en az bir parça görünür kalmalı
      if (!cb.checked && meshes.filter((m) => m.visible).length === 1) { cb.checked = true; return; }
      mesh.visible = cb.checked;
      schedule(recapture);
    };
    row.append(cb, mesh.name || mesh.material?.name || `parça ${i + 1}`);
    return row;
  }));
}

async function loadFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'fbx') {
      const obj = await new FBXLoader().loadAsync(url);
      setModel(obj, obj.animations || [], file.name);
    } else {
      const gltf = await new GLTFLoader().loadAsync(url);
      setModel(gltf.scene, gltf.animations || [], file.name);
    }
    $('name').value = file.name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_');
  } catch (err) {
    console.error(err);
    $('modelInfo').textContent = `Yüklenemedi: ${err.message}`;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadDemo() {
  const { root, clips } = createDemoCharacter();
  setModel(root, clips, 'Demo karakter');
  $('name').value = 'demo';
}

// ---------- dışa aktarma ----------
function buildExport() {
  const L = state.layout;
  const frames = allFinalFrames();
  const cols = num('columns');
  const color = packSheet(frames, 'color', cols);
  const normal = packSheet(frames, 'normal', cols);
  const name = $('name').value.trim() || 'character';
  let start = 0;
  const meta = {
    version: 1,
    name,
    colorTexture: `${name}_color.png`,
    normalTexture: `${name}_normal.png`,
    cellWidth: L.w,
    cellHeight: L.h,
    columns: color.columns,
    rows: color.rows,
    frameCount: frames.length,
    pivot: L.pivot, // hücrenin sol-alt köşesinden piksel; modelin orijini (ayak) buraya düşer
    pixelsPerUnit: num('unityPPU'),
    shadingBaked: on('bake'),
    clips: state.final.map((c) => {
      const entry = { name: c.name, start, count: c.frames.length, fps: num('fps'), loop: c.loop };
      start += c.frames.length;
      return entry;
    }),
  };
  return { name, color, normal, meta };
}

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function sheetBlob(sheet) {
  const c = document.createElement('canvas');
  putPixels(c, sheet.data, sheet.width, sheet.height, 1);
  return new Promise((res) => c.toBlob(res, 'image/png'));
}

async function exportAll() {
  const ex = buildExport();
  download(await sheetBlob(ex.color), ex.meta.colorTexture);
  download(await sheetBlob(ex.normal), ex.meta.normalTexture);
  download(new Blob([JSON.stringify(ex.meta, null, 2)], { type: 'application/json' }), `${ex.name}.json`);
}

// ---------- olaylar ----------
let pending = null;
function schedule(fn) {
  // recapture, reprocess'i de kapsar; ikisi birden istenirse recapture kazanır
  if (pending === recapture && fn === reprocess) return;
  pending = fn;
  requestAnimationFrame(() => { if (pending) { const f = pending; pending = null; f(); } });
}

function syncOutputs() {
  document.querySelectorAll('label > output').forEach((o) => {
    const input = o.parentElement.querySelector('input[type=range]');
    if (input) o.textContent = input.value;
  });
  const custom = $('paletteMode').value === 'custom';
  $('customPalette').hidden = !custom;
  $('colorCountRow').hidden = custom;
}

for (const id of CAPTURE_IDS) $(id).addEventListener('input', () => { syncOutputs(); schedule(recapture); });
for (const id of PROCESS_IDS) $(id).addEventListener('input', () => { syncOutputs(); schedule(reprocess); });
$('zoom').addEventListener('input', syncOutputs);
$('file').addEventListener('change', (e) => e.target.files[0] && loadFile(e.target.files[0]));
$('demo').addEventListener('click', loadDemo);
$('export').addEventListener('click', exportAll);
$('play').addEventListener('click', () => {
  state.playing = !state.playing;
  $('play').textContent = state.playing ? 'Duraklat' : 'Oynat';
});

const stage = $('stage');
stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drop'); });
stage.addEventListener('dragleave', () => stage.classList.remove('drop'));
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  stage.classList.remove('drop');
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});
stage.addEventListener('pointermove', (e) => {
  const r = $('preview').getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2), dy = (r.top + r.height / 2) - e.clientY;
  state.mouseLight = { lightAngle: (Math.atan2(dy, dx) * 180) / Math.PI, lightHeight: 30 };
});

syncOutputs();
loadDemo();
requestAnimationFrame(tick);

// Test ve konsoldan kurcalama için
window.__app = { state, capturer, recapture, reprocess, buildExport, loadFile };
