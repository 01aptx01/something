import * as THREE from 'three';

export type WorldInfo = {
  title: string;
  kicker: string;
  description: string;
  coordinates: string;
  tip: string;
  color: string;
  accent: string;
  accent2: string;
};

export const WORLDS: WorldInfo[] = [
  {
    title: 'ONE PIECE',
    kicker: 'WORLD 01  /  THE GRAND LINE',
    description: 'ลมทะเลกำลังเรียกหา ออกเดินทางข้ามผืนน้ำสีคราม แล้วตามแสงสุดขอบฟ้าไป',
    coordinates: '34° 12′ N  ·  OPEN SEA',
    tip: 'ลองแตะเรือหรือแสงบนขอบฟ้า',
    color: '#56d6d0',
    accent: '#70f1d2',
    accent2: '#ffb468',
  },
  {
    title: 'DEMON SLAYER',
    kicker: 'WORLD 02  /  WISTERIA NIGHT',
    description: 'ก้าวเข้าสู่ป่าที่แสงจันทร์แตะกลีบดอกไม้ ทุกเสียงในความเงียบอาจบอกทางให้คุณ',
    coordinates: 'KYOTO REGION  ·  02:14 AM',
    tip: 'แตะประตูหรือดอกไม้เรืองแสง',
    color: '#d397ff',
    accent: '#c98cff',
    accent2: '#8ce6dc',
  },
  {
    title: 'ATTACK ON TITAN',
    kicker: 'WORLD 03  /  THE OUTER WALL',
    description: 'เมืองกำลังตื่นใต้ท้องฟ้าสีอำพัน สำรวจแนวกำแพงและมองหาสัญญาณไกลลิบ',
    coordinates: 'WALL MARIA  ·  DISTRICT 07',
    tip: 'แตะหอคอยหรือสัญญาณบนกำแพง',
    color: '#ff9a6d',
    accent: '#ff906e',
    accent2: '#ffd886',
  },
];

const rand = (seed: number) => () => {
  let value = (seed += 0x6d2b79f5);
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};

function material(color: string, options: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.12, ...options });
}

function box(parent: THREE.Group, name: string, position: THREE.Vector3, scale: THREE.Vector3, color: string, clickable = false) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material(color));
  mesh.name = name;
  mesh.position.copy(position);
  mesh.scale.copy(scale);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (clickable) mesh.userData.landmark = name;
  parent.add(mesh);
  return mesh;
}

function cylinder(parent: THREE.Group, name: string, position: THREE.Vector3, radiusTop: number, radiusBottom: number, height: number, color: string, segments = 12) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), material(color));
  mesh.name = name;
  mesh.position.copy(position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function sphere(parent: THREE.Group, name: string, position: THREE.Vector3, radius: number, color: string, emissive = false) {
  const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(radius, 2), material(color, emissive ? { emissive: color, emissiveIntensity: 1.4, roughness: 0.35 } : {}));
  mesh.name = name;
  mesh.position.copy(position);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function addLights(root: THREE.Group, keyColor: string, fillColor: string) {
  const ambient = new THREE.HemisphereLight(0xa8c5ff, 0x171323, 2.2);
  root.add(ambient);
  const key = new THREE.DirectionalLight(keyColor, 3.3);
  key.position.set(-4, 8, 6);
  root.add(key);
  const fill = new THREE.PointLight(fillColor, 38, 28, 2);
  fill.position.set(2.5, 2.8, 1.5);
  root.add(fill);
}

function createSea(root: THREE.Group, random: () => number) {
  root.userData.sky = '#102a43';
  addLights(root, '#ffe4b2', '#58dece');

  const waterGeometry = new THREE.PlaneGeometry(40, 42, 60, 60);
  waterGeometry.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(waterGeometry, new THREE.MeshStandardMaterial({ color: '#0e7385', roughness: 0.27, metalness: 0.38, emissive: '#053945', emissiveIntensity: 0.65 }));
  water.name = 'Open sea';
  water.position.set(0, -1.6, -5);
  water.receiveShadow = true;
  root.add(water);

  const horizon = new THREE.Mesh(new THREE.CircleGeometry(2.1, 48), new THREE.MeshBasicMaterial({ color: '#ffbd78', transparent: true, opacity: 0.72, side: THREE.DoubleSide }));
  horizon.position.set(0, 3.7, -10);
  root.add(horizon);
  const sun = new THREE.Mesh(new THREE.CircleGeometry(1.25, 48), new THREE.MeshBasicMaterial({ color: '#ffe1a7', side: THREE.DoubleSide }));
  sun.position.set(0, 3.7, -9.8);
  root.add(sun);

  // A little hand-built vessel on the horizon, with sails that catch the light.
  const ship = new THREE.Group();
  ship.name = 'The wandering ship';
  ship.position.set(-1.8, -0.85, -5.4);
  box(ship, 'Ship deck', new THREE.Vector3(0, 0, 0), new THREE.Vector3(2.8, 0.2, 0.68), '#5d372b', true);
  const hull = new THREE.Mesh(new THREE.ConeGeometry(0.67, 2.65, 4), material('#744532'));
  hull.rotation.z = Math.PI / 2;
  hull.position.set(0, -0.16, 0);
  hull.scale.set(0.5, 1, 1);
  ship.add(hull);
  cylinder(ship, 'Mast', new THREE.Vector3(0, 1.15, 0), 0.055, 0.07, 2.3, '#d7c5a5', 8);
  const sailShape = new THREE.Shape();
  sailShape.moveTo(0.06, 0.08); sailShape.lineTo(0.06, 1.06); sailShape.lineTo(0.88, 0.37); sailShape.closePath();
  const sail = new THREE.Mesh(new THREE.ShapeGeometry(sailShape), material('#f3ead4', { side: THREE.DoubleSide, roughness: 0.84 }));
  sail.position.set(0, 0.48, 0.04);
  ship.add(sail);
  root.add(ship);

  for (let i = 0; i < 18; i += 1) {
    const x = (random() - 0.5) * 22;
    const z = -2 - random() * 14;
    const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.35 + random() * 1.2, 0.012 + random() * 0.025, 5, 24), new THREE.MeshBasicMaterial({ color: random() > 0.5 ? '#5de5d5' : '#9cf2dc', transparent: true, opacity: 0.16 + random() * 0.28 }));
    stripe.rotation.x = Math.PI / 2;
    stripe.scale.set(1.3, 0.45, 1);
    stripe.position.set(x, -1.5 + random() * 0.12, z);
    root.add(stripe);
  }

  const buoy = sphere(root, 'Beacon beyond the horizon', new THREE.Vector3(4.1, 1.65, -4.5), 0.34, '#ffc47f', true);
  buoy.userData.landmark = 'แสงจากเกาะไกลลิบ';
}

function createWisteria(root: THREE.Group, random: () => number) {
  root.userData.sky = '#10101f';
  addLights(root, '#c3a3ff', '#ae66ff');
  const ground = new THREE.Mesh(new THREE.CircleGeometry(22, 48), material('#191726', { roughness: 0.94 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.65;
  root.add(ground);

  // Moonlit path.
  const path = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 26), new THREE.MeshBasicMaterial({ color: '#8f84aa', transparent: true, opacity: 0.16 }));
  path.rotation.x = -Math.PI / 2;
  path.position.set(0, -1.62, -4);
  root.add(path);

  const gate = new THREE.Group();
  gate.name = 'Moon gate';
  gate.position.set(0, -1.5, -7.5);
  box(gate, 'Gate crossbar', new THREE.Vector3(0, 3.35, 0), new THREE.Vector3(4.6, 0.28, 0.28), '#8d344c', true);
  box(gate, 'Gate top beam', new THREE.Vector3(0, 3.75, 0), new THREE.Vector3(5.3, 0.2, 0.32), '#cf5968', true);
  for (const x of [-1.65, 1.65]) {
    cylinder(gate, 'Gate pillar', new THREE.Vector3(x, 0.9, 0), 0.2, 0.28, 3.7, '#8c3044', 10);
    cylinder(gate, 'Gate footing', new THREE.Vector3(x, -0.78, 0), 0.32, 0.32, 0.18, '#d16b78', 10);
  }
  root.add(gate);

  const trunkMaterial = material('#31263b', { roughness: 0.93 });
  for (let i = 0; i < 22; i += 1) {
    const side = i % 2 === 0 ? -1 : 1;
    const x = side * (3.6 + random() * 5.2);
    const z = -10 + random() * 15;
    const height = 2.4 + random() * 2.6;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.22, height, 7), trunkMaterial);
    trunk.position.set(x, -1.65 + height * 0.5, z);
    trunk.rotation.z = (random() - 0.5) * 0.18;
    root.add(trunk);
    for (let j = 0; j < 4; j += 1) {
      const branch = sphere(root, 'Wisteria canopy', new THREE.Vector3(x + (random() - 0.5) * 1.9, 0.9 + random() * 2.2, z + (random() - 0.5) * 1.5), 0.65 + random() * 0.5, random() > 0.55 ? '#493061' : '#32264c');
      branch.scale.set(1.25, 0.56, 0.76);
    }
  }

  const petalColors = ['#cf91ff', '#b47bfa', '#f2b6e5', '#92dfde'];
  for (let i = 0; i < 70; i += 1) {
    const petal = new THREE.Mesh(new THREE.SphereGeometry(0.055 + random() * 0.06, 8, 6), new THREE.MeshBasicMaterial({ color: petalColors[Math.floor(random() * petalColors.length)], transparent: true, opacity: 0.65 }));
    petal.name = 'Falling wisteria petal';
    petal.position.set((random() - 0.5) * 15, -0.6 + random() * 6.5, -10 + random() * 15);
    petal.userData.floatSeed = random() * Math.PI * 2;
    petal.userData.baseX = petal.position.x;
    petal.userData.baseY = petal.position.y;
    petal.userData.landmark = i % 13 === 0 ? 'กลีบดอกไม้ที่ยังมีแสง' : undefined;
    root.add(petal);
  }
  sphere(root, 'Moon', new THREE.Vector3(4.5, 5.2, -12), 1.05, '#d3c8ff', true);
}

function createWallCity(root: THREE.Group, random: () => number) {
  root.userData.sky = '#302331';
  addLights(root, '#ffc28b', '#ff765c');

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(50, 50), material('#35323a', { roughness: 0.98 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.7;
  root.add(ground);

  // A long crenellated wall closes the horizon.
  const wall = new THREE.Group();
  wall.name = 'The outer wall';
  wall.position.set(0, -1.6, -10.5);
  box(wall, 'Outer wall', new THREE.Vector3(0, 2.25, 0), new THREE.Vector3(22, 4.5, 1.2), '#82716b', true);
  for (let x = -10; x <= 10; x += 1.25) {
    box(wall, 'Wall merlon', new THREE.Vector3(x, 4.72, 0), new THREE.Vector3(0.62, 0.55, 1.1), '#a58a7b');
    box(wall, 'Wall block seam', new THREE.Vector3(x + 0.5, 1.2, 0.62), new THREE.Vector3(0.035, 1.05, 0.025), '#514d50');
  }
  root.add(wall);

  const buildingColors = ['#645257', '#73635d', '#564a50', '#89736a'];
  for (let i = 0; i < 31; i += 1) {
    const side = i % 2 === 0 ? -1 : 1;
    const depth = 2 + random() * 9;
    const x = side * (2.8 + random() * 6.5);
    const width = 0.9 + random() * 1.5;
    const height = 1.2 + random() * 3.2;
    const building = box(root, 'Quiet district building', new THREE.Vector3(x, -1.65 + height / 2, -depth), new THREE.Vector3(width, height, width * 0.8), buildingColors[Math.floor(random() * buildingColors.length)]);
    if (i % 4 === 0) building.userData.landmark = 'บ้านเรือนในเขตชั้นนอก';
    for (let row = 0; row < Math.floor(height); row += 1) {
      const window = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.22), new THREE.MeshBasicMaterial({ color: random() > 0.55 ? '#ffcc88' : '#b4836c', transparent: true, opacity: 0.72 }));
      window.position.set(x + (random() - 0.5) * width * 0.45, -1.25 + row * 0.72, -depth + width * 0.41);
      root.add(window);
    }
  }

  const watchtower = new THREE.Group();
  watchtower.name = 'Signal watchtower';
  watchtower.position.set(-4.2, -1.65, -4.7);
  box(watchtower, 'Watchtower base', new THREE.Vector3(0, 1.8, 0), new THREE.Vector3(0.72, 3.6, 0.74), '#8d796c', true);
  box(watchtower, 'Watchtower cabin', new THREE.Vector3(0, 3.85, 0), new THREE.Vector3(1.15, 0.85, 1.12), '#b7987e');
  const roof = new THREE.Mesh(new THREE.ConeGeometry(0.9, 0.7, 4), material('#543e44'));
  roof.position.set(0, 4.6, 0);
  roof.rotation.y = Math.PI / 4;
  watchtower.add(roof);
  root.add(watchtower);

  // Tiny amber windows make the district feel inhabited from afar.
  for (let i = 0; i < 13; i += 1) {
    const ember = sphere(root, 'Distant signal', new THREE.Vector3((random() - 0.5) * 17, -0.2 + random() * 2.5, -3 - random() * 12), 0.055 + random() * 0.05, '#ffca8b', true);
    ember.userData.landmark = i % 5 === 0 ? 'สัญญาณจากแนวกำแพง' : undefined;
  }
}

export function buildWorld(index: number): THREE.Group {
  const root = new THREE.Group();
  root.name = `World ${index + 1}`;
  const random = rand(1201 + index * 1771);
  if (index === 0) createSea(root, random);
  else if (index === 1) createWisteria(root, random);
  else createWallCity(root, random);
  return root;
}
