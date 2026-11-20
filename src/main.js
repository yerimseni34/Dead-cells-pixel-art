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
  clipStates: [],   // {clip, include, loop}
  current: 0,       // önizlenen klip (clipStates indeksi)
  bounds: null,     // ölçülmüş kutu (pahalı; yalnızca açı/fps/klip/parça değişince yeniden)
  boundsKey: '',
  layout: null,
  paletteSamples: [],
  palette: [],
  ctx: null,
  // Önbellekler: yalnızca ihtiyaç duyulan klip hesaplanır.
  raw: new Map(),   // clip -> ham frame'ler (render ayarı değişince silinir)
  proc: new Map(),  // clip -> işlenmiş frame'ler (herhangi bir ayar değişince silinir)
  playing: true,
  mouseLight: null,
  frame: 0,
};

// ---------- ayarlar ----------
const CAPTURE_IDS = ['charHeight', 'fps', 'yaw', 'pitch', 'flatNormals', 'rootLock', 'centerChar'];
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
const POSE = { clip: null, include: true, loop: true };

/** Export'a girecek klipler (hiçbiri seçili değilse tek poz). */
function exportStates() {
  const included = state.clipStates.filter((c) => c.include);
  return included.length ? included : [POSE];
}
function previewState() { return state.clipStates[state.current] ?? POSE; }
const clipName = (cs) => (cs.clip ? cs.clip.name : 'pose');

/** Render ayarı (boy, açı, fps, klip seçimi, parçalar...) değişince. */
function relayout() {
  if (!capturer.root) return;
  capturer.rootLock = on('rootLock');
  const clips = exportStates().map((c) => c.clip).filter(Boolean);
  const fps = num('fps');
  const key = JSON.stringify([num('yaw'), num('pitch'), fps, on('rootLock'),
    clips.map((c) => capturer.clips.indexOf(c)), capturer.meshes.map((m) => m.visible)]);
  if (key !== state.boundsKey) {
    state.bounds = capturer.measureBounds({ clips, fps, yaw: num('yaw'), pitch: num('pitch') });
    state.boundsKey = key;
  }
  state.layout = capturer.applyLayout(state.bounds, {
    charHeight: num('charHeight'), padding: PADDING, center: on('centerChar'),
  });

  // Palet bütün animasyonlar için ortak olmalı; ama hepsini render etmek yerine
  // her klipten birkaç örnek kare yeterli.
  const states = exportStates();
  const perClip = Math.max(4, Math.ceil(60 / states.length));
  state.paletteSamples = [];
  for (const cs of states) {
    const times = capturer.sampleTimes(cs.clip, fps);
    const n = Math.min(perClip, times.length);
    for (let k = 0; k < n; k++) {
      state.paletteSamples.push(capturer.captureAlbedo(cs.clip, times[Math.floor((k * times.length) / n)]));
    }
  }
  state.raw.clear();
  reprocess();
}

/** İşleme ayarı (palet, gölge, outline...) değişince: sadece seçili klip yeniden hesaplanır. */
function reprocess() {
  if (!state.layout) return;
  const custom = $('paletteMode').value === 'custom' ? parsePalette($('customPalette').value) : [];
  const locked = custom.length >= 2;
  state.palette = locked ? custom : quantizeHistogram(buildHistogram(state.paletteSamples), num('colorCount'));
  const match = makeMatcher(state.palette);
  // Kendi paletin varsa gölge tonları da o paletin içinden seçilir.
  state.ctx = { palette: state.palette, match, finalMatch: locked ? match : null };
  state.proc.clear();
  drawSwatches();
  refreshPreview();
}

function ensureRaw(cs) {
  if (!state.raw.has(cs.clip)) {
    const flat = on('flatNormals');
    state.raw.set(cs.clip, capturer.sampleTimes(cs.clip, num('fps')).map((t) => capturer.captureFrame(cs.clip, t, flat)));
  }
  return state.raw.get(cs.clip);
}

function ensureProc(cs) {
  if (!state.proc.has(cs.clip)) {
    const opts = processOptions();
    const frames = ensureRaw(cs).map((f) => processFrame(f, opts, state.ctx));
    state.proc.set(cs.clip, on('deflicker') ? reduceFlicker(frames, cs.loop) : frames);
  }
  return state.proc.get(cs.clip);
}

function refreshPreview() {
  if (!state.layout) return;
  const frames = ensureProc(previewState());
  drawSheets(frames);
  updateInfo(frames);
}

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

function drawSheets(frames) {
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

function totalExportFrames() {
  const fps = num('fps');
  return exportStates().reduce((n, cs) => n + capturer.sampleTimes(cs.clip, fps).length, 0);
}

function updateInfo(frames) {
  const L = state.layout;
  const colors = new Set();
  for (const f of frames) {
    for (let i = 0; i < f.color.length; i += 4) if (f.color[i + 3]) colors.add((f.color[i] << 16) | (f.color[i + 1] << 8) | f.color[i + 2]);
  }
  $('info').textContent = `Hücre ${L.w}×${L.h} px · bu animasyon ${frames.length} frame, ${colors.size} renk · export: ${totalExportFrames()} frame`;
}

function tick(now) {
  requestAnimationFrame(tick);
  const cs = previewState();
  const frames = state.proc.get(cs.clip);
  if (!frames || !frames.length) return;
  const fps = num('fps');
  if (state.playing) state.frame = Math.floor((now / 1000) * fps) % frames.length;
  const fi = Math.min(state.frame || 0, frames.length - 1);
  const view = $('view').value;
  let f = frames[fi];
  if (view === 'light' && state.mouseLight) {
    // Oyundaki dinamik ışığın taklidi: aynı ham veriyi fare yönünden gelen ışıkla yeniden gölgele
    f = processFrame(ensureRaw(cs)[fi], { ...processOptions(), bake: true, steps: Math.max(2, num('steps')), ...state.mouseLight }, state.ctx);
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
  state.boundsKey = '';
  $('modelInfo').textContent = `${label} · ${clips.length} animasyon`;
  renderClipList();
  relayout();
}

function renderClipList() {
  const box = $('clips');
  if (!state.clipStates.length) { box.textContent = 'Animasyon yok: tek poz çıkarılır.'; return; }
  box.replaceChildren(...state.clipStates.map((cs, i) => {
    const row = document.createElement('div');
    row.className = 'clip' + (i === state.current ? ' active' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = cs.include;
    cb.onclick = (e) => { e.stopPropagation(); cs.include = cb.checked; schedule(relayout); };
    const name = document.createElement('span');
    name.textContent = cs.clip.name || `clip_${i}`;
    const dur = document.createElement('small');
    dur.textContent = `${cs.clip.duration.toFixed(2)} sn`;
    const loop = document.createElement('label');
    loop.className = 'loop';
    loop.title = "Unity'de döngülü oynat";
    const loopCb = document.createElement('input');
    loopCb.type = 'checkbox'; loopCb.checked = cs.loop;
    loopCb.onclick = (e) => { e.stopPropagation(); cs.loop = loopCb.checked; state.proc.delete(cs.clip); refreshPreview(); };
    loop.onclick = (e) => e.stopPropagation();
    loop.append(loopCb, '↻');
    row.append(cb, name, dur, loop);
    row.onclick = () => { state.current = i; state.frame = 0; renderClipList(); refreshPreview(); };
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
      schedule(relayout);
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
const nextFrame = () => new Promise((r) => setTimeout(r, 0));

/** Export'a girecek bütün klipleri hesaplar; arayüz donmasın diye klip klip ilerler. */
async function prepareAll(onProgress) {
  const states = exportStates();
  for (let i = 0; i < states.length; i++) {
    onProgress?.(i, states.length, clipName(states[i]));
    await nextFrame();
    ensureProc(states[i]);
  }
}

/** prepareAll() sonrasında çağrılır. */
function buildExport() {
  const L = state.layout;
  const states = exportStates();
  const perClip = states.map((cs) => {
    const frames = state.proc.get(cs.clip);
    if (!frames) throw new Error(`'${clipName(cs)}' henüz hesaplanmadı`);
    return { cs, frames };
  });
  const frames = perClip.flatMap((c) => c.frames);
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
    pivot: L.pivot, // hücrenin sol-alt köşesinden piksel; karakterin ayağı buraya düşer
    pixelsPerUnit: num('unityPPU'),
    shadingBaked: on('bake'),
    clips: perClip.map(({ cs, frames: f }) => {
      const entry = { name: clipName(cs), start, count: f.length, fps: num('fps'), loop: cs.loop };
      start += f.length;
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
  const btn = $('export');
  const label = btn.textContent;
  btn.disabled = true;
  $('exportStatus').textContent = '';
  try {
    await prepareAll((i, n, clip) => { btn.textContent = `Hazırlanıyor ${i + 1}/${n}: ${clip}`; });
    btn.textContent = 'Paketleniyor…';
    await nextFrame();
    await saveExport(buildExport());
  } catch (err) {
    console.error(err);
    $('exportStatus').textContent = `Export başarısız: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function saveExport(ex) {
  download(await sheetBlob(ex.color), ex.meta.colorTexture);
  download(await sheetBlob(ex.normal), ex.meta.normalTexture);
  download(new Blob([JSON.stringify(ex.meta, null, 2)], { type: 'application/json' }), `${ex.name}.json`);
}

// ---------- olaylar ----------
let pending = null;
function schedule(fn) {
  // relayout, reprocess'i de kapsar; ikisi birden istenirse relayout kazanır
  if (pending === relayout && fn === reprocess) return;
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

for (const id of CAPTURE_IDS) $(id).addEventListener('input', () => { syncOutputs(); schedule(relayout); });
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
window.__app = { state, capturer, setModel, relayout, reprocess, prepareAll, buildExport, loadFile };
