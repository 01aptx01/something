# Anime Worlds

ประสบการณ์ Three.js ที่เปิดด้วย **ภาพอนิเมะรายละเอียดสูงแบบเดิม** เป็นค่าเริ่มต้น เลือกสำรวจได้ 9 ซีน พร้อมภาพตัวละคร 6 ตัวให้ซูมและเลื่อนชม และโมเดล 3D 7 คน และยังสลับไปเดินสำรวจฉาก 3D หรือหมุนโมเดลรอบตัวได้

## แตะตัวละครในฉากเพื่อดูโมเดล

แตะ/คลิกบนตัวละครในภาพเพื่อเปิดโมเดลของคนนั้นทันที หรือเลือกปุ่มชื่อตัวละครฝั่งซ้ายของฉาก เมื่อภาพถูกซูมจนตัวละครอยู่นอกจอ ปุ่มชื่อใช้ Tab/Enter ได้ การลากและจีบจอยังใช้สำรวจภาพตามเดิม เมื่อปิดห้องโมเดลจะกลับภาพ ซีน มุมเลื่อน และระดับซูมเดิม

กำหนดพื้นที่กดตามภาพครบ 9 ซีน รวม 17 ตำแหน่ง เฉพาะตัวละครที่ปรากฏจริงในแต่ละภาพ (เช่น ชายหาดมีลูฟี่คนเดียว) ตัวเลือกชื่อยังเปิดโมเดลของทั้งสองคนในโลกได้

**ลูฟี่ใช้ `luffy.glb` ที่ผู้ใช้อัปโหลดแล้ว** เก็บไฟล์ต้นฉบับโดยไม่แก้ bytes จัดท่ายืนผ่าน rig และปรับขนาดใน runtime ใช้กล้องตามขอบเขตโมเดล พร้อมกระพริบตาเป็นช่วง ๆ และหยุดเมื่อเปิด reduced motion ส่วนโซโล ทันจิโร่ เนซึโกะ รีไวล์ และมิคาสะปั้นใหม่เป็นรุ่น 2 แล้ว มีหัวอนิเมะ ชุดและอุปกรณ์เฉพาะตัว พร้อม rig พื้นฐานและกระพริบตาเช่นกัน

![ลูฟี่จากไฟล์ที่อัปโหลดในแอปจริง](docs/screenshots/luffy-uploaded.png)

[ใบหน้า](docs/screenshots/luffy-uploaded-face.png) · [ด้านหลัง](docs/screenshots/luffy-uploaded-back.png) · [แตะจากภาพฉาก](docs/screenshots/click-character-world-0-luffy.png) · [มือถือ](docs/screenshots/direct-model-390x844.png) · [ซีนที่กลับมาหลังชมโมเดล](docs/screenshots/image-restored-after-model.png)

ที่มา เครดิต และสถานะของแต่ละโมเดล: [manifest](public/models/manifest.json) · [ผลตรวจไฟล์ต้นฉบับก่อนนำเข้า](docs/model-reviews/uploaded-luffy/README.md)

## img2threejs: ตัวอย่างโมเดลที่สร้างด้วย Three.js

ใช้สกิล `img2threejs 2.0.0` ที่ล็อก revision ไว้ สร้าง **factory โซโลด้วยโค้ด Three.js จริง** ผ่าน pipeline แบบแบ่ง pass โดยไม่ได้อ่าน geometry จาก Blender หรือ GLB เดิม รอบแก้เพิ่มได้รับอนุมัติและบันทึกไว้ โดยคงประวัติเดิมและเกณฑ์ของสกิล

เปิด **`/sculpt-lab.html`** บนเซิร์ฟเวอร์เดียวกับเว็บหลัก เพื่อเทียบภาพอ้างอิง หมุนดูหน้า/ข้าง/หลัง ซูมใบหน้า ดูโครงตาข่าย แตะเลือกและแยกชิ้นส่วน มีภาพตรวจจาก Chromium/WebGL รวมมุมด้านบนและด้านล่าง

**สถานะ: prototype โซโลยังไม่ผ่าน likeness และไม่ได้ใช้ในฉากหลัก.** blockout ได้ silhouette IoU `0.8977`; สัดส่วนหัวต่างจากค่าที่วัด `0.18%` ใน pass ที่วัดสัดส่วนเท่านั้น. structural v10 ได้ visual score `0.60/0.80`; geometry checks ผ่านและมี 96 meshes แต่ภาพยังหยาบ (ผมเป็นทรงมงกุฎ ใบหน้าทั่วไป ชุดเรียบ และอุปกรณ์ดาบยังไม่ครบ) จึงยังไม่ผ่าน structural quality gate, material, rig หรือ production integration รอบถัดไปถูกบันทึกไว้ที่ `7/9`

[ด้านหน้า blockout](docs/model-reviews/img2threejs-cast/zoro-blockout-v6-fixed/front.png) · [ด้านหน้า structural ล่าสุด](docs/model-reviews/img2threejs-cast/zoro-structural-v10/front.png) · [ด้านข้าง](docs/model-reviews/img2threejs-cast/zoro-structural-v10/right.png) · [ด้านหลัง](docs/model-reviews/img2threejs-cast/zoro-structural-v10/rear.png) · [รายงานและสถานะปัจจุบัน](docs/model-reviews/img2threejs-cast/README.md)

หลัง clone ใช้ `npm run skill:install` และ `npm run skill:check` คำสั่ง `npm run sculpt:zoro:build` ตรวจ local state ก่อนแก้หรือสร้างเสมอ รอบแก้ Zoro ที่อนุมัติถูกจำกัดไว้ที่ 9 ครั้งต่อ pass และ 18 ครั้งรวม; ล่าสุด 13/18 โดยไม่ปรับเกณฑ์คุณภาพ

โมเดล GLB 7 คนที่เปิดจากฉากยังเป็นชุดเดิม: ลูฟี่ที่อัปโหลด และงาน Blender ของโซโล ทันจิโร่ เนซึโกะ รีไวล์ มิคาสะ และเอเรน เอเรนใช้ชุดทหารฝึกตามภาพเต็มตัวล่าสุด โมเดลเหล่านี้ไม่ได้เป็นผลจาก img2threejs และไม่ได้ใช้ผลตรวจของ prototype นี้รับรองคุณภาพ

## โมเดล 3D ชุดใหม่

**ปั้นใหม่ครบอีก 5 คน โดยใช้ลูฟี่เป็นภาพอ้างอิงด้านสไตล์** หัวอนิเมะและกรามสร้างใหม่ ดวงตาทรงอัลมอนด์มีม่านตา/รูม่านตาและเปลือกตากระพริบ ผมเป็นช่อ geometry รอบหัว เสื้อผ้ามีความหนา รอยพับ ตะเข็บ และลายที่ฝังในไฟล์ ใช้ฐาน MakeHuman CC0 เฉพาะสัดส่วนลำตัวและมือ ไม่คัดลอก geometry จากลูฟี่

| ตัวละคร | รายละเอียดที่ปั้นเพิ่ม |
| --- | --- |
| โซโล | ผมเขียวสั้น แผลตาซ้ายปิด ต่างหู 3 ห่วง แผลหน้าอก เสื้อคลุมเขียว ผ้าคาดเอว และดาบ 3 เล่มพร้อมลายด้าม/ฝัก |
| ทันจิโร่ | ผมดำอมแดง แผลหน้าผาก ฮาโอริลายตาราง ชุดคอปิด กระดุม/เข็มขัด ต่างหูฮานาฟูดะที่แยกดวงอาทิตย์และเส้นรัศมี และดาบนิจิริน |
| เนซึโกะ | ผมยาวแสกกลางไล่ปลายส้ม ตาสีชมพู กิโมโนลายอาซาโนะฮะ โอบิ/เชือกแดง โบสีชมพู และกระบอกไม้ไผ่ที่มีข้อ/เสี้ยน/สายผูก |
| รีไวล์ | ผมแสกกลาง ตาเรียว ผ้าผูกคอขาว แจ็กเก็ต/กระเป๋า ตราปีก สายรัด รองเท้า ผ้าคลุมพับพร้อมตราด้านหลัง และ ODM/ดาบคู่ |
| มิคาสะ | ผมบ๊อบดำ ผ้าพันคอแดงหลายชั้นกับชายผ้า แจ็กเก็ตสั้น/ตราปีก สายรัด/หัวเข็มขัด รองเท้าบูต และ ODM/ดาบคู่ |

ทั้ง 5 ไฟล์มีโครงกระดูก 20 ข้อและ blink morph ใช้โมเดลเดียวกันในโลกและห้องแสดง กล้องใบหน้าอ้างอิง `HeadTarget` ของโมเดลแต่ละตัว รายละเอียดขั้นตอนสร้างและภาพครบทุกมุมอยู่ใน [บันทึกโมเดลรุ่น 2](docs/model-reviews/anime-cast-v2/README.md)

- ห้องแสดงมีแสงสะท้อน วัสดุ PBR เงาใต้เท้า และแสงให้เลือก 3 แบบ
- เลือกมุมเต็มตัว / ใบหน้า / ด้านหลัง แล้วหมุนและซูมต่อได้ กล้องจัดกรอบตามพื้นที่บนมือถือและแนวนอน
- โหลด GLB และตัวโหลดเมื่อเลือก 3D มีสถานะโหลด ลองใหม่ และยกเลิกคำขอเก่าเมื่อเปลี่ยนตัวละคร
- ฉากทั้งสามปรับผิวไม้ หิน ทราย ให้มี bump detail และเพิ่มแสงสะท้อนตามมุมมองบนผิวน้ำ

เปิดโลก → **ชมตัวละคร** → **โมเดล 3D** แล้วเลือกเต็มตัว ใบหน้า ด้านหลัง หรือเปลี่ยนแสงได้ทันที

![โมเดลทันจิโร่ชุดใหม่ในห้องแสดง](docs/screenshots/model-tanjiro.png)

| ตัวละคร | เต็มตัว | รายละเอียดใบหน้า | ด้านหลัง | ชุดและอุปกรณ์ |
| --- | --- | --- | --- | --- |
| ลูฟี่ | [ดู](docs/screenshots/model-luffy.png) | [ดู](docs/screenshots/model-face-luffy.png) | [ดู](docs/screenshots/model-back-luffy.png) | — |
| โซโล | [ดู](docs/screenshots/model-zoro.png) | [ดู](docs/screenshots/model-face-zoro.png) | [ดู](docs/screenshots/model-back-zoro.png) | [ดู](docs/screenshots/model-gear-zoro.png) |
| ทันจิโร่ | [ดู](docs/screenshots/model-tanjiro.png) | [ดู](docs/screenshots/model-face-tanjiro.png) | [ดู](docs/screenshots/model-back-tanjiro.png) | [ดู](docs/screenshots/model-gear-tanjiro.png) |
| เนซึโกะ | [ดู](docs/screenshots/model-nezuko.png) | [ดู](docs/screenshots/model-face-nezuko.png) | [ดู](docs/screenshots/model-back-nezuko.png) | [ดู](docs/screenshots/model-gear-nezuko.png) |
| รีไวล์ | [ดู](docs/screenshots/model-levi.png) | [ดู](docs/screenshots/model-face-levi.png) | [ดู](docs/screenshots/model-back-levi.png) | [ดู](docs/screenshots/model-gear-levi.png) |
| มิคาสะ | [ดู](docs/screenshots/model-mikasa.png) | [ดู](docs/screenshots/model-face-mikasa.png) | [ดู](docs/screenshots/model-back-mikasa.png) | [ดู](docs/screenshots/model-gear-mikasa.png) |
| เอเรน | [ดู](docs/screenshots/model-eren.png) | [ดู](docs/screenshots/model-face-eren.png) | [ดู](docs/screenshots/model-back-eren.png) | [ดู](docs/screenshots/model-gear-eren.png) |

[ตราบนผ้าคลุมรีไวล์แบบซูม](docs/screenshots/model-cape-levi.png) · [มือถือ](docs/screenshots/sculpture-390x844.png) · [จอเล็ก 320 พิกเซล](docs/screenshots/sculpture-320x740.png) · [แนวนอน](docs/screenshots/sculpture-844x390.png) · [ตัวอย่างแสงจันทร์](docs/screenshots/studio-light-1.png) · [ที่มาและสิทธิ์ของฐานโมเดล](scripts/model-source/README.md)

## เก็บงานทุกโลก

- แถบเลือกซีนมีภาพตัวอย่าง ปุ่มก่อนหน้า/ถัดไป และจำนวนจุดที่ค้นพบของแต่ละซีน
- เรื่องราวเฉพาะ 18 จุด แยกซีนละ 2 จุด พร้อมสมุดสำรวจที่จำความคืบหน้าเดิมและพาเดินทางไปแต่ละซีนได้
- เปลี่ยนภาพอย่างนุ่มนวล เพิ่มละอองทะเล กลีบวิสทีเรีย และประกายอำพัน โดยหยุดการเคลื่อนไหวอัตโนมัติเมื่อใช้ reduced motion
- จีบซูมฉาก ดับเบิลคลิกขยาย และเลื่อนดูได้ทั่วภาพบนมือถือ; ภาพตัวละครที่ซูมเข้าเลื่อนชมได้ตั้งแต่หัวถึงเท้า
- หน้าชมตัวละครมีภาพย่อ ปุ่มก่อนหน้า/ถัดไป และปุ่มลัด `[ ]`
- “บันทึกภาพ” ส่งออกมุมที่กำลังชมเป็น PNG โดยไม่รวมเมนู
- ปุ่ม `?` เปิดวิธีเล่นและเลือกคุณภาพ อัตโนมัติ / เน้นความลื่น / เน้นความคมชัด โดยจำตัวเลือกไว้บนอุปกรณ์
- โหมดภาพไม่สร้าง geometry ฉาก 3D ล่วงหน้า ฉากและห้องโมเดลจะสร้างเมื่อเลือกใช้

## โลกและพื้นที่สำรวจ

| โลก | จุดเดินทางที่เชื่อมกัน | ตัวละครในห้องโมเดล |
| --- | --- | --- |
| One Piece | ดาดฟ้าเรือ → ท่าเรือหมวกฟาง → ชายหาดลับ | ลูฟี่ / โซโล |
| Demon Slayer | อุโมงค์วิสทีเรีย → ศาลเจ้าใต้แสงจันทร์ → ลานฝึกริมธาร | ทันจิโร่ / เนซึโกะ |
| Attack on Titan | ถนนชิกันชินะ → ประตูกำแพง → จุดเฝ้าระวังบนกำแพง | รีไวล์ / มิคาสะ / เอเรน (3D) |

**ภาพอนิเมะ**: ลากหรือ A/D เลื่อนมุมภาพ, W/S หรือล้อเมาส์ซูม, เลือกสถานที่เพื่อเปลี่ยนฉาก มี parallax เบา ๆ จุดสำรวจและเอฟเฟกต์ประจำโลก ใช้ภาพเดิม 3 ภาพและเพิ่มภาพสถานที่ใหม่ 6 ภาพ โดยคงลุค สี และรายละเอียดของภาพวาด

**เดิน 3D**: เลือกปุ่มเดิน 3D แล้วใช้ WASD/Shift และลากมองรอบตัว มีแผนที่ ขอบเขตและสิ่งกีดขวาง ทางลาดเดินขึ้นกำแพงสูง 9 เมตรได้ โหมดภาพอนิเมะเป็นการสำรวจภาพแบบ 2.5D ที่มีขอบเขต ส่วนการเดินอิสระและหมุนมอง 360° อยู่ในโหมด 3D

## ภาพหน้าจอจริง

### One Piece

![ภาพอนิเมะดาดฟ้าเรือและกลุ่มหมวกฟาง](docs/screenshots/one-piece.png)

[ท่าเรือ](docs/screenshots/one-piece-scene-2.png) · [ชายหาดลับ](docs/screenshots/one-piece-scene-3.png) · [เอฟเฟกต์ลมทะเล](docs/screenshots/one-piece-action.png)

### Demon Slayer

![ภาพอนิเมะทันจิโร่และเนซึโกะในป่าวิสทีเรีย](docs/screenshots/demon-slayer.png)

[ศาลเจ้า](docs/screenshots/demon-slayer-scene-2.png) · [ลานฝึกริมธาร](docs/screenshots/demon-slayer-scene-3.png) · [เอฟเฟกต์สายน้ำ](docs/screenshots/demon-slayer-action.png)

### Attack on Titan

![ภาพอนิเมะหน่วยสำรวจและไททันเหนือกำแพง](docs/screenshots/attack-on-titan.png)

[ประตูกำแพง](docs/screenshots/attack-on-titan-scene-2.png) · [จุดชมเมืองบนกำแพง](docs/screenshots/attack-on-titan-scene-3.png) · [เอฟเฟกต์พลุสัญญาณ](docs/screenshots/attack-on-titan-action.png)

### ห้องชมตัวละคร

![ภาพอนิเมะลูฟี่ในหน้าชมตัวละคร](docs/screenshots/portrait-luffy.png)

เริ่มด้วยภาพอนิเมะตัวละครเต็มตัว เลือกทีละคน ลากเลื่อน ซูมด้วยล้อเมาส์/จีบจอหรือปุ่ม และเลือกเคลื่อนไหวเบา ๆ ได้ ปุ่ม “โมเดล 3D” เปิดแฟนโมเดลชุดใหม่เพื่อหมุนรอบตัวและเลือกมุมรายละเอียด เมื่อกลับไปสำรวจจะคืนตำแหน่งเดิม

| One Piece | Demon Slayer | Attack on Titan |
| --- | --- | --- |
| [ลูฟี่](docs/screenshots/portrait-luffy.png) | [ทันจิโร่](docs/screenshots/portrait-tanjiro.png) | [รีไวล์](docs/screenshots/portrait-levi.png) |
| [โซโล](docs/screenshots/portrait-zoro.png) | [เนซึโกะ](docs/screenshots/portrait-nezuko.png) | [มิคาสะ](docs/screenshots/portrait-mikasa.png) |

### มือถือและเครื่องมือเดิม

![ภาพอนิเมะบนมือถือ](docs/screenshots/mobile-demon-slayer.png)

[ชมตัวละครบนมือถือ](docs/screenshots/mobile-gallery.png) · [ฉากแนวนอน](docs/screenshots/landscape-world.png) · [ชมตัวละครแนวนอน](docs/screenshots/landscape-gallery.png) · [สมุดสำรวจ](docs/screenshots/field-notes.png) · [ซ่อน UI](docs/screenshots/cinematic.png) · [ฮับพอร์ทัล](docs/screenshots/hub.png)

ดู [ตัวอย่างโหมดเดิน 3D](docs/screenshots/3d-one-piece.png), [ตัวละครใหม่ที่อยู่ในโลก](docs/screenshots/3d-one-piece-action.png) และ [โมเดลรอบตัว](docs/screenshots/model-luffy.png) ได้จากปุ่มสลับโหมด

## การควบคุม

| การทำงาน | คอมพิวเตอร์ | มือถือ |
| --- | --- | --- |
| ภาพอนิเมะ: เลื่อน / ซูม | ลากหรือ A/D / W/S หรือล้อเมาส์; ดับเบิลคลิกขยาย | ลากจอ / จีบจอ / ปุ่ม + − |
| เดิน 3D / มองรอบตัว | เลือกเดิน 3D, WASD/Shift / ลากหรือปุ่มลูกศร | ปุ่มลูกศรค้าง / ลากด้วยนิ้วที่สอง |
| เปลี่ยนจุดสำรวจ | ภาพย่อ 01–03 / ปุ่มก่อนหน้า–ถัดไป / `[ ]` | แตะภาพตัวอย่างหรือปุ่มลูกศรข้างแถบ |
| กลับจุดเริ่มของซีน | R | แตะชื่อสถานที่เดิม |
| ชมตัวละคร | G / ปุ่มชมตัวละคร | ปุ่มชมตัวละคร |
| หมุน / ซูมโมเดล | ลาก / ล้อเมาส์; ลูกศร / + − | ลาก / จีบจอ / ปุ่มซูม |
| คืนมุมโมเดล | Home / มุมเริ่มต้น | มุมเริ่มต้น |
| เอฟเฟกต์ประจำโลก | Space / ปุ่มเอฟเฟกต์ | ปุ่มเอฟเฟกต์ |
| ซ่อน UI / บันทึกมุม | C / ปุ่มบันทึกภาพ | ปุ่มชมภาพ / บันทึกภาพ |
| วิธีเล่นและคุณภาพภาพ | `?` / ปุ่มวิธีเล่นด้านบน | ปุ่ม ? |
| กลับ | Esc ปิดสมุด/ห้องโมเดล/โหมดชมภาพก่อนกลับฮับ | ปุ่มกลับแต่ละโหมด |

รองรับ reduced motion โดยหยุดน้ำ/อนุภาค/การหมุนอัตโนมัติ กล้องยังตอบสนองต่อคำสั่งผู้ใช้ สมุดสำรวจจำความคืบหน้าบนอุปกรณ์แบบ best-effort และปุ่มเสียงควบคุมเสียงสังเคราะห์เดิม

## เริ่มใช้งาน

ต้องมี Node.js 20.19+ หรือ 22.12+ และ npm

```bash
npm ci --cache /tmp/anime-worlds-npm-cache --no-audit --no-fund
npm run dev
```

เปิดพอร์ต `5173` ในหน้าพรีวิวของสภาพแวดล้อม หรือเปิด URL ที่ Vite แสดงใน terminal สคริปต์ dev จะ bind ที่ `0.0.0.0:5173` เพื่อให้ cloud preview เข้าถึงได้ และจะไม่ย้ายพอร์ตเงียบ ๆ หากพอร์ตนี้ถูกใช้อยู่

ถ้าพอร์ต `5173` ถูกใช้อยู่ ให้หยุดเซิร์ฟเวอร์เดิมก่อน หรือเลือกพอร์ตอื่นแล้วเปิดพอร์ตเดียวกันใน cloud preview:

```bash
npm run dev -- --port 5174 --strictPort
```

สร้าง production build และรันพรีวิวได้ด้วย:

```bash
npm run build
npm run preview
```

## ตรวจสอบด้วยเบราว์เซอร์

```bash
npm run test:navigation  # ขอบเขตเดินและเส้นทาง 4 ชุด
npm run test:journal     # ข้อมูลเก่า ความคืบหน้า และกรณี storage ใช้ไม่ได้ 4 ชุด
npm run test:viewport    # เลื่อนทั่วภาพ ขอบว่าง และขอบเขตภาพตัวละคร 4 ชุด
npm run test:polish      # ใช้ Chromium ตรวจคลิกจริง PNG คุณภาพภาพ pinch และจอเล็ก
npm run test:character-regions # พื้นที่กดบนภาพทั้ง 9 ซีน
npm run test:character-entry # คลิกจริง เลื่อน/ซูม กลับซีนเดิม rig/blink และมือถือ
npm run test:models      # GLB ทั้ง 7: geometry, UV, normals, texture, rig/weights, blink และ hash
npm run test:models:browser # โมเดล/มุมชม/กระพริบตา/แสง/มือถือ/ลองใหม่/คำขอเก่า
```

การทดสอบ TypeScript แบบไม่ build ใช้ Node.js 22.18+ หรือ 24

`npm run test:navigation` ตรวจเส้นทางที่เชื่อมกัน ขอบทะเล สะพาน ทางลาดและสิ่งกีดขวาง 4 ชุดทดสอบ (Node.js 22.18+ หรือ Node.js 24)

`npm run test:browser` ใช้ Node.js 22+ และ Chromium ที่เปิด Chrome DevTools Protocol ไว้ เช่นใน cloud Linux:

```bash
chromium --headless=new --no-sandbox --disable-dev-shm-usage --enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader-webgl --user-data-dir=/tmp/anime-worlds-chrome --remote-debugging-port=9223 --remote-allow-origins='*' about:blank
```

จากอีก terminal ที่รันแอปไว้แล้ว:

```bash
npm run test:browser
# ทดสอบ production preview และบันทึกภาพหน้าจอ
APP_URL=http://127.0.0.1:4173 SCREENSHOT_DIR=/tmp/anime-checks npm run test:browser
```

สคริปต์ตรวจว่าโหมดภาพอนิเมะเป็นค่าเริ่มต้น, โหลดภาพตรงกับสถานที่ทั้ง 9 ซีน, เลื่อน/ซูมภาพและภาพตัวละคร 6 คน, สลับโหมดภาพ/3D, เดิน/มอง/คืนมุม, ทางลาดและความสูง, โมเดลทั้ง 7 ตัว, orbit/zoom/หมุนอัตโนมัติ, คืนตำแหน่งหลังออกจาก gallery, คืน geometry หลังออกจากโลก, สมุดสำรวจ/เอฟเฟกต์, สองนิ้วเดินพร้อมมอง, retina/แนวนอน/reduced motion, ยกเลิกการเปลี่ยนโลกแล้วลองใหม่ ภาพที่มาช้าไม่ทับซีนใหม่, timeout/ลองโหลดภาพใหม่ สมุดสำรวจ 18 จุด, ฉาก 3D ที่สร้างเมื่อเลือกใช้ และสลับไปเดิน 3D ได้แม้ภาพอนิเมะโหลดไม่สำเร็จ การวัด FPS บนอุปกรณ์จริงยังอยู่ในแผนระยะถัดไป

## ที่มาของโมเดลและวัสดุ

ภาพอนิเมะทั้งฉากและภาพตัวละครเป็นแฟนอาร์ต AI ที่สร้างขึ้นสำหรับโปรเจกต์นี้ ภาพสถานที่ใหม่มีขนาดต้นฉบับ 1672×941, ภาพตัวละคร 1024×1536 และไฟล์ใหม่ทั้งหมดประมาณ 6 MB โหลดเฉพาะซีน/ตัวละครที่เลือก

ฉาก 3D สร้างด้วย Three.js ใน [src/immersive](src/immersive) วัสดุไม้ หิน ทราย และท้องฟ้าสร้างในเครื่อง ส่วนตัวละครโหลดจาก GLB ใน `public/models` พร้อม texture ที่ฝังในไฟล์ ไม่เรียก CDN ภายนอก ดูที่มา ขนาด และข้อจำกัดใน [asset manifest](docs/ASSETS.md)

การสร้างโมเดลตามภาพทั้ง 5 คนซ้ำใช้ Blender 4.3+ และ `npm run models:build` (ไม่เขียนทับลูฟี่ที่อัปโหลด) โดยมี source และ license ของฐานสัดส่วนเก็บใน repository แล้ว การเปิดเว็บตามปกติไม่ต้องติดตั้ง Blender

รายละเอียดภาพเดิม ภาพสถานที่และภาพตัวละคร พร้อม manifest อยู่ใน [public/artwork/README.md](public/artwork/README.md) ภาพวาดไม่ใช่เฟรมหรือโมเดลทางการจากอนิเมะ โมเดลมี geometry รอบตัวจริง ทั้ง 7 คนมี rig และ blink; อีก 5 คนเป็นแฟนโมเดลที่ปั้นสำหรับโปรเจกต์ ยังไม่มีอนิเมชันเดินหรือระบบต่อสู้ ชื่อเรื่อง/ตัวละครเป็นของผู้ถือสิทธิ์ต้นฉบับ

ดู [หน้าวิธีเล่น](docs/screenshots/controls-guide.png) · [หน้าจอมือถือ](docs/screenshots/mobile-immersive.png)

รายละเอียดการทำงานและสิ่งที่ยังเหลือ: [แผนเก็บงาน](docs/POLISH_PLAN.md)
