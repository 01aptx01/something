import * as THREE from 'three';

export type WorldInfo = {
  title: string;
  kicker: string;
  description: string;
  coordinates: string;
  artwork: string;
  desktopFocus: number;
  mobileFocus: number;
  color: string;
  accent: string;
  accent2: string;
  action: string;
  landmarks: { id: string; title: string; description: string; point: [number, number] }[];
};

export const WORLDS: WorldInfo[] = [
  {
    title: 'ONE PIECE',
    kicker: 'WORLD 01  /  THE GRAND LINE',
    description: 'ลมทะเลกำลังเรียกหา ออกเดินทางข้ามผืนน้ำสีคราม แล้วตามแสงสุดขอบฟ้าไป',
    coordinates: '34° 12′ N  ·  OPEN SEA',
    artwork: '/artwork/one-piece.webp',
    desktopFocus: 0.5,
    mobileFocus: 0.71,
    color: '#56d6d0',
    accent: '#70f1d2',
    accent2: '#ffb468',
    action: 'เรียกลมทะเล',
    landmarks: [
      { id: 'sunny', title: 'กลุ่มหมวกฟาง', description: 'เรือ Thousand Sunny คือบ้านกลางทะเลของกลุ่มหมวกฟาง สังเกตหัวเรือรูปสิงโตและธงโจรสลัดเหนือดาดฟ้า', point: [0.72, 0.39] },
      { id: 'grand-line', title: 'เส้นทางแกรนด์ไลน์', description: 'ทะเลที่เกาะและอากาศเปลี่ยนแปลงอย่างคาดเดาไม่ได้ การเดินทางที่นี่อาศัย Log Pose เพื่อติดตามสนามแม่เหล็กของแต่ละเกาะ', point: [0.29, 0.56] },
    ],
  },
  {
    title: 'DEMON SLAYER',
    kicker: 'WORLD 02  /  WISTERIA NIGHT',
    description: 'ก้าวเข้าสู่ป่าวิสทีเรียใต้แสงจันทร์ ตามกลีบดอกไม้เรืองแสงไปยังประตูสีชาด',
    coordinates: 'KYOTO REGION  ·  02:14 AM',
    artwork: '/artwork/demon-slayer.webp',
    desktopFocus: 0.5,
    mobileFocus: 0.74,
    color: '#d397ff',
    accent: '#c98cff',
    accent2: '#8ce6dc',
    action: 'สายน้ำวิสทีเรีย',
    landmarks: [
      { id: 'siblings', title: 'ทันจิโร่และเนซึโกะ', description: 'พี่น้องคามาโดะออกเดินทางร่วมกัน ทันจิโร่ใช้ปราณวารีในการต่อสู้ ส่วนเนซึโกะยังคงปกป้องมนุษย์แม้กลายเป็นอสูร', point: [0.73, 0.36] },
      { id: 'wisteria', title: 'เส้นทางวิสทีเรีย', description: 'ดอกวิสทีเรียมีบทบาทในการป้องกันอสูร สีม่วงของกลีบดอกไม้และแสงโคมไฟเป็นจุดนำสายตาของฉากแฟนอาร์ตนี้', point: [0.48, 0.42] },
    ],
  },
  {
    title: 'ATTACK ON TITAN',
    kicker: 'WORLD 03  /  THE OUTER WALL',
    description: 'เมืองกำลังตื่นใต้ท้องฟ้าสีอำพัน สำรวจแนวกำแพงและมองหาสัญญาณเหนือกำแพง',
    coordinates: 'WALL MARIA  ·  DISTRICT 07',
    artwork: '/artwork/attack-on-titan.webp',
    desktopFocus: 0.42,
    mobileFocus: 0.72,
    color: '#ff9a6d',
    accent: '#ff906e',
    accent2: '#ffd886',
    action: 'ยิงพลุสัญญาณ',
    landmarks: [
      { id: 'scouts', title: 'หน่วยสำรวจ', description: 'อุปกรณ์เคลื่อนย้ายสามมิติใช้สายสลิงและแก๊สช่วยเคลื่อนตัวระหว่างอาคาร พื้นที่และจุดยึดจึงเป็นส่วนสำคัญของการต่อสู้', point: [0.64, 0.55] },
      { id: 'titan', title: 'ไททันเหนือกำแพง', description: 'กำแพงสูงเคยเป็นสิ่งที่มนุษย์เชื่อว่าปกป้องตนได้ เงาไททันที่สูงเหนือแนวกำแพงจึงสร้างความรู้สึกถึงภัยที่ใหญ่เกินคาด', point: [0.74, 0.18] },
    ],
  },
];

const rand = (seed: number) => () => {
  let value = (seed += 0x6d2b79f5);
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};

function seaWorld(root: THREE.Group, random: () => number) {
  root.userData.sky = '#102a43';
  // Translucent 3D ripples float in front of the painted sea and drift with the camera.
  for (let i = 0; i < 12; i += 1) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.22 + random() * 0.72, 0.009 + random() * 0.012, 5, 48),
      new THREE.MeshBasicMaterial({ color: random() > 0.5 ? '#8df1e7' : '#ffe0a6', transparent: true, opacity: 0.12 + random() * 0.12 }),
    );
    ring.scale.set(1.5, 0.44, 1);
    ring.position.set((random() - 0.5) * 17, -2.1 + random() * 0.55, -1 - random() * 9);
    ring.userData.floatSeed = random() * Math.PI * 2;
    ring.userData.baseX = ring.position.x;
    ring.userData.baseY = ring.position.y;
    root.add(ring);
  }
}

function wisteriaWorld(root: THREE.Group, random: () => number) {
  root.userData.sky = '#10101f';
  const petalShape = new THREE.Shape();
  petalShape.moveTo(0, 0);
  petalShape.bezierCurveTo(-0.08, 0.06, -0.13, 0.16, 0, 0.28);
  petalShape.bezierCurveTo(0.13, 0.16, 0.08, 0.06, 0, 0);
  const geometry = new THREE.ShapeGeometry(petalShape, 8);
  const colors = ['#e8a7ff', '#cc8bff', '#ffc1ed', '#9beae3'];
  for (let i = 0; i < 44; i += 1) {
    const petal = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ color: colors[Math.floor(random() * colors.length)], transparent: true, opacity: 0.4 + random() * 0.35, side: THREE.DoubleSide, depthWrite: false }),
    );
    petal.name = 'Falling wisteria petal';
    petal.position.set((random() - 0.5) * 18, -2 + random() * 8, -2.5 + random() * 5);
    petal.rotation.z = random() * Math.PI * 2;
    petal.scale.setScalar(0.45 + random() * 0.85);
    petal.userData.floatSeed = random() * Math.PI * 2;
    petal.userData.baseX = petal.position.x;
    petal.userData.baseY = petal.position.y;
    root.add(petal);
  }
}

function wallCityWorld(root: THREE.Group, random: () => number) {
  root.userData.sky = '#302331';
  // Sparse amber embers and dust add a separate 3D foreground layer to the wall artwork.
  for (let i = 0; i < 42; i += 1) {
    const ember = new THREE.Mesh(
      new THREE.SphereGeometry(0.018 + random() * 0.035, 8, 6),
      new THREE.MeshBasicMaterial({ color: random() > 0.25 ? '#ffc17d' : '#f4ddce', transparent: true, opacity: 0.38 + random() * 0.42 }),
    );
    ember.name = 'Wall district ember';
    ember.position.set((random() - 0.5) * 19, -2.2 + random() * 8, -2 + random() * 6);
    ember.userData.floatSeed = random() * Math.PI * 2;
    ember.userData.baseX = ember.position.x;
    ember.userData.baseY = ember.position.y;
    root.add(ember);
  }
}

export function buildWorld(index: number): THREE.Group {
  const root = new THREE.Group();
  root.name = `World ${index + 1}`;
  const random = rand(1201 + index * 1771);
  if (index === 0) seaWorld(root, random);
  else if (index === 1) wisteriaWorld(root, random);
  else wallCityWorld(root, random);
  return root;
}
