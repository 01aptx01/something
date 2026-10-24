import * as T from 'three';
import { disposeGroup } from '../effects';

export const CAST = [
  [{ id: 'luffy', name: 'MONKEY D. LUFFY', thai: 'มังกี้ ดี. ลูฟี่', detail: 'หมวกฟาง · เสื้อกั๊กแดง · กัปตันกลุ่มหมวกฟาง' }, { id: 'zoro', name: 'RORONOA ZORO', thai: 'โรโรโนอา โซโล', detail: 'นักดาบสามดาบ · ผมสีเขียว · ผ้าคาดเอว' }],
  [{ id: 'tanjiro', name: 'TANJIRO KAMADO', thai: 'คามาโดะ ทันจิโร่', detail: 'ฮาโอริลายตาราง · ต่างหูฮานาฟูดะ · ดาบนิจิริน' }, { id: 'nezuko', name: 'NEZUKO KAMADO', thai: 'คามาโดะ เนซึโกะ', detail: 'กิโมโนสีชมพู · กระบอกไม้ไผ่ · ปลายผมสีส้ม' }],
  [{ id: 'levi', name: 'LEVI ACKERMAN', thai: 'รีไวล์ แอคเคอร์แมน', detail: 'ผ้าคลุมหน่วยสำรวจ · อุปกรณ์ ODM · ผ้าผูกคอสีขาว' }, { id: 'mikasa', name: 'MIKASA ACKERMAN', thai: 'มิคาสะ แอคเคอร์แมน', detail: 'ผ้าพันคอแดง · แจ็กเก็ตสั้น · ดาบคู่และอุปกรณ์ ODM' }],
];

/** Independent local GLBs, loaded only when needed. Every sculpt is volumetric. */
export async function loadCharacter(id: string, signal: AbortSignal): Promise<T.Group> {
  if (!CAST.flat().some(c=>c.id===id)) throw new Error('Unknown character');
  const response=await fetch(`/models/${id}.glb`,{signal});
  if(!response.ok)throw new Error(`Model HTTP ${response.status}`);
  const data=await response.arrayBuffer();signal.throwIfAborted();
  const {GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');signal.throwIfAborted();
  const gltf=await new GLTFLoader().parseAsync(data,'/models/');
  const root=gltf.scene;
  if(signal.aborted){disposeCharacter(root);signal.throwIfAborted();}
  root.name=`Sculpted fan model: ${id}`;
  root.traverse(object=>{if(object instanceof T.Mesh){object.castShadow=object.receiveShadow=true;for(const m of Array.isArray(object.material)?object.material:[object.material]){if(m instanceof T.MeshStandardMaterial){m.envMapIntensity=.35;for(const value of Object.values(m))if(value instanceof T.Texture)value.anisotropy=4;}}}});
  return root;
}
export function disposeTextures(textures:Iterable<T.Texture>){
  const images=new Set<ImageBitmap>();
  for(const t of textures){if(typeof ImageBitmap!=='undefined'&&t.source.data instanceof ImageBitmap)images.add(t.source.data);t.dispose();}
  images.forEach(image=>image.close());
}
export function disposeCharacter(root:T.Group){
  const textures=new Set<T.Texture>();
  root.traverse(object=>{if(object instanceof T.Mesh)for(const m of Array.isArray(object.material)?object.material:[object.material])for(const v of Object.values(m))if(v instanceof T.Texture)textures.add(v);});
  disposeTextures(textures);disposeGroup(root);
}
