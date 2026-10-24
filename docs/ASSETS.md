# 3D asset manifest

โหมดหลักใช้ภาพแฟนอาร์ต AI รายละเอียดสูง พร้อมฉากและโมเดล 3D ชุดใหม่เป็นโหมดสลับ ไม่มีเฟรมอนิเมะ scraped, โมเดล ripped หรือ runtime CDN

| Asset | Source / creator | Format / loading | Notes |
| --- | --- | --- | --- |
| เรือ ใบเรือ เชือก หัวสิงโต ท่าเรือ เกาะ | `src/immersive/environments.ts`, สร้างสำหรับโปรเจกต์ | Procedural Three.js geometry | ฉากตีความธีม One Piece |
| โทริอิ ศาลเจ้า โคมไฟ ดอกวิสทีเรีย ลำธาร | ไฟล์เดียวกัน | Geometry + InstancedMesh | ดอกไม้รวมหลายต้นใน 4 instanced draw calls |
| อาคาร กำแพง ประตู ทางลาด เงาไททัน | ไฟล์เดียวกัน | Geometry | มีทางลาดจริงจาก y=0 ถึง y=9 |
| ลูฟี่ โซโล ทันจิโร่ เนซึโกะ รีไวล์ มิคาสะ | `scripts/build-characters.py` + MakeHuman hm08 CC0, แฟนโมเดลปั้นใหม่สำหรับโปรเจกต์ | Local GLB + embedded PBR textures | ดวงตา ผม หมวก เสื้อผ้า อาวุธ เป็น geometry; ไม่ใช่ billboard |
| ไม้ หิน ทราย | `src/immersive/kit.ts` | Seeded 256×256 CanvasTexture + bump map | สร้างในเครื่อง ไม่ดาวน์โหลดภาพพื้นผิว |
| ท้องฟ้าและน้ำ | `kit.ts`, `environments.ts` | Gradient dome / animated GLSL water | หยุด animation เมื่อ reduced motion |
| ภาพเดิม 3 โลก | OpenAI ImageGen; ดู `public/artwork/README.md` | Local WebP 1920×1080 | ใช้ในฮับและซีนแรกของแต่ละโลก |
| ภาพสถานที่ใหม่ 6 ซีน | OpenAI ImageGen, สร้างใหม่โดยใช้ภาพเดิมเป็น reference | Local WebP 1672×941, quality 93 | ท่าเรือ/ชายหาด, ศาลเจ้า/ลานฝึก, ประตู/บนกำแพง |
| ภาพตัวละคร 6 คน | OpenAI ImageGen, สร้างใหม่สำหรับโปรเจกต์ | Local WebP 1024×1536, quality 93 | ภาพเต็มตัวสำหรับ gallery แบบเลื่อน/ซูม |
| Three.js และ addons | https://github.com/mrdoob/three.js | npm package, MIT | OrbitControls และ BufferGeometryUtils ใช้ license ของ Three.js |

ตัวละครใหม่เป็น GLB แยก 6 ไฟล์ โหลดตามที่เลือกในห้องแสดง และโหลดสองคนเมื่อเปิดโลก 3D ภาพอนิเมะไม่โหลด GLB ตัวโหลด GLTFLoader แยก chunk และโหลดเมื่อใช้งาน ส่วนฉากยังสร้างด้วย Three.js

ฐานสัดส่วน `scripts/model-source/base.obj` มาจาก MakeHuman hm08 ที่ระบุ CC0 ไว้ใน header มี source URL, SHA-256, license และคำสั่งสร้างซ้ำใน [model-source/README.md](../scripts/model-source/README.md) โค้ด Blender ปรับรูปทรงและปั้นผม เสื้อผ้า ดวงตา ลายผ้า ดาบและอุปกรณ์ขึ้นใหม่ ไม่มีโมเดล ripped หรือ asset จากเกม

ฐาน CC0 ไม่ได้ให้สิทธิ์ในตัวละครต้นฉบับเพิ่มเติม โมเดลเป็นแฟนประติมากรรมท่าคงที่ ไม่มี rig, facial animation, combat หรืออนิเมชันเดิน

### ขนาดโมเดลที่ส่งมอบ

ดูค่าจริงที่เครื่องสร้างบันทึกใน [build-report.json](../public/models/build-report.json) แต่ละไฟล์ฝัง texture ทั้งหมดไว้ภายในและรวม geometry ตาม material เพื่อลด draw calls

| ไฟล์ | ขนาด MB | สามเหลี่ยม | Materials |
| --- | ---: | ---: | ---: |
| `luffy.glb` | 3.32 | 140,468 | 14 |
| `zoro.glb` | 2.96 | 126,371 | 10 |
| `tanjiro.glb` | 3.03 | 128,342 | 15 |
| `nezuko.glb` | 2.62 | 109,706 | 13 |
| `levi.glb` | 3.33 | 136,864 | 11 |
| `mikasa.glb` | 3.06 | 124,486 | 11 |

รวม 18.32 MB สำหรับทั้ง 6 คน ไม่ได้โหลดทุกคนพร้อมกันเมื่อเปิดเว็บ App entry ประมาณ 121 kB, GLTFLoader chunk ประมาณ 44 kB และ Three.js พร้อม PMREM ประมาณ 553 kB ก่อน gzip ณรอบนี้

## Rendering decisions

- รวม mesh นิ่งเฉพาะที่มี material และ vertex layout ตรงกัน ป้องกันชิ้นส่วนหายเมื่อรวม geometry ต่างรูปแบบ
- ฉากวิสทีเรียใช้ instancing; เงานิ่งอัปเดตเฉพาะตอนเปลี่ยนฉาก/โมเดลหรือเมื่อ GLB ในโลกโหลดเสร็จ การหมุนโมเดลอัปเดตเงาตามเฟรม
- จำกัด pixel ratio มือถือไว้ 1.5, desktop 2; แผนที่และปุ่ม touch ใช้ DOM/canvas ขนาดเล็ก
- ขอบเขตชนเป็นรูปทรงง่ายบนแกน XZ; ไม่ใช่ระบบ physics ตัวละคร ปีน กระโดด หรือ ODM
- ยังไม่มี benchmark FPS/หน่วยความจำบนมือถือจริง ผล headless browser ใช้ตรวจการทำงานเท่านั้น

## Anime presentation

`src/immersive/anime.ts` แสดงภาพผ่าน full-screen shader แบบไม่มี tone mapping เพื่อคงสีต้นฉบับ เลื่อน/ซูมภายในกรอบและ parallax เบา ๆ; ไม่อ้างว่าเปลี่ยนภาพวาดเป็นฉากเดิน 360° การเดินอิสระยังใช้ geometry ในโหมด 3D

โหลดภาพเฉพาะสถานที่ที่เลือก มี timeout, retry, ยกเลิกคำขอเมื่อออกจากโลก และ token ป้องกันภาพที่มาช้าเปิดทับซีนใหม่ ภาพตัวละครใช้ DOM image ที่ลาก/จีบเพื่อซูมได้ โดยแยกปุ่มภาพอนิเมะกับโมเดล 3D อย่างชัดเจน

รายการไฟล์ใหม่ ขนาด ผู้สร้าง และ source artifact: [public/artwork/manifest.json](../public/artwork/manifest.json) รวม 12 ไฟล์ประมาณ 6 MB เป็นภาพแฟนอาร์ต AI ไม่ใช่งาน official

## Latest polish

- `public/artwork/thumbs`: ภาพย่อจากภาพเดิม 15 ไฟล์ รวม 218,272 bytes; ฉาก 320×180 และตัวละคร 160×240, WebP quality 78 ไม่มีภาพวาดใหม่หรือแหล่งภายนอกเพิ่มเติม
- `src/immersive/catalog.ts`: เรื่องราวและตำแหน่งจุดสำรวจเฉพาะทั้ง 9 ซีน รวม 18 จุด
- `src/immersive/atmosphere.ts`: ละออง/กลีบดอก/ประกาย screen-space 36 จุดบนจอเล็กหรือ 64 จุดบนจอใหญ่; ปิดเมื่อ reduced motion
- `src/immersive/viewport.ts`: ขอบเขตเลื่อนภาพที่เปิดให้สำรวจทั่วภาพ โดยไม่เผยขอบว่าง และขอบเขตภาพตัวละครหลังซูม
- ฉาก 3D และแท่นแสดงโมเดลสร้างเมื่อเลือกใช้ ไม่ต้องสร้างเพื่อเปิดภาพอนิเมะ
- PNG export อ่าน canvas หลัง render เฟรมเดียวกัน เพื่อบันทึกมุมปัจจุบันโดยไม่รวม DOM เมนู

ยังไม่มี benchmark บนอุปกรณ์จริง ไม่ใช้จำนวน geometry หรือผล headless เพื่ออ้าง FPS บนมือถือ

## Sculpture studio

- `RoomEnvironment` ของ Three.js (MIT) สร้าง PMREM สำหรับแสงสะท้อนในเครื่อง ไม่ดาวน์โหลด HDRI
- แสงหลักแบบ SpotLight, fill/rim, เงา 1024×1024 และ radial contact shadow สร้างในเครื่อง
- กล้องจัดกรอบโมเดลตามพื้นที่ว่างในแต่ละขนาดจอ มีมุมเต็มตัว ใบหน้า และด้านหลัง
- ภาพดวงตา เส้นผม ลายตาราง ลายอาซาโนะฮะ ฟาง และ normal ของเนื้อผ้าสร้างจากโค้ด Blender แล้วฝังใน GLB
- โหลดมี timeout 15 วินาที, retry, AbortController และ token ป้องกันคำตอบเก่าทับตัวละครใหม่
- เมื่อเปลี่ยนตัวละคร/ออกจากโลก คืน geometry/material/texture ของโมเดล รวม environment map และ shadow target ของห้องแสดง
