// Geometry-only preflight before browser capture. No source/model GLB is loaded.
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import {createRoronoaZoroModel} from '../src/sculpt/createZoroModel.ts';

const out=path.resolve('.img2threejs/cast/zoro');
const root=createRoronoaZoroModel();
root.updateMatrixWorld(true);
const runtime=root.userData.sculptRuntime;
const head=runtime.meshes.head;
const positions=head.geometry.getAttribute('position');
const index=head.geometry.index;
head.geometry.computeBoundingBox();
const bounds=head.geometry.boundingBox;
const rings=[];
// Intersect the actual emitted triangles with horizontal planes, rather than
// pretending an SDF head is a unit sphere (the generic emitter fallback).
for(let n=0;n<=32;n++){
 const y=THREE.MathUtils.lerp(bounds.min.y+.0001,bounds.max.y-.0001,n/32);
 const points=[];
 const count=index?index.count:positions.count;
 for(let k=0;k<count;k+=3){
  const vs=[0,1,2].map(j=>new THREE.Vector3().fromBufferAttribute(positions,index?index.getX(k+j):k+j));
  for(let j=0;j<3;j++){
   const a=vs[j],b=vs[(j+1)%3];
   if((a.y<=y&&b.y>y)||(b.y<=y&&a.y>y)){
    const t=(y-a.y)/(b.y-a.y);points.push([THREE.MathUtils.lerp(a.x,b.x,t),THREE.MathUtils.lerp(a.z,b.z,t)]);
   }
  }
 }
 if(points.length){
  const xs=points.map(p=>p[0]),zs=points.map(p=>p[1]);
  const z0=Math.min(...zs),z1=Math.max(...zs);
  rings.push([y,Math.max(.0001,...xs.map(Math.abs)),Math.max(.0001,(z1-z0)/2),(z0+z1)/2]);
 }
}
const hair=[];
const inverse=new THREE.Matrix4().copy(head.matrixWorld).invert();
const meshes=[];
const measured={};
let triangles=0;
for(const [id,mesh] of Object.entries(runtime.meshes)){
 measured[id]=new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3()).toArray();
 const a=mesh.geometry.getAttribute('position');
 const n=mesh.geometry.getAttribute('normal');
 const ix=mesh.geometry.index;
 const matrix=new THREE.Matrix4().multiplyMatrices(inverse,mesh.matrixWorld);
 const vertices=[],normals=[];
 for(let i=0;i<a.count;i++){
  const p=new THREE.Vector3().fromBufferAttribute(a,i);
  vertices.push(p.toArray());
  normals.push(new THREE.Vector3().fromBufferAttribute(n,i).toArray());
  if(id==='hair'||id.startsWith('hair-tip-'))hair.push(p.clone().applyMatrix4(matrix).toArray());
 }
 const count=ix?ix.count:a.count;triangles+=count/3;
 meshes.push({id,name:mesh.name,vertices,normals,indices:ix?Array.from(ix.array):Array.from({length:a.count},(_,i)=>i),matrixWorld:mesh.matrixWorld.toArray()});
}
fs.writeFileSync(path.join(out,'head-rings.json'),JSON.stringify(rings));
fs.writeFileSync(path.join(out,'hair-points.json'),JSON.stringify(hair));
fs.writeFileSync(path.join(out,'measured-anchors.json'),JSON.stringify(measured,null,2)+'\n');
fs.writeFileSync('/tmp/img2threejs-zoro-meshes.json',JSON.stringify({meshes}));
fs.writeFileSync(path.join(out,'geometry-preflight.json'),JSON.stringify({source:'actual emitted Three.js BufferGeometry',pass:root.userData.sculptBuildPass??'blockout',parts:meshes.length,triangles,headRingCount:rings.length,hairPointCount:hair.length,unmeasuredAttachments:['anchor gate must be evaluated separately using measured-anchors.json'],staticOnly:true},null,2)+'\n');
console.log(JSON.stringify({parts:meshes.length,triangles,headRingCount:rings.length,hairPointCount:hair.length}));
