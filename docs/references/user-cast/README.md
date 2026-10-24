# Primary character references

`zoro.png` เป็น public mirror ของภาพโซโลท่าและชุดเดียวกับ inline reference ของผู้ใช้ ดู [URL, hash และข้อจำกัด](zoro.source.json) ผ่าน official reference-admission แล้ว แต่ไม่อ้างว่า bytes ตรงกับไฟล์ในแชต เพราะ inline image bytes ไม่ได้ถูก mount ให้ filesystem tools

ยังขาด primary bytes สำหรับ `nezuko.png`, `eren.png`, `tanjiro.png`, `mikasa.png` การเห็นภาพในแชตใช้วิเคราะห์ได้ แต่ไม่เพียงพอสำหรับ hash/mask/pixel comparison ของสกิล ไม่มีภาพสร้างใหม่หรือภาพคนละท่าปลอมเป็นต้นฉบับในโฟลเดอร์นี้

เอเรนใช้ **ภาพเต็มตัวทหารฝึกผมสั้นที่ส่งล่าสุด** แทน adult portrait เนซึโกะในภาพหลักยังถูกตัดขา/เท้า ภาพเต็มตัวเสริมที่หาได้อยู่ใน [supporting-cast](../supporting-cast/sources.json) พร้อม provenance และไม่ได้ใช้แทน primary admission

เมื่อมี PNG/JPG ต้นฉบับ ให้วางที่นี่โดยรักษา bytes หากใช้ JPG ให้แก้ `expectedReference` ใน `docs/model-reviews/img2threejs-cast/request.json` แล้วรัน `npm run skill:cast:admit` เฉพาะ reconstruction ที่ยัง active โซโลหยุดตาม correction limit แล้วและต้องรับ input ตามสกิลก่อนทำต่อ
