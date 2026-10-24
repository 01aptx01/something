# Anime cast v2 — 24 ตุลาคม 2026

ปั้นโซโล ทันจิโร่ เนซึโกะ รีไวล์ และมิคาสะใหม่ใน Blender โดยใช้ลูฟี่ที่อัปโหลดเป็นภาพอ้างอิงด้านสไตล์ ไฟล์ลูฟี่เดิมคง SHA-256 `70c9516935eca0065f22da082e46405150225215eeb617d2e6ad394d714c85c4` ไม่มี geometry ของลูฟี่ถูกนำมาคัดลอกเป็นตัวละครอื่น

## โครงสร้างและรายละเอียด

- หัวอนิเมะสร้างจากหน้าตัดแก้ม/กรามของแต่ละคน แยกจากศีรษะ MakeHuman สันจมูกและแก้มต่อเนื่องกับผิวศีรษะ มีปาก ใบหู/รอยพับหู คิ้ว และรอยแผลที่แนบกับผิว
- ตาเป็นผิวทรงอัลมอนด์ มีตาขาว ม่านตาที่วาดสี รูม่านตาและประกาย ขอบตาบน/ล่าง และ Blink shape key ที่บีบเข้าหาแนวเปลือกตา
- ผมมี scalp ตามแนวไรผมและช่อผมโค้งที่มีความหนา/สัน/ปลายเรียว จัดทรงแยกแต่ละคน เนซึโกะเปิดแสกกลางและไล่สีส้มเฉพาะปลายผมยาว
- ชุดเป็นผิวโค้งมีความหนา แขนเสื้อขึ้นรูปตามไหล่/ข้อศอก มีตะเข็บ ขอบพับ ลายสี และ normal map ของเส้นทอฝังใน GLB
- ใช้ MakeHuman hm08 CC0 เฉพาะสัดส่วนลำตัวและมือ/นิ้ว ที่มาและ license อยู่ใน [model-source](../../../scripts/model-source/README.md)

| ตัวละคร | ชุดและอุปกรณ์เฉพาะ |
| --- | --- |
| โซโล | ตาซ้ายปิดและรอยแผล ผมเขียวสั้น ต่างหูทอง 3 ห่วง แผลหน้าอกพร้อมรอยเย็บ เสื้อคลุมเขียว ฮารามากิ/ผ้าแดง ดาบ 3 เล่มแยกสีฝัก ด้ามพันไขว้ โกร่ง/ปลอกโลหะ และรองเท้าดำ |
| ทันจิโร่ | แผลหน้าผาก ผมดำอมแดงทรงปัด ฮาโอริลายอิจิมัตสึ ชุดนักล่าอสูรคอตั้ง กระดุมทอง/เข็มขัดขาว ต่างหูฮานาฟูดะพร้อมดวงอาทิตย์ รัศมีและภูเขา ดาบนิจิรินในฝัก สนับแข้งและโซริ |
| เนซึโกะ | ผมยาวปลายส้ม ตาชมพูรูม่านตาเรียว โบสีชมพู กิโมโนลายอาซาโนะฮะ ปกไขว้ โอบิลายตารางและเชือกแดง ฮาโอริสีเข้ม ไม้ไผ่มีข้อ/เสี้ยน/สายผูก สนับแข้งและโซริ |
| รีไวล์ | ผมแสก ตาเรียว ผ้าผูกคอขาวและจีบ แจ็กเก็ตสั้นพร้อมกระเป๋า/กระดุม/ตราปีก สายรัดลำตัวและต้นขา บูต/หัวเข็มขัด ผ้าคลุมมีฮู้ดพับและตราด้านหลังที่ฉายแนบผ้า |
| มิคาสะ | ผมบ๊อบดำ ผ้าพันคอแดงซ้อนหลายชั้นและชายผ้า แจ็กเก็ตสั้น/กระเป๋า/ตราปีก สายรัดและหัวเข็มขัด บูตขึ้นรูป และ ODM เช่นเดียวกับรีไวล์ |

ODM ของทั้งสองคนมีช่องเก็บใบมีด 6 ชั้น ถังก๊าซ แคลมป์ สายแรงดัน ดาบคู่ที่มีปลายเรียว/สันคม/เส้นแบ่งใบมีด ด้ามพัน และโครงไกจับ

## Rig และการใช้งานในเว็บ

แต่ละไฟล์มีโครงกระดูกพื้นฐาน 20 ข้อ: Root, Hips, Spine, Chest, Neck, Head, Clavicle/UpperArm/Forearm/Hand และ Thigh/Shin/Foot ทั้งสองข้าง ทุกผิวผูกน้ำหนักกับโครงกระดูก รวมอาวุธและชิ้นส่วนตา มี clip `blink` จาก morph เปลือกตา แอปเล่นกระพริบตาเป็นช่วง ๆ ในห้องแสดงและหยุดเมื่อเปิด reduced motion

เป็น presentation rig แบบพื้นฐาน ยังไม่มี finger rig, cloth simulation, walk/combat clips หรือการทดสอบท่าทางเคลื่อนไหวเต็มชุด โมเดลเป็นแฟนอาร์ตอนิเมะที่ปั้นด้วยโค้ดสำหรับโปรเจกต์ ไม่ใช่โมเดลทางการหรือโมเดลเกมที่ดึงมา

`HeadTarget` ใน GLB กำหนดเป้ากล้องใบหน้าหลัง runtime ปรับขนาด/วางเท้า ตัวละครชุดเดียวกันโหลดเฉพาะเมื่อเปิดห้อง 3D หรือโลกเดิน 3D การแตะจากภาพฉากยังเปิดคนนั้นโดยตรงและปิดกลับไปที่มุมภาพเดิม

## ภาพจากเว็บจริง

| ตัวละคร | เต็มตัว | ใบหน้า | ด้านหลัง | ชุดและอุปกรณ์ |
| --- | --- | --- | --- | --- |
| โซโล | [ดู](../../screenshots/model-zoro.png) | [ดู](../../screenshots/model-face-zoro.png) | [ดู](../../screenshots/model-back-zoro.png) | [ดู](../../screenshots/model-gear-zoro.png) |
| ทันจิโร่ | [ดู](../../screenshots/model-tanjiro.png) | [ดู](../../screenshots/model-face-tanjiro.png) | [ดู](../../screenshots/model-back-tanjiro.png) | [ดู](../../screenshots/model-gear-tanjiro.png) |
| เนซึโกะ | [ดู](../../screenshots/model-nezuko.png) | [ดู](../../screenshots/model-face-nezuko.png) | [ดู](../../screenshots/model-back-nezuko.png) | [ดู](../../screenshots/model-gear-nezuko.png) |
| รีไวล์ | [ดู](../../screenshots/model-levi.png) | [ดู](../../screenshots/model-face-levi.png) | [ดู](../../screenshots/model-back-levi.png) | [ดู](../../screenshots/model-gear-levi.png) |
| มิคาสะ | [ดู](../../screenshots/model-mikasa.png) | [ดู](../../screenshots/model-face-mikasa.png) | [ดู](../../screenshots/model-back-mikasa.png) | [ดู](../../screenshots/model-gear-mikasa.png) |

[ตราผ้าคลุมรีไวล์แบบซูม](../../screenshots/model-cape-levi.png) · [มือถือ](../../screenshots/sculpture-390x844.png) · [จอ 320px](../../screenshots/sculpture-320x740.png) · [แนวนอน](../../screenshots/sculpture-844x390.png) · [เครดิตและสถานะ](../../../public/models/manifest.json) · [ขนาด/triangle count จริง](../../../public/models/build-report.json)

## สร้างซ้ำและแก้ต่อ

ต้องมี Blender 4.3+ เฉพาะตอนสร้างไฟล์ โมเดลที่เช็กอินไว้เปิดด้วย Vite ได้โดยไม่ใช้ Blender

```bash
npm run models:build

# สร้างเฉพาะตัว โดยไม่เขียนทับ public จนกว่าจะตรวจภาพเสร็จ
blender -b --python-exit-code 1 --python scripts/sculpt-anime-cast.py -- --output /tmp/cast-review-build tanjiro

# เก็บไฟล์ Blender พร้อม mesh, material, rig และ morph สำหรับแก้ต่อ
blender -b --python-exit-code 1 --python scripts/sculpt-anime-cast.py -- --save-blend --output /tmp/cast-editable nezuko
```

สคริปต์รับเฉพาะ 5 ชื่อนี้ จึงไม่สามารถเขียนทับ Luffy ได้ พารามิเตอร์สัดส่วน/สีอยู่ใน `PROFILES`; `head`/`hair` สร้างใบหน้าและทรงผม; `garments` สร้างชุด/อุปกรณ์; `rig_and_export` ลดผิวตาม budget ผูกโครงกระดูก รวม mesh นิ่งตาม material และส่งออก GLB พร้อม texture และ animation ภายในไฟล์

ข้อจำกัดของโมเดล: พื้นผิวและทรงผมยังเป็นงานตีความ stylized การเคลื่อนไหวมีเพียง blink ในห้องแสดง ไม่ได้เพิ่มระบบเดิน/ต่อสู้ให้ตัวละคร จำนวน triangles ใช้ควบคุมขนาดงาน ไม่ใช่ผลวัด FPS บนอุปกรณ์จริง

สร้างภาพซูมชุดและอุปกรณ์ซ้ำจากหน้าเว็บจริงได้ด้วย `APP_URL=http://127.0.0.1:4174 SCREENSHOT_DIR=docs/screenshots node scripts/capture-cast-details.mjs` หลังเปิด production preview และ Chromium CDP ตามคำแนะนำใน README


## ผลตรวจชุดส่งมอบ

- Production build และ unit tests 21 ชุดผ่าน รวม GLB ทั้ง 6: embedded textures, UV, normals, ขนาด, geometry budget, rig, น้ำหนักรวม 1, มือ/เท้าทั้งสองข้าง, morph และ SHA-256 ตรง report/manifest
- Studio browser suite ผ่านทั้ง 6 คน: เต็มตัว/ใบหน้า/ด้านหลัง กระพริบตา แสง สลับตัวละคร โหลดพลาด/ลองใหม่ คำขอเก่าไม่ทับตัวใหม่ คืน geometry/texture และปุ่มบน 320px/มือถือ/แนวนอน
- แตะตัวละครบนภาพจริงครบ 17 ตำแหน่งใน 9 ซีน คืนซีน/มุมเลื่อน/ซูม/focus เดิม การลากและจีบไม่เปิดโมเดล พร้อมคีย์บอร์ดและ reduced motion
- Browser regression ผ่านครบทั้งสามโลก รวมเดิน/มอง/คืนจุด สลับโหมด โมเดลทั้ง 6 touch สองนิ้ว retina และภาพเสีย/ช้า/timeout/retry ไม่พบ runtime exception หรือ console/resource error ที่ไม่ใช่การจำลองความล้มเหลวตามแผนทดสอบ
- ทดสอบสร้าง GLB/manifest/report และ `--save-blend` แล้ว เปิด `tanjiro.blend` ที่บันทึกกลับได้: 20 bones, 8 eye shape-key meshes และภาพพื้นผิวทั้งหมด packed อยู่ภายใน ลูฟี่คงไฟล์ต้นฉบับและ metadata เดิม
- ภาพ 30 ภาพเป็นการจับหน้าจอจากแอปจริง ไม่มีการแต่งภาพเพื่อแสดงรายละเอียดที่โมเดลไม่มี

หากแก้เฉพาะคู่หน่วยสำรวจ สามารถถ่ายมุมหลักพร้อมภาพซูมใหม่ด้วย `CAST_CAPTURE_WORLD=2 CAPTURE_MODEL_VIEWS=1` เพิ่มหน้าคำสั่ง capture ด้านบน
