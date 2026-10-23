import * as T from 'three';
import { box, material, mesh, rod, sphere } from './kit';

export const CAST = [
  [{ id: 'luffy', name: 'MONKEY D. LUFFY', thai: 'มังกี้ ดี. ลูฟี่', detail: 'หมวกฟาง · เสื้อกั๊กแดง · กัปตันกลุ่มหมวกฟาง' }, { id: 'zoro', name: 'RORONOA ZORO', thai: 'โรโรโนอา โซโล', detail: 'นักดาบสามดาบ · ผมสีเขียว · ผ้าคาดเอว' }],
  [{ id: 'tanjiro', name: 'TANJIRO KAMADO', thai: 'คามาโดะ ทันจิโร่', detail: 'ฮาโอริลายตาราง · ต่างหูฮานาฟูดะ · ดาบนิจิริน' }, { id: 'nezuko', name: 'NEZUKO KAMADO', thai: 'คามาโดะ เนซึโกะ', detail: 'กิโมโนสีชมพู · กระบอกไม้ไผ่ · ปลายผมสีส้ม' }],
  [{ id: 'levi', name: 'LEVI ACKERMAN', thai: 'รีไวล์ แอคเคอร์แมน', detail: 'ผ้าคลุมหน่วยสำรวจ · อุปกรณ์ ODM · ผ้าผูกคอสีขาว' }, { id: 'mikasa', name: 'MIKASA ACKERMAN', thai: 'มิคาสะ แอคเคอร์แมน', detail: 'ผ้าพันคอแดง · แจ็กเก็ตสั้น · ดาบคู่และอุปกรณ์ ODM' }],
];

// Original volumetric fan sculptures. Every visible part is geometry, including eyes and costume details.
export function character(id: string): T.Group {
  const root = new T.Group(); root.name = `Fan sculpture: ${id}`;
  const skin = material('#efba95'), hair = material(id === 'zoro' ? '#407753' : id === 'tanjiro' ? '#492531' : '#20202a');
  const dark = material('#202633'), white = material('#f0ebd8'), gold = material('#d5ad5a', .35, .4), leather = material('#6c4734');
  const red = material('#b83c3e'), green = material('#35735a'), pink = material('#df9daf'), steel = material('#b5c7d1', .28, .7);
  const pirate = id === 'luffy' || id === 'zoro', demon = id === 'tanjiro' || id === 'nezuko', female = id === 'nezuko' || id === 'mikasa';
  // Feet, tapered legs, pelvis and tailored torso establish a human silhouette.
  for (const side of [-1, 1]) {
    sphere(root, pirate ? leather : dark, side * .19, .10, .095, .16, .75, .65, 1.7);
    rod(root, id === 'luffy' ? skin : id === 'nezuko' ? pink : demon ? dark : white, [side * .18, .18, 0], [side * .20, .97, 0], .09, .13, 16);
    if (!pirate && !demon) {
      rod(root, leather, [side * .18, .16, 0], [side * .19, .51, 0], .105, .11, 14);
      box(root, leather, side * .19, .78, .10, .16, .055, .04);
      box(root, leather, side * .19, .64, .10, .16, .045, .04);
    }
    if (id === 'luffy') {
      rod(root, material('#41689a'), [side * .19, .66, 0], [side * .20, 1.02, 0], .15, .18, 16);
      rod(root, white, [side * .19, .63, 0], [side * .19, .70, 0], .154, .154, 16);
    }
  }
  sphere(root, id === 'luffy' ? skin : id === 'zoro' ? white : id === 'nezuko' ? pink : dark, 0, 1.29, 0, .38, female ? .72 : .85, 1.02, .55);
  rod(root, skin, [0, 1.55, 0], [0, 1.77, 0], .10, .10, 16);
  // Head has a shaped chin, muzzle, ears and separate inset eyes, with highlights.
  sphere(root, skin, 0, 1.94, .005, .28, .83, 1.06, .80);
  sphere(root, skin, 0, 1.80, .035, .14, 1.04, .78, .80);
  for (const s of [-1, 1]) {
    sphere(root, skin, s * .232, 1.92, .01, .055, .5, 1, .8);
    sphere(root, white, s * .092, 1.97, .210, .059, 1, .65, .16);
    sphere(root, id === 'nezuko' ? pink : dark, s * .084, 1.973, .224, .029, .75, 1, .16);
    sphere(root, white, s * .083 - .009, 1.986, .230, .007);
    rod(root, hair, [s * .035, 2.052, .218], [s * .145, 2.063, .194], .011);
  }
  sphere(root, skin, 0, 1.921, .232, .025, .7, 1.5, 1);
  rod(root, material('#985c54'), [-.045, 1.845, .198], [.045, 1.845, .198], .006, .006);
  sphere(root, hair, 0, 2.103, -.025, .27, .92, .58, .92);
  for (let i = 0; i < 11; i++) {
    const angle = i / 11 * Math.PI * 2;
    const lock = mesh(root, new T.ConeGeometry(.065, .24 + (i % 3) * .035, 5), hair, Math.sin(angle) * .205, 2.052, Math.cos(angle) * .18);
    lock.rotation.z = Math.sin(angle) * -.35 + Math.PI; lock.rotation.x = Math.cos(angle) * .3;
  }
  // Arms have separate sleeves, forearms, hands and thumbs.
  const sleeve = id === 'luffy' ? red : id === 'zoro' ? white : id === 'tanjiro' ? green : id === 'nezuko' ? pink : leather;
  for (const s of [-1, 1]) {
    rod(root, id === 'luffy' ? skin : sleeve, [s * .29, 1.48, 0], [s * .43, 1.15, .025], id === 'luffy' ? .095 : .115, id === 'luffy' ? .085 : .14, 16);
    sphere(root, id === 'luffy' ? skin : sleeve, s * .30, 1.46, 0, id === 'luffy' ? .10 : .13);
    rod(root, pirate ? skin : sleeve, [s * .43, 1.15, .025], [s * .46, .91, .09], .09, pirate ? .065 : .10, 16);
    sphere(root, skin, s * .46, .86, .09, .09, .75, 1.2, .8);
    sphere(root, skin, s * .40, .87, .14, .035, .7, 1.4, .8);
  }
  box(root, id === 'zoro' ? green : id === 'luffy' ? gold : leather, 0, 1.04, .015, .57, .13, .39);
  if (id === 'luffy') {
    for (const s of [-1, 1]) {
      const outline = new T.Shape();
      outline.moveTo(s * .09, 1.07); outline.lineTo(s * .31, 1.07); outline.lineTo(s * .33, 1.48); outline.quadraticCurveTo(s * .28, 1.61, s * .19, 1.58); outline.lineTo(s * .11, 1.47); outline.closePath();
      mesh(root, new T.ExtrudeGeometry(outline, { depth: .34, bevelEnabled: true, bevelSize: .025, bevelThickness: .02, bevelSegments: 3, steps: 1 }), red, 0, 0, -.17);
      for (let i = 0; i < 3; i++) sphere(root, gold, s * .17, 1.2 + i * .12, .225, .016);
    }
    const straw = material('#d9b36a');
    mesh(root, new T.CylinderGeometry(.42, .43, .045, 48), straw, 0, 2.20, 0);
    sphere(root, straw, 0, 2.27, 0, .28, 1, .7, 1);
    mesh(root, new T.CylinderGeometry(.275, .28, .055, 40), red, 0, 2.26, 0);
    for (let i = 0; i < 32; i++) {
      const a = i / 32 * Math.PI * 2;
      rod(root, material('#ba9255'), [Math.sin(a) * .29, 2.226, Math.cos(a) * .29], [Math.sin(a) * .42, 2.226, Math.cos(a) * .42], .0025, .0025, 4);
    }
    rod(root, material('#88584c'), [.105, 1.905, .22], [.167, 1.894, .197], .006);
  }
  if (id === 'zoro') {
    for (let i = 0; i < 3; i++) {
      const sword = new T.Group(); sword.position.set(-.35, 1.08 - i * .07, -.10); sword.rotation.z = -.24 + i * .10;
      rod(sword, i === 0 ? white : dark, [0, -.75, 0], [0, .30, 0], .035); box(sword, gold, 0, .12, 0, .18, .035, .07); root.add(sword);
      sphere(root, gold, -.243, 1.86 - i * .035, .02, .015);
    }
  }
  if (id === 'tanjiro') {
    for (const s of [-1, 1]) {
      box(root, green, s * .22, 1.34, -.015, .19, .67, .47);
      for (let row = 0; row < 5; row++) for (let col = 0; col < 2; col++) if ((row + col) % 2 === 0) {
        box(root, dark, s * (.145 + col * .095), 1.07 + row * .13, .227, .095, .13, .012);
        box(root, dark, s * (.145 + col * .095), 1.07 + row * .13, -.255, .095, .13, .012);
      }
      box(root, white, s * .245, 1.78, .04, .045, .15, .018); box(root, red, s * .245, 1.80, .052, .026, .035, .008);
    }
    box(root, red, -.12, 2.093, .175, .075, .045, .018).rotation.z = -.3;
    const katana = new T.Group(); katana.position.set(.36, .95, -.13); katana.rotation.z = .18;
    rod(katana, dark, [0, -.65, 0], [0, .44, 0], .027); box(katana, steel, 0, .16, 0, .16, .035, .08); root.add(katana);
    for (let i = 0; i < 4; i++) sphere(root, gold, 0, 1.13 + i * .12, .22, .014);
  }
  if (id === 'nezuko') {
    mesh(root, new T.CylinderGeometry(.25, .42, .85, 24), pink, 0, .79, 0);
    // Raised geometric hemp-leaf motif on the kimono.
    const seam = material('#af6f83');
    for (let row = 0; row < 4; row++) for (const s of [-1, 1]) {
      rod(root, seam, [s * .05, .43 + row * .17, .34 - row * .028], [s * .27, .60 + row * .17, .30 - row * .028], .005, .005, 4);
    }
    for (const s of [-1, 1]) box(root, material('#392b31'), s * .26, 1.22, -.07, .15, .84, .48);
    box(root, white, 0, 1.07, .20, .48, .17, .03); box(root, red, 0, 1.07, .23, .43, .06, .03);
    const bamboo = material('#699250'); rod(root, bamboo, [-.15, 1.833, .237], [.15, 1.833, .237], .043, .043, 16);
    for (const s of [-1, 1]) rod(root, gold, [s * .11, 1.832, .235], [s * .11, 1.835, .235], .045, .045, 12);
    for (let i = 0; i < 9; i++) {
      const x = (i - 4) * .058, y = 1.62 - (i % 3) * .04;
      rod(root, hair, [x, 2.10, -.14], [x * 1.3, y, -.22], .045, .055, 10);
      rod(root, material('#b45f3b'), [x * 1.3, y, -.22], [x * 1.4, y - .16, -.20], .025, .045, 10);
    }
    box(root, pink, .18, 2.09, .09, .09, .06, .035).rotation.z = .5;
  }
  if (!pirate && !demon) {
    for (const s of [-1, 1]) {
      box(root, leather, s * .20, 1.40, 0, .19, .43, .43);
      box(root, gold, s * .20, 1.43, .232, .12, .09, .018);
      box(root, dark, s * .185, 1.23, .225, .035, .43, .025).rotation.z = s * .36;
      box(root, steel, s * .37, .98, -.06, .18, .20, .38);
      for (let i = 0; i < 3; i++) box(root, dark, s * .37, .95 + i * .05, .14, .14, .018, .025);
      rod(root, steel, [s * .40, .90, .14], [s * .72, .28, .20], .018, .018, 4);
      box(root, dark, s * .43, .85, .15, .14, .045, .07);
    }
    if (id === 'levi') {
      // A curved cloth cape remains a volume from every viewing angle.
      const capeGeo = new T.PlaneGeometry(1.1, 1.08, 16, 16), p = capeGeo.attributes.position;
      for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i); p.setXYZ(i, x * (1 - (y + .54) * .34), y, -.18 - Math.cos(x * 7) * .055 - (.54 - y) * .18); }
      capeGeo.computeVertexNormals(); const capeMat = material('#3b5942'); capeMat.side = T.DoubleSide;
      mesh(root, capeGeo, capeMat, 0, 1.10, -.12);
      for (const s of [-1, 1]) for (let i = 0; i < 4; i++) box(root, i % 2 ? white : material('#5b839a'), s * (.035 + i * .023), 1.41 - i * .045, -.405, .055, .13, .012).rotation.z = s * -.55;
      box(root, white, 0, 1.55, .22, .10, .21, .025);
    } else {
      mesh(root, new T.TorusGeometry(.12, .055, 12, 32), red, 0, 1.65, .01).rotation.x = Math.PI / 2;
      box(root, red, -.12, 1.48, .24, .14, .36, .04).rotation.z = -.12;
      for (const s of [-1, 1]) box(root, hair, s * .20, 1.89, -.025, .07, .24, .29);
    }
  }
  return root;
}
