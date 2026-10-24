# img2threejs: procedural reconstruction

ใช้ [img2threejs 2.0.0 ที่ล็อก revision](https://github.com/img2threejs/img2threejs/blob/954cd5845e90efd045694bab725d68a9863c20e0/SKILL.md) สร้าง factory ด้วยโค้ด Three.js จริงแล้วสำหรับโซโล งานนี้ยังเป็น **blockout ที่ไม่ผ่านคุณภาพ** และยังไม่ได้แทนโมเดล GLB ในฉาก

## เปิดตัวอย่าง

```bash
npm ci
npm run dev
# เปิด http://localhost:5173/sculpt-lab.html
```

`npm run build` รวมหน้า Studio ใน `dist/sculpt-lab.html` แล้ว ใช้ `npm run preview` เพื่อเปิด build จริง ส่วนเว็บหลักอยู่ที่ `/`

Studio มีภาพอ้างอิงข้างโมเดล หมุน/ซูม เลือกหน้า/มุมเฉียง/ข้าง/หลัง/ใบหน้า โครงตาข่าย การแตะเลือกชิ้นส่วน การแยกชิ้นส่วนและคืนมุมมอง หน้าแสดงสถานะว่าเป็นแบบร่างอย่างชัดเจน

[หน้าจอ desktop](studio-ui/sculpt-studio-desktop.png) · [มือถือ 390px](studio-ui/sculpt-studio-390.png) · [มือถือ 320px](studio-ui/sculpt-studio-320.png)

## ผลตรวจ

| ขั้น | ผลปัจจุบัน |
| --- | --- |
| reference admission | ผ่าน: public mirror ของภาพโซโลท่า/ชุดเดียวกับในแชต พร้อม URL/hash; ไม่อ้างว่า bytes ตรงกับ inline upload |
| character contracts / landmarks | อ่านสัญญา character วัดพิกัดจากภาพที่รับจริง ระบุข้อจำกัดความลึก |
| local spec search | BM25 `core_3d` สำหรับ anatomy, cloth, skin, hair และวัสดุ |
| assessment / inventory | complex, รายละเอียด 15 กลุ่ม, component tree 80 ชิ้น |
| strict spec validation | ผ่าน เป็นการตรวจ spec ไม่ใช่การรับรองความเหมือน |
| factory generation | เรียก `generate_threejs_factory.py --pass-id blockout` จริง ไม่มี Blender หรือ GLB geometry ในเส้นทางนี้ |
| browser capture | Chromium/WebGL จริง 9 มุมและภาพ unlit ปิด material maps ไม่มี bloom/DOF |
| silhouette IoU | `0.7681 → 0.8040 → 0.8035` ยังต่ำกว่า `0.85` |
| multi-angle / turntable | ไม่พบ silhouette collapse; ครบ 0/90/180/270 องศา อนุญาตช่องว่างระหว่างแขน/ดาบกับลำตัวที่มีอยู่จริง |
| scalp exposure | ผ่าน 640 samples เฉพาะ band เหนือ hairline `v=0.73..1`; ไม่รับรองทรงผมหรือความเหมือน |
| attachment anchors | ผ่าน 9 จุดจาก centroid ของ geometry จริง ไม่มี unmeasured attachment |
| self-intersection | ยังไม่ผ่าน: 5 vertices ถูกระบุว่าอยู่ในผิว, 507 undecided จาก 89,606 samples; ไม่ได้ตรวจทุก vertex |
| AI likeness / later passes | ยังไม่ทำ เพราะ Tier 1 ไม่ผ่าน |
| texture projection | de-lit source และ descriptor เท่านั้น ยังไม่ได้ bake ใน runtime หรือผ่าน material pass |
| animation readiness | ยังไม่มี moving rig หรือผลทดสอบ animation ของ prototype |

IoU วัดพื้นที่เงาร่าง ไม่ใช่เปอร์เซ็นต์ความเหมือนของใบหน้า ผลตรวจโครงสร้างไม่รับรองความสวยหรือสมจริง ด้านข้าง/หลังอนุมานจากภาพเดียว ความมั่นใจด้านความลึก `0.4`

[สถานะสรุป](../../../.img2threejs/cast/zoro/status.json) · [state](../../../.img2threejs/cast/zoro/state.json) · [spec](../../../.img2threejs/cast/zoro/character-sculpt-spec.json) · [factory](../../../src/sculpt/createZoroModel.ts) · [หลักฐานวัสดุสีแบนจากภาพ cel](../../../.img2threejs/cast/zoro/material-evidence.json)

## ภาพตรวจล่าสุด

[ด้านหน้า](zoro-blockout-v2/front.png) · [มุมเฉียง](zoro-blockout-v2/positive.png) · [มุม -35°](zoro-blockout-v2/negative.png) · [ข้าง 90°](zoro-blockout-v2/right.png) · [ข้าง 270°](zoro-blockout-v2/left.png) · [หลัง 135°](zoro-blockout-v2/rear-three-quarter.png) · [หลัง 180°](zoro-blockout-v2/rear.png) · [ใบหน้า](zoro-blockout-v2/head.png) · [ใบหน้าเฉียง](zoro-blockout-v2/head-positive.png) · [ปิด maps / unlit](zoro-blockout-v2/map-stripped.png)

หลักฐานก่อนแก้เก็บใน [รอบเริ่มต้น](zoro-blockout/front.png) และ [แก้ครั้งแรก](zoro-blockout-v1/front.png) ไม่เขียนทับภาพที่ reviewHistory อ้างถึง

## เหตุผลที่หยุด

`forge/next.py` คืน exit `3`, `status=stopped`, `max-correction-loops-reached:blockout:3/3` หลังการตรวจล่าสุด คะแนนเงาร่างหยุดดีขึ้นและยังไม่ผ่าน จึงไม่ปลดล็อก pass ถัดไป

สกิลกำหนดว่า **“Exit code 3 or `status=stopped` is a hard stop: report the reason and request input.”** และ **“Obey a hard stop; never continue from memory.”** ต้องรับคำยืนยันจากผู้ใช้ก่อนเปลี่ยนขอบเขตรอบแก้ ไม่มีการรีเซ็ต state เพิ่ม limit หรือปลอมผลผ่านในงานนี้

หลังได้รับคำยืนยัน ยังต้องแก้ silhouette และการประกอบผิว skirt/sash/head ตรวจ Tier 1/self-intersection ใหม่ แล้วจึงเก็บใบหน้า รายละเอียดชุด วัสดุ projection แสงและ interaction ตาม pass ที่ปลดล็อก งานปัจจุบันยังไม่เทียบคุณภาพกับ GLB ลูฟี่ของผู้ใช้

## ตัวละครอื่น

| ตัวละคร | ภาพหลัก | สถานะ factory ใหม่ |
| --- | --- | --- |
| โซโล | เสื้อคลุมเขียว ผ้าม่วง มือขวายกจับดาบ | blockout หยุดตาม gate |
| เนซึโกะ | ภาพโบกมือ กิโมโนชมพู ช่วงล่างถูกตัด | ยังไม่ได้สร้าง: primary bytes ไม่อยู่ใน filesystem |
| เอเรน | **เต็มตัวทหารฝึก ผมสั้น ที่ส่งล่าสุด** | ยังไม่ได้สร้าง: วิเคราะห์ใหม่แทน adult portrait แล้ว แต่ยังไม่มี primary bytes |
| ทันจิโร่ | ภาพเดิน มือจับสายสะพาย กล่องไม้ | ยังไม่ได้สร้าง: ยังไม่มี primary bytes |
| มิคาสะ | ฟิกเกอร์ แจ็กเก็ตน้ำตาล ODM ดาบคู่ | ยังไม่ได้สร้าง: ยังไม่มี primary bytes |

พบ [ภาพเสริมเต็มตัว](../../references/supporting-cast/sources.json) ของเนซึโกะและทันจิโร่จาก public repositories เป็นคนละท่า จึงระบุเป็น supporting reference และไม่ใช้แทนภาพหลักเพื่อปลดล็อก gate ไม่มีการนับ GLB เดิมว่าเป็นโมเดลจากสกิล

## คำสั่ง

```bash
npm run skill:install
npm run skill:check
npm run skill:cast:status     # exit 3 สำหรับ hard stop พร้อมแสดงอีก 4 คนที่ขาด input
npm run sculpt:zoro:build    # ตรวจ official state ก่อน ปฏิเสธการสร้างเมื่อหยุด
npm run sculpt:zoro:geometry # ตรวจ frozen factory ส่งออก geometry และ normals จริง
npm run sculpt:zoro:capture  # ต้องมี Vite และ Chromium CDP :9223
APP_URL=http://127.0.0.1:4174 npm run test:sculpt:browser
```

ตัวช่วย author intake/spec ตรวจ `forge/next.py` ก่อนเขียนไฟล์เช่นกัน ให้ทำตาม exact next command ใน state การมี referenceCamera/de-lighting descriptor ไม่เท่ากับ solve กล้องหรือ bake texture สำเร็จ

Build และ unit 22 รายการผ่านแล้ว Browser smoke ของ Studio บน production build ตรวจ assets, เปลี่ยนมุม/ใบหน้า, raycast เลือกชิ้นส่วน, wireframe, explode/reset, จอ 390/320px และ disposal ผ่าน การทดสอบเว็บไม่ใช่การผ่าน quality gates ของโมเดล

Generated runtime อ้างอิง code ของ img2threejs ภายใต้ [Apache-2.0](../../../tools/licenses/img2threejs-APACHE-2.0.txt) ที่มา/สิทธิ์ภาพตัวละครแยกจาก license ของสกิล ดู provenance ของแต่ละภาพประกอบ
