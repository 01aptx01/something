import * as T from 'three';
import { disposeGroup } from '../effects';

export const CAST = [
  [{ id: 'luffy', name: 'MONKEY D. LUFFY', thai: 'มังกี้ ดี. ลูฟี่', detail: 'หมวกฟาง · เสื้อกั๊กแดง · กัปตันกลุ่มหมวกฟาง' }, { id: 'zoro', name: 'RORONOA ZORO', thai: 'โรโรโนอา โซโล', detail: 'นักดาบสามดาบ · ผมสีเขียว · ผ้าคาดเอว' }],
  [{ id: 'tanjiro', name: 'TANJIRO KAMADO', thai: 'คามาโดะ ทันจิโร่', detail: 'ฮาโอริลายตาราง · ต่างหูฮานาฟูดะ · ดาบนิจิริน' }, { id: 'nezuko', name: 'NEZUKO KAMADO', thai: 'คามาโดะ เนซึโกะ', detail: 'กิโมโนสีชมพู · กระบอกไม้ไผ่ · ปลายผมสีส้ม' }],
  [{ id: 'levi', name: 'LEVI ACKERMAN', thai: 'รีไวล์ แอคเคอร์แมน', detail: 'ผ้าคลุมหน่วยสำรวจ · อุปกรณ์ ODM · ผ้าผูกคอสีขาว' }, { id: 'mikasa', name: 'MIKASA ACKERMAN', thai: 'มิคาสะ แอคเคอร์แมน', detail: 'ผ้าพันคอแดง · แจ็กเก็ตสั้น · ดาบคู่และอุปกรณ์ ODM' }],
];

export const UPLOADED_LUFFY_CREDIT='KingOfThePirates · Sketchfab Standard';
const motions=new WeakMap<T.Object3D,{mixer:T.AnimationMixer;action:T.AnimationAction;next:number;start:number;active:boolean}>();
export function updateCharacter(root:T.Object3D,elapsed:number,reduced:boolean){
 const motion=motions.get(root);if(!motion)return false;root.userData.blinkTime=0;
 if(reduced){if(motion.active){motion.action.stop();motion.mixer.update(0);motion.active=false;}motion.next=elapsed+4;return false;}
 if(motion.next<0)motion.next=elapsed+3.5;
 if(!motion.active){if(elapsed<motion.next)return false;motion.action.reset().play();motion.start=elapsed;motion.active=true;root.userData.blinkCount=(root.userData.blinkCount??0)+1;}
 motion.mixer.setTime(elapsed-motion.start);root.userData.blinkTime=motion.action.time;
 if(!motion.action.isRunning()){motion.action.stop();motion.mixer.update(0);motion.active=false;motion.next=elapsed+4.2;}
 return true;
}
function prepareCharacter(scene:T.Group,id:string,clips:T.AnimationClip[]){
 scene.updateMatrixWorld(true);
 if(id==='luffy'){
  // This rig has separate control branches. Transform every arm joint coherently
  // in world space, then recover local transforms in parent-first order.
  for(const side of ['L','R']){
   const bones:T.Object3D[]=[];let shoulder:T.Object3D|undefined;
   scene.traverse(o=>{if(o instanceof T.Bone&&o.name.startsWith('arm_')&&new RegExp(`${side}_\\d+$`,'i').test(o.name))bones.push(o);if(o.name.includes('shoulder')&&o.name.endsWith(side==='L'?'_224':'_252'))shoulder=o;});
   if(!shoulder)continue;
   const pivot=shoulder.getWorldPosition(new T.Vector3());
   const rotation=new T.Matrix4().makeRotationZ((pivot.x>0?-1:1)*T.MathUtils.degToRad(64));
   const delta=new T.Matrix4().makeTranslation(pivot.x,pivot.y,pivot.z).multiply(rotation).multiply(new T.Matrix4().makeTranslation(-pivot.x,-pivot.y,-pivot.z));
   const targets=new Map(bones.map(b=>[b,delta.clone().multiply(b.matrixWorld)]));
   for(const bone of bones){if(!bone.parent)continue;bone.parent.updateWorldMatrix(true,false);const local=bone.parent.matrixWorld.clone().invert().multiply(targets.get(bone)!);local.decompose(bone.position,bone.quaternion,bone.scale);bone.updateMatrixWorld(true);}
   scene.updateMatrixWorld(true);
  }
 }
 scene.traverse(o=>{if(o instanceof T.SkinnedMesh){o.skeleton.update();o.computeBoundingBox();}});
 const bounds=new T.Box3().setFromObject(scene,true),size=bounds.getSize(new T.Vector3()),center=bounds.getCenter(new T.Vector3());
 const scale=2.4/Math.max(.01,size.y),root=new T.Group();scene.scale.multiplyScalar(scale);scene.position.add(new T.Vector3(-center.x*scale,-bounds.min.y*scale,-center.z*scale));root.add(scene);root.updateMatrixWorld(true);
 const fitted=new T.Box3().setFromObject(root,true),headTarget=scene.getObjectByName('HeadTarget');
 root.userData.frame={height:fitted.max.y-fitted.min.y,width:fitted.max.x-fitted.min.x,depth:fitted.max.z-fitted.min.z,head:headTarget?headTarget.getWorldPosition(new T.Vector3()).y:id==='luffy'?2.10:2.16};
 root.animations=clips;
 const blink=clips.find(c=>c.name==='blink');
 if(blink){const mixer=new T.AnimationMixer(scene),action=mixer.clipAction(blink);action.setLoop(T.LoopOnce,1);motions.set(root,{mixer,action,next:-1,start:0,active:false});}
 return root;
}
/** Independent local GLBs, loaded only when needed. Every sculpt is volumetric. */
export async function loadCharacter(id: string, signal: AbortSignal): Promise<T.Group> {
  if (!CAST.flat().some(c=>c.id===id)) throw new Error('Unknown character');
  const response=await fetch(`/models/${id}.glb`,{signal});
  if(!response.ok)throw new Error(`Model HTTP ${response.status}`);
  const data=await response.arrayBuffer();signal.throwIfAborted();
  const {GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');signal.throwIfAborted();
  const gltf=await new GLTFLoader().parseAsync(data,'/models/');
  if(signal.aborted){disposeCharacter(gltf.scene);signal.throwIfAborted();}
  const root=prepareCharacter(gltf.scene,id,gltf.animations);
  root.name=`Character model: ${id}`;root.userData.assetKind=id==='luffy'?'uploaded':'sculpted-v2';
  root.traverse(object=>{if(object instanceof T.Mesh){object.castShadow=object.receiveShadow=true;for(const m of Array.isArray(object.material)?object.material:[object.material]){if(m instanceof T.MeshStandardMaterial){m.envMapIntensity=.35;for(const value of Object.values(m))if(value instanceof T.Texture)value.anisotropy=4;}}}});
  return root;
}
export function disposeTextures(textures:Iterable<T.Texture>){
  const images=new Set<ImageBitmap>();
  for(const t of textures){if(typeof ImageBitmap!=='undefined'&&t.source.data instanceof ImageBitmap)images.add(t.source.data);t.dispose();}
  images.forEach(image=>image.close());
}
export function disposeRigResources(root:T.Object3D){
  const skeletons=new Set<T.Skeleton>();root.traverse(o=>{const motion=motions.get(o);if(motion){motion.mixer.stopAllAction();motion.mixer.uncacheRoot(motion.mixer.getRoot());motions.delete(o);}if(o instanceof T.SkinnedMesh)skeletons.add(o.skeleton);});skeletons.forEach(s=>s.dispose());
}
export function disposeCharacter(root:T.Group){
  disposeRigResources(root);
  const textures=new Set<T.Texture>();
  root.traverse(object=>{if(object instanceof T.Mesh)for(const m of Array.isArray(object.material)?object.material:[object.material])for(const v of Object.values(m))if(v instanceof T.Texture)textures.add(v);});
  disposeTextures(textures);disposeGroup(root);
}
