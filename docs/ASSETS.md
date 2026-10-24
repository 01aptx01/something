# 3D asset manifest

โหมดหลักใช้ภาพแฟนอาร์ต AI รายละเอียดสูง พร้อมฉากและโมเดล 3D ชุดใหม่เป็นโหมดสลับ ไม่มีเฟรมอนิเมะ scraped, โมเดล ripped หรือ runtime CDN

| Asset | Source / creator | Format / loading | Notes |
| --- | --- | --- | --- |
| เรือ ใบเรือ เชือก หัวสิงโต ท่าเรือ เกาะ | `src/immersive/environments.ts`, สร้างสำหรับโปรเจกต์ | Procedural Three.js geometry | ฉากตีความธีม One Piece |
| โทริอิ ศาลเจ้า โคมไฟ ดอกวิสทีเรีย ลำธาร | ไฟล์เดียวกัน | Geometry + InstancedMesh | ดอกไม้รวมหลายต้นใน 4 instanced draw calls |
| อาคาร กำแพง ประตู ทางลาด เงาไททัน | ไฟล์เดียวกัน | Geometry | มีทางลาดจริงจาก y=0 ถึง y=9 |
| ลูฟี่ที่ผู้ใช้อัปโหลด | KingOfThePirates, แหล่งที่มาและ license ตาม metadata ใน [manifest](../public/models/manifest.json) | Local GLB 5,013,272 bytes, rig + blink | Sketchfab Standard; ไม่จัดเป็น CC0; ต้นฉบับไม่ถูกแก้ bytes |
| โซโล ทันจิโร่ เนซึโกะ รีไวล์ มิคาสะ | `scripts/sculpt-anime-cast.py` + MakeHuman hm08 CC0, แฟนโมเดลปั้นใหม่สำหรับโปรเจกต์ | Local GLB + embedded PBR textures | หัวอนิเมะใหม่ ช่อผม ชุดและอุปกรณ์เป็น geometry; rig 20 ข้อ + blink morph |
| ไม้ หิน ทราย | `src/immersive/kit.ts` | Seeded 256×256 CanvasTexture + bump map | สร้างในเครื่อง ไม่ดาวน์โหลดภาพพื้นผิว |
| ท้องฟ้าและน้ำ | `kit.ts`, `environments.ts` | Gradient dome / animated GLSL water | หยุด animation เมื่อ reduced motion |
| ภาพเดิม 3 โลก | OpenAI ImageGen; ดู `public/artwork/README.md` | Local WebP 1920×1080 | ใช้ในฮับและซีนแรกของแต่ละโลก |
| ภาพสถานที่ใหม่ 6 ซีน | OpenAI ImageGen, สร้างใหม่โดยใช้ภาพเดิมเป็น reference | Local WebP 1672×941, quality 93 | ท่าเรือ/ชายหาด, ศาลเจ้า/ลานฝึก, ประตู/บนกำแพง |
| ภาพตัวละคร 6 คน | OpenAI ImageGen, สร้างใหม่สำหรับโปรเจกต์ | Local WebP 1024×1536, quality 93 | ภาพเต็มตัวสำหรับ gallery แบบเลื่อน/ซูม |
| Three.js และ addons | https://github.com/mrdoob/three.js | npm package, MIT | OrbitControls และ BufferGeometryUtils ใช้ license ของ Three.js |

ตัวละครเป็น GLB แยก 7 ไฟล์ โหลดตามที่เลือกในห้องแสดง และโหลดสองคนใน One Piece/Demon Slayer หรือสามคนใน Attack on Titan เมื่อเปิดโลก 3D ภาพอนิเมะไม่โหลด GLB ตัวโหลด GLTFLoader แยก chunk และโหลดเมื่อใช้งาน ส่วนฉากยังสร้างด้วย Three.js

ฐานสัดส่วน `scripts/model-source/base.obj` มาจาก MakeHuman hm08 ที่ระบุ CC0 ไว้ใน header มี source URL, SHA-256, license และคำสั่งสร้างซ้ำใน [model-source/README.md](../scripts/model-source/README.md) โค้ด Blender ปรับรูปทรงและปั้นผม เสื้อผ้า ดวงตา ลายผ้า ดาบและอุปกรณ์ขึ้นใหม่ ไม่มีโมเดล ripped หรือ asset จากเกม

ฐาน CC0 ไม่ได้ให้สิทธิ์ในตัวละครต้นฉบับเพิ่มเติม ทั้ง 7 คนมี rig และ blink; รุ่น 2 ของอีก 5 คนใช้โครงกระดูกพื้นฐานสำหรับการจัดท่าและ morph เปลือกตา ไม่มี combat หรืออนิเมชันเดิน

### ขนาดโมเดลที่ส่งมอบ

ดูค่าจริงที่เครื่องสร้างบันทึกใน [build-report.json](../public/models/build-report.json) แต่ละไฟล์ฝัง texture ทั้งหมดไว้ภายในและรวม geometry ตาม material เพื่อลด draw calls

| ไฟล์ | MB | Triangles | Materials |
| --- | ---: | ---: | ---: |
| `luffy.glb` | 5.01 | 48,964 | 19 |
| `zoro.glb` | 5.92 | 172,107 | 21 |
| `tanjiro.glb` | 5.25 | 145,459 | 24 |
| `nezuko.glb` | 4.04 | 115,650 | 21 |
| `levi.glb` | 5.63 | 144,832 | 16 |
| `mikasa.glb` | 5.46 | 139,060 | 18 |
| `eren.glb` | 4.85 | 135,769 | 19 |

ค่าลูฟี่เป็นไฟล์ที่อัปโหลดก่อนปรับขนาดและจัดท่าใน runtime ส่วนอีก 5 คนมาจาก Blender pipeline ของโปรเจกต์

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

## Direct character entry and uploaded Luffy

- `character-regions.ts`: 17 source-image polygon regions across 9 scenes; canvas tap testing follows crop, pan, zoom and subtle parallax. Drags and multi-touch gestures never activate a model.
- World presentation and gallery presentation are independent. Closing restores world mode, scene, image view and entry focus.
- `luffy.glb` is the original user upload (SHA-256 in manifest). Runtime normalizes scale, transforms the complete arm/control hierarchy coherently into a relaxed pose and retains the blink clip.
- Occasional blink follows elapsed time rather than movement delta; reduced motion restores the resting face. Mixer bindings, skeleton/bone textures, geometry and image bitmaps are released on disposal.
- Full-body framing considers width and height of the posed model; face framing uses a per-character target.
- Regenerating the five v2 characters cannot overwrite the uploaded Luffy. The other five are now original v2 project sculpts with 20-joint presentation rigs and blink morphs. See [cast review](model-reviews/anime-cast-v2/README.md).


## Visual-reference additions, 24 October 2026

Eren is a seventh character, built with `scripts/sculpt-eren.py`. Zoro, Tanjiro, Nezuko and Mikasa have visual-reference costume updates in `scripts/sculpt-reference-cast.py`. These use agent observations of the inline reference images, not a measured pixel fit or an img2threejs-approved TypeScript factory. The original img2threejs intake states remain unevaluated. All five use a neutral standing pose; details hidden in the single image are inferred. Luffy and Levi were preserved. See [delivery notes](model-reviews/visual-reference-cast/README.md).
