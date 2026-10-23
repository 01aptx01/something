import * as T from 'three';

export type Obstacle = { x: number; z: number; w: number; d: number };
export const material = (color: string, roughness = .8, metalness = 0) => new T.MeshStandardMaterial({ color, roughness, metalness });
export function mesh(root: T.Object3D, geometry: T.BufferGeometry, mat: T.Material, x = 0, y = 0, z = 0) {
  const object = new T.Mesh(geometry, mat);
  object.position.set(x, y, z); object.castShadow = object.receiveShadow = true; root.add(object); return object;
}
export function box(root: T.Object3D, mat: T.Material, x: number, y: number, z: number, w: number, h: number, d: number) {
  return mesh(root, new T.BoxGeometry(w, h, d), mat, x, y, z);
}
export function sphere(root: T.Object3D, mat: T.Material, x: number, y: number, z: number, r: number, sx = 1, sy = 1, sz = 1) {
  const object = mesh(root, new T.SphereGeometry(r, 20, 14), mat, x, y, z); object.scale.set(sx, sy, sz); return object;
}
export function rod(root: T.Object3D, mat: T.Material, from: number[], to: number[], radius: number, top = radius, sides = 10) {
  const a = new T.Vector3(...from), b = new T.Vector3(...to), direction = b.clone().sub(a);
  const object = mesh(root, new T.CylinderGeometry(top, radius, direction.length(), sides), mat);
  object.position.copy(a.add(b).multiplyScalar(.5)); object.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), direction.normalize()); return object;
}
export function seeded(seed: number) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}
export function surface(kind: 'wood' | 'stone' | 'sand') {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const ctx = c.getContext('2d')!, random = seeded(92);
  ctx.fillStyle = kind === 'wood' ? '#a07141' : kind === 'stone' ? '#9d998d' : '#d0b789'; ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2200; i++) {
    const v = Math.floor(60 + random() * 90); ctx.fillStyle = `rgba(${v},${v * .85},${v * .65},${random() * .18})`;
    ctx.fillRect(random() * 256, random() * 256, kind === 'wood' ? 2 : 1 + random() * 8, kind === 'wood' ? 10 + random() * 65 : 1 + random() * 4);
  }
  if (kind !== 'sand') {
    ctx.strokeStyle = '#30281f65'; ctx.lineWidth = 2;
    for (let y = 0; y < 256; y += kind === 'wood' ? 64 : 32) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke();
      for (let x = 0; x < 256; x += kind === 'wood' ? 32 : 64) {
        ctx.beginPath(); ctx.moveTo(x + (y % 64 ? 32 : 0), y); ctx.lineTo(x + (y % 64 ? 32 : 0), y + (kind === 'wood' ? 64 : 32)); ctx.stroke();
      }
    }
  }
  const texture = new T.CanvasTexture(c); texture.colorSpace = T.SRGBColorSpace; texture.wrapS = texture.wrapT = T.RepeatWrapping; texture.repeat.set(4, 4); texture.anisotropy = 4;
  return texture;
}
export function sky(top: string, bottom: string) {
  const c = document.createElement('canvas'); c.width = 16; c.height = 256;
  const ctx = c.getContext('2d')!, gradient = ctx.createLinearGradient(0, 0, 0, 256);
  gradient.addColorStop(0, top); gradient.addColorStop(.7, bottom); gradient.addColorStop(1, bottom); ctx.fillStyle = gradient; ctx.fillRect(0, 0, 16, 256);
  const texture = new T.CanvasTexture(c); texture.colorSpace = T.SRGBColorSpace;
  const dome = new T.Mesh(new T.SphereGeometry(105, 32, 24), new T.MeshBasicMaterial({ map: texture, side: T.BackSide, depthWrite: false })); dome.userData.dynamic = true; return dome;
}
export function lights(root: T.Group, world: number) {
  root.add(new T.HemisphereLight(world === 1 ? '#a2b8ff' : '#ddf4ff', world === 1 ? '#352340' : '#70604a', world === 1 ? 1.6 : 2.1));
  const sun = new T.DirectionalLight(world === 1 ? '#a2b5ff' : '#fff0ca', world === 1 ? 2.2 : 3.2);
  sun.position.set(-16, 30, 12); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -38, right: 38, top: 38, bottom: -38, near: 1, far: 90 }); sun.shadow.bias = -.0005; sun.shadow.normalBias = .035; root.add(sun);
  const rim = new T.DirectionalLight(world === 1 ? '#d795ff' : '#63c7e5', .7); rim.position.set(15, 8, -16); root.add(rim);
}
