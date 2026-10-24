# โมเดลตามภาพที่ผู้ใช้ให้ — 24 ตุลาคม 2026

เพิ่มเอเรนเต็มตัวและปรับโซโล ทันจิโร่ เนซึโกะ มิคาสะเข้าโปรเจกต์แล้ว ตามคำสั่งให้เพิ่มจากภาพที่เห็นทันที ใช้ Blender toolkit ที่มีอยู่เพื่อสร้าง geometry จริงรอบตัว ไม่ได้ใช้ภาพตัวละครเป็นแผ่นหน้าหลัง ลูฟี่ที่อัปโหลดและรีไวล์คงเดิม

เส้นทางการสร้างชุดนี้คือการปั้นจากการสังเกตภาพในแชต ภาพล่าสุดของเอเรนเป็นวัยทหารฝึกหัดผมสั้น จึงใช้ชุดนั้นแทนเวอร์ชัน portrait ผมมวยที่ส่งก่อนหน้า ใช้ท่ายืนสำหรับชมรอบตัว ไม่ได้จำลองท่าเดิน/โบกมือ/ยกดาบให้ตรงทุกภาพ ไม่มีการวัด landmark หรือคะแนนความเหมือนจากพิกเซลต้นฉบับ และไม่ได้อ้างว่าเป็น TypeScript factory ที่ผ่าน img2threejs gates สกิลที่ติดตั้งและ checklist เดิมยังเก็บไว้สำหรับตรวจต่อเมื่อมี source pixels

| ตัวละคร | สิ่งที่เพิ่ม/ปรับในโมเดลจริง | เต็มตัว | ใบหน้า | ด้านหลัง | ชุด/อุปกรณ์ |
| --- | --- | --- | --- | --- | --- |
| เอเรน | ผมสั้นน้ำตาล ตาเขียว คิ้วและปากจริงจัง เสื้อคอผูกเชือกพร้อมตาไก่ แจ็กเก็ต ตราทหารฝึกหัดดาบไขว้ สายรัด/หัวเข็มขัด ผ้าคลุมสะโพก บูตสีเข้ม ไม่มีมวยผมหรือเสื้อฮู้ดจากภาพก่อน | [ดู](../../screenshots/model-eren.png) | [ดู](../../screenshots/model-face-eren.png) | [ดู](../../screenshots/model-back-eren.png) | [ดู](../../screenshots/model-gear-eren.png) |
| โซโล | ผ้าคาดเอวม่วงแดงหลายชั้น ปมและชายผ้าสองชาย เสื้อคลุมช่วงล่างปิดพร้อมตัวกระดุม แขนเสื้อคาดดำ และรอยยิ้มมีฟัน | [ดู](../../screenshots/model-zoro.png) | [ดู](../../screenshots/model-face-zoro.png) | [ดู](../../screenshots/model-back-zoro.png) | [ดู](../../screenshots/model-gear-zoro.png) |
| ทันจิโร่ | กล่องไม้ด้านหลัง ร่องไม้ แถบเหล็ก หมุด สายสะพายสีอ่อนพร้อมตัวปรับ ชุดด้านในสีดำแดง และรอยยิ้มเปิดปาก | [ดู](../../screenshots/model-tanjiro.png) | [ดู](../../screenshots/model-face-tanjiro.png) | [ดู](../../screenshots/model-back-tanjiro.png) | [ดู](../../screenshots/model-gear-tanjiro.png) |
| เนซึโกะ | เชือกโอบิสีเหลืองส้ม ปมและห่วงเชือก ฮาโอริสีดำ; คงกิโมโน ตาชมพู ผมปลายส้ม โบและไม้ไผ่ | [ดู](../../screenshots/model-nezuko.png) | [ดู](../../screenshots/model-face-nezuko.png) | [ดู](../../screenshots/model-back-nezuko.png) | [ดู](../../screenshots/model-gear-nezuko.png) |
| มิคาสะ | ผ้าคลุมสะโพกน้ำตาลพร้อมชายผ้า และกล่อง ODM สีโลหะเข้ม; คงผ้าพันคอแดง ดาบคู่ ชุดสายรัดและบูต | [ดู](../../screenshots/model-mikasa.png) | [ดู](../../screenshots/model-face-mikasa.png) | [ดู](../../screenshots/model-back-mikasa.png) | [ดู](../../screenshots/model-gear-mikasa.png) |

## เปิดในแอป

เข้า Attack on Titan → ปุ่มชื่อ **เอเรน เยเกอร์** เปิดโมเดลทันที หรือเข้า “ชมตัวละคร” แล้วเลือกเอเรนคนที่ 3 รีไวล์และมิคาสะยังใช้ชื่อ/ลำดับเดิม เอเรนมีเฉพาะโมเดล 3D ปุ่มภาพอนิเมะจึงปิดสำหรับคนนี้ สลับกลับไปรีไวล์/มิคาสะแล้วเลือกภาพได้ตามปกติ และโหมดเดิน 3D โหลดตัวละครทั้งสามคน

สำหรับอีก 4 คนยังเปิดจากภาพตัวละครเดิมหรือปุ่มชื่อในโลกนั้นได้ พื้นที่กดในภาพทั้ง 17 ตำแหน่งยังอ้างเฉพาะคนที่มีอยู่ในภาพจริง ไม่สร้างพื้นที่กดเอเรนปลอมบนภาพเก่า

[มือถือ 390px](../../screenshots/eren-390x844.png) · [จอ 320px](../../screenshots/eren-320x740.png) · [แนวนอน](../../screenshots/eren-844x390.png) · [เอเรนในโลก 3D](../../screenshots/eren-in-world.png)

## สร้างซ้ำ

```bash
npm run models:build      # โซโล ทันจิโร่ เนซึโกะ มิคาสะ และเอเรน
npm run models:eren       # เอเรนคนเดียว

# เก็บต้นฉบับ Blender ของเอเรนไว้แก้ต่อ
blender -b --python-exit-code 1 --python scripts/sculpt-eren.py -- --save-blend --output /tmp/eren-editable

# สร้างเฉพาะชุดอ้างอิงบางคนเพื่อตรวจภาพก่อนแทนไฟล์ใน public
blender -b --python-exit-code 1 --python scripts/sculpt-reference-cast.py -- --output /tmp/cast-check zoro tanjiro
```

พื้นฐานสัดส่วนและมือ MakeHuman hm08 CC0 อยู่ใน repository รายละเอียดสิทธิ์ใน [model-source](../../../scripts/model-source/README.md) และ [manifest](../../../public/models/manifest.json) รูปแบบตัวละครยังเป็นแฟนโมเดล สิทธิ์ต้นฉบับเป็นของผู้ถือสิทธิ์นั้น ทุกไฟล์ฝัง texture และ normal map มี basic rig 20 ข้อและ blink ไม่มีแอนิเมชันเดิน/ต่อสู้

ขนาด triangles/materials/hash ที่ส่งออกจริงอยู่ใน [build report](../../../public/models/build-report.json) ตัวสร้างใหม่อัปเดต hash เมื่อสร้างซ้ำโดยไม่แตะลูฟี่หรือรีไวล์

## ผลตรวจชุดส่งมอบ

- Build ผ่าน และ unit tests 22 ชุดผ่าน รวม GLB ทั้ง 7: normals, embedded textures, finite positions, UV/rig/weights/morph ของโมเดลโปรเจกต์ และ SHA-256 ตรง report/manifest
- Studio suite ตรวจครบทั้ง 7 คน ทั้ง full/face/back, blink, แสง, mobile/320px/landscape, error/retry, race และ GPU disposal โดยรันช่วงโลก 0/1 และช่วงโลก 2 แยกกัน หลัง headless screenshot ครั้งหนึ่งเกินเวลา เพิ่มเวลาเฉพาะ `Page.captureScreenshot` เป็น 45 วินาที; timeout ของการโต้ตอบและโหลดโมเดลยังเท่าเดิม
- Eren browser suite ผ่าน: ปุ่มจากฉาก, counter 03/03, next/previous วนครบ 3 คน, สลับจาก portrait ไปโมเดลเอเรนอัตโนมัติ, กลับโลกภาพเดิม, ปุ่มทั้งสามเข้าถึงได้จริงบน 320px/มือถือ/แนวนอน, โหลดเอเรนร่วมกับรีไวล์/มิคาสะในโลก 3D และคืน geometry/texture เมื่อออก
- ไม่มีคำขอไปยังภาพ/thumbnail เอเรนที่ไม่มีอยู่ และไม่พบ runtime exception ในชุดทดสอบเอเรน
- ภาพใหม่ 38 ภาพมาจากแอปจริง ไม่มีการแต่งภาพหลังจับหน้าจอเพื่อเติมรายละเอียด โมเดลลูฟี่และรีไวล์คงไฟล์เดิม

ผลเหล่านี้เป็นการตรวจไฟล์และการทำงาน ไม่ใช่คะแนนความเหมือนจาก source pixels หรือ benchmark FPS บนมือถือจริง
