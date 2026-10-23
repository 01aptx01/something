# 3D asset manifest

โหมดหลักใช้ภาพแฟนอาร์ต AI รายละเอียดสูง และเก็บฉาก/โมเดล 3D เดิมเป็นโหมดสลับ ไม่มีเฟรมอนิเมะ scraped, โมเดล ripped หรือ runtime CDN

| Asset | Source / creator | Format / loading | Notes |
| --- | --- | --- | --- |
| เรือ ใบเรือ เชือก หัวสิงโต ท่าเรือ เกาะ | `src/immersive/environments.ts`, สร้างสำหรับโปรเจกต์ | Procedural Three.js geometry | ฉากตีความธีม One Piece |
| โทริอิ ศาลเจ้า โคมไฟ ดอกวิสทีเรีย ลำธาร | ไฟล์เดียวกัน | Geometry + InstancedMesh | ดอกไม้รวมหลายต้นใน 4 instanced draw calls |
| อาคาร กำแพง ประตู ทางลาด เงาไททัน | ไฟล์เดียวกัน | Geometry | มีทางลาดจริงจาก y=0 ถึง y=9 |
| ลูฟี่ โซโล ทันจิโร่ เนซึโกะ รีไวล์ มิคาสะ | `src/immersive/characters.ts`, แฟนโมเดลสร้างสำหรับโปรเจกต์ | Individual mesh sculptures | ดวงตา ผม หมวก เสื้อผ้า อาวุธ เป็น geometry; ไม่ใช่ billboard |
| ไม้ หิน ทราย | `src/immersive/kit.ts` | Seeded 256×256 CanvasTexture | สร้างในเครื่อง ไม่ดาวน์โหลดภาพพื้นผิว |
| ท้องฟ้าและน้ำ | `kit.ts`, `environments.ts` | Gradient dome / animated GLSL water | หยุด animation เมื่อ reduced motion |
| ภาพเดิม 3 โลก | OpenAI ImageGen; ดู `public/artwork/README.md` | Local WebP 1920×1080 | ใช้ในฮับและซีนแรกของแต่ละโลก |
| ภาพสถานที่ใหม่ 6 ซีน | OpenAI ImageGen, สร้างใหม่โดยใช้ภาพเดิมเป็น reference | Local WebP 1672×941, quality 93 | ท่าเรือ/ชายหาด, ศาลเจ้า/ลานฝึก, ประตู/บนกำแพง |
| ภาพตัวละคร 6 คน | OpenAI ImageGen, สร้างใหม่สำหรับโปรเจกต์ | Local WebP 1024×1536, quality 93 | ภาพเต็มตัวสำหรับ gallery แบบเลื่อน/ซูม |
| Three.js และ addons | https://github.com/mrdoob/three.js | npm package, MIT | OrbitControls และ BufferGeometryUtils ใช้ license ของ Three.js |

โมเดลไม่มีไฟล์ GLB ที่ต้องโหลดแยก โค้ด geometry อยู่ใน app bundle ประมาณ 116 kB ก่อน gzip ณรอบ build นี้ (Three.js/addons แยก chunk) โหลดและสร้างเพียงโลกที่เปิดอยู่ และสร้างทีละโมเดลในห้องแสดง คืน geometry/material/texture/instance buffer/shadow map เมื่อออกจากโลก

โค้ดงานแฟนโมเดลใน repository ไม่ได้ให้สิทธิ์ในตัวละครต้นฉบับเพิ่มเติม ไม่มีการอ้างว่าเป็นงาน official หรือ scan ตัวละคร สัดส่วนเป็น stylized, ชุดและรายละเอียดลดรูป ไม่มี rig, facial animation, combat หรืออนิเมชันเดิน

## Rendering decisions

- รวม mesh นิ่งเฉพาะที่มี material และ vertex layout ตรงกัน ป้องกันชิ้นส่วนหายเมื่อรวม geometry ต่างรูปแบบ
- ฉากวิสทีเรียใช้ instancing; เงานิ่งอัปเดตเฉพาะตอนเปลี่ยนฉาก/โมเดล การหมุนโมเดลอัปเดตเงาตามเฟรม
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
