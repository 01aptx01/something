import * as T from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { box, lights, material, mesh, rod, seeded, sky, sphere, texturedMaterial, type Obstacle } from './kit';
import { loadCharacter, disposeCharacter } from './characters';

export type Destination = { name: string; english: string; position: [number, number, number]; look: [number, number, number]; marker: [number, number, number] };
export const DESTINATIONS: Destination[][] = [
  [
    { name: 'ดาดฟ้าเรือ', english: 'THE SUNNY / 01', position: [2.6, 1.7, 2], look: [0, 2.4, -5], marker: [0, 2, -5] },
    { name: 'ท่าเรือหมวกฟาง', english: 'STRAW HAT HARBOR / 02', position: [14.5, 1.7, 5], look: [0, 2.5, 0], marker: [12, 1, 0] },
    { name: 'ชายหาดลับ', english: 'HIDDEN COVE / 03', position: [20, 1.7, -14], look: [10, 1, -6], marker: [21, 1, -12] },
  ],
  [
    { name: 'อุโมงค์วิสทีเรีย', english: 'WISTERIA PASSAGE / 01', position: [0, 1.7, 13], look: [0, 2, -8], marker: [0, 2, 0] },
    { name: 'ศาลเจ้าใต้แสงจันทร์', english: 'MOONLIT SHRINE / 02', position: [0, 1.7, -11], look: [0, 2.5, -22], marker: [0, 2, -22] },
    { name: 'ลานฝึกริมธาร', english: 'WATER TRAINING / 03', position: [15, 1.7, 0], look: [20, 1, -8], marker: [19, 1, -7] },
  ],
  [
    { name: 'ถนนชิกันชินะ', english: 'SHIGANSHINA / 01', position: [0, 1.7, 16], look: [0, 7, -20], marker: [0, 2, 0] },
    { name: 'ประตูกำแพง', english: 'THE OUTER GATE / 02', position: [0, 1.7, -12], look: [0, 9, -23], marker: [0, 3, -22] },
    { name: 'จุดเฝ้าระวังบนกำแพง', english: 'WALL WATCH / 03', position: [12, 10.7, -21], look: [0, 2, 10], marker: [12, 11, -21] },
  ],
];
export type Environment = { root: T.Group; obstacles: Obstacle[]; water?: T.ShaderMaterial; particles?: T.Points; fog: string; density: number };

function optimize(root: T.Group) {
  root.updateMatrixWorld(true);
  const buckets = new Map<string, { mat: T.Material; geometries: T.BufferGeometry[] }>(), originals: T.Mesh[] = [];
  root.traverse(object => {
    if (!(object instanceof T.Mesh) || object instanceof T.InstancedMesh || Array.isArray(object.material) || object.userData.dynamic) return;
    const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld);
    // Only merge compatible vertex layouts. An unindexed ramp must never discard a textured wall.
    const layout = Object.keys(geometry.attributes).map(key => { const a = geometry.getAttribute(key) as T.BufferAttribute; return `${key}:${a.itemSize}:${a.normalized}`; }).sort().join('|');
    const key = `${object.material.uuid}:${!!geometry.index}:${layout}`;
    const bucket = buckets.get(key) ?? { mat: object.material, geometries: [] as T.BufferGeometry[] }; bucket.geometries.push(geometry); buckets.set(key, bucket); originals.push(object);
  });
  const old = new Set<T.BufferGeometry>();
  for (const object of originals) { old.add(object.geometry); object.removeFromParent(); }
  old.forEach(g => g.dispose());
  buckets.forEach(({ geometries, mat }) => {
    const merged = mergeGeometries(geometries, false);
    if (merged) { mesh(root, merged, mat); geometries.forEach(g => g.dispose()); }
    else geometries.forEach(g => mesh(root, g, mat));
  });
}
function water(root: T.Group, color: string, x: number, z: number, w: number, d: number, y: number) {
  const mat = new T.ShaderMaterial({
    uniforms: { time: { value: 0 }, color: { value: new T.Color(color) } },
    vertexShader: `varying vec3 p; uniform float time; void main(){vec3 v=position;v.z+=sin(v.x*.75+time)*.055+cos(v.y*.8+time*.7)*.045;vec4 world=modelMatrix*vec4(v,1.);p=world.xyz;gl_Position=projectionMatrix*viewMatrix*world;}`,
    fragmentShader: `varying vec3 p;uniform float time;uniform vec3 color;
    void main(){
      float a=p.x*.75+time,b=p.z*.8+time*.7;
      vec3 n=normalize(vec3(-cos(a)*.085,1.,sin(b)*.065));
      vec3 view=normalize(cameraPosition-p);float fresnel=pow(1.-max(0.,dot(n,view)),4.);
      float ripple=sin(p.x*2.+sin(p.z*.8+time)*2.+time)*sin(p.z*2.1-time*.7);
      float glint=pow(max(0.,dot(reflect(normalize(vec3(-.4,-1.,.2)),n),view)),96.);
      vec3 c=mix(color*(.8+ripple*.08),vec3(.42,.62,.71),fresnel*.75)+vec3(1.,.86,.56)*glint*.55;
      gl_FragColor=vec4(c,1.);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  });
  const sea = mesh(root, new T.PlaneGeometry(w, d, 80, 80), mat, x, y, z); sea.rotation.x = -Math.PI / 2; sea.userData.dynamic = true; sea.castShadow = false; return mat;
}
function particles(root: T.Group, color: string, count: number, random: () => number) {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) positions.set([(random() - .5) * 48, 1 + random() * 10, (random() - .5) * 55], i * 3);
  const geo = new T.BufferGeometry(); geo.setAttribute('position', new T.BufferAttribute(positions, 3));
  const points = new T.Points(geo, new T.PointsMaterial({ color, size: .055, transparent: true, opacity: .7, depthWrite: false })); root.add(points); return points;
}
function placeCast(root: T.Group, world: number, x: number, z: number) {
  const names = [['luffy', 'zoro'], ['tanjiro', 'nezuko'], ['levi', 'mikasa','eren']][world];
  const controller=new AbortController();root.userData.abortAssets=()=>controller.abort();
  names.forEach((id,i)=>{void loadCharacter(id,controller.signal).then(figure=>{
    if(controller.signal.aborted){disposeCharacter(figure);return;}
    figure.position.set(x+(i-(names.length-1)/2)*1.5,.08,z);figure.rotation.y=i?-.25:.25;root.add(figure);root.userData.onAsset?.();
  }).catch(()=>{/* Decorative figures never block walking. The studio provides retry. */});});
}
function seaWorld(): Environment {
  const root = new T.Group(), obstacles: Obstacle[] = [], random = seeded(440);
  root.add(sky('#28639a', '#c4e1dd')); lights(root, 0);
  const wood = texturedMaterial('#c69a64','wood');
  const darkWood = material('#65452e'), trim = material('#d8b96e', .5), cream = material('#f4e8c6'), red = material('#a83832'), leaf = material('#386f53');
  const sand = texturedMaterial('#e1c999','sand');
  const ocean = water(root, '#147d91', 0, 0, 180, 180, -1.05);
  // The ship is a complete volume with a curved hull, walkable deck, rails, rigging and sails.
  const hull = mesh(root, new T.CylinderGeometry(1, .8, 2.2, 32), darkWood, 0, -1.1, 0); hull.scale.set(4.1, 1, 10.5);
  box(root, wood, 0, -.12, 0, 7.6, .24, 17);
  box(root, trim, 0, -.28, 0, 8, .18, 17.3);
  for (const s of [-1, 1]) {
    for (let z = -7; z <= 8; z += 1.1) {
      if (s === 1 && z > -.5 && z < 2.5) continue;
      rod(root, cream, [s * 3.75, 0, z], [s * 3.75, .9, z], .055);
    }
    rod(root, darkWood, [s * 3.75, .95, -7.9], [s * 3.75, .95, -.1], .065);
    rod(root, darkWood, [s * 3.75, .95, 2.5], [s * 3.75, .95, 8], .065);
  }
  box(root, red, 0, .92, 7.1, 4.2, 1.8, 2.2); box(root, cream, 0, 1.85, 7.1, 4.6, .15, 2.6);
  for (const x of [-1.25, 0, 1.25]) sphere(root, material('#81bdc8', .3), x, 1.0, 5.98, .28, 1, 1, .16);
  obstacles.push({ x: 0, z: 7.1, w: 4.5, d: 2.5 });
  for (const [z, height] of [[-3, 9], [3, 6.5]]) {
    rod(root, darkWood, [0, 0, z], [0, height, z], .13, .10, 16); obstacles.push({ x: 0, z, w: .6, d: .6 });
    rod(root, darkWood, [-3.0, height - 1, z], [3, height - 1, z], .07);
    const geo = new T.PlaneGeometry(5.8, height * .53, 24, 16), p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setZ(i, Math.cos(p.getX(i) / 3 * Math.PI / 2) * .8 * Math.sin((p.getY(i) / (height * .53) + .5) * Math.PI));
    geo.computeVertexNormals(); const cloth = material('#f4ecd3'); cloth.side = T.DoubleSide;
    mesh(root, geo, cloth, 0, height * .62, z);
    for (const s of [-1, 1]) rod(root, material('#a8986e'), [0, height - .2, z], [s * 3.6, .85, z + 2], .014, .014, 5);
  }
  // Straw hat Jolly Roger sculpted on the forward sail.
  const ink = material('#283340'); sphere(root, ink, 0, 5.65, -2.14, .59, 1.1, 1, .045);
  for (const s of [-1, 1]) sphere(root, cream, s * .22, 5.75, -2.10, .16, 1, 1, .1);
  box(root, cream, 0, 5.26, -2.09, .5, .22, .025); box(root, trim, 0, 6.20, -2.10, 1.5, .10, .03);
  sphere(root, trim, 0, 6.28, -2.12, .5, 1, .45, .08);
  for (const s of [-1, 1]) rod(root, ink, [-.8, 5.02 + (s + 1) * .45, -2.09], [.8, 5.92 - (s + 1) * .45, -2.09], .055);
  // Lion figurehead sits at the bow, visible from the harbor.
  sphere(root, trim, 0, .15, -9, .85, 1, 1, .8);
  sphere(root, material('#e4ae4d'), 0, .15, -9.55, .57, 1, 1, .55);
  for (const s of [-1, 1]) sphere(root, ink, s * .22, .28, -9.87, .075);
  for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; sphere(root, trim, Math.sin(a) * .81, .15 + Math.cos(a) * .81, -9.25, .18); }
  // Jetty connects the deck to a broad explorable island.
  box(root, wood, 9, -.12, 1.1, 12, .24, 2.7);
  for (let x = 5; x <= 15; x += 2) for (const z of [-.1, 2.3]) rod(root, darkWood, [x, -1.4, z], [x, .8, z], .10);
  box(root, sand, 23, -.35, -1, 20, .7, 44);
  const rock = material('#7b8e87');
  for (let i = 0; i < 20; i++) sphere(root, rock, 30 + random() * 3, .15, -22 + i * 2.3, .7 + random(), 1, .8, 1);
  for (let i = 0; i < 10; i++) {
    const x = 17 + random() * 13, z = -20 + random() * 38;
    if (Math.abs(z - 1) < 4) continue;
    rod(root, darkWood, [x, 0, z], [x + .5, 5, z + .2], .16, .08);
    obstacles.push({ x, z, w: .6, d: .6 });
    for (let j = 0; j < 7; j++) {
      const a = j * Math.PI * 2 / 7;
      const frond = sphere(root, leaf, x + .5 + Math.sin(a) * 1.1, 5, z + .2 + Math.cos(a) * 1.1, 1, .34, .10, 1.9); frond.rotation.y = a; frond.rotation.z = .22;
    }
  }
  for (const [x, z] of [[17, 6], [23, 10]]) {
    box(root, cream, x, 1.4, z, 3.2, 2.8, 3); const roof = mesh(root, new T.ConeGeometry(2.8, 1.5, 4), red, x, 3.5, z); roof.rotation.y = Math.PI / 4;
    box(root, darkWood, x, .8, z + 1.51, .8, 1.6, .05); obstacles.push({ x, z, w: 3.4, d: 3.3 });
  }
  // Treasure destination and coastal rock arches.
  box(root, darkWood, 24, .35, -15, 1.4, .7, .9); box(root, trim, 24, .74, -15, 1.5, .12, .95);
  for (const x of [23.5, 24.5]) box(root, trim, x, .38, -14.54, .09, .65, .035);
  for (const x of [-18, -30, 42]) sphere(root, leaf, x, 0, -42, 7, 1.1, .65, 1);
  for (let i = 0; i < 8; i++) sphere(root, cream, -28 + i * 10, 20 + i % 3, -55, 3, 2, .5, 1);
  placeCast(root, 0, 1.5, -5.8);
  optimize(root); return { root, obstacles, water: ocean, fog: '#bddee0', density: .008 };
}
function nightWorld(): Environment {
  const root = new T.Group(), obstacles: Obstacle[] = [], random = seeded(221);
  root.add(sky('#090e2e', '#45416a')); lights(root, 1);
  sphere(root, new T.MeshBasicMaterial({ color: '#f5e9ce' }), -25, 35, -65, 3);
  const ground = material('#293e3e'), stone = texturedMaterial('#87868b','stone');
  const bark = material('#4d393e'), red = material('#973e46'), roofmat = material('#252c42'), wood = material('#816250');
  box(root, ground, 0, -.22, 0, 65, .4, 70);
  box(root, stone, 0, -.02, -2, 4.2, .12, 52);
  box(root, stone, 10, -.02, -2, 20, .12, 3.5);
  const purple = [material('#8a66af'), material('#aa81c9'), material('#c4a3db'), material('#66508e')];
  // Curved hanging wisteria clusters use instancing instead of hundreds of draw calls.
  const flowerGeo = new T.IcosahedronGeometry(.19, 1);
  const flowers = purple.map(mat => new T.InstancedMesh(flowerGeo, mat, 500)); const counts = [0, 0, 0, 0];
  const transform = new T.Object3D();
  for (let i = 0; i < 30; i++) {
    const z = -25 + i * 1.9, s = i % 2 ? 1 : -1, x = s * (4.4 + random() * 2);
    rod(root, bark, [x, 0, z], [x * .87, 6.5 + random() * 2, z], .25, .12);
    rod(root, bark, [x * .9, 5.2, z], [s * .3, 6.6, z + 1.2], .13, .035);
    obstacles.push({ x, z, w: .9, d: .9 });
    for (let strand = 0; strand < 12; strand++) {
      const fx = x * .75 + (random() - .5) * 5, fz = z + (random() - .5) * 3, length = 3 + Math.floor(random() * 5), color = Math.floor(random() * 4);
      for (let j = 0; j < length; j++) {
        if (counts[color] >= 500) continue;
        transform.position.set(fx + Math.sin(j) * .05, 6.5 - j * .26, fz); transform.scale.setScalar(1 - j / (length + 2)); transform.updateMatrix(); flowers[color].setMatrixAt(counts[color]++, transform.matrix);
      }
    }
  }
  flowers.forEach((f, i) => { f.count = counts[i]; f.castShadow = true; root.add(f); });
  const glow = new T.MeshBasicMaterial({ color: '#ffda9c' });
  for (let z = -23; z <= 17; z += 6) for (const s of [-1, 1]) {
    const x = s * 3.1; box(root, stone, x, .14, z, .65, .28, .65); rod(root, wood, [x, .25, z], [x, 1.5, z], .09);
    box(root, glow, x, 1.65, z, .42, .55, .42); box(root, roofmat, x, 1.97, z, .65, .12, .65);
    if (s === 1 && z % 12 !== 0) { const light = new T.PointLight('#ffac61', 3, 5, 2); light.position.set(x, 1.8, z); root.add(light); }
  }
  for (const z of [6, -8, -17]) {
    for (const s of [-1, 1]) rod(root, red, [s * 2.7, 0, z], [s * 2.7, 5.2, z], .18, .14);
    box(root, red, 0, 4.1, z, 6.2, .25, .32); box(root, red, 0, 5, z, 7.3, .35, .5); box(root, roofmat, 0, 5.22, z, 7.5, .12, .6);
  }
  // Shrine with veranda, layered tiled roof, columns, doors and hanging bell.
  box(root, stone, 0, .22, -25, 9, .45, 6);
  box(root, wood, 0, .7, -25, 8.5, .35, 5.5);
  box(root, red, 0, 2.1, -26, 7.5, 2.8, 3.2);
  for (const x of [-3.8, -1.3, 1.3, 3.8]) rod(root, red, [x, .8, -23], [x, 4.2, -23], .11);
  for (let i = 0; i < 2; i++) { const roof = mesh(root, new T.ConeGeometry(6.5 - i * 1.3, 1.8, 4), roofmat, 0, 4.25 + i * 1.1, -25); roof.rotation.y = Math.PI / 4; roof.scale.z = .72; }
  for (const x of [-2, 0, 2]) { box(root, creamMaterial(), x, 2.3, -24.36, 1.4, 2.2, .035); for (let y = 1.4; y < 3.4; y += .3) box(root, wood, x, y, -24.32, 1.45, .035, .04); }
  rod(root, wood, [0, 3.8, -22.8], [0, 1.4, -22.8], .035); sphere(root, material('#b19e66', .3, .5), 0, 3.7, -22.8, .19);
  obstacles.push({ x: 0, z: -25.4, w: 9, d: 5.5 });
  const stream = water(root, '#204d74', 20, 0, 5, 58, -.03);
  for (let z = -26; z < 27; z += 2) for (const x of [17.5, 22.5]) sphere(root, stone, x, .12, z, .6, 1, .55, 1.2);
  box(root, wood, 20, .1, -1, 8, .18, 2.7);
  for (const z of [-2.2, .2]) { rod(root, red, [16, 1, z], [24, 1, z], .055); for (const x of [16.5, 20, 23.5]) rod(root, red, [x, .1, z], [x, 1, z], .055); }
  for (const [x, z] of [[12, -9], [14, -12], [12, -15]]) { box(root, wood, x, .9, z, .32, 1.8, .32); rod(root, wood, [x - .8, 1.4, z], [x + .8, 1.4, z], .09); }
  for (let i = 0; i < 20; i++) { const x = -25 + random() * 50, z = -32 + random() * 60; if (Math.abs(x) < 8 || x > 10) continue; sphere(root, stone, x, .3, z, .6 + random(), 1, .7, 1); }
  placeCast(root, 1, -1, -4);
  const motes = particles(root, '#e1a9ff', 160, random);
  optimize(root); return { root, obstacles, water: stream, particles: motes, fog: '#26263d', density: .017 };
}
const creamMaterial = () => material('#dbbd9f');
function cityWorld(): Environment {
  const root = new T.Group(), obstacles: Obstacle[] = [], random = seeded(91);
  root.add(sky('#697387', '#e5b48a')); lights(root, 2);
  const stone = texturedMaterial('#b5ad95','stone');
  const paving = texturedMaterial('#b0a28e','stone');
  const plaster = [material('#d8c8ac'), material('#c8b69e'), material('#e1d4ba')], timber = material('#584538'), tile = material('#934b39'), glass = material('#647e86', .3);
  box(root, paving, 0, -.3, 0, 62, .6, 70);
  // Tall outer wall, open arch gateway and parapet; its top is reachable by a long ramp.
  for (const s of [-1, 1]) box(root, stone, s * 18, 4.5, -24, 28, 9, 3.5);
  box(root, stone, 0, 8, -24, 8, 2, 3.5);
  for (let x = -31; x <= 31; x += 2) box(root, stone, x, 9.65, -25.4, .95, 1.3, .6);
  box(root, stone, 0, 9.1, -23, 64, .35, 4.6);
  for (let x = -30; x <= 30; x += 5) box(root, stone, x, 4.6, -21.9, .5, 9.2, .5);
  // Arched portcullis above the walk-through opening.
  const arch = mesh(root, new T.TorusGeometry(3.6, .34, 8, 40, Math.PI), stone, 0, 3.6, -21.9); arch.rotation.z = 0;
  for (const x of [-3.6, 3.6]) box(root, stone, x, 1.8, -21.9, .7, 3.6, .65);
  obstacles.push({ x: -18, z: -24, w: 28, d: 3.5 }, { x: 18, z: -24, w: 28, d: 3.5 });
  const rampGeo = new T.BufferGeometry();
  rampGeo.setAttribute('position', new T.Float32BufferAttribute([10,0,13,14,0,13,10,9,-21,14,0,13,14,9,-21,10,9,-21], 3)); rampGeo.computeVertexNormals(); mesh(root, rampGeo, stone);
  for (const x of [10, 14]) rod(root, timber, [x, 1, 13], [x, 10, -21], .07);
  for (let i = 0; i < 18; i++) { const z = 13 - i * 1.85, y = (13 - z) / 34 * 9; for (const x of [10,14]) rod(root, timber, [x, y, z], [x, y + 1, z], .055); }
  // Half-timbered houses form several streets, with real roof volumes and chimneys.
  for (const s of [-1, 1]) for (let i = 0; i < 5; i++) {
    const x = s * (7 + (i % 2) * .3), z = 15 - i * 7.4, w = 4.2, h = 4.8 + random() * 1.8, d = 5.3;
    box(root, plaster[i % 3], x, h / 2, z, w, h, d); obstacles.push({ x, z, w: w + .3, d: d + .3 });
    const roof = mesh(root, new T.ConeGeometry(3.6, 2.2, 4), tile, x, h + .95, z); roof.rotation.y = Math.PI / 4; roof.scale.z = 1.22;
    box(root, stone, x + 1.2, h + 1, z - .8, .55, 2.5, .55);
    for (const y of [h * .45, h - .2]) box(root, timber, x, y, z + d / 2 + .025, w, .12, .1);
    for (const offset of [-1.75, 0, 1.75]) box(root, timber, x + offset, h / 2, z + d / 2 + .03, .12, h, .1);
    for (const y of [1.35, 3.7]) for (const dx of [-1, 1]) {
      box(root, timber, x + dx, y, z + d / 2 + .09, .90, 1.2, .12);
      box(root, glass, x + dx, y, z + d / 2 + .16, .68, .98, .04);
      box(root, plaster[0], x + dx, y, z + d / 2 + .19, .045, .98, .025);
    }
    const brace = box(root, timber, x + 1, h * .72, z + d / 2 + .07, .10, h * .52, .09); brace.rotation.z = -.6;
    // Road-facing side windows make the houses read from within the street too.
    for (const y of [1.6, 3.9]) for (const dz of [-1.5, 1.5]) box(root, glass, x - s * 2.11, y, z + dz, .04, .8, .65);
  }
  for (const side of [-1, 1]) for (let i = 0; i < 12; i++) {
    const x = side * (18 + (i % 3) * 5.5), z = -14 + Math.floor(i / 3) * 11, h = 3.6 + random() * 3;
    box(root, plaster[i % 3], x, h / 2, z, 4, h, 4.8);
    const roof = mesh(root, new T.ConeGeometry(3.35, 2, 4), tile, x, h + .85, z); roof.rotation.y = Math.PI / 4;
    for (const dx of [-1,1]) box(root, glass, x + dx, h * .65, z + 2.42, .65, .9, .04);
    obstacles.push({ x, z, w: 4.2, d: 5 });
  }
  // Side plaza fountain, market and scout supply crates.
  box(root, paving, -19, -.04, 4, 15, .12, 25);
  const basin = mesh(root, new T.CylinderGeometry(2.5, 2.8, .55, 32), stone, -18, .28, 4);
  basin.receiveShadow = true; mesh(root, new T.CylinderGeometry(2.2, 2.2, .06, 32), material('#649b9f', .2), -18, .58, 4);
  rod(root, stone, [-18, .5, 4], [-18, 2.6, 4], .18); sphere(root, stone, -18, 2.6, 4, .38);
  obstacles.push({ x: -18, z: 4, w: 5, d: 5 });
  for (let i = 0; i < 5; i++) { box(root, timber, -22 + i * 1.3, .45, -5, 1, .9, 1); box(root, tile, -22 + i * 1.3, .94, -5, 1.05, .09, 1.05); }
  // Colossal silhouette beyond the gate conveys the scale of the wall.
  const titan = material('#a36c5e'), muscle = material('#713e3b');
  sphere(root, titan, -12, 13, -33, 2, .8, 1.2, .7); sphere(root, muscle, -12, 8, -33, 4, 1.5, 1.2, .6);
  for (const s of [-1, 1]) { rod(root, muscle, [-12 + s * 4, 9, -33], [-12 + s * 6, 6, -30], 1.1, 1.3); sphere(root, material('#e6d6bb'), -12 + s * .6, 13.4, -31.7, .18); }
  for (let i = 0; i < 6; i++) box(root, titan, -12, 11.7 + i * .28, -31.58, 1.6, .10, .08);
  placeCast(root, 2, -1.2, -2.4);
  const dust = particles(root, '#f4d3a2', 110, random);
  optimize(root); return { root, obstacles, particles: dust, fog: '#d8b9a0', density: .009 };
}
export function buildEnvironment(world: number) { return world === 0 ? seaWorld() : world === 1 ? nightWorld() : cityWorld(); }
