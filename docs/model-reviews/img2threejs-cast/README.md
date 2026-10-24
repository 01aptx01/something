# img2threejs — ภาพอ้างอิงชุดใหม่ 24 ตุลาคม 2026

สถานะ: **ติดตั้งสกิลและวิเคราะห์ภาพในแชตแล้ว แต่ยังไม่ได้สร้างโมเดลชุดนี้** ขั้น `reference-admission` ของทั้ง 5 งานยังไม่ผ่าน เนื่องจากภาพในข้อความไม่ได้ถูกส่งเป็นไฟล์ที่อ่านได้ใน workspace มีเพียงไฟล์ `luffy.glb` จากการอัปโหลดครั้งก่อน จึงไม่มี source pixels สำหรับวัด landmark สัดส่วน สี และเปรียบเทียบภาพ

โมเดลรุ่น 2 เดิมในแอปยังใช้งานอยู่ ส่วนเอเรนจะเป็นตัวละครใหม่แยกจากรีไวล์ หลังมีโมเดลที่ผ่านการตรวจจริง

## ติดตั้งและเรียกใช้

ติดตั้งแบบ project-local ตามแนวทาง checkout ร่วมและ symlink ของ upstream โดยไม่แก้การตั้งค่าสกิลส่วนกลางของคลาวด์

- Repository: https://github.com/img2threejs/img2threejs
- Skill version: `2.0.0`
- Revision: `954cd5845e90efd045694bab725d68a9863c20e0`
- License: Apache-2.0; ตัว installer ไม่เปลี่ยนสิทธิ์ของภาพตัวละครต้นฉบับ
- Checkout: `.tools/img2threejs` (ไม่ commit ตัวรีโปภายนอก)
- Codex project skill: `.agents/skills/img2threejs` → `../../.tools/img2threejs`
- Lock: [tools/img2threejs.lock.json](../../../tools/img2threejs.lock.json)

```bash
npm run skill:install       # ดาวน์โหลด commit ที่ล็อกไว้และสร้าง symlink
npm run skill:check         # ตรวจ revision, link, SKILL.md และ character profile
npm run skill:cast:status   # เรียก forge/next.py ของทุกตัว
```

ใช้ profile `character` ที่มีในสกิลอยู่แล้ว ไม่ได้ติดตั้ง paid service หรือ plugin เพิ่ม การติดตั้งซ้ำไม่เปลี่ยน checkout ที่ถูกล็อก และจะปฏิเสธการทับสกิลที่ไม่ใช่ของ installer นี้

สกิลนี้เป็นกระบวนการปั้นด้วยโค้ด Three.js พร้อมตรวจคุณภาพ ไม่ใช่คำสั่งที่ติดตั้งแล้วสร้าง mesh ได้ทันที รายละเอียด upstream: [SKILL.md](https://github.com/img2threejs/img2threejs/blob/954cd5845e90efd045694bab725d68a9863c20e0/SKILL.md)

## วิเคราะห์จากภาพที่เห็นจริง

ยังไม่มีตัวเลขวัดสัดส่วน, SHA ของภาพ หรือคะแนนความเหมือน ทุกค่าเหล่านี้รอไฟล์ต้นฉบับ ห้ามใช้ภาพเก่าของโปรเจกต์หรือภาพวาดใหม่แทนต้นฉบับแล้วอ้างว่าเป็นหลักฐานเดียวกัน

| ตัวละคร | สิ่งที่ต้องสร้างตามภาพ | ขอบเขตที่ภาพรองรับ | บันทึกภาพ |
| --- | --- | --- | --- |
| โซโล | ท่ายกดาบ มือกำด้าม เสื้อคลุมเขียวเปิดอก แผลตา/หน้าอก ต่างหูสามห่วง ฮารามากิ ผ้าคาดเอวม่วงแดงชายยาว ดาบ/ฝักสามชุด | เต็มตัว ภาพมุมด้านหน้าเอียง | [การวิเคราะห์](zoro-analysis.json) |
| เนซึโกะ | ใบหน้า/ตาชมพู ผมยาวและโบ มือยกโบก กิโมโนอาซาโนะฮะ ฮาโอริ โอบิแดงขาว เชือกเหลืองส้ม ไม้ไผ่ | ศีรษะถึงช่วงลำตัว เท้าและช่วงล่างถูกตัด | [การวิเคราะห์](nezuko-analysis.json) |
| เอเรน | ใบหน้าและกราม ผมรวบมวย ปอยผม ตาเทาเขียว รอยแดงใต้ตา ฮู้ด เสื้อคอผูกเชือก | ศีรษะ/อกเท่านั้น ยังไม่มีภาพเต็มตัว | [การวิเคราะห์](eren-analysis.json) |
| ทันจิโร่ | ท่าเดิน มือจับสายสะพาย ผมดำแดง แผลหน้าผาก ต่างหู ลายฮาโอริ ชุดนักล่าอสูร กล่องไม้ด้านหลัง ดาบ ผ้าพันขาและรองเท้า | เต็มตัวมุมสามส่วน | [การวิเคราะห์](tanjiro-analysis.json) |
| มิคาสะ | ผมบ๊อบปิดตาบางส่วน ผ้าพันคอแดง แจ็กเก็ตสีเหลืองน้ำตาล กระเป๋า/ตรา กระโปรงสะโพก สายรัดแนบกางเกง ODM ดาบคู่ มือกำด้าม และบูต | ฟิกเกอร์เต็มตัว มุมด้านหน้าเอียง | [การวิเคราะห์](mikasa-analysis.json) |

แต่ละ JSON แยก macro/meso/micro, จุดยึด, สี, กลุ่มวัสดุ, สิ่งที่ซ่อนอยู่ และเกณฑ์คุณภาพที่เสนอไว้ สันจมูก/ใบหน้าต้องเป็นผิวต่อเนื่อง ผมต้องยึดกับ scalp สายรัด/อุปกรณ์ต้องแนบชุด และท่าทางต้องตรงภาพ การปั้นหลังศีรษะหรือรายละเอียดที่ภาพไม่เห็นจะต้องระบุว่าอนุมาน

## จุดรอรับไฟล์

แนบต้นฉบับทั้ง 5 รูปเป็นไฟล์ PNG/JPG หรือรวม ZIP ก็ได้ เมื่อรับได้แล้วจะวางไฟล์เดิมโดยรักษา bytes ที่ [docs/references/user-cast](../../references/user-cast/README.md) และบันทึก hash/dimensions จากไฟล์จริง หากใช้ JPG ให้แก้ `expectedReference` ใน [request.json](request.json) ให้ตรงชื่อจริง

```bash
npm run skill:cast:init     # สร้าง state ใหม่เมื่อยังไม่มี ไม่รีเซ็ตงานที่มีอยู่
npm run skill:cast:admit    # รัน reference-admission ของ upstream
npm run skill:cast:status  # ดูขั้นถัดไปตาม state จริง
```

คำสั่ง init/status/admit คืน exit `2` ขณะต้นฉบับยังไม่พร้อม เป็นสถานะรอ input ไม่ใช่การตรวจผ่าน รายงานอย่างเป็นทางการอยู่ใน `.img2threejs/cast/<id>/admission.json`; checklist และ exact next command อยู่ใน `state.json` / `next-step.txt` ของแต่ละตัว

## ขั้นต่อจากไฟล์พร้อม

1. ตรวจไฟล์/alpha/foreground และบันทึก provenance ของแต่ละภาพ
2. วัด landmark และอัตราส่วนจริง แก้ข้อจำกัดภาพที่ตัดช่วงล่างก่อนกำหนดโมเดลเต็มตัว โดยเอเรนรองรับข้อเสนอแบบ bust จากภาพปัจจุบัน
3. สร้าง assessment, detail inventory, quality contract และ sculpt spec เฉพาะคน แล้วผ่าน strict validation
4. สร้าง TypeScript factory เป็น pass: blockout → structure → form → materials → lighting → interaction → optimization
5. Capture จาก Three.js จริงทั้งมุมอ้างอิง มุมเอียง ด้านข้าง ด้านหลัง และใบหน้า ตรวจ hair coverage, attachment, chirality, self-intersection และเทียบภาพ
6. จึงนำโมเดลที่ผ่านเข้า studio/ระบบแตะจากฉาก พร้อมเพิ่มเอเรนแยกจากรีไวล์ และอัปเดต README ด้วยภาพใหม่

ยังไม่มี spec ที่ผ่าน strict validation, factory, rig หรือภาพ render สำหรับคำขอชุดนี้ และไม่มีขั้นที่ข้าม gate ไปแทนที่โมเดลเดิม
