# 3D asset manifest

งานรอบนี้ใช้โมเดลแฟนอาร์ตที่เขียนขึ้นสำหรับ repository ไม่มีโมเดล ripped, ไฟล์ดาวน์โหลดจาก Sketchfab หรือ runtime CDN

| Asset | Source / creator | Format / loading | Notes |
| --- | --- | --- | --- |
| เรือ ใบเรือ เชือก หัวสิงโต ท่าเรือ เกาะ | `src/immersive/environments.ts`, สร้างสำหรับโปรเจกต์ | Procedural Three.js geometry | ฉากตีความธีม One Piece |
| โทริอิ ศาลเจ้า โคมไฟ ดอกวิสทีเรีย ลำธาร | ไฟล์เดียวกัน | Geometry + InstancedMesh | ดอกไม้รวมหลายต้นใน 4 instanced draw calls |
| อาคาร กำแพง ประตู ทางลาด เงาไททัน | ไฟล์เดียวกัน | Geometry | มีทางลาดจริงจาก y=0 ถึง y=9 |
| ลูฟี่ โซโล ทันจิโร่ เนซึโกะ รีไวล์ มิคาสะ | `src/immersive/characters.ts`, แฟนโมเดลสร้างสำหรับโปรเจกต์ | Individual mesh sculptures | ดวงตา ผม หมวก เสื้อผ้า อาวุธ เป็น geometry; ไม่ใช่ billboard |
| ไม้ หิน ทราย | `src/immersive/kit.ts` | Seeded 256×256 CanvasTexture | สร้างในเครื่อง ไม่ดาวน์โหลดภาพพื้นผิว |
| ท้องฟ้าและน้ำ | `kit.ts`, `environments.ts` | Gradient dome / animated GLSL water | หยุด animation เมื่อ reduced motion |
| ภาพปก 3 โลก | OpenAI ImageGen; ดู `public/artwork/README.md` | Local WebP ~0.5–0.6 MB/ภาพ | ใช้บนการ์ดฮับเท่านั้น ไม่ต้องรอเพื่อเข้าโลก |
| Three.js และ addons | https://github.com/mrdoob/three.js | npm package, MIT | OrbitControls และ BufferGeometryUtils ใช้ license ของ Three.js |

โมเดลไม่มีไฟล์ GLB ที่ต้องโหลดแยก โค้ด geometry อยู่ใน app bundle ประมาณ 82 kB ก่อน gzip ณรอบ build นี้ (Three.js/addons แยก chunk) โหลดและสร้างเพียงโลกที่เปิดอยู่ และสร้างทีละโมเดลในห้องแสดง คืน geometry/material/texture/instance buffer/shadow map เมื่อออกจากโลก

โค้ดงานแฟนโมเดลใน repository ไม่ได้ให้สิทธิ์ในตัวละครต้นฉบับเพิ่มเติม ไม่มีการอ้างว่าเป็นงาน official หรือ scan ตัวละคร สัดส่วนเป็น stylized, ชุดและรายละเอียดลดรูป ไม่มี rig, facial animation, combat หรืออนิเมชันเดิน

## Rendering decisions

- รวม mesh นิ่งเฉพาะที่มี material และ vertex layout ตรงกัน ป้องกันชิ้นส่วนหายเมื่อรวม geometry ต่างรูปแบบ
- ฉากวิสทีเรียใช้ instancing; เงานิ่งอัปเดตเฉพาะตอนเปลี่ยนฉาก/โมเดล การหมุนโมเดลอัปเดตเงาตามเฟรม
- จำกัด pixel ratio มือถือไว้ 1.5, desktop 2; แผนที่และปุ่ม touch ใช้ DOM/canvas ขนาดเล็ก
- ขอบเขตชนเป็นรูปทรงง่ายบนแกน XZ; ไม่ใช่ระบบ physics ตัวละคร ปีน กระโดด หรือ ODM
- ยังไม่มี benchmark FPS/หน่วยความจำบนมือถือจริง ผล headless browser ใช้ตรวจการทำงานเท่านั้น
