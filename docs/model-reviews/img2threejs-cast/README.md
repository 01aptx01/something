# img2threejs: สร้างโมเดลโซโลด้วยโค้ด

สร้าง factory ด้วย **img2threejs 2.0.0** ที่ล็อก revision `954cd5845e90efd045694bab725d68a9863c20e0` และท่อสร้าง Three.js ตาม pass ที่สกิลกำหนด ไม่อ่าน geometry จาก Blender หรือโมเดล GLB ผู้ใช้

สถานะ: **structural pass ยังไม่ผ่านการประเมินภาพรวม**; โมเดลยังเป็นงานต้นแบบ ไม่ได้แทนไฟล์โซโลในฉากหลัก การแก้ล่าสุดสร้าง factory จากสเปกนิ้วที่แก้จริง และ deterministic self-intersection / scalp / anchor checks ผ่าน แต่รูปทรงใบหน้า ผม และชุดยังหยาบเมื่อเทียบกับภาพ ผล v10 ได้ visual score `0.60/0.80` (critical features: garment `0.58`, sword assembly `0.55`) จึงยังไม่ผ่าน. รอบถัดไปถูกบันทึกเป็น `refine-code`, loop `7/9` (`13/18` รวม) โดยไม่ลดเกณฑ์ตรวจ. ดูประวัติใน `state.json` และ `character-sculpt-spec.json`

## เปิดดู

```bash
npm ci
npm run skill:install
npm run dev
# http://localhost:5173/sculpt-lab.html
```

Studio เทียบกับภาพอ้างอิง หมุนและซูมดูหน้า/ด้านข้าง/หลัง/ด้านบน แสดง wireframe แตะเลือกส่วนและแยกชิ้นส่วนได้ หน้ายังคงระบุว่าเป็นแบบร่าง ภาพตรวจจาก Chromium/WebGL อยู่ด้านล่าง

## หลักฐานล่าสุด

- Blockout v6 ได้ silhouette IoU **0.8977**, aspect-ratio delta `0.0044` และ scale delta `0.0141` ตัวเลขเหล่านี้วัดเงาร่างและการจัดกรอบ ไม่ได้วัด likeness ของหน้า
- Agent vision รับ `blockout` ที่ fidelity `0.84` สำหรับเป้าหมาย blockout เท่านั้น: silhouette/proportion `0.88`, component structure `0.72`, form/detail `0.35`, material/surface `0.30`, lighting/camera `0.85`
- สัดส่วนหัวจาก geometry จริงคือ **8.5857 units** เทียบกับ **8.57 units** จากภาพ ต่างกัน `0.18%`; เป้าหมายนี้ได้รีวิวเฉพาะ pass `proportion-lock` fidelity `0.85` ไม่ใช่การตรวจความเหมือนทั้งตัว
- Structural pass เพิ่มแผ่นปกเสื้อที่ดัดรอบลำตัวและเสื้อด้านหลัง พร้อมฝ่ามือและนิ้วโค้งแยกชิ้น ตรวจ ray parity กับ anchors จาก mesh จริงก่อนตัดสินผล pass; รายละเอียดหน้า ผม และสี cel ยังต้องเก็บ
- Structural v10 สร้างใหม่จาก spec ที่แก้ path นิ้วชี้โดยตรง; Tier 1 ผ่าน silhouette IoU `0.8964`, geometry มี 96 meshes, self-intersection `false` (106,544 sampled vertices; 674 undecided), anchors ผ่าน 14 จุด และ scalp 640/640 ไม่มี exposed sample. Visual review ได้ `0.60/0.80`, garment `0.58`, sword assembly `0.55`. ผลเหล่านี้ตรวจ topology/coverage ไม่ได้แปลว่ารูปทรงเหมือนต้นฉบับ
- ภาพ v10 ยังมีทรงผมคล้ายมงกุฎ ใบหน้าทั่วไป เสื้อคลุมเป็นทรงเรียบ และดาบ/นิ้วดูเป็นชิ้นประกอบ จึงยังไม่ควรแทนโมเดลในฉากหรือเรียกว่างานเสร็จ
- Model เป็นงาน static ไม่ได้ทำหรือทดสอบ moving rig ความหนาด้านข้าง/หลังอนุมานจากภาพเดียว ความมั่นใจด้านความลึก `0.4`
- ภาพต้นฉบับใน repo มาจาก public mirror ของ artwork ชุด/ท่าเดียวกับภาพผู้ใช้ ระบุ URL/hash แยกไว้ใน `docs/references/user-cast/zoro.source.json`; ไม่อ้างว่าเป็น byte เดียวกับ inline upload

| มุมตรวจ | หลักฐาน |
| --- | --- |
| Blockout ด้านหน้า / เฉียง / ข้าง / หลัง | [ด้านหน้า](zoro-blockout-v6-fixed/front.png) · [เฉียง](zoro-blockout-v6-fixed/positive.png) · [ข้าง](zoro-blockout-v6-fixed/right.png) · [หลัง](zoro-blockout-v6-fixed/rear.png) |
| structural ล่าสุด v10 | [ด้านหน้า](zoro-structural-v10/front.png) · [เฉียง](zoro-structural-v10/positive.png) · [ข้าง](zoro-structural-v10/right.png) · [ด้านหลัง](zoro-structural-v10/rear.png) · [ด้านบน](zoro-structural-v10/top.png) · [ด้านล่าง](zoro-structural-v10/bottom.png) |
| รูปทรงหน้า / ปิด maps | [หน้า](zoro-structural-v10/head.png) · [หน้าเฉียง](zoro-structural-v10/head-positive.png) · [unlit](zoro-structural-v10/map-stripped.png) |

รอบแก้ก่อนหน้าและผลตรวจไม่ถูกเขียนทับ: [v3](zoro-blockout-v3/), [v4](zoro-blockout-v4/), [v5](zoro-blockout-v5/), [v6](zoro-blockout-v6-fixed/)

## Pipeline และข้อจำกัด

| รายการ | สถานะ |
| --- | --- |
| reference admission, landmarks, local spec search, detail inventory, strict spec | เสร็จ |
| source-specific factory generation และ capture | ทำผ่าน img2threejs; แยก prototype ออกจาก production model |
| blockout Tier 1 | ผ่านที่ silhouette IoU `0.8977`; ไม่ใช้เป็นคะแนน likeness ทั้งตัว |
| scalp | ผ่าน 640 samples ใน band `v=0.73..1`; ไม่รับรองว่าทรงผมเหมือนภาพ |
| anchors | blockout ผ่าน 14 จุดจาก geometry ที่วัดได้ |
| self-intersection / scalp / anchors | deterministic checks ผ่านใน v10; self-intersection false, scalp 640 samples, attachment errors 0 |
| structural likeness gate | ยังไม่ผ่าน; ต้องบันทึก visual review แยกจาก geometry checks |
| face, hair, cel-color projection/material, lighting | ยังไม่ได้ผ่าน pass ที่เกี่ยวข้อง |
| part coverage / action-ready / GLB export / plugin gates | ยังไม่ประกาศผ่าน |
| integration ในฉากหลัก | ยังไม่ทำ; GLB เดิมคงอยู่จนกว่าผล likeness ของ prototype จะผ่าน |

คำสั่งพัฒนาที่ตรวจ official state ก่อนทำงาน:

```bash
npm run sculpt:zoro:build
npm run sculpt:zoro:geometry
npm run sculpt:zoro:capture
node scripts/check-sculpt-pass.mjs docs/model-reviews/img2threejs-cast/zoro-structural-v10
```

`check-sculpt-pass` สร้างหลักฐานและหยุดก่อน agent vision; ต้องดูภาพ comparison ด้วยตาและบันทึกคะแนนตามจริง จึงจะปลดล็อก pass ถัดไป ไม่รีเซ็ต counters หรือสร้างคะแนนอัตโนมัติ

สถานะที่บันทึกใน [state](../../../.img2threejs/cast/zoro/state.json) · [spec/review history](../../../.img2threejs/cast/zoro/character-sculpt-spec.json) · [สถานะรวม](../../../.img2threejs/cast/zoro/status.json) · [ตัวสร้าง](../../../src/sculpt/createZoroModel.ts) · [ภาพและ analysis](../../../.img2threejs/cast/zoro/material-evidence.json)

ตัวละครอีกสี่คนยังไม่มี bytes ของภาพอ้างอิงหลักใน workspace จึงยังไม่สร้าง factory ใหม่ให้พวกเขา ภาพเสริมของเนซึโกะและทันจิโร่มี provenance แยกและไม่ใช้แทนภาพหลัก

โค้ด img2threejs ภายใต้ Apache-2.0; ดู [license](../../../tools/licenses/img2threejs-APACHE-2.0.txt) และ provenance ของภาพแต่ละรายการ
