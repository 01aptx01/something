import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {Matrix4,Vector3,Quaternion} from 'three';

const report=JSON.parse(fs.readFileSync(new URL('../public/models/build-report.json',import.meta.url)));
for(const id of ['luffy','zoro','tanjiro','nezuko','levi','mikasa'])test(`${id}: complete local GLB, finite sculpture, embedded PBR textures and bounded geometry`,()=>{
 const buffer=fs.readFileSync(new URL(`../public/models/${id}.glb`,import.meta.url));
 assert.equal(buffer.toString('ascii',0,4),'glTF');assert.equal(buffer.readUInt32LE(4),2);assert.equal(buffer.readUInt32LE(8),buffer.length);
 const jsonLength=buffer.readUInt32LE(12),gltf=JSON.parse(buffer.toString('utf8',20,20+jsonLength));
 assert.ok(gltf.images.length>=3,'eyes, fabric and hair have embedded textures');
 assert.ok(gltf.images.every(i=>i.bufferView!==undefined&&!i.uri),'models work without external image/CDN requests');
 assert.ok(gltf.materials.length<25,'batching keeps a sculpture below 25 materials');
 let tris=0;
 const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
 const transforms=new Map();
 const visit=(index,parent)=>{const n=gltf.nodes[index],local=n.matrix?new Matrix4().fromArray(n.matrix):new Matrix4().compose(new Vector3().fromArray(n.translation??[0,0,0]),new Quaternion().fromArray(n.rotation??[0,0,0,1]),new Vector3().fromArray(n.scale??[1,1,1])),world=parent.clone().multiply(local);if(n.mesh!==undefined)transforms.set(n.mesh,world);for(const child of n.children??[])visit(child,world);};
 for(const n of gltf.scenes[gltf.scene??0].nodes)visit(n,new Matrix4());
 for(const [mi,m] of gltf.meshes.entries())for(const p of m.primitives){
   assert.ok(p.attributes.NORMAL!==undefined,'every sculpture surface has normals');
   const a=gltf.accessors[p.attributes.POSITION],view=gltf.bufferViews[a.bufferView];
   assert.equal(a.componentType,5126);assert.equal(a.type,'VEC3');
   const start=28+jsonLength+view.byteOffset+(a.byteOffset??0),stride=view.byteStride??12;
   for(let i=0;i<a.count;i++){const co=[];for(let c=0;c<3;c++){const value=buffer.readFloatLE(start+i*stride+c*4);assert.ok(Number.isFinite(value),'no NaN/Infinity positions');co.push(value);}const v=new Vector3().fromArray(co).applyMatrix4(transforms.get(mi)).toArray();for(let c=0;c<3;c++){min[c]=Math.min(min[c],v[c]);max[c]=Math.max(max[c],v[c]);}}
   tris+=(p.indices===undefined?a.count:gltf.accessors[p.indices].count)/3;
 }
 assert.ok(tris>(id==='luffy'?40000:50000)&&tris<180000,`sized for one detailed exhibit: ${tris}`);
 assert.ok(max[1]-min[1]>(id==='luffy'?1:2)&&max[1]-min[1]<3,'human full-body scale');
 assert.ok(max[2]-min[2]>.25,'real volume from front to back');
 if(id==='luffy'){assert.equal(createHash('sha256').update(buffer).digest('hex'),'70c9516935eca0065f22da082e46405150225215eeb617d2e6ad394d714c85c4');assert.ok(gltf.skins[0].joints.length>0);assert.ok(gltf.animations.some(c=>c.name==='blink'));assert.equal(gltf.asset.extras.license,'SKETCHFAB Standard (https://sketchfab.com/licenses)');}
 const entry=report.find(m=>m.id===id);assert.equal(entry.bytes,buffer.length);assert.equal(entry.triangles,tris);
});
