// Araç açılır açılmaz bir şey görünsün diye kodla üretilen basit demo karakter.
// Bilerek "pixel art'a uygun" yapıldı: düz renkler, büyük kafa/el/ayak, az detay.

import * as THREE from 'three';

export function createDemoCharacter() {
  const mats = {};
  const mat = (hex) => (mats[hex] ??= new THREE.MeshStandardMaterial({ color: hex }));
  const joint = (name, parent, x, y, z) => {
    const g = new THREE.Group();
    g.name = name;
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  };
  const box = (parent, color, sx, sy, sz, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat(color));
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };
  // Yuvarlak parça: normal map'te hacim okunabilsin diye uzuvlar elipsoid
  const sphere = new THREE.SphereGeometry(0.5, 16, 12);
  const blob = (parent, color, sx, sy, sz, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(sphere, mat(color));
    m.scale.set(sx * 1.25, sy * 1.25, sz * 1.25);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };

  const CLOTH = 0x3b6ea5, SKIN = 0xe8b48a, DARK = 0x2b2a3a, SCARF = 0xd9483b, STEEL = 0xc9d3dc, BOOT = 0x6b4a3a;

  const root = new THREE.Group();
  root.name = 'demo';
  const hips = joint('hips', root, 0, 0.44, 0);
  blob(hips, DARK, 0.26, 0.12, 0.17);
  const torso = joint('torso', hips, 0, 0.06, 0);
  blob(torso, CLOTH, 0.3, 0.26, 0.2, 0, 0.13, 0);
  box(torso, SCARF, 0.32, 0.07, 0.22, 0, 0.26, 0);
  const scarf = joint('scarf', torso, 0, 0.26, -0.11);
  box(scarf, SCARF, 0.1, 0.07, 0.24, 0.05, 0, -0.12).name = 'Atkı ucu';
  const head = joint('head', torso, 0, 0.29, 0);
  blob(head, SKIN, 0.3, 0.26, 0.28, 0, 0.13, 0);
  box(head, DARK, 0.32, 0.1, 0.3, 0, 0.24, -0.005); // saç
  box(head, DARK, 0.2, 0.05, 0.02, 0, 0.13, 0.14); // gözler

  for (const [side, sx] of [['L', 1], ['R', -1]]) {
    const shoulder = joint('arm' + side, torso, sx * 0.2, 0.22, 0);
    blob(shoulder, CLOTH, 0.1, 0.17, 0.1, 0, -0.07, 0);
    const elbow = joint('forearm' + side, shoulder, 0, -0.16, 0);
    blob(elbow, SKIN, 0.09, 0.13, 0.09, 0, -0.06, 0);
    blob(elbow, SKIN, 0.12, 0.11, 0.12, 0, -0.17, 0); // büyük el
    if (side === 'R') {
      box(elbow, BOOT, 0.04, 0.04, 0.12, 0, -0.17, 0.05).name = 'Kılıç kabzası';
      box(elbow, STEEL, 0.03, 0.07, 0.46, 0, -0.17, 0.33).name = 'Kılıç';
    }
    const hip = joint('leg' + side, hips, sx * 0.08, -0.05, 0);
    blob(hip, DARK, 0.12, 0.2, 0.13, 0, -0.09, 0);
    const knee = joint('shin' + side, hip, 0, -0.19, 0);
    blob(knee, DARK, 0.1, 0.16, 0.11, 0, -0.08, 0);
    box(knee, BOOT, 0.13, 0.07, 0.22, 0, -0.165, 0.04); // büyük ayak
  }

  const e = new THREE.Euler();
  const q = new THREE.Quaternion();
  const rot = (name, times, angles) => {
    const values = [];
    for (const a of angles) {
      const [x, y, z] = Array.isArray(a) ? a : [a, 0, 0];
      q.setFromEuler(e.set(x, y, z));
      values.push(q.x, q.y, q.z, q.w);
    }
    return new THREE.QuaternionKeyframeTrack(name + '.quaternion', times, values);
  };
  const posY = (name, times, ys, base) =>
    new THREE.VectorKeyframeTrack(name + '.position', times, ys.flatMap((y) => [0, base + y, 0]));

  const tI = [0, 0.5, 1.0];
  const idle = new THREE.AnimationClip('idle', 1.0, [
    posY('hips', tI, [0, -0.02, 0], 0.44),
    rot('torso', tI, [0, 0.05, 0]),
    rot('armL', tI, [0.05, 0.15, 0.05]),
    rot('armR', tI, [-0.3, -0.2, -0.3]),
    rot('forearmR', tI, [-0.9, -1.0, -0.9]),
    rot('scarf', tI, [0.3, 0.5, 0.3]),
  ]);

  const tR = [0, 0.15, 0.3, 0.45, 0.6];
  const run = new THREE.AnimationClip('run', 0.6, [
    posY('hips', tR, [0, -0.04, 0, -0.04, 0], 0.44),
    rot('torso', tR, [0.25, 0.3, 0.25, 0.3, 0.25]),
    rot('head', tR, [-0.15, -0.2, -0.15, -0.2, -0.15]),
    rot('legL', tR, [-1.0, -0.1, 0.8, 0.0, -1.0]),
    rot('shinL', tR, [0.5, 0.2, 1.2, 1.7, 0.5]),
    rot('legR', tR, [0.8, 0.0, -1.0, -0.1, 0.8]),
    rot('shinR', tR, [1.2, 1.7, 0.5, 0.2, 1.2]),
    rot('armL', tR, [1.0, 0.0, -1.0, 0.0, 1.0]),
    rot('forearmL', tR, [-1.2, -1.2, -1.2, -1.2, -1.2]),
    rot('armR', tR, [-1.0, 0.0, 1.0, 0.0, -1.0]),
    rot('forearmR', tR, [-1.2, -1.2, -1.2, -1.2, -1.2]),
    rot('scarf', tR, [-0.2, 0.1, -0.2, 0.1, -0.2]),
  ]);

  // Saldırı: uzun hazırlık yok, hızlı vuruş, uzun toparlanma (Dead Cells'teki gibi pose-to-pose)
  const tA = [0, 0.1, 0.16, 0.3, 0.5];
  const attack = new THREE.AnimationClip('attack', 0.5, [
    posY('hips', tA, [0, 0.02, -0.06, -0.05, 0], 0.44),
    rot('torso', tA, [0, [-0.2, -0.5, 0], [0.5, 0.4, 0], [0.45, 0.35, 0], 0]),
    rot('armR', tA, [-0.3, -3.0, -1.0, -0.9, -0.3]),
    rot('forearmR', tA, [-0.9, -0.6, 0.3, 0.2, -0.9]),
    rot('armL', tA, [0.05, 0.6, -0.5, -0.4, 0.05]),
    rot('legL', tA, [0, 0.2, -0.7, -0.65, 0]),
    rot('shinL', tA, [0, 0.1, 0.7, 0.65, 0]),
    rot('legR', tA, [0, -0.1, 0.5, 0.45, 0]),
    rot('scarf', tA, [0.3, -0.3, 0.9, 0.6, 0.3]),
  ]);

  return { root, clips: [idle, run, attack] };
}
