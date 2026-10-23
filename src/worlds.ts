export type WorldInfo = {
  title: string;
  kicker: string;
  description: string;
  coordinates: string;
  artwork: string;
  color: string;
  accent: string;
  accent2: string;
  action: string;
  landmarks: { id: string; title: string; description: string }[];
};

export const WORLDS: WorldInfo[] = [
  {
    title: 'ONE PIECE',
    kicker: 'WORLD 01  /  THE GRAND LINE',
    description: 'ลมทะเลกำลังเรียกหา ออกเดินทางข้ามผืนน้ำสีคราม แล้วตามแสงสุดขอบฟ้าไป',
    coordinates: '34° 12′ N  ·  OPEN SEA',
    artwork: '/artwork/one-piece.webp',
    color: '#56d6d0',
    accent: '#70f1d2',
    accent2: '#ffb468',
    action: 'เรียกลมทะเล',
    landmarks: [
      { id: 'sunny', title: 'กลุ่มหมวกฟาง', description: 'เรือ Thousand Sunny คือบ้านกลางทะเลของกลุ่มหมวกฟาง สังเกตหัวเรือรูปสิงโตและธงโจรสลัดเหนือดาดฟ้า' },
      { id: 'grand-line', title: 'เส้นทางแกรนด์ไลน์', description: 'ทะเลที่เกาะและอากาศเปลี่ยนแปลงอย่างคาดเดาไม่ได้ การเดินทางที่นี่อาศัย Log Pose เพื่อติดตามสนามแม่เหล็กของแต่ละเกาะ' },
    ],
  },
  {
    title: 'DEMON SLAYER',
    kicker: 'WORLD 02  /  WISTERIA NIGHT',
    description: 'ก้าวเข้าสู่ป่าวิสทีเรียใต้แสงจันทร์ ตามกลีบดอกไม้เรืองแสงไปยังประตูสีชาด',
    coordinates: 'KYOTO REGION  ·  02:14 AM',
    artwork: '/artwork/demon-slayer.webp',
    color: '#d397ff',
    accent: '#c98cff',
    accent2: '#8ce6dc',
    action: 'สายน้ำวิสทีเรีย',
    landmarks: [
      { id: 'siblings', title: 'ทันจิโร่และเนซึโกะ', description: 'พี่น้องคามาโดะออกเดินทางร่วมกัน ทันจิโร่ใช้ปราณวารีในการต่อสู้ ส่วนเนซึโกะยังคงปกป้องมนุษย์แม้กลายเป็นอสูร' },
      { id: 'wisteria', title: 'เส้นทางวิสทีเรีย', description: 'ดอกวิสทีเรียมีบทบาทในการป้องกันอสูร กลีบดอกไม้สีม่วงและแสงโคมไฟนำทางไปยังศาลเจ้าและลานฝึก' },
    ],
  },
  {
    title: 'ATTACK ON TITAN',
    kicker: 'WORLD 03  /  THE OUTER WALL',
    description: 'เมืองกำลังตื่นใต้ท้องฟ้าสีอำพัน สำรวจแนวกำแพงและมองหาสัญญาณเหนือกำแพง',
    coordinates: 'WALL MARIA  ·  DISTRICT 07',
    artwork: '/artwork/attack-on-titan.webp',
    color: '#ff9a6d',
    accent: '#ff906e',
    accent2: '#ffd886',
    action: 'ยิงพลุสัญญาณ',
    landmarks: [
      { id: 'scouts', title: 'หน่วยสำรวจ', description: 'อุปกรณ์เคลื่อนย้ายสามมิติใช้สายสลิงและแก๊สช่วยเคลื่อนตัวระหว่างอาคาร พื้นที่และจุดยึดจึงเป็นส่วนสำคัญของการต่อสู้' },
      { id: 'titan', title: 'ไททันเหนือกำแพง', description: 'กำแพงสูงเคยเป็นสิ่งที่มนุษย์เชื่อว่าปกป้องตนได้ เงาไททันที่สูงเหนือแนวกำแพงจึงสร้างความรู้สึกถึงภัยที่ใหญ่เกินคาด' },
    ],
  },
];
