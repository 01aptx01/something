import * as THREE from 'three';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import {createRoronoaZoroModel,createRoronoaZoroEnvironment} from './createZoroModel';
import './studio.css';

const capture=new URLSearchParams(location.search).has('capture');
window.addEventListener('error',()=>{
 const message=document.querySelector('.loading');
 if(message)message.textContent='เปิดโมเดลไม่ได้ กรุณาลองโหลดหน้านี้อีกครั้ง';
});
document.body.classList.toggle('capture',capture);
const stage=document.querySelector<HTMLDivElement>('#stage')!;
document.querySelector<HTMLImageElement>('#reference')!.src=new URL('../../docs/references/user-cast/zoro.png',import.meta.url).href;
document.querySelector<HTMLAnchorElement>('#reference-source')!.href='https://github.com/Shreyansh4real/Roronoa-Zoro-Website/blob/HEAD/Images/pngwing.com%20(3).png';
const renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,preserveDrawingBuffer:capture});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.outputColorSpace=THREE.SRGBColorSpace;
renderer.toneMapping=THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure=1;
const scene=new THREE.Scene();scene.background=new THREE.Color('#ffffff');
scene.environment=createRoronoaZoroEnvironment(renderer);
const key=new THREE.DirectionalLight('#fff3df',2.2);key.position.set(-3,5,5);
const fill=new THREE.DirectionalLight('#dceaff',.8);fill.position.set(3,2,3);
const rim=new THREE.DirectionalLight('#d9edff',1.4);rim.position.set(2,4,-3);
scene.add(key,fill,rim,new THREE.HemisphereLight('#e8f3ff','#65605a',1));
const camera=new THREE.OrthographicCamera(-1,1,1,-1,.01,30);
const controls=new OrbitControls(camera,renderer.domElement);
controls.enableDamping=true;controls.minZoom=.5;controls.maxZoom=6;
let disposed=false;
const model=createRoronoaZoroModel();scene.add(model);
const runtime=model.userData.sculptRuntime as {meshes:Record<string,THREE.Mesh>;nodes:Record<string,THREE.Object3D>};
const center=new THREE.Vector3(.17125,1.2875,0);
let headView=false;
function resize(){
 const {width,height}=stage.getBoundingClientRect();
 renderer.setSize(width,height,false);
 const halfH=headView ? .20 : 1.3125;const halfW=halfH*width/height;
 camera.left=-halfW;camera.right=halfW;camera.top=halfH;camera.bottom=-halfH;camera.updateProjectionMatrix();
}
function view(value:number|string=0){
 headView=String(value).startsWith('head');
 const az=(headView?(value==='head35'?35:0):Number(value))*Math.PI/180;
 const target=headView?new THREE.Vector3(-.015,2.33,0):center;
 camera.position.copy(target).add(new THREE.Vector3(Math.sin(az)*6,0,Math.cos(az)*6));
 controls.target.copy(target);camera.zoom=1;controls.update();resize();
 document.querySelector('#view-label')!.textContent=headView?'ใบหน้า':`${value}°`;
 document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===String(value)));
}
const basePositions=new Map<string,THREE.Vector3>();
const originalMaterials=new Map<THREE.Mesh,THREE.Material|THREE.Material[]>();
for(const mesh of Object.values(runtime.meshes))originalMaterials.set(mesh,mesh.material);
function stripped(enabled:boolean){
 for(const [mesh,original] of originalMaterials){
  if(enabled){
   const source=Array.isArray(original)?original[0]:original;
   const color='color' in source?(source as THREE.MeshStandardMaterial).color:new THREE.Color('#cccccc');
   mesh.material=new THREE.MeshBasicMaterial({color,transparent:source.transparent,opacity:source.opacity,side:source.side});
  }else{
   if(mesh.material!==original)for(const m of Array.isArray(mesh.material)?mesh.material:[mesh.material])m.dispose();
   mesh.material=original;
  }
 }
}
for(const [id,node] of Object.entries(runtime.nodes))basePositions.set(id,node.position.clone());
function explode(enabled:boolean){
 for(const [id,node] of Object.entries(runtime.nodes)){
  if(id==='root')continue;
  const component=node.userData.sculptComponent;
  // Face/hair ride their head; scaling a parent layout avoids double offsets.
  if(component?.parent==='head')continue;
  const base=basePositions.get(id)!;
  node.position.copy(base);
  if(enabled){
   const partCenter=new THREE.Box3().setFromObject(node).getCenter(new THREE.Vector3());
   node.position.add(partCenter.sub(center).multiplyScalar(.24));
  }
 }
 document.querySelector('#explode')!.setAttribute('aria-pressed',String(enabled));
}
const raycaster=new THREE.Raycaster();const pointer=new THREE.Vector2();
let downX=0,downY=0;
renderer.domElement.addEventListener('pointerdown',e=>{downX=e.clientX;downY=e.clientY;});
renderer.domElement.addEventListener('pointerup',e=>{
 if(Math.hypot(e.clientX-downX,e.clientY-downY)>5)return;
 const rect=renderer.domElement.getBoundingClientRect();pointer.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);
 raycaster.setFromCamera(pointer,camera);
 const hit=raycaster.intersectObjects(Object.entries(runtime.meshes).filter(([id])=>id!=='root').map(([,m])=>m),false)[0];
 if(hit)document.querySelector('#selected-part')!.textContent=hit.object.name;
});
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(b=>b.addEventListener('click',()=>view(b.dataset.view!)));
document.querySelector('#explode')!.addEventListener('click',()=>explode(document.querySelector('#explode')!.getAttribute('aria-pressed')!=='true'));
document.querySelector('#reset')!.addEventListener('click',()=>{explode(false);view(0);});
document.querySelector<HTMLInputElement>('#wireframe')!.addEventListener('change',e=>{
 const enabled=(e.target as HTMLInputElement).checked;
 for(const mesh of Object.values(runtime.meshes))for(const mat of Array.isArray(mesh.material)?mesh.material:[mesh.material])if('wireframe' in mat)(mat as THREE.MeshStandardMaterial).wireframe=enabled;
});
const observer=new ResizeObserver(resize);observer.observe(stage);
stage.querySelector('.loading')?.remove();stage.append(renderer.domElement);view(0);
renderer.setAnimationLoop(()=>{if(!disposed){controls.update();renderer.render(scene,camera);}});
function dispose(){
 if(disposed)return;disposed=true;observer.disconnect();controls.dispose();renderer.setAnimationLoop(null);
 const geometries=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>();
 model.traverse(n=>{if(n instanceof THREE.Mesh){geometries.add(n.geometry);for(const m of Array.isArray(n.material)?n.material:[n.material])materials.add(m);}});
 geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());scene.environment?.dispose();renderer.dispose();
}
window.addEventListener('pagehide',dispose,{once:true});
Object.assign(window,{__sculpt:{ready:true,model,renderer,scene,camera,view,explode,stripped,dispose,
 metadata:{character:'zoro',stage:'blockout',accepted:false,source:'img2threejs-procedural',parts:Object.keys(runtime.meshes).length}}});
