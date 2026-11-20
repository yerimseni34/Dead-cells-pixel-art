// 3D model -> ham piksel verisi.
// Dead Cells'in yaptığı gibi: mesh DOĞRUDAN hedef çözünürlükte ve antialiasing
// olmadan render edilir. Büyük render alıp küçültmek yok (o bulanık kenar verir).

import * as THREE from 'three';

export class Capturer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    this.normalMat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
    this.depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking, side: THREE.DoubleSide });
    this.root = null;
    this.mixer = null;
    this.clips = [];
    this.meshes = [];
    this.layout = null;
    this.rootLock = true;
    this._locked = new Map();
  }

  setModel(root, clips) {
    if (this.root) this.scene.remove(this.root);
    this.root = root;
    this.clips = clips || [];
    this.scene.add(root);
    this.mixer = new THREE.AnimationMixer(root);
    this._locked = new Map();
    this.meshes = [];
    const basicCache = new Map();
    const toBasic = (m) => {
      if (!basicCache.has(m)) {
        // Işıksız düz renk: gölge sonradan normal map'ten, kademeli olarak hesaplanacak.
        const cutout = m.transparent || m.alphaTest > 0;
        basicCache.set(m, new THREE.MeshBasicMaterial({
          color: m.color ? m.color.clone() : new THREE.Color(1, 1, 1),
          map: m.map || null,
          vertexColors: !!m.vertexColors,
          side: m.side,
          alphaTest: cutout ? Math.max(m.alphaTest, 0.5) : 0,
        }));
      }
      return basicCache.get(m);
    };
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = false; // iskeletli mesh'lerde sınır kutusu yanıltıcı olabiliyor
      if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals(); // normal map için şart
      o.userData.basic = Array.isArray(o.material) ? o.material.map(toBasic) : toBasic(o.material);
      this.meshes.push(o);
    });
  }

  /** Klipteki örnekleme zamanları. Düşük fps + ara değer yok = pose-to-pose his. */
  sampleTimes(clip, fps) {
    if (!clip) return [0];
    const count = Math.max(1, Math.round(clip.duration * fps));
    return Array.from({ length: count }, (_, i) => (i * clip.duration) / count);
  }

  /**
   * Kök hareketini kilitler: animasyon karakteri ileri taşıyorsa (koşu, yuvarlanma) o yatay
   * kayma çıkarılır, karakter yerinde oynar. 2D oyunda hareketi oyun kodu yapar; sprite
   * yerinde durmazsa hücre devasa olur ve karakter hücrenin bir kenarına kayar.
   * Kalçanın sallanması ve dikey hareket (zıplama) korunur, yalnızca baştan sona kayma silinir.
   */
  _lockedClip(clip) {
    if (this._locked.has(clip)) return this._locked.get(clip);
    let result = clip;
    // En üstteki (köke en yakın) konum izi = kök hareketi
    let best = null, bestDepth = Infinity;
    for (const track of clip.tracks) {
      const parsed = THREE.PropertyBinding.parseTrackName(track.name);
      if (parsed.propertyName !== 'position') continue;
      const node = THREE.PropertyBinding.findNode(this.root, parsed.nodeName);
      if (!node || !node.parent) continue;
      let depth = 0;
      for (let n = node; n && n !== this.root; n = n.parent) depth++;
      if (depth < bestDepth) { bestDepth = depth; best = { track, node }; }
    }
    if (best && clip.duration > 0) {
      const interp = best.track.createInterpolant();
      const p0 = new THREE.Vector3().fromArray(interp.evaluate(0));
      const p1 = new THREE.Vector3().fromArray(interp.evaluate(clip.duration));
      this.root.updateMatrixWorld(true);
      const parentM = new THREE.Matrix3().setFromMatrix4(best.node.parent.matrixWorld);
      const world = p1.clone().sub(p0).applyMatrix3(parentM);
      world.y = 0; // dikey hareket kalsın
      const local = world.applyMatrix3(parentM.clone().invert());
      if (local.lengthSq() > 1e-12) {
        const track = best.track.clone();
        const v = track.values;
        for (let k = 0; k < track.times.length; k++) {
          const f = track.times[k] / clip.duration;
          v[k * 3] -= local.x * f; v[k * 3 + 1] -= local.y * f; v[k * 3 + 2] -= local.z * f;
        }
        result = new THREE.AnimationClip(clip.name, clip.duration, clip.tracks.map((t) => (t === best.track ? track : t)));
      }
    }
    this._locked.set(clip, result);
    return result;
  }

  pose(clip, time) {
    this.mixer.stopAllAction();
    if (clip) {
      const action = this.mixer.clipAction(this.rootLock ? this._lockedClip(clip) : clip);
      action.reset().play();
      this.mixer.setTime(time);
    }
    this.root.updateMatrixWorld(true);
  }

  _placeCamera(yawDeg, pitchDeg) {
    const yaw = (yawDeg * Math.PI) / 180, pitch = (pitchDeg * Math.PI) / 180;
    const dir = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    this.camera.position.copy(dir);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld(true);
  }

  /** Kamera uzayında modelin kapladığı kutu (o anki poz için). */
  _expandBounds(box) {
    const v = new THREE.Vector3();
    const view = this.camera.matrixWorldInverse;
    for (const mesh of this.meshes) {
      if (!mesh.visible) continue;
      const pos = mesh.geometry.attributes.position;
      const stride = Math.max(1, Math.floor(pos.count / 1500));
      for (let i = 0; i < pos.count; i += stride) {
        mesh.getVertexPosition(i, v);
        v.applyMatrix4(mesh.matrixWorld).applyMatrix4(view);
        box.expandByPoint(v);
      }
    }
  }

  /**
   * Seçili kliplerin bütün frame'lerini kapsayan kutuyu ölçer (kamera uzayında, kamera orijinden
   * 1 birim uzakta). Render yapmaz, sadece köşe noktalarını hesaplar; karakter boyu değişince
   * yeniden ölçmeye gerek yoktur.
   */
  measureBounds({ clips, fps, yaw, pitch }) {
    this._placeCamera(yaw, pitch);
    const list = clips.length ? clips : [null];
    // Referans: ilk klibin ilk karesi (boy ve ortalama bunun üzerinden)
    this.pose(list[0], 0);
    const ref = new THREE.Box3();
    this._expandBounds(ref);
    const box = new THREE.Box3();
    for (const clip of list) {
      for (const t of this.sampleTimes(clip, fps)) {
        this.pose(clip, t);
        this._expandBounds(box);
      }
    }
    return { ref, box, yaw, pitch };
  }

  /**
   * Hücre boyutunu ve kamerayı ayarlar. Bütün frame'ler TEK bir hücre boyutunu paylaşır ve
   * çapa noktası (ayak) her frame'de aynı piksele düşer; böylece sprite oyunda zıplamaz.
   * center=true: çapa, ilk karedeki karakterin yatay ortası ve en alt noktası
   *              (model orijini ayakta değilse ya da karakter orijinden kaymışsa).
   * center=false: çapa, modelin orijini.
   */
  applyLayout({ ref, box, yaw, pitch }, { charHeight, padding, center }) {
    this._placeCamera(yaw, pitch);
    const refHeight = Math.max(1e-6, ref.max.y - ref.min.y);
    const ppu = charHeight / refHeight; // dünya birimi başına piksel
    const ax = center ? (ref.min.x + ref.max.x) / 2 : 0;
    const ay = center ? ref.min.y : 0;

    const left = Math.max(0, Math.ceil((ax - box.min.x) * ppu)) + padding;
    const right = Math.max(0, Math.ceil((box.max.x - ax) * ppu)) + padding;
    const down = Math.max(0, Math.ceil((ay - box.min.y) * ppu)) + padding;
    const up = Math.max(0, Math.ceil((box.max.y - ay) * ppu)) + padding;
    const w = Math.max(2, left + right), h = Math.max(2, down + up);

    // Ölçüm sırasında kamera orijinden 1 birim uzaktaydı: z_view = (bakış ekseni üzerindeki konum) - 1
    const zNear = box.max.z + 1, zFar = box.min.z + 1; // kameraya en yakın / en uzak nokta
    const depthPad = (zNear - zFar) * 0.05 + 1e-3;
    const dist = zNear + depthPad + 1; // kamera modelin tamamen dışında
    this.camera.position.setLength(dist);
    this.camera.left = ax - left / ppu;
    this.camera.right = ax + right / ppu;
    this.camera.bottom = ay - down / ppu;
    this.camera.top = ay + up / ppu;
    this.camera.near = 1;
    this.camera.far = dist - zFar + depthPad;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);

    this.renderer.setSize(w, h, false);
    this.layout = {
      w, h, ppu, refHeight,
      pivot: { x: left, y: down }, // sol-alt köşeden piksel
      depthRange: this.camera.far - this.camera.near,
    };
    return this.layout;
  }

  /** Sadece düz renk geçişi (palet çıkarmak için). */
  captureAlbedo(clip, time) {
    this.pose(clip, time);
    const originals = this.meshes.map((m) => m.material);
    this.meshes.forEach((m) => { m.material = m.userData.basic; });
    this.renderer.render(this.scene, this.camera);
    this.meshes.forEach((m, i) => { m.material = originals[i]; });
    const { w, h } = this.layout;
    return { w, h, albedo: this._read() };
  }

  _read() {
    const { w, h } = this.layout;
    const gl = this.renderer.getContext();
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    // GL satırları aşağıdan yukarı verir; resim düzenine çevir
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) out.set(buf.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    return out;
  }

  /** Tek poz için 3 geçiş: düz renk, normal, derinlik. */
  captureFrame(clip, time, flatNormals) {
    const { w, h } = this.layout;
    this.pose(clip, time);

    const originals = this.meshes.map((m) => m.material);
    this.meshes.forEach((m) => { m.material = m.userData.basic; });
    this.renderer.render(this.scene, this.camera);
    const albedo = this._read();
    this.meshes.forEach((m, i) => { m.material = originals[i]; });

    if (this.normalMat.flatShading !== flatNormals) {
      this.normalMat.flatShading = flatNormals;
      this.normalMat.needsUpdate = true;
    }
    this.scene.overrideMaterial = this.normalMat;
    this.renderer.render(this.scene, this.camera);
    const normal = this._read();

    this.scene.overrideMaterial = this.depthMat;
    this.renderer.render(this.scene, this.camera);
    const d = this._read();
    this.scene.overrideMaterial = null;

    const depth = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) depth[i] = albedo[i * 4 + 3] >= 128 ? d[i * 4] : 0;
    return { w, h, albedo, normal, depth };
  }
}
